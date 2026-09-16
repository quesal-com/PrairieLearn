import { createHash } from 'node:crypto';
import { statSync, watch } from 'node:fs';
import path from 'node:path';

import { omit } from 'es-toolkit';
import express, { type Express, type Request, type Response } from 'express';
import asyncHandler from 'express-async-handler';

import type {
  LocalPreviewAssessmentCourseSource,
  LocalPreviewCourseResource,
} from '../question-preview/course-source.js';
import {
  QUESTION_PREVIEW_ERROR_DOCUMENT,
  type QuestionPreviewDiagnostic,
  type QuestionPreviewDocumentResult,
  type QuestionPreviewSubmissionInput,
  type QuestionPreviewSubmissionSnapshot,
} from '../question-preview/document.js';
import { parseQuestionPreviewQid } from '../question-preview/qid.js';
import type { QuestionPreviewRuntime } from '../question-preview/render.js';
import type { QuestionPreviewServerHttpOptions } from '../question-preview/server-options.js';

import type { AssessmentPreviewStudentFacts } from './access.js';
import type { AssessmentPlanDiagnostic } from './assessment-plan.js';
import {
  augmentAssessmentPreviewQuestionDocument,
  renderAssessmentPreviewDocument,
} from './document.js';
import { InvalidAssessmentPreviewMetadataError, loadAssessmentPreviewPlan } from './load.js';
import { parseAssessmentPreviewLocator } from './locator.js';
import {
  AssessmentPreviewSession,
  type AssessmentPreviewSessionRun,
  InvalidAssessmentPreviewPlanError,
  sanitizeAssessmentPreviewDiagnostics,
} from './session.js';

interface RegisterAssessmentPreviewRoutesInput {
  app: Express;
  courseSource: LocalPreviewAssessmentCourseSource;
  httpOptions: QuestionPreviewServerHttpOptions;
  runtime: QuestionPreviewRuntime;
  savedSubmissionsMaxSize?: number;
  sessionPrefix: string;
  sourceWatcherFactory?: AssessmentPreviewSourceWatcherFactory;
}

interface AssessmentPreviewSourceWatcher {
  close(): void;
}

type AssessmentPreviewSourceWatcherFactory = (input: {
  courseDir: string;
  sourceChanged: (sourceMtimeMs: number | null) => void;
}) => AssessmentPreviewSourceWatcher;

const SOURCE_WATCHER_UNAVAILABLE_MESSAGE =
  'Automatic course source change detection is unavailable. After editing course sources, send an explicit source-change notification and recreate the assessment preview run.';

const SOURCE_WATCHER_UNAVAILABLE_DIAGNOSTIC: AssessmentPlanDiagnostic = {
  code: 'source-watcher-unavailable',
  message: SOURCE_WATCHER_UNAVAILABLE_MESSAGE,
  path: 'course-source',
  severity: 'warning',
};

const DEFAULT_ASSESSMENT_PREVIEW_SAVED_SUBMISSIONS_MAX_SIZE = 256 * 1024 * 1024;
const RETAINED_VALUE_CONTAINER_OVERHEAD_BYTES = 16;
const RETAINED_VALUE_PROPERTY_OVERHEAD_BYTES = 8;

interface AssessmentPreviewCreateBody {
  facts?: Partial<AssessmentPreviewStudentFacts>;
  locator: { aid: string; ciid: string };
  reuse: boolean;
  seed: string;
}

interface AssessmentPreviewSavedSubmission {
  kind: 'assessment-preview-saved-submission-v1';
  submission: QuestionPreviewSubmissionInput;
}

const QUESTION_SUBMISSION_CONTROL_FIELDS = [
  '__action',
  '__assessment_preview_revision',
  '__assessment_preview_variant_number',
  '__csrf_token',
  '__variant_id',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isQuestionPreviewSubmissionSnapshot(
  value: unknown,
): value is QuestionPreviewSubmissionSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.rawSubmittedAnswer) ||
    (value.workspaceFormatErrors !== undefined && !isRecord(value.workspaceFormatErrors)) ||
    !Array.isArray(value.workspaceGradedFiles)
  ) {
    return false;
  }
  return value.workspaceGradedFiles.every(
    (file) => isRecord(file) && typeof file.name === 'string' && typeof file.contents === 'string',
  );
}

function assessmentPreviewSavedSubmissionInput(
  value: unknown,
): QuestionPreviewSubmissionInput | null {
  // The preview session is in-memory, but accepting the old raw-answer shape
  // keeps hot-reload and direct reducer fixtures compatible with this seam.
  if (!isRecord(value)) return null;
  if (value.kind !== 'assessment-preview-saved-submission-v1') {
    return { rawSubmittedAnswer: value };
  }
  if (!isRecord(value.submission)) return null;
  if (isRecord(value.submission.rawSubmittedAnswer)) {
    return { rawSubmittedAnswer: value.submission.rawSubmittedAnswer };
  }
  if (isQuestionPreviewSubmissionSnapshot(value.submission.snapshot)) {
    return { snapshot: value.submission.snapshot };
  }
  return null;
}

function makeAssessmentPreviewSavedSubmission(
  rawSubmittedAnswer: Record<string, unknown>,
  snapshot?: QuestionPreviewSubmissionSnapshot,
): AssessmentPreviewSavedSubmission {
  return {
    kind: 'assessment-preview-saved-submission-v1',
    submission: snapshot == null ? { rawSubmittedAnswer } : { snapshot },
  };
}

/**
 * Conservatively estimates retained data without serializing it into another
 * potentially large string. Unsupported or hostile values are treated as over
 * the limit so a renderer cannot accidentally leave an unbounded object graph
 * in the assessment run.
 */
function retainedValueSizeWithinLimit(value: unknown, maxSize: number): number | null {
  let size = 0;
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();

  const addSize = (bytes: number): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxSize - size) return false;
    size += bytes;
    return true;
  };

  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) {
      if (!addSize(1)) return null;
      continue;
    }
    if (typeof current === 'string') {
      // UTF-8 bytes are never fewer than the JavaScript string's code units.
      if (current.length > maxSize - size || !addSize(Buffer.byteLength(current))) return null;
      continue;
    }
    if (typeof current === 'number') {
      if (!addSize(8)) return null;
      continue;
    }
    if (typeof current === 'boolean') {
      if (!addSize(1)) return null;
      continue;
    }
    if (typeof current !== 'object') return null;
    if (seen.has(current)) continue;
    seen.add(current);

    if (!addSize(RETAINED_VALUE_CONTAINER_OVERHEAD_BYTES)) return null;
    if (ArrayBuffer.isView(current)) {
      if (!addSize(current.byteLength)) return null;
      continue;
    }
    if (current instanceof ArrayBuffer) {
      if (!addSize(current.byteLength)) return null;
      continue;
    }
    if (current instanceof Map) {
      for (const [key, item] of current) {
        if (!addSize(RETAINED_VALUE_PROPERTY_OVERHEAD_BYTES)) return null;
        pending.push(key, item);
      }
      continue;
    }
    if (current instanceof Set) {
      for (const item of current) pending.push(item);
      continue;
    }
    if (current instanceof Date) {
      if (!addSize(8)) return null;
      continue;
    }

    let keys: string[];
    try {
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
        return null;
      }
      keys = Object.keys(current);
    } catch {
      return null;
    }
    for (const key of keys) {
      if (
        key.length > maxSize - size ||
        !addSize(Buffer.byteLength(key) + RETAINED_VALUE_PROPERTY_OVERHEAD_BYTES)
      ) {
        return null;
      }
      try {
        pending.push((current as Record<string, unknown>)[key]);
      } catch {
        return null;
      }
    }
  }

  return size;
}

function assessmentPreviewSavedSubmissionsFit({
  maxSize,
  record,
  replacement,
  slotId,
}: {
  maxSize: number;
  record: AssessmentPreviewSessionRun;
  replacement: AssessmentPreviewSavedSubmission;
  slotId: string;
}): boolean {
  let remaining = maxSize;
  for (const question of record.run.questions) {
    const savedAnswer = question.slotId === slotId ? replacement : question.savedAnswer;
    if (savedAnswer == null) continue;
    const answerSize = retainedValueSizeWithinLimit(savedAnswer, remaining);
    if (answerSize == null) return false;
    remaining -= answerSize;
  }
  return true;
}

function stripQuestionSubmissionControlFields(
  submission: Record<string, unknown>,
): Record<string, unknown> {
  return omit(submission, QUESTION_SUBMISSION_CONTROL_FIELDS);
}

function parseStudentFacts(value: unknown): Partial<AssessmentPreviewStudentFacts> | null {
  if (value == null) return {};
  if (!isRecord(value)) return null;

  const facts: Partial<AssessmentPreviewStudentFacts> = {};
  if (value.now != null) {
    if (typeof value.now !== 'string') return null;
    const now = new Date(value.now);
    if (Number.isNaN(now.getTime())) return null;
    facts.now = now;
  }
  if (value.uid != null) {
    if (typeof value.uid !== 'string' || value.uid.length === 0) return null;
    facts.uid = value.uid;
  }
  if (value.enrollmentId != null) {
    if (typeof value.enrollmentId !== 'string' || value.enrollmentId.length === 0) return null;
    facts.enrollmentId = value.enrollmentId;
  }
  if (value.studentLabels != null) {
    if (
      !Array.isArray(value.studentLabels) ||
      !value.studentLabels.every((label) => typeof label === 'string')
    ) {
      return null;
    }
    facts.studentLabels = value.studentLabels;
  }
  if (value.mode != null) {
    if (value.mode !== 'Public' && value.mode !== 'Exam' && value.mode !== 'SEB') return null;
    facts.mode = value.mode;
  }
  if (value.courseRole != null) {
    if (!['None', 'Previewer', 'Viewer', 'Editor', 'Owner'].includes(String(value.courseRole))) {
      return null;
    }
    facts.courseRole = value.courseRole as AssessmentPreviewStudentFacts['courseRole'];
  }
  if (value.courseInstanceRole != null) {
    if (
      !['None', 'Student Data Viewer', 'Student Data Editor'].includes(
        String(value.courseInstanceRole),
      )
    ) {
      return null;
    }
    facts.courseInstanceRole =
      value.courseInstanceRole as AssessmentPreviewStudentFacts['courseInstanceRole'];
  }
  if (value.prairieTestReservations != null) {
    if (!Array.isArray(value.prairieTestReservations)) return null;
    const reservations: AssessmentPreviewStudentFacts['prairieTestReservations'] = [];
    for (const reservation of value.prairieTestReservations) {
      if (
        !isRecord(reservation) ||
        typeof reservation.examUuid !== 'string' ||
        reservation.examUuid.length === 0 ||
        typeof reservation.accessEnd !== 'string'
      ) {
        return null;
      }
      const accessEnd = new Date(reservation.accessEnd);
      if (Number.isNaN(accessEnd.getTime())) return null;
      reservations.push({ accessEnd, examUuid: reservation.examUuid });
    }
    facts.prairieTestReservations = reservations;
  }
  return facts;
}

function parseCreateBody(value: unknown): AssessmentPreviewCreateBody | null {
  if (!isRecord(value) || !isRecord(value.locator)) return null;
  const { aid, ciid } = value.locator;
  const facts = parseStudentFacts(value.facts);
  if (
    typeof aid !== 'string' ||
    typeof ciid !== 'string' ||
    typeof value.seed !== 'string' ||
    value.seed.length === 0 ||
    value.seed.length > 256 ||
    value.reuse !== true ||
    facts == null
  ) {
    return null;
  }
  return { facts, locator: { aid, ciid }, reuse: true, seed: value.seed };
}

function assessmentPreviewError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

function requestPrefersJson(req: Request): boolean {
  if (req.is('application/json')) return true;
  const preferredType = req.accepts(['application/json', 'text/html', 'application/xhtml+xml']);
  return preferredType !== 'text/html' && preferredType !== 'application/xhtml+xml';
}

function parseAssessmentPreviewQuestionIdentityField(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function assessmentPreviewMetadataError(
  res: Response,
  courseSource: LocalPreviewAssessmentCourseSource,
  err: InvalidAssessmentPreviewMetadataError,
): void {
  res.status(422).json({
    diagnostics: sanitizeAssessmentPreviewDiagnostics(courseSource, err.diagnostics),
    error: {
      code: 'invalid_assessment_preview_metadata',
      message: err.message,
    },
  });
}

function runUrl(sessionPrefix: string, assessmentPreviewRunId: string): string {
  return `${sessionPrefix}/assessment-preview-runs/${assessmentPreviewRunId}`;
}

function assessmentQuestionDiagnostics(
  diagnostics: readonly QuestionPreviewDiagnostic[],
  slotId: string,
  qid: string,
): AssessmentPlanDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: `question-preview-${diagnostic.phase ?? 'render'}`,
    ...(diagnostic.data === undefined ? {} : { data: diagnostic.data }),
    message: `${diagnostic.name}: ${diagnostic.message}`,
    path: `questions/${qid}`,
    severity: diagnostic.fatal ? 'error' : 'warning',
    slotId,
  }));
}

function assessmentQuestionExceptionDiagnostic(
  err: unknown,
  phase: 'grade' | 'render',
  slotId: string,
  qid: string,
): AssessmentPlanDiagnostic {
  return {
    code: `question-preview-${phase}`,
    message:
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : `The question renderer failed unexpectedly during ${phase}.`,
    path: `questions/${qid}`,
    severity: 'error',
    slotId,
  };
}

function documentView(
  courseSource: LocalPreviewAssessmentCourseSource,
  record: AssessmentPreviewSessionRun,
  url: string,
  finishGradingAvailable: boolean,
  serverDiagnostics: readonly AssessmentPlanDiagnostic[] = [],
) {
  return {
    access: record.access,
    assessmentText: record.loaded.assessment.text ?? '',
    diagnostics: sanitizeAssessmentPreviewDiagnostics(courseSource, [
      ...record.diagnostics,
      ...serverDiagnostics,
    ]),
    finishGradingAvailable,
    invalidation: {
      invalidated: record.invalidated,
      ...(record.invalidationMessage == null ? {} : { message: record.invalidationMessage }),
    },
    run: {
      ...record.run,
      diagnostics: sanitizeAssessmentPreviewDiagnostics(courseSource, record.run.diagnostics),
    },
    runUrl: url,
  };
}

function assessmentPreviewRequestError({
  code,
  courseSource,
  finishGradingAvailable,
  message,
  path,
  record,
  req,
  res,
  serverDiagnostics,
  sessionPrefix,
  slotId,
  status,
}: {
  code: string;
  courseSource: LocalPreviewAssessmentCourseSource;
  finishGradingAvailable: boolean;
  message: string;
  path: string;
  record: AssessmentPreviewSessionRun;
  req: Request;
  res: Response;
  serverDiagnostics: readonly AssessmentPlanDiagnostic[];
  sessionPrefix: string;
  slotId?: string;
  status: number;
}): void {
  if (requestPrefersJson(req)) {
    assessmentPreviewError(res, status, code, message);
    return;
  }

  const url = runUrl(sessionPrefix, record.assessmentPreviewRunId);
  res
    .status(status)
    .type('html')
    .send(
      renderAssessmentPreviewDocument(
        documentView(courseSource, record, url, finishGradingAvailable, [
          ...serverDiagnostics,
          {
            code,
            message,
            path,
            severity: 'error',
            ...(slotId == null ? {} : { slotId }),
          },
        ]),
      ),
    );
}

function sendInvalidatedRunDocument(
  res: Response,
  record: AssessmentPreviewSessionRun,
  sessionPrefix: string,
  courseSource: LocalPreviewAssessmentCourseSource,
  finishGradingAvailable: boolean,
  serverDiagnostics: readonly AssessmentPlanDiagnostic[],
): void {
  const url = runUrl(sessionPrefix, record.assessmentPreviewRunId);
  res
    .status(409)
    .type('html')
    .send(
      renderAssessmentPreviewDocument(
        documentView(courseSource, record, url, finishGradingAvailable, serverDiagnostics),
      ),
    );
}

function sendFinishGradingFailureDocument(
  res: Response,
  record: AssessmentPreviewSessionRun,
  sessionPrefix: string,
  courseSource: LocalPreviewAssessmentCourseSource,
  diagnostics: readonly AssessmentPlanDiagnostic[],
  slotId: string,
): void {
  const failedRecord: AssessmentPreviewSessionRun = {
    ...record,
    run: {
      ...record.run,
      diagnostics: [
        ...record.run.diagnostics,
        {
          code: 'finish-grading-failed',
          message:
            'Deferred grading failed for this question. The run remains in progress and no finish grades were applied.',
          severity: 'error',
          slotId,
        },
      ],
    },
  };
  const url = runUrl(sessionPrefix, record.assessmentPreviewRunId);
  res
    .status(422)
    .type('html')
    .send(
      renderAssessmentPreviewDocument(
        documentView(courseSource, failedRecord, url, true, diagnostics),
      ),
    );
}

function publicRunState(
  courseSource: LocalPreviewAssessmentCourseSource,
  record: AssessmentPreviewSessionRun,
  serverDiagnostics: readonly AssessmentPlanDiagnostic[] = [],
) {
  return {
    access: {
      authorized: record.access.authorized,
      complete: record.access.complete,
      credit: record.access.credit,
      creditDateString: record.access.creditDateString,
      source: record.access.source,
      submittable: record.access.submittable,
      visibility: record.access.visibility,
      visibilitySource: record.access.visibilitySource,
    },
    assessmentPreviewRunId: record.assessmentPreviewRunId,
    diagnostics: sanitizeAssessmentPreviewDiagnostics(courseSource, [
      ...record.diagnostics,
      ...record.run.diagnostics,
      ...serverDiagnostics,
    ]),
    invalidated: record.invalidated,
    ...(record.access.visibility.showQuestions
      ? {
          questions: record.run.questions.map(
            ({ savedAnswer: _savedAnswer, ...question }) => question,
          ),
        }
      : {}),
    revision: record.run.revision,
    ...(record.access.visibility.showScore ? { score: record.run.score } : {}),
    seed: record.seed,
    status: record.run.status,
  };
}

function variantSeed(record: AssessmentPreviewSessionRun, slotId: string): string {
  const question = record.run.questions.find((candidate) => candidate.slotId === slotId);
  const digest = createHash('sha256')
    .update(`${record.seed}\0${slotId}\0${question?.variant.number ?? 1}`)
    .digest();
  // Native PrairieLearn question generators expect a non-zero uint32 seed. Keep
  // the derivation deterministic without passing the full assessment hash into
  // question code that narrows the seed to NumPy's uint32 range.
  return (digest.readUInt32BE(0) || 1).toString(36);
}

function rawPathname(req: Request): string {
  const queryStart = req.originalUrl.search(/[?#]/);
  return queryStart === -1 ? req.originalUrl : req.originalUrl.slice(0, queryStart);
}

function safePathSegments(req: Request, prefix: string): string[] | null {
  const pathname = rawPathname(req);
  if (!pathname.startsWith(prefix)) return null;
  const encodedPath = pathname.slice(prefix.length);
  if (encodedPath.length === 0) return null;
  const segments: string[] = [];
  for (const encodedSegment of encodedPath.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      return null;
    }
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      path.isAbsolute(segment)
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

function makeResource(
  record: AssessmentPreviewSessionRun,
  kind: 'clientFilesCourse' | 'clientFilesCourseInstance' | 'clientFilesAssessment',
  filePathSegments: string[],
): LocalPreviewCourseResource {
  switch (kind) {
    case 'clientFilesCourse':
      return { filePathSegments, kind: 'course-client-file' };
    case 'clientFilesCourseInstance':
      return {
        filePathSegments,
        kind: 'course-instance-client-file',
        locator: record.loaded.locator,
      };
    case 'clientFilesAssessment':
      return {
        filePathSegments,
        kind: 'assessment-client-file',
        locator: record.loaded.locator,
      };
  }
}

const createSourceWatcher: AssessmentPreviewSourceWatcherFactory = ({
  courseDir,
  sourceChanged,
}) => {
  return watch(courseDir, { recursive: true }, (_eventType, filename) => {
    if (filename != null && String(filename).split(path.sep).includes('.git')) return;
    let sourceMtimeMs: number | null = null;
    if (filename != null) {
      try {
        const changedPath = path.resolve(courseDir, String(filename));
        const relativePath = path.relative(courseDir, changedPath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return;
        sourceMtimeMs = statSync(changedPath).mtimeMs;
      } catch {
        // A removed or renamed source path is still a source change.
      }
    }
    sourceChanged(sourceMtimeMs);
  });
};

export function registerAssessmentPreviewRoutes({
  app,
  courseSource,
  httpOptions,
  runtime,
  savedSubmissionsMaxSize = DEFAULT_ASSESSMENT_PREVIEW_SAVED_SUBMISSIONS_MAX_SIZE,
  sessionPrefix,
  sourceWatcherFactory = createSourceWatcher,
}: RegisterAssessmentPreviewRoutesInput): { close(): void } {
  if (!Number.isSafeInteger(savedSubmissionsMaxSize) || savedSubmissionsMaxSize < 1) {
    throw new RangeError('savedSubmissionsMaxSize must be a positive safe integer.');
  }
  const session = new AssessmentPreviewSession(courseSource);
  let sourceWatcher: AssessmentPreviewSourceWatcher | null = null;
  let serverDiagnostics: readonly AssessmentPlanDiagnostic[] = [];
  try {
    sourceWatcher = sourceWatcherFactory({
      courseDir: courseSource.courseDir,
      sourceChanged: (sourceMtimeMs) => session.invalidateFromWatcher(sourceMtimeMs),
    });
  } catch {
    console.error(SOURCE_WATCHER_UNAVAILABLE_MESSAGE);
    serverDiagnostics = [SOURCE_WATCHER_UNAVAILABLE_DIAGNOSTIC];
  }

  app.get(
    '/assessments',
    asyncHandler(async (req, res) => {
      if (typeof req.query.aid !== 'string' || typeof req.query.ciid !== 'string') {
        assessmentPreviewError(
          res,
          400,
          'invalid_request',
          'ciid and aid query values are required.',
        );
        return;
      }
      const locatorResult = parseAssessmentPreviewLocator({
        aid: req.query.aid,
        ciid: req.query.ciid,
      });
      if (!locatorResult.ok) {
        assessmentPreviewError(res, 400, 'invalid_assessment_locator', locatorResult.error.message);
        return;
      }
      let loaded;
      try {
        loaded = await loadAssessmentPreviewPlan({
          courseSource,
          locator: locatorResult.locator,
        });
      } catch (err) {
        if (err instanceof InvalidAssessmentPreviewMetadataError) {
          assessmentPreviewMetadataError(res, courseSource, err);
          return;
        }
        throw err;
      }
      const diagnostics = sanitizeAssessmentPreviewDiagnostics(courseSource, loaded.diagnostics);
      res.json({
        assessment: {
          number: loaded.assessment.number,
          set: loaded.assessment.set,
          title: loaded.assessment.title,
          type: loaded.assessment.type,
        },
        diagnostics,
        plan: {
          ...loaded.plan,
          ...(loaded.plan.validationErrors == null
            ? {}
            : {
                validationErrors: sanitizeAssessmentPreviewDiagnostics(
                  courseSource,
                  loaded.plan.validationErrors,
                ),
              }),
        },
      });
    }),
  );

  app.post(
    '/assessment-preview-runs',
    express.json({ limit: '16kb', strict: true }),
    asyncHandler(async (req, res) => {
      const body = parseCreateBody(req.body);
      if (body == null) {
        assessmentPreviewError(
          res,
          400,
          'invalid_request',
          'Expected locator, a non-empty seed, reuse: true, and optional simulated facts.',
        );
        return;
      }
      const locatorResult = parseAssessmentPreviewLocator(body.locator);
      if (!locatorResult.ok) {
        assessmentPreviewError(res, 400, 'invalid_assessment_locator', locatorResult.error.message);
        return;
      }

      let created;
      try {
        created = await session.create({
          facts: body.facts,
          locator: locatorResult.locator,
          reuse: body.reuse,
          seed: body.seed,
        });
      } catch (err) {
        if (err instanceof InvalidAssessmentPreviewMetadataError) {
          assessmentPreviewMetadataError(res, courseSource, err);
          return;
        }
        if (err instanceof InvalidAssessmentPreviewPlanError) {
          res.status(422).json({
            diagnostics: sanitizeAssessmentPreviewDiagnostics(courseSource, err.diagnostics),
            error: {
              code: 'invalid_assessment_preview_plan',
              message: err.message,
            },
          });
          return;
        }
        throw err;
      }
      const href = `${runUrl(sessionPrefix, created.record.assessmentPreviewRunId)}/`;
      res.status(created.reused ? 200 : 201).json({
        assessmentPreviewRunId: created.record.assessmentPreviewRunId,
        href,
        seed: created.record.seed,
      });
    }),
  );

  app.post('/source-changed', (_req, res) => {
    session.invalidate();
    res.status(204).end();
  });

  app.get(
    [
      '/assessment-preview-runs/:assessmentPreviewRunId',
      '/assessment-preview-runs/:assessmentPreviewRunId/',
    ],
    (req, res) => {
      const record = session.get(req.params.assessmentPreviewRunId);
      if (record == null) {
        assessmentPreviewError(
          res,
          404,
          'assessment_preview_run_not_found',
          'The assessment preview run does not exist.',
        );
        return;
      }
      if (req.query.format === 'json') {
        res.json(publicRunState(courseSource, record, serverDiagnostics));
        return;
      }
      const url = runUrl(sessionPrefix, record.assessmentPreviewRunId);
      res
        .status(record.invalidated ? 409 : 200)
        .type('html')
        .send(
          renderAssessmentPreviewDocument(
            documentView(
              courseSource,
              record,
              url,
              httpOptions.renderMode === 'full',
              serverDiagnostics,
            ),
          ),
        );
    },
  );

  for (const kind of [
    'clientFilesCourse',
    'clientFilesCourseInstance',
    'clientFilesAssessment',
  ] as const) {
    app.get(
      `/assessment-preview-runs/:assessmentPreviewRunId/${kind}/*`,
      asyncHandler(async (req, res) => {
        const record = session.get(req.params.assessmentPreviewRunId);
        if (record == null) {
          res.status(404).end();
          return;
        }
        if (record.invalidated) {
          assessmentPreviewError(
            res,
            409,
            'assessment_preview_run_invalidated',
            'The assessment preview run is out of date. Create a new run to load current assets.',
          );
          return;
        }
        const prefix = `${runUrl(sessionPrefix, record.assessmentPreviewRunId)}/${kind}/`;
        const filePathSegments = safePathSegments(req, prefix);
        if (filePathSegments == null) {
          res.status(404).end();
          return;
        }
        const filePath = await courseSource.resolveResource(
          makeResource(record, kind, filePathSegments),
        );
        if (filePath == null) {
          res.status(404).end();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          res.sendFile(filePath, (err?: Error) => (err == null ? resolve() : reject(err)));
        });
      }),
    );
  }

  const questionHandler = async (
    req: Request,
    res: Response,
    submission?: Record<string, unknown>,
  ) => {
    const initialRecord = session.get(req.params.assessmentPreviewRunId);
    if (initialRecord == null) {
      assessmentPreviewError(
        res,
        404,
        'assessment_preview_run_not_found',
        'The assessment preview run does not exist.',
      );
      return;
    }
    let record = initialRecord;
    if (record.invalidated) {
      sendInvalidatedRunDocument(
        res,
        record,
        sessionPrefix,
        courseSource,
        httpOptions.renderMode === 'full',
        serverDiagnostics,
      );
      return;
    }
    if (submission == null && record.run.status === 'not_started') {
      res.redirect(303, `${runUrl(sessionPrefix, record.assessmentPreviewRunId)}/`);
      return;
    }
    const slot = session.slot(record, req.params.slotId);
    const questionState = record.run.questions.find(
      (candidate) => candidate.slotId === req.params.slotId,
    );
    if (slot == null || questionState == null) {
      assessmentPreviewError(
        res,
        404,
        'assessment_preview_slot_not_found',
        'The selected assessment question does not exist.',
      );
      return;
    }
    const questionRequestError = (status: number, code: string, message: string): void => {
      assessmentPreviewRequestError({
        code,
        courseSource,
        finishGradingAvailable: httpOptions.renderMode === 'full',
        message,
        path: `questions/${slot.qid}`,
        record,
        req,
        res,
        serverDiagnostics,
        sessionPrefix,
        slotId: slot.id,
        status,
      });
    };
    if (submission != null && submission.__action !== 'save' && submission.__action !== 'grade') {
      questionRequestError(400, 'invalid_submission_action', 'Expected the save or grade action.');
      return;
    }
    if (submission != null) {
      const submittedRevision = parseAssessmentPreviewQuestionIdentityField(
        submission.__assessment_preview_revision,
      );
      const submittedVariantNumber = parseAssessmentPreviewQuestionIdentityField(
        submission.__assessment_preview_variant_number,
      );
      if (
        submittedRevision == null ||
        submittedVariantNumber == null ||
        submittedRevision !== record.run.revision ||
        submittedVariantNumber !== questionState.variant.number
      ) {
        questionRequestError(
          409,
          'assessment_preview_question_conflict',
          'The assessment preview question changed. Reload and retry.',
        );
        return;
      }
      if (record.run.status !== 'in_progress') {
        questionRequestError(
          409,
          'assessment_preview_question_not_editable',
          'This assessment question is not currently editable.',
        );
        return;
      }
    }
    if (
      submission == null &&
      (!record.access.authorized ||
        !record.access.visibility.showQuestions ||
        questionState.accessMode.startsWith('blocked_'))
    ) {
      res.redirect(303, `${runUrl(sessionPrefix, record.assessmentPreviewRunId)}/`);
      return;
    }
    const qidResult = parseQuestionPreviewQid(slot.qid);
    if (!qidResult.ok) {
      questionRequestError(
        422,
        'question_unavailable',
        'This assessment question is not a local question.',
      );
      return;
    }
    if (submission != null) {
      if (!record.access.authorized || !record.access.submittable) {
        questionRequestError(
          403,
          'assessment_not_submittable',
          'The simulated access rules do not allow submissions.',
        );
        return;
      }
      if (!record.access.visibility.showQuestions) {
        questionRequestError(
          403,
          'assessment_questions_hidden',
          "The simulated access rules hide this assessment's questions.",
        );
        return;
      }
      if (
        questionState.accessMode !== 'default' ||
        !questionState.open ||
        !questionState.variant.open
      ) {
        questionRequestError(
          409,
          'assessment_preview_question_not_editable',
          'This assessment question is not currently editable.',
        );
        return;
      }
    }

    const nextGradableAtMs =
      questionState.lastGradableAtMs === null
        ? null
        : questionState.lastGradableAtMs + slot.gradeRateMinutes * 60_000;
    const gradeRateLimited =
      submission?.__action === 'grade' &&
      slot.allowRealTimeGrading &&
      nextGradableAtMs !== null &&
      record.run.facts.nowMs < nextGradableAtMs;
    const postedAnswer =
      submission == null ? null : stripQuestionSubmissionControlFields(submission);
    let didPersistPostedAnswer = false;
    let renderSubmission: QuestionPreviewSubmissionInput | undefined =
      postedAnswer == null ? undefined : { rawSubmittedAnswer: postedAnswer };
    let renderSubmissionMode: 'grade' | 'save' = 'grade';
    const shouldSavePostedAnswer =
      submission != null &&
      (submission.__action === 'save' || !slot.allowRealTimeGrading || gradeRateLimited);
    if (shouldSavePostedAnswer) {
      renderSubmissionMode = 'save';
    } else if (submission == null) {
      const savedSubmission = assessmentPreviewSavedSubmissionInput(questionState.savedAnswer);
      if (savedSubmission != null) {
        renderSubmission = savedSubmission;
        renderSubmissionMode = 'save';
      }
    }

    const renderRecord = record;
    const render = () =>
      runtime.render({
        preferences: slot.preferences,
        qid: qidResult.qid,
        renderMode: httpOptions.renderMode,
        submission: renderSubmission,
        submissionMode: renderSubmissionMode,
        variantSeed: variantSeed(renderRecord, slot.id),
      });
    let result: QuestionPreviewDocumentResult;
    try {
      result = await beforeTimeout(render, httpOptions.questionTimeoutMilliseconds);
    } catch (err) {
      console.error('Assessment question rendering failed.', err);
      const url = runUrl(sessionPrefix, renderRecord.assessmentPreviewRunId);
      res
        .status(500)
        .type('html')
        .send(
          augmentAssessmentPreviewQuestionDocument({
            ...documentView(courseSource, renderRecord, url, httpOptions.renderMode === 'full', [
              ...serverDiagnostics,
              assessmentQuestionExceptionDiagnostic(err, 'render', slot.id, qidResult.qid.decoded),
            ]),
            questionDocumentHtml: QUESTION_PREVIEW_ERROR_DOCUMENT,
            slotId: slot.id,
          }),
        );
      return;
    }
    const latestRecord = session.get(record.assessmentPreviewRunId);
    if (latestRecord == null) {
      assessmentPreviewError(
        res,
        409,
        'assessment_preview_run_unavailable',
        'Create a new assessment preview run.',
      );
      return;
    }
    if (latestRecord.invalidated) {
      sendInvalidatedRunDocument(
        res,
        latestRecord,
        sessionPrefix,
        courseSource,
        httpOptions.renderMode === 'full',
        serverDiagnostics,
      );
      return;
    }
    if (latestRecord.run.revision !== renderRecord.run.revision) {
      record = latestRecord;
      questionRequestError(
        409,
        'revision_conflict',
        'The assessment preview run changed. Reload and retry.',
      );
      return;
    }
    record = latestRecord;

    if (shouldSavePostedAnswer && postedAnswer != null && result.ok && result.saveOutcome != null) {
      const answer = makeAssessmentPreviewSavedSubmission(postedAnswer, result.submissionSnapshot);
      if (
        !assessmentPreviewSavedSubmissionsFit({
          maxSize: savedSubmissionsMaxSize,
          record,
          replacement: answer,
          slotId: slot.id,
        })
      ) {
        const url = runUrl(sessionPrefix, record.assessmentPreviewRunId);
        res
          .status(413)
          .type('html')
          .send(
            augmentAssessmentPreviewQuestionDocument({
              ...documentView(courseSource, record, url, httpOptions.renderMode === 'full', [
                ...serverDiagnostics,
                ...assessmentQuestionDiagnostics(
                  result.diagnostics,
                  slot.id,
                  qidResult.qid.decoded,
                ),
                {
                  code: 'assessment-preview-saved-submissions-size-limit',
                  data: { maxSize: savedSubmissionsMaxSize },
                  message:
                    'This answer was not saved because the local preview run reached its saved-answer memory limit. Remove large uploaded or workspace files, or create a new preview run.',
                  path: `questions/${qidResult.qid.decoded}`,
                  severity: 'error',
                  slotId: slot.id,
                },
              ]),
              questionDocumentHtml: result.documentHtml,
              slotId: slot.id,
            }),
          );
        return;
      }
      const savedRecord = session.dispatch(record.assessmentPreviewRunId, {
        answer,
        gradable: result.saveOutcome.kind === 'saved',
        slotId: slot.id,
        type: 'save',
      });
      if (savedRecord == null) {
        assessmentPreviewError(
          res,
          409,
          'assessment_preview_run_unavailable',
          'Create a new assessment preview run.',
        );
        return;
      }
      record = savedRecord;
      didPersistPostedAnswer = record.run.questions.some(
        (question) => question.slotId === slot.id && question.savedAnswer === answer,
      );
      if (gradeRateLimited && result.saveOutcome.kind === 'saved') {
        record =
          session.dispatch(record.assessmentPreviewRunId, {
            gradable: false,
            score: 0,
            slotId: slot.id,
            type: 'grade',
          }) ?? record;
      }
    }

    if (
      postedAnswer != null &&
      renderSubmissionMode === 'grade' &&
      slot.allowRealTimeGrading &&
      result.ok &&
      result.answerCheck != null
    ) {
      const answer = postedAnswer;
      if (result.answerCheck.kind === 'graded') {
        record =
          session.dispatch(record.assessmentPreviewRunId, {
            answer,
            gradable: true,
            score: result.answerCheck.score,
            slotId: slot.id,
            type: 'grade',
          }) ?? record;
      } else if (result.answerCheck.kind === 'invalid') {
        record =
          session.dispatch(record.assessmentPreviewRunId, {
            answer,
            gradable: false,
            score: 0,
            slotId: slot.id,
            type: 'grade',
          }) ?? record;
      }
    }

    const url = runUrl(sessionPrefix, record.assessmentPreviewRunId);
    if (submission?.__action === 'save' && didPersistPostedAnswer) {
      // A redirect keeps refreshing a saved answer from resubmitting a now-stale
      // form. The GET below replays the stored submission (including its exact
      // workspace-file snapshot) and renders the same saved/invalid state.
      res.redirect(303, req.originalUrl);
      return;
    }
    res.type('html').send(
      augmentAssessmentPreviewQuestionDocument({
        ...documentView(courseSource, record, url, httpOptions.renderMode === 'full', [
          ...serverDiagnostics,
          ...assessmentQuestionDiagnostics(result.diagnostics, slot.id, qidResult.qid.decoded),
        ]),
        questionDocumentHtml: result.documentHtml,
        slotId: slot.id,
      }),
    );
  };

  app.get(
    '/assessment-preview-runs/:assessmentPreviewRunId/questions/:slotId',
    asyncHandler(async (req, res) => questionHandler(req, res)),
  );
  const assessmentQuestionPath =
    '/assessment-preview-runs/:assessmentPreviewRunId/questions/:slotId';
  if (httpOptions.renderMode === 'question-only') {
    app.post(assessmentQuestionPath, (_req, res) => {
      res.set('Allow', 'GET, HEAD').status(405).end();
    });
  } else {
    app.post(
      assessmentQuestionPath,
      express.urlencoded({ extended: false, limit: 5 * 1536 * 1024 }),
      asyncHandler(async (req, res) => {
        await questionHandler(req, res, req.body ?? {});
      }),
    );
  }

  app.post(
    '/assessment-preview-runs/:assessmentPreviewRunId/actions',
    express.urlencoded({ extended: false, limit: '16kb' }),
    express.json({ limit: '16kb', strict: true }),
    asyncHandler(async (req, res) => {
      const record = session.get(req.params.assessmentPreviewRunId);
      if (record == null) {
        assessmentPreviewError(
          res,
          409,
          'assessment_preview_run_unavailable',
          'Create a new assessment preview run.',
        );
        return;
      }
      if (record.invalidated) {
        if (requestPrefersJson(req)) {
          assessmentPreviewError(
            res,
            409,
            'assessment_preview_run_unavailable',
            'Create a new assessment preview run.',
          );
        } else {
          sendInvalidatedRunDocument(
            res,
            record,
            sessionPrefix,
            courseSource,
            httpOptions.renderMode === 'full',
            serverDiagnostics,
          );
        }
        return;
      }
      const actionRequestError = (status: number, code: string, message: string): void => {
        assessmentPreviewRequestError({
          code,
          courseSource,
          finishGradingAvailable: httpOptions.renderMode === 'full',
          message,
          path: 'assessment-preview/actions',
          record,
          req,
          res,
          serverDiagnostics,
          sessionPrefix,
          status,
        });
      };
      const revision = Number(req.body?.revision);
      if (!Number.isInteger(revision) || revision !== record.run.revision) {
        actionRequestError(
          409,
          'revision_conflict',
          'The assessment preview run changed. Reload and retry.',
        );
        return;
      }
      const action = req.body?.action;
      const slotId = req.body?.slotId;
      const zoneId = req.body?.zoneId;
      if (action === 'finish' && httpOptions.renderMode === 'question-only') {
        res.status(405).end();
        return;
      }
      if (
        (action === 'finish' || action === 'new-variant' || action === 'cross-lockpoint') &&
        (!record.access.authorized || !record.access.submittable)
      ) {
        actionRequestError(
          403,
          'assessment_not_submittable',
          'The simulated access rules do not allow this assessment action.',
        );
        return;
      }
      let updated: AssessmentPreviewSessionRun | null = null;
      if (action === 'start') {
        if (!record.access.authorized || !record.access.submittable) {
          actionRequestError(
            403,
            'assessment_not_submittable',
            'The simulated access rules do not allow this assessment to start.',
          );
          return;
        }
        const acceptedHonorCode =
          req.body?.honorCodeAccepted === true ||
          req.body?.honorCodeAccepted === 'true' ||
          req.body?.honorCodeAccepted === 'on';
        if (record.run.plan.requireHonorCode && !acceptedHonorCode) {
          actionRequestError(
            403,
            'honor_code_required',
            'Accept the assessment honor code before starting the preview run.',
          );
          return;
        }
        if (record.access.password != null && req.body?.password !== record.access.password) {
          actionRequestError(
            403,
            'invalid_assessment_password',
            'The assessment password is incorrect.',
          );
          return;
        }
        updated = session.dispatch(record.assessmentPreviewRunId, { type: 'start' });
      }
      if (action === 'new-variant' && typeof slotId === 'string') {
        updated = session.dispatch(record.assessmentPreviewRunId, { slotId, type: 'new-variant' });
      }
      if (action === 'cross-lockpoint' && typeof zoneId === 'string') {
        updated = session.dispatch(record.assessmentPreviewRunId, {
          type: 'cross-lockpoint',
          zoneId,
        });
      }
      if (action === 'advance-time' && typeof req.body?.now === 'string') {
        const nowMs = new Date(req.body.now).getTime();
        if (!Number.isNaN(nowMs)) {
          updated = session.dispatch(record.assessmentPreviewRunId, {
            nowMs,
            type: 'advance-time',
          });
        }
      }
      if (action === 'finish') {
        const finishGradeActions: {
          answer: unknown;
          gradable: boolean;
          mode: 'finish';
          score: number;
          slotId: string;
          type: 'grade';
        }[] = [];
        for (const question of record.run.questions) {
          const slot = session.slot(record, question.slotId);
          const savedSubmission = assessmentPreviewSavedSubmissionInput(question.savedAnswer);
          if (
            slot?.grading.kind !== 'internal' ||
            question.status !== 'saved' ||
            savedSubmission == null
          ) {
            continue;
          }
          const qidResult = parseQuestionPreviewQid(slot.qid);
          if (!qidResult.ok) continue;
          const savedAnswer = question.savedAnswer;
          const finishRecord: AssessmentPreviewSessionRun = record;
          let result: QuestionPreviewDocumentResult;
          try {
            result = await beforeTimeout(
              () =>
                runtime.render({
                  preferences: slot.preferences,
                  qid: qidResult.qid,
                  renderMode: httpOptions.renderMode,
                  submission: savedSubmission,
                  submissionMode: 'grade',
                  variantSeed: variantSeed(finishRecord, slot.id),
                }),
              httpOptions.questionTimeoutMilliseconds,
            );
          } catch (err) {
            console.error('Deferred assessment finish grading failed.', err);
            sendFinishGradingFailureDocument(
              res,
              finishRecord,
              sessionPrefix,
              courseSource,
              [
                ...serverDiagnostics,
                assessmentQuestionExceptionDiagnostic(err, 'grade', slot.id, qidResult.qid.decoded),
              ],
              slot.id,
            );
            return;
          }
          const latestRecord = session.get(record.assessmentPreviewRunId);
          if (latestRecord == null || latestRecord.invalidated) {
            assessmentPreviewError(
              res,
              409,
              'assessment_preview_run_unavailable',
              'Create a new assessment preview run.',
            );
            return;
          }
          if (latestRecord.run.revision !== finishRecord.run.revision) {
            assessmentPreviewError(
              res,
              409,
              'revision_conflict',
              'The assessment preview run changed. Reload and retry.',
            );
            return;
          }
          if (
            !result.ok ||
            result.answerCheck == null ||
            result.answerCheck.kind === 'unsupported'
          ) {
            sendFinishGradingFailureDocument(
              res,
              finishRecord,
              sessionPrefix,
              courseSource,
              [
                ...serverDiagnostics,
                ...assessmentQuestionDiagnostics(
                  result.diagnostics,
                  slot.id,
                  qidResult.qid.decoded,
                ),
              ],
              slot.id,
            );
            return;
          }
          if (result.answerCheck.kind === 'graded') {
            finishGradeActions.push({
              answer: savedAnswer,
              gradable: true,
              mode: 'finish',
              score: result.answerCheck.score,
              slotId: slot.id,
              type: 'grade',
            });
          } else {
            finishGradeActions.push({
              answer: savedAnswer,
              gradable: false,
              mode: 'finish',
              score: 0,
              slotId: slot.id,
              type: 'grade',
            });
          }
        }
        updated = session.dispatchBatch(record.assessmentPreviewRunId, [
          ...finishGradeActions,
          { type: 'finish' },
        ]);
      }
      if (updated == null) {
        if (session.get(record.assessmentPreviewRunId)?.invalidated) {
          assessmentPreviewError(
            res,
            409,
            'assessment_preview_run_unavailable',
            'Create a new assessment preview run.',
          );
          return;
        }
        actionRequestError(400, 'invalid_action', 'The assessment preview action is invalid.');
        return;
      }
      if (req.is('application/json')) {
        res.json(publicRunState(courseSource, updated, serverDiagnostics));
        return;
      }
      const destination =
        action === 'new-variant' && typeof slotId === 'string'
          ? `${runUrl(sessionPrefix, updated.assessmentPreviewRunId)}/questions/${encodeURIComponent(slotId)}`
          : `${runUrl(sessionPrefix, updated.assessmentPreviewRunId)}/`;
      res.redirect(303, destination);
    }),
  );

  return { close: () => sourceWatcher?.close() };
}

async function beforeTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Assessment question preview timed out.')),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}
