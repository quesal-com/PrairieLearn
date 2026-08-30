import { randomBytes } from 'node:crypto';

import type { LocalPreviewAssessmentCourseSource } from '../question-preview/course-source.js';

import {
  type AssessmentPreviewAccessResult,
  type AssessmentPreviewStudentFacts,
  evaluateAssessmentPreviewAccess,
} from './access.js';
import { type AssessmentPlanDiagnostic, type AssessmentPlanSlot } from './assessment-plan.js';
import {
  type AssessmentPreviewRun,
  type AssessmentPreviewRunAction,
  createAssessmentPreviewRun,
  reduceAssessmentPreviewRun,
} from './assessment-run.js';
import { type LoadedAssessmentPreviewPlan, loadAssessmentPreviewPlan } from './load.js';
import type { AssessmentPreviewLocator } from './locator.js';

const DEFAULT_INVALIDATION_MESSAGE =
  'Course source changed. Create a new assessment preview sample.';

export interface CreateAssessmentPreviewSessionRunInput {
  facts?: Partial<AssessmentPreviewStudentFacts>;
  locator: AssessmentPreviewLocator;
  reuse: boolean;
  seed: string;
}

export interface AssessmentPreviewSessionRun {
  access: AssessmentPreviewAccessResult;
  assessmentPreviewRunId: string;
  diagnostics: readonly AssessmentPlanDiagnostic[];
  facts: AssessmentPreviewStudentFacts;
  invalidated: boolean;
  invalidationMessage: string | null;
  loaded: LoadedAssessmentPreviewPlan;
  run: AssessmentPreviewRun;
  seed: string;
  timeLimitExpiresAtMs: number | null;
}

export interface CreatedAssessmentPreviewSessionRun {
  record: AssessmentPreviewSessionRun;
  reused: boolean;
}

export class InvalidAssessmentPreviewPlanError extends Error {
  override name = 'InvalidAssessmentPreviewPlanError';

  constructor(public readonly diagnostics: readonly AssessmentPlanDiagnostic[]) {
    super('The assessment preview plan contains errors and cannot be sampled.');
  }
}

export type AssessmentPreviewSessionAction =
  | Exclude<AssessmentPreviewRunAction, { type: 'advance-time' }>
  | { type: 'advance-time'; nowMs: number };

export type AssessmentPreviewSessionBatchAction = Exclude<
  AssessmentPreviewSessionAction,
  { type: 'advance-time' }
>;

function makeAssessmentPreviewRunId(): string {
  return `apr_${randomBytes(16).toString('base64url')}`;
}

function defaultStudentFacts(now: Date): AssessmentPreviewStudentFacts {
  return {
    courseInstanceRole: 'None',
    courseRole: 'None',
    enrollmentId: 'local-preview',
    mode: 'Public',
    now,
    prairieTestReservations: [],
    studentLabels: [],
    uid: 'local-preview@example.com',
  };
}

function sameLocator(a: AssessmentPreviewLocator, b: AssessmentPreviewLocator): boolean {
  return a.aid === b.aid && a.ciid === b.ciid;
}

function canonicalizeFacts(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeFacts);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, canonicalizeFacts(object[key])]),
    );
  }
  return value;
}

function factsReuseKey(facts: Partial<AssessmentPreviewStudentFacts> | undefined): string {
  return JSON.stringify(canonicalizeFacts(facts ?? {}));
}

function afterFinishAccess(access: AssessmentPreviewAccessResult): AssessmentPreviewAccessResult {
  if (access.visibilitySource === 'prairieTest') return access;
  return {
    ...access,
    complete: true,
    creditDateString: 'None',
    password: null,
    submittable: false,
    timeLimitMin: null,
    visibility: access.afterCompleteVisibility,
    visibilitySource: 'afterComplete',
  };
}

function applyInstanceTimeLimit(
  access: AssessmentPreviewAccessResult,
  run: AssessmentPreviewRun,
  timeLimitExpiresAtMs: number | null,
): AssessmentPreviewAccessResult {
  if (run.status !== 'in_progress' || timeLimitExpiresAtMs == null) return access;
  const remainingMs = timeLimitExpiresAtMs - run.facts.nowMs;
  if (remainingMs <= 0) return afterFinishAccess(access);
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  return {
    ...access,
    timeLimitMin:
      access.timeLimitMin == null
        ? remainingMinutes
        : Math.min(access.timeLimitMin, remainingMinutes),
  };
}

function validStudentLabelNames(record: LoadedAssessmentPreviewPlan): Set<string> {
  return new Set(record.courseInstance.studentLabels?.map(({ name }) => name));
}

export function sanitizeAssessmentPreviewDiagnostics<
  Diagnostic extends { data?: unknown; message: string; path?: string; slotId?: string },
>(
  courseSource: LocalPreviewAssessmentCourseSource,
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  const sanitizeString = (value: string): string => {
    const sanitized = courseSource.sanitizeDiagnosticValue(value);
    return typeof sanitized === 'string' ? sanitized : '<redacted>';
  };

  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    ...(diagnostic.data === undefined
      ? {}
      : { data: courseSource.sanitizeDiagnosticValue(diagnostic.data) }),
    message: sanitizeString(diagnostic.message),
    ...(diagnostic.path == null ? {} : { path: sanitizeString(diagnostic.path) }),
    ...(diagnostic.slotId == null ? {} : { slotId: sanitizeString(diagnostic.slotId) }),
  }));
}

export class AssessmentPreviewSession {
  private activeRun: AssessmentPreviewSessionRun | null = null;
  private activeRunFactsReuseKey: string | null = null;
  private activeRunSourceReadStartedAtMs: number | null = null;
  private createTail: Promise<void> = Promise.resolve();
  private latestInvalidationMessage = DEFAULT_INVALIDATION_MESSAGE;
  private loadingSourceReadStartedAtMs: number | null = null;
  private sourceRevision = 0;

  constructor(private readonly courseSource: LocalPreviewAssessmentCourseSource) {}

  async create(
    input: CreateAssessmentPreviewSessionRunInput,
  ): Promise<CreatedAssessmentPreviewSessionRun> {
    const inputFactsReuseKey = factsReuseKey(input.facts);
    let releaseCreate: () => void = () => {};
    const priorCreate = this.createTail;
    this.createTail = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await priorCreate;

    try {
      if (
        input.reuse &&
        this.activeRun != null &&
        !this.activeRun.invalidated &&
        this.activeRun.seed === input.seed &&
        this.activeRunFactsReuseKey === inputFactsReuseKey &&
        sameLocator(this.activeRun.loaded.locator, input.locator)
      ) {
        return { record: this.activeRun, reused: true };
      }

      const sourceRevision = this.sourceRevision;
      const sourceReadStartedAtMs = Date.now();
      this.loadingSourceReadStartedAtMs = sourceReadStartedAtMs;
      const loaded = await loadAssessmentPreviewPlan({
        courseSource: this.courseSource,
        locator: input.locator,
      });
      const blockingDiagnostics = loaded.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      );
      if (blockingDiagnostics.length > 0) {
        throw new InvalidAssessmentPreviewPlanError(
          sanitizeAssessmentPreviewDiagnostics(this.courseSource, blockingDiagnostics),
        );
      }
      const now = input.facts?.now ?? new Date();
      const facts = { ...defaultStudentFacts(now), ...input.facts, now };
      const access = evaluateAssessmentPreviewAccess({
        assessment: loaded.assessment,
        facts,
        timezone: loaded.plan.courseTimezone,
        validStudentLabelNames: validStudentLabelNames(loaded),
      });
      let run = createAssessmentPreviewRun(loaded.plan, input.seed, {
        creditPercent: access.credit ?? 0,
        nowMs: facts.now.getTime(),
      });
      run = { ...run, id: makeAssessmentPreviewRunId() };

      const invalidated = sourceRevision !== this.sourceRevision;
      const record: AssessmentPreviewSessionRun = {
        access,
        assessmentPreviewRunId: run.id,
        diagnostics: loaded.diagnostics,
        facts,
        invalidated,
        invalidationMessage: invalidated ? this.latestInvalidationMessage : null,
        loaded,
        run,
        seed: input.seed,
        timeLimitExpiresAtMs: null,
      };
      this.activeRun = record;
      this.activeRunFactsReuseKey = inputFactsReuseKey;
      this.activeRunSourceReadStartedAtMs = sourceReadStartedAtMs;
      return { record, reused: false };
    } finally {
      this.loadingSourceReadStartedAtMs = null;
      releaseCreate();
    }
  }

  get(assessmentPreviewRunId: string): AssessmentPreviewSessionRun | null {
    return this.activeRun?.assessmentPreviewRunId === assessmentPreviewRunId
      ? this.activeRun
      : null;
  }

  slot(record: AssessmentPreviewSessionRun, slotId: string): AssessmentPlanSlot | null {
    return record.run.sample.selectedSlots.find((slot) => slot.id === slotId) ?? null;
  }

  dispatch(
    assessmentPreviewRunId: string,
    action: AssessmentPreviewSessionAction,
  ): AssessmentPreviewSessionRun | null {
    const record = this.get(assessmentPreviewRunId);
    if (record == null || record.invalidated) return null;
    let facts = record.facts;
    let access = record.access;
    let timeLimitExpiresAtMs = record.timeLimitExpiresAtMs;
    const run = (() => {
      if (action.type !== 'advance-time') return reduceAssessmentPreviewRun(record.run, action);

      const nextFacts = { ...facts, now: new Date(action.nowMs) };
      const nextAccess = evaluateAssessmentPreviewAccess({
        assessment: record.loaded.assessment,
        facts: nextFacts,
        timezone: record.loaded.plan.courseTimezone,
        validStudentLabelNames: validStudentLabelNames(record.loaded),
      });
      const nextRun = reduceAssessmentPreviewRun(record.run, {
        ...action,
        creditPercent: nextAccess.credit ?? 0,
      });
      if (nextRun.facts.nowMs === action.nowMs) {
        facts = nextFacts;
        access = nextAccess;
      }
      return nextRun;
    })();
    if (
      action.type === 'start' &&
      record.loaded.assessment.type === 'Exam' &&
      record.run.status === 'not_started' &&
      run.status === 'in_progress' &&
      run.startedAtMs != null &&
      access.timeLimitMin != null
    ) {
      timeLimitExpiresAtMs = run.startedAtMs + access.timeLimitMin * 60_000;
    }
    access = applyInstanceTimeLimit(access, run, timeLimitExpiresAtMs);
    if (run.status === 'finished') access = afterFinishAccess(access);
    return this.commit(record, run, facts, access, timeLimitExpiresAtMs);
  }

  /** Apply a synchronous sequence as one visible run-state transition. */
  dispatchBatch(
    assessmentPreviewRunId: string,
    actions: readonly AssessmentPreviewSessionBatchAction[],
  ): AssessmentPreviewSessionRun | null {
    const record = this.get(assessmentPreviewRunId);
    if (record == null || record.invalidated) return null;
    const run = actions.reduce(reduceAssessmentPreviewRun, record.run);
    const access = run.status === 'finished' ? afterFinishAccess(record.access) : record.access;
    return this.commit(record, run, record.facts, access, record.timeLimitExpiresAtMs);
  }

  private commit(
    record: AssessmentPreviewSessionRun,
    run: AssessmentPreviewRun,
    facts: AssessmentPreviewStudentFacts,
    access: AssessmentPreviewAccessResult,
    timeLimitExpiresAtMs: number | null,
  ): AssessmentPreviewSessionRun {
    const updated: AssessmentPreviewSessionRun = {
      ...record,
      access,
      diagnostics: record.loaded.diagnostics,
      facts,
      run,
      timeLimitExpiresAtMs,
    };
    this.activeRun = updated;
    return updated;
  }

  invalidate(message = DEFAULT_INVALIDATION_MESSAGE): void {
    this.sourceRevision += 1;
    this.latestInvalidationMessage = message;
    if (this.activeRun == null || this.activeRun.invalidated) return;
    this.activeRun = {
      ...this.activeRun,
      invalidated: true,
      invalidationMessage: message,
    };
  }

  invalidateFromWatcher(sourceMtimeMs: number | null): void {
    const sourceReadStartedAtMs =
      this.loadingSourceReadStartedAtMs ?? this.activeRunSourceReadStartedAtMs;
    if (
      sourceMtimeMs != null &&
      sourceReadStartedAtMs != null &&
      sourceMtimeMs < sourceReadStartedAtMs
    ) {
      return;
    }
    this.invalidate();
  }
}
