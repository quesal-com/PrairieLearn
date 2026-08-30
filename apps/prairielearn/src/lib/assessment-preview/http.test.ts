import type * as nodeFs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import * as cheerio from 'cheerio';
import express from 'express';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AssessmentJsonSchema,
  CourseInstanceJsonSchema,
  CourseJsonSchema,
  QuestionJsonSchema,
} from '../../schemas/index.js';
import { init as initAssets } from '../assets.js';
import type { LocalPreviewAssessmentCourseSource } from '../question-preview/course-source.js';
import type { QuestionPreviewSubmissionSnapshot } from '../question-preview/document.js';
import type { QuestionPreviewRuntime } from '../question-preview/render.js';

import { registerAssessmentPreviewRoutes } from './http.js';

const sourceWatch = vi.hoisted(() => ({
  listener: null as ((eventType: string, filename: string | null) => void) | null,
  missing: false,
  mtimeMs: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    statSync: () => {
      if (sourceWatch.missing) throw new Error('source path no longer exists');
      return { mtimeMs: sourceWatch.mtimeMs };
    },
    watch: (
      _filename: string,
      _options: { recursive: boolean },
      listener: (eventType: string, filename: string | null) => void,
    ) => {
      sourceWatch.listener = listener;
      return { close: () => {} };
    },
  };
});

const invalidAssessment = AssessmentJsonSchema.parse({
  number: '1',
  set: 'Homework',
  title: 'Invalid HTTP preview assessment',
  type: 'Homework',
  uuid: '11111111-1111-4111-8111-111111111301',
  zones: [{ questions: [{ id: 'missing/question', points: 2 }] }],
});

const validAssessment = AssessmentJsonSchema.parse({
  ...invalidAssessment,
  title: 'Valid HTTP preview assessment',
  zones: [{ questions: [{ id: 'local/question', points: 2 }] }],
});

const courseInstance = CourseInstanceJsonSchema.parse({
  longName: 'Fall 2026',
  uuid: '11111111-1111-4111-8111-111111111302',
});

const course = CourseJsonSchema.parse({
  assessmentSets: [{ abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' }],
  name: 'TST 101',
  timezone: 'UTC',
  title: 'HTTP preview course',
  topics: [{ color: 'blue1', name: 'Testing' }],
});

const question = QuestionJsonSchema.parse({
  title: 'Local question',
  topic: 'Testing',
  type: 'v3',
  uuid: '11111111-1111-4111-8111-111111111303',
});

function makeCourseSource(valid: boolean): LocalPreviewAssessmentCourseSource {
  return {
    courseDir: '/private/local/course',
    courseMetadata: {
      assessmentSets: [
        { abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
      ],
      name: 'TST 101',
      options: {},
      timezone: 'UTC',
      title: 'HTTP preview course',
    },
    readAssessmentInfo: vi.fn(async () => (valid ? validAssessment : invalidAssessment)),
    readCourseInfo: vi.fn(async () => course),
    readCourseInstanceInfo: vi.fn(async () => courseInstance),
    readQuestionInfo: vi.fn(async (qid) => {
      if (valid) return question;
      throw new Error(`Cannot read /private/local/course/questions/${qid.decoded}/info.json`);
    }),
    readTemplateInfo: vi.fn(async () => question),
    resolveLegacyQuestionFile: vi.fn(async () => {
      throw new Error('not used by assessment preview HTTP tests');
    }),
    resolveResource: vi.fn(async () => null),
    sanitizeDiagnosticValue: (value) => {
      if (typeof value === 'string') {
        return value.replaceAll('/private/local/course', '<course>');
      }
      return value;
    },
  };
}

const runtime: QuestionPreviewRuntime = {
  close: vi.fn(async () => {}),
  render: vi.fn(async () => {
    throw new Error('not used by assessment preview HTTP tests');
  }),
};

function emitSourceWatchEvent(filename: string | null): void {
  if (sourceWatch.listener == null) throw new Error('Source watcher was not registered.');
  sourceWatch.listener('change', filename);
}

describe('assessment preview HTTP routes', () => {
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    await initAssets();
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function startServer({
    courseSource,
    questionRuntime = runtime,
    savedSubmissionsMaxSize,
    sourceWatcherFactory,
    validCourse = false,
  }: {
    courseSource?: LocalPreviewAssessmentCourseSource;
    questionRuntime?: QuestionPreviewRuntime;
    savedSubmissionsMaxSize?: number;
    sourceWatcherFactory?: () => { close(): void };
    validCourse?: boolean;
  } = {}) {
    sourceWatch.listener = null;
    sourceWatch.missing = false;
    sourceWatch.mtimeMs = 0;
    const app = express();
    const routes = registerAssessmentPreviewRoutes({
      app,
      courseSource: courseSource ?? makeCourseSource(validCourse),
      httpOptions: {
        host: '127.0.0.1',
        port: 0,
        questionTimeoutMilliseconds: 1_000,
        renderMode: 'full',
      },
      runtime: questionRuntime,
      ...(savedSubmissionsMaxSize == null ? {} : { savedSubmissionsMaxSize }),
      sessionPrefix: '/preview-sessions/pvs_test',
      ...(sourceWatcherFactory == null ? {} : { sourceWatcherFactory }),
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          routes.close();
          server.close((error) => (error == null ? resolve() : reject(error)));
        }),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function makeGradableQuestionRuntime() {
    const render = vi.fn(async (input: Parameters<QuestionPreviewRuntime['render']>[0]) => ({
      ...(input.submission == null ? {} : { answerCheck: { kind: 'graded' as const, score: 0 } }),
      diagnostics: [],
      documentHtml: `<!doctype html>
        <html>
          <head><title>Question</title></head>
          <body>
            <div class="question-container">
              <form class="question-form" method="post">
                <input name="answer" />
                <button type="submit" name="__action" value="grade">Save &amp; Grade</button>
              </form>
            </div>
          </body>
        </html>`,
      ok: true as const,
    }));
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    return { questionRuntime, render };
  }

  async function createStartedAssessment(baseUrl: string) {
    const created = await fetch(`${baseUrl}/assessment-preview-runs`, {
      body: JSON.stringify({
        locator: { aid: 'homework', ciid: '2026/fall' },
        reuse: true,
        seed: 'submission-identity',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const { assessmentPreviewRunId } = (await created.json()) as {
      assessmentPreviewRunId: string;
    };
    const actionsUrl = `${baseUrl}/assessment-preview-runs/${assessmentPreviewRunId}/actions`;
    const started = await fetch(actionsUrl, {
      body: JSON.stringify({ action: 'start', revision: 0 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(started.status).toBe(200);
    const startedRun = (await started.json()) as {
      questions: { slotId: string; variant: { number: number } }[];
      revision: number;
    };
    const runUrl = `${baseUrl}/assessment-preview-runs/${assessmentPreviewRunId}`;
    return {
      actionsUrl,
      question: startedRun.questions[0],
      questions: startedRun.questions,
      questionUrl: `${runUrl}/questions/${encodeURIComponent(startedRun.questions[0].slotId)}`,
      revision: startedRun.revision,
      runUrl,
    };
  }

  it('rejects an assessment question submission without its rendered identity', async () => {
    const { questionRuntime, render } = makeGradableQuestionRuntime();
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { questionUrl } = await createStartedAssessment(baseUrl);

    const response = await fetch(questionUrl, {
      body: new URLSearchParams({ __action: 'grade', answer: 'stale' }),
      headers: { accept: 'text/html' },
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('text/html');
    const $ = cheerio.load(await response.text());
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();
    expect($('main > .alert-danger').text()).toContain(
      'This preview could not be completed. Open Preview details for diagnostic information.',
    );
    expect(detailsText).toContain('assessment_preview_question_conflict');
    const questionPath = new URL(questionUrl).pathname;
    expect(
      $('a').filter((_, element) => $(element).attr('href')?.endsWith(questionPath) ?? false),
    ).toHaveLength(1);
    expect(render).not.toHaveBeenCalled();
  });

  it('keeps structured question-conflict errors for API callers', async () => {
    const { questionRuntime, render } = makeGradableQuestionRuntime();
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { questionUrl } = await createStartedAssessment(baseUrl);

    const response = await fetch(questionUrl, {
      body: new URLSearchParams({ __action: 'grade', answer: 'stale' }),
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      error: { code: 'assessment_preview_question_conflict' },
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('honors media-type quality when negotiating browser and API errors', async () => {
    const { questionRuntime } = makeGradableQuestionRuntime();
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { questionUrl } = await createStartedAssessment(baseUrl);

    const jsonResponse = await fetch(questionUrl, {
      body: new URLSearchParams({ __action: 'grade', answer: 'stale' }),
      headers: { accept: 'text/html;q=0, application/json;q=1' },
      method: 'POST',
    });
    expect(jsonResponse.status).toBe(409);
    expect(jsonResponse.headers.get('content-type')).toContain('application/json');
    expect(await jsonResponse.json()).toMatchObject({
      error: { code: 'assessment_preview_question_conflict' },
    });

    const htmlResponse = await fetch(questionUrl, {
      body: new URLSearchParams({ __action: 'grade', answer: 'stale' }),
      headers: { accept: 'application/json;q=0.5, text/html;q=1' },
      method: 'POST',
    });
    expect(htmlResponse.status).toBe(409);
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    expect(
      cheerio
        .load(await htmlResponse.text())('main > .alert-danger')
        .text(),
    ).toContain('Open Preview details');
  });

  it('rejects an assessment question submission with a mismatched run or variant identity', async () => {
    for (const mismatch of ['revision', 'variant'] as const) {
      const { questionRuntime, render } = makeGradableQuestionRuntime();
      const baseUrl = await startServer({ questionRuntime, validCourse: true });
      const { question, questionUrl, revision } = await createStartedAssessment(baseUrl);
      const response = await fetch(questionUrl, {
        body: new URLSearchParams({
          __action: 'grade',
          __assessment_preview_revision: String(mismatch === 'revision' ? revision - 1 : revision),
          __assessment_preview_variant_number: String(
            mismatch === 'variant' ? question.variant.number + 1 : question.variant.number,
          ),
          answer: 'stale',
        }),
        headers: { accept: 'text/html' },
        method: 'POST',
      });

      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain('text/html');
      const $ = cheerio.load(await response.text());
      const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
        .attr('data-bs-target')
        ?.slice(1);
      expect(detailsTarget == null ? '' : $(`#${detailsTarget}`).text()).toContain(
        'assessment_preview_question_conflict',
      );
      expect(render).not.toHaveBeenCalled();
    }
  });

  it('rejects a submission from a tab showing the previous assessment question variant', async () => {
    const { questionRuntime, render } = makeGradableQuestionRuntime();
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { actionsUrl, question, questionUrl } = await createStartedAssessment(baseUrl);

    const initialQuestion = await fetch(questionUrl);
    expect(initialQuestion.status).toBe(200);
    const initialQuestionHtml = await initialQuestion.text();
    const initialForm = cheerio.load(initialQuestionHtml)('form.question-form');
    const staleRevision = initialForm
      .find('input[name="__assessment_preview_revision"]')
      .attr('value')!;
    const staleVariantNumber = initialForm
      .find('input[name="__assessment_preview_variant_number"]')
      .attr('value')!;

    const graded = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'grade',
        __assessment_preview_revision: staleRevision,
        __assessment_preview_variant_number: staleVariantNumber,
        answer: 'incorrect',
      }),
      method: 'POST',
    });
    expect(graded.status).toBe(200);
    const gradedForm = cheerio.load(await graded.text())('form.question-form');
    const gradedRevision = gradedForm
      .find('input[name="__assessment_preview_revision"]')
      .attr('value')!;

    const newVariant = await fetch(actionsUrl, {
      body: JSON.stringify({
        action: 'new-variant',
        revision: Number(gradedRevision),
        slotId: question.slotId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(newVariant.status).toBe(200);
    expect(await newVariant.json()).toMatchObject({
      questions: [expect.objectContaining({ variant: expect.objectContaining({ number: 2 }) })],
    });

    const staleSubmission = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'grade',
        __assessment_preview_revision: staleRevision,
        __assessment_preview_variant_number: staleVariantNumber,
        answer: 'from old tab',
      }),
      headers: { accept: 'text/html' },
      method: 'POST',
    });

    expect(staleSubmission.status).toBe(409);
    expect(staleSubmission.headers.get('content-type')).toContain('text/html');
    const stale$ = cheerio.load(await staleSubmission.text());
    const detailsTarget = stale$('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    expect(detailsTarget == null ? '' : stale$(`#${detailsTarget}`).text()).toContain(
      'assessment_preview_question_conflict',
    );
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('returns a browser shell for a submission from a no-longer-editable question', async () => {
    const { questionRuntime, render } = makeGradableQuestionRuntime();
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { actionsUrl, question, questionUrl, revision } = await createStartedAssessment(baseUrl);
    const finished = await fetch(actionsUrl, {
      body: JSON.stringify({ action: 'finish', revision }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(finished.status).toBe(200);
    const finishedRun = (await finished.json()) as { revision: number };

    const response = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'grade',
        __assessment_preview_revision: String(finishedRun.revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'from a finished tab',
      }),
      headers: { accept: 'text/html' },
      method: 'POST',
    });
    const $ = cheerio.load(await response.text());
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect($('main > .alert-danger').text()).toContain(
      'This preview could not be completed. Open Preview details for diagnostic information.',
    );
    expect(detailsText).toContain('assessment_preview_question_not_editable');
    expect($('main').text()).toContain('Finished');
    expect(render).not.toHaveBeenCalled();

    const apiResponse = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'grade',
        __assessment_preview_revision: String(finishedRun.revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'from an API caller',
      }),
      headers: { accept: 'application/json' },
      method: 'POST',
    });
    expect(apiResponse.status).toBe(409);
    expect(await apiResponse.json()).toMatchObject({
      error: { code: 'assessment_preview_question_not_editable' },
    });
  });

  it('returns a browser shell when simulated access rejects a start form', async () => {
    const accessDeniedAssessment = AssessmentJsonSchema.parse({
      ...validAssessment,
      accessControl: [
        {
          beforeRelease: { listed: true },
          dateControl: { release: { date: '2027-01-01T00:00:00' } },
        },
      ],
    });
    const courseSource = makeCourseSource(true);
    courseSource.readAssessmentInfo = vi.fn(async () => accessDeniedAssessment);
    const baseUrl = await startServer({ courseSource });
    const created = await fetch(`${baseUrl}/assessment-preview-runs`, {
      body: JSON.stringify({
        facts: { now: '2026-08-30T00:00:00.000Z' },
        locator: { aid: 'homework', ciid: '2026/fall' },
        reuse: true,
        seed: 'access-denied-form',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const { assessmentPreviewRunId } = (await created.json()) as {
      assessmentPreviewRunId: string;
    };
    const actionsUrl = `${baseUrl}/assessment-preview-runs/${assessmentPreviewRunId}/actions`;

    const response = await fetch(actionsUrl, {
      body: new URLSearchParams({ action: 'start', revision: '0' }),
      headers: { accept: 'text/html' },
      method: 'POST',
    });
    const $ = cheerio.load(await response.text());
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect($('main').text()).toContain('Simulated access rules deny this assessment.');
    expect(detailsText).toContain('assessment_not_submittable');

    const apiResponse = await fetch(actionsUrl, {
      body: JSON.stringify({ action: 'start', revision: 0 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(apiResponse.status).toBe(403);
    expect(await apiResponse.json()).toMatchObject({
      error: { code: 'assessment_not_submittable' },
    });
  });

  it('returns a browser shell for an invalid question form action', async () => {
    const { questionRuntime, render } = makeGradableQuestionRuntime();
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { questionUrl } = await createStartedAssessment(baseUrl);

    const response = await fetch(questionUrl, {
      body: new URLSearchParams({ __action: 'unexpected-action', answer: 'ignored' }),
      headers: { accept: 'text/html' },
      method: 'POST',
    });
    const $ = cheerio.load(await response.text());
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect($('main > .alert-danger').text()).toContain(
      'This preview could not be completed. Open Preview details for diagnostic information.',
    );
    expect(detailsText).toContain('invalid_submission_action');
    expect(render).not.toHaveBeenCalled();

    const apiResponse = await fetch(questionUrl, {
      body: new URLSearchParams({ __action: 'unexpected-action', answer: 'ignored' }),
      headers: { accept: 'application/json' },
      method: 'POST',
    });
    expect(apiResponse.status).toBe(400);
    expect(await apiResponse.json()).toMatchObject({
      error: { code: 'invalid_submission_action' },
    });
  });

  it('returns a browser shell for invalid or stale assessment action forms', async () => {
    const baseUrl = await startServer({ validCourse: true });
    const { actionsUrl, revision } = await createStartedAssessment(baseUrl);

    for (const request of [
      {
        body: new URLSearchParams({ action: 'unexpected-action', revision: String(revision) }),
        code: 'invalid_action',
        status: 400,
      },
      {
        body: new URLSearchParams({ action: 'finish', revision: String(revision - 1) }),
        code: 'revision_conflict',
        status: 409,
      },
    ]) {
      const response = await fetch(actionsUrl, {
        body: request.body,
        headers: { accept: 'text/html' },
        method: 'POST',
      });
      const $ = cheerio.load(await response.text());
      const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
        .attr('data-bs-target')
        ?.slice(1);
      const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

      expect(response.status).toBe(request.status);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(detailsText).toContain(request.code);
      expect($('main').text()).toContain('In progress');
    }
  });

  it('returns the current browser shell when an assessment action targets an invalidated run', async () => {
    const baseUrl = await startServer({ validCourse: true });
    const { actionsUrl, revision } = await createStartedAssessment(baseUrl);
    sourceWatch.mtimeMs = Date.now() + 1_000;
    emitSourceWatchEvent('infoAssessment.json');

    const response = await fetch(actionsUrl, {
      body: new URLSearchParams({ action: 'finish', revision: String(revision) }),
      headers: { accept: 'text/html' },
      method: 'POST',
    });
    const $ = cheerio.load(await response.text());

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect($('main').text()).toContain('This preview run is out of date.');
    expect($('main').text()).toContain('Create a new assessment preview sample.');

    const apiResponse = await fetch(actionsUrl, {
      body: JSON.stringify({ action: 'finish', revision }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(apiResponse.status).toBe(409);
    expect(await apiResponse.json()).toMatchObject({
      error: { code: 'assessment_preview_run_unavailable' },
    });
  });

  it('keeps an unexpected question-render failure inside the assessment shell', async () => {
    const diagnosticCoursePath = '/private/local/course/questions/local/question/server.py';
    const render = vi.fn(async () => {
      throw new Error(`Question renderer failed in ${diagnosticCoursePath}`);
    });
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { questionUrl } = await createStartedAssessment(baseUrl);

    const response = await fetch(questionUrl, { headers: { accept: 'text/html' } });
    const responseHtml = await response.text();
    const $ = cheerio.load(responseHtml);
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const inlineErrors = $('main > .alert-danger').text().replaceAll(/\s+/g, ' ').trim();
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect($('.assessment-preview-question-shell')).toHaveLength(1);
    expect(inlineErrors).toContain(
      'This preview could not be completed. Open Preview details for diagnostic information.',
    );
    expect(inlineErrors).not.toContain('Question renderer failed');
    expect(detailsText).toContain('question-preview-render');
    expect(detailsText).toContain('Error: Question renderer failed in <course>');
    expect(responseHtml).not.toContain(diagnosticCoursePath);
  });

  it('replays the exact submission snapshot from Save when Finish grades the assessment', async () => {
    const submissionSnapshot: QuestionPreviewSubmissionSnapshot = {
      rawSubmittedAnswer: { normalizedAnswer: 'saved by the question renderer' },
      workspaceGradedFiles: [
        {
          contents: Buffer.from('workspace at save time').toString('base64'),
          name: 'solution.py',
        },
      ],
    };
    const render = vi.fn(async (input: Parameters<QuestionPreviewRuntime['render']>[0]) => ({
      ...(input.submissionMode === 'save'
        ? {
            saveOutcome: { kind: 'saved' as const },
            submissionSnapshot,
          }
        : { answerCheck: { kind: 'graded' as const, score: 1 } }),
      diagnostics: [],
      documentHtml: `<!doctype html>
        <html>
          <head><title>Question</title></head>
          <body>
            <form class="question-form" method="post">
              <input name="answer" />
              <button type="submit" name="__action" value="grade">Save &amp; Grade</button>
            </form>
          </body>
        </html>`,
      ok: true as const,
    }));
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { actionsUrl, question, questionUrl, revision } = await createStartedAssessment(baseUrl);

    const saved = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'save',
        __assessment_preview_revision: String(revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'raw browser field',
      }),
      method: 'POST',
    });
    expect(saved.status).toBe(200);
    const savedForm = cheerio.load(await saved.text())('form.question-form');
    const savedRevision = savedForm
      .find('input[name="__assessment_preview_revision"]')
      .attr('value')!;

    const finished = await fetch(actionsUrl, {
      body: JSON.stringify({ action: 'finish', revision: Number(savedRevision) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(finished.status).toBe(200);
    expect(render).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        submission: { rawSubmittedAnswer: { answer: 'raw browser field' } },
        submissionMode: 'save',
      }),
    );
    expect(render).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        submission: { snapshot: submissionSnapshot },
        submissionMode: 'save',
      }),
    );
    expect(render).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        submission: { snapshot: submissionSnapshot },
        submissionMode: 'grade',
      }),
    );
  });

  it('replays an invalid Save snapshot including workspace collection errors', async () => {
    const submissionSnapshot: QuestionPreviewSubmissionSnapshot = {
      rawSubmittedAnswer: { normalizedAnswer: 'invalid after parsing' },
      workspaceFormatErrors: { _files: ['The saved workspace files could not be collected.'] },
      workspaceGradedFiles: [],
    };
    const render = vi.fn(async (input: Parameters<QuestionPreviewRuntime['render']>[0]) => ({
      diagnostics: [],
      documentHtml: `<!doctype html>
        <html>
          <head><title>Question</title></head>
          <body>
            <form class="question-form" method="post">
              <input name="answer" />
              <button type="submit" name="__action" value="save">Save</button>
            </form>
          </body>
        </html>`,
      ok: true as const,
      saveOutcome: { kind: 'invalid' as const },
      submissionSnapshot: input.submissionMode === 'save' ? submissionSnapshot : undefined,
    }));
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { question, questionUrl, revision } = await createStartedAssessment(baseUrl);

    const saved = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'save',
        __assessment_preview_revision: String(revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'raw browser field',
      }),
      method: 'POST',
    });

    expect(saved.status).toBe(200);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        submission: { snapshot: submissionSnapshot },
        submissionMode: 'save',
      }),
    );
  });

  it('keeps a failed Save result on the POST response instead of redirecting', async () => {
    const render = vi.fn(async () => ({
      diagnostics: [
        {
          fatal: true,
          message: 'The posted answer triggered a submission-specific parse failure.',
          name: 'SaveParseError',
          phase: 'parse' as const,
        },
      ],
      documentHtml: `<!doctype html>
        <html>
          <head><title>Question</title></head>
          <body><p>Question preview failed for the posted answer.</p></body>
        </html>`,
      ok: false as const,
      reason: 'render-failure' as const,
    }));
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { question, questionUrl, revision } = await createStartedAssessment(baseUrl);

    const response = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'save',
        __assessment_preview_revision: String(revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'fatal only when parsed',
      }),
      headers: { accept: 'text/html' },
      method: 'POST',
      redirect: 'manual',
    });
    const $ = cheerio.load(await response.text());
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect($('main > .alert-danger').text()).toContain(
      'This preview could not be completed. Open Preview details for diagnostic information.',
    );
    expect(detailsText).toContain('question-preview-parse');
    expect(detailsText).toContain(
      'SaveParseError: The posted answer triggered a submission-specific parse failure.',
    );
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('rejects an over-limit saved snapshot without mutating the assessment run', async () => {
    const submissionSnapshot: QuestionPreviewSubmissionSnapshot = {
      rawSubmittedAnswer: { normalizedAnswer: 'x'.repeat(1_024) },
      workspaceGradedFiles: [],
    };
    const render = vi.fn(async () => ({
      diagnostics: [],
      documentHtml: `<!doctype html>
        <html>
          <head><title>Question</title></head>
          <body>
            <form class="question-form" method="post">
              <input name="answer" />
              <button type="submit" name="__action" value="save">Save</button>
            </form>
          </body>
        </html>`,
      ok: true as const,
      saveOutcome: { kind: 'saved' as const },
      submissionSnapshot,
    }));
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    const baseUrl = await startServer({
      questionRuntime,
      savedSubmissionsMaxSize: 256,
      validCourse: true,
    });
    const { actionsUrl, question, questionUrl, revision } = await createStartedAssessment(baseUrl);

    const response = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'save',
        __assessment_preview_revision: String(revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'raw browser field',
      }),
      method: 'POST',
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();
    const runStateResponse = await fetch(`${actionsUrl.slice(0, -'/actions'.length)}?format=json`);
    const runState = (await runStateResponse.json()) as {
      questions: [{ status: string }];
      revision: number;
    };

    expect(response.status).toBe(413);
    expect($('main > .alert-danger').text()).toContain(
      'This preview could not be completed. Open Preview details for diagnostic information.',
    );
    expect(detailsText).toContain('assessment-preview-saved-submissions-size-limit');
    expect(detailsText).toContain('was not saved');
    expect(runState).toMatchObject({
      questions: [{ status: 'unanswered' }],
      revision,
    });
  });

  it('applies the saved-snapshot byte limit across all questions in a run', async () => {
    const twoQuestionAssessment = AssessmentJsonSchema.parse({
      ...validAssessment,
      zones: [
        {
          questions: [
            { id: 'local/question', points: 1 },
            { id: 'local/question-two', points: 1 },
          ],
        },
      ],
    });
    const courseSource = makeCourseSource(true);
    courseSource.readAssessmentInfo = vi.fn(async () => twoQuestionAssessment);
    courseSource.readQuestionInfo = vi.fn(async (qid) =>
      qid.decoded === 'local/question'
        ? question
        : QuestionJsonSchema.parse({
            ...question,
            title: 'Second local question',
            uuid: '11111111-1111-4111-8111-111111111304',
          }),
    );
    const submissionSnapshot: QuestionPreviewSubmissionSnapshot = {
      rawSubmittedAnswer: { normalizedAnswer: 'x'.repeat(300) },
      workspaceGradedFiles: [],
    };
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render: vi.fn(async () => ({
        diagnostics: [],
        documentHtml: `<!doctype html>
          <html>
            <head><title>Question</title></head>
            <body>
              <form class="question-form" method="post">
                <input name="answer" />
                <button type="submit" name="__action" value="save">Save</button>
              </form>
            </body>
          </html>`,
        ok: true as const,
        saveOutcome: { kind: 'saved' as const },
        submissionSnapshot,
      })),
    };
    const baseUrl = await startServer({
      courseSource,
      questionRuntime,
      savedSubmissionsMaxSize: 800,
    });
    const { questions, revision, runUrl } = await createStartedAssessment(baseUrl);
    expect(questions).toHaveLength(2);

    const firstSave = await fetch(
      `${runUrl}/questions/${encodeURIComponent(questions[0].slotId)}`,
      {
        body: new URLSearchParams({
          __action: 'save',
          __assessment_preview_revision: String(revision),
          __assessment_preview_variant_number: String(questions[0].variant.number),
          answer: 'first',
        }),
        method: 'POST',
      },
    );
    expect(firstSave.status).toBe(200);
    const firstSaveRevision = Number(
      cheerio
        .load(await firstSave.text())('input[name="__assessment_preview_revision"]')
        .attr('value'),
    );

    const secondSave = await fetch(
      `${runUrl}/questions/${encodeURIComponent(questions[1].slotId)}`,
      {
        body: new URLSearchParams({
          __action: 'save',
          __assessment_preview_revision: String(firstSaveRevision),
          __assessment_preview_variant_number: String(questions[1].variant.number),
          answer: 'second',
        }),
        method: 'POST',
      },
    );
    const runState = (await (await fetch(`${runUrl}?format=json`)).json()) as {
      questions: { status: string }[];
      revision: number;
    };

    expect(secondSave.status).toBe(413);
    expect(runState).toMatchObject({
      questions: [{ status: 'saved' }, { status: 'unanswered' }],
      revision: firstSaveRevision,
    });
  });

  it('keeps deferred Finish failures generic inline and exposes sanitized renderer diagnostics in Preview details', async () => {
    const diagnosticCoursePath = '/private/local/course/questions/local/question/server.py';
    const render = vi.fn(async (input: Parameters<QuestionPreviewRuntime['render']>[0]) => {
      if (input.submissionMode === 'save') {
        return {
          diagnostics: [],
          documentHtml: `<!doctype html>
            <html>
              <head><title>Question</title></head>
              <body>
                <form class="question-form" method="post">
                  <input name="answer" />
                  <button type="submit" name="__action" value="grade">Save &amp; Grade</button>
                </form>
              </body>
            </html>`,
          ok: true as const,
          saveOutcome: { kind: 'saved' as const },
        };
      }
      return {
        diagnostics: [
          {
            data: diagnosticCoursePath,
            fatal: true,
            message: `Could not grade ${diagnosticCoursePath}`,
            name: 'QuestionRuntimeError',
            phase: 'grade' as const,
          },
        ],
        documentHtml: '<!doctype html><html><body>Question preview failed</body></html>',
        ok: false as const,
        reason: 'render-failure' as const,
      };
    });
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { actionsUrl, question, questionUrl, revision } = await createStartedAssessment(baseUrl);

    const saved = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'save',
        __assessment_preview_revision: String(revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'pending answer',
      }),
      method: 'POST',
    });
    expect(saved.status).toBe(200);

    const failedFinish = await fetch(actionsUrl, {
      body: JSON.stringify({ action: 'finish', revision: revision + 1 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const failedHtml = await failedFinish.text();
    const $ = cheerio.load(failedHtml);
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const inlineErrors = $('main > .alert-danger').text().replaceAll(/\s+/g, ' ').trim();
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

    expect(failedFinish.status).toBe(422);
    expect(inlineErrors).toContain(
      'This preview could not be completed. Open Preview details for diagnostic information.',
    );
    expect(inlineErrors).not.toContain('QuestionRuntimeError');
    expect(inlineErrors).not.toContain(diagnosticCoursePath);
    expect(detailsText).toContain('question-preview-grade');
    expect(detailsText).toContain('QuestionRuntimeError: Could not grade <course>');
    expect(detailsText).toContain('questions/local/question');
    expect(detailsText).toContain('<course>/questions/local/question/server.py');
    expect(detailsText).not.toContain(diagnosticCoursePath);
  });

  it('keeps an unexpected deferred Finish exception inside sanitized Preview details', async () => {
    const diagnosticCoursePath = '/private/local/course/questions/local/question/server.py';
    const render = vi.fn(async (input: Parameters<QuestionPreviewRuntime['render']>[0]) => {
      if (input.submissionMode === 'grade') {
        throw new Error(`Deferred grading failed in ${diagnosticCoursePath}`);
      }
      return {
        diagnostics: [],
        documentHtml: `<!doctype html>
          <html>
            <head><title>Question</title></head>
            <body>
              <form class="question-form" method="post">
                <input name="answer" />
                <button type="submit" name="__action" value="grade">Save &amp; Grade</button>
              </form>
            </body>
          </html>`,
        ok: true as const,
        saveOutcome: { kind: 'saved' as const },
      };
    });
    const questionRuntime: QuestionPreviewRuntime = {
      close: vi.fn(async () => {}),
      render,
    };
    const baseUrl = await startServer({ questionRuntime, validCourse: true });
    const { actionsUrl, question, questionUrl, revision } = await createStartedAssessment(baseUrl);
    const saved = await fetch(questionUrl, {
      body: new URLSearchParams({
        __action: 'save',
        __assessment_preview_revision: String(revision),
        __assessment_preview_variant_number: String(question.variant.number),
        answer: 'pending answer',
      }),
      method: 'POST',
    });
    expect(saved.status).toBe(200);

    const failedFinish = await fetch(actionsUrl, {
      body: JSON.stringify({ action: 'finish', revision: revision + 1 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const failedHtml = await failedFinish.text();
    const $ = cheerio.load(failedHtml);
    const detailsTarget = $('button[data-bs-toggle="modal"][aria-label^="Preview details"]')
      .attr('data-bs-target')
      ?.slice(1);
    const inlineErrors = $('main > .alert-danger').text().replaceAll(/\s+/g, ' ').trim();
    const detailsText = detailsTarget == null ? '' : $(`#${detailsTarget}`).text();

    expect(failedFinish.status).toBe(422);
    expect(inlineErrors).not.toContain('Deferred grading failed');
    expect(detailsText).toContain('question-preview-grade');
    expect(detailsText).toContain('Error: Deferred grading failed in <course>');
    expect(failedHtml).not.toContain(diagnosticCoursePath);
  });

  it('keeps invalid plans inspectable but rejects run creation with sanitized diagnostics', async () => {
    const baseUrl = await startServer();

    const inspection = await fetch(`${baseUrl}/assessments?ciid=2026%2Ffall&aid=homework`);
    const inspectionText = await inspection.text();
    expect(inspection.status).toBe(200);
    const inspectionBody = JSON.parse(inspectionText) as unknown;
    expect(inspectionBody).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'question-metadata-unavailable',
          message:
            'Question "missing/question" could not be loaded: Cannot read <course>/questions/missing/question/info.json',
          severity: 'error',
        }),
      ]),
    });
    expect(JSON.stringify(inspectionBody)).not.toContain('/private/local/course');

    const response = await fetch(`${baseUrl}/assessment-preview-runs`, {
      body: JSON.stringify({
        locator: { aid: 'homework', ciid: '2026/fall' },
        reuse: true,
        seed: 'invalid',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'question-metadata-unavailable',
          message:
            'Question "missing/question" could not be loaded: Cannot read <course>/questions/missing/question/info.json',
          path: 'zones',
          severity: 'error',
        }),
      ]),
      error: {
        code: 'invalid_assessment_preview_plan',
        message: 'The assessment preview plan contains errors and cannot be sampled.',
      },
    });
    expect(JSON.stringify(body)).not.toContain('/private/local/course');
  });

  it('returns sanitized structured diagnostics when top-level metadata cannot be loaded', async () => {
    const courseSource = makeCourseSource(true);
    courseSource.readAssessmentInfo = vi.fn(async () => {
      throw new Error('Malformed metadata at /private/local/course/infoAssessment.json');
    });
    const baseUrl = await startServer({ courseSource });

    const inspection = await fetch(`${baseUrl}/assessments?ciid=2026%2Ffall&aid=homework`);
    const inspectionBody = await inspection.json();
    expect(inspection.status).toBe(422);
    expect(inspectionBody).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'assessment-metadata-unavailable',
          message: expect.stringContaining('<course>/infoAssessment.json'),
          severity: 'error',
        }),
      ]),
      error: { code: 'invalid_assessment_preview_metadata' },
    });
    expect(JSON.stringify(inspectionBody)).not.toContain('/private/local/course');

    const created = await fetch(`${baseUrl}/assessment-preview-runs`, {
      body: JSON.stringify({
        locator: { aid: 'homework', ciid: '2026/fall' },
        reuse: true,
        seed: 'malformed-metadata',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'assessment-metadata-unavailable' }),
      ]),
      error: { code: 'invalid_assessment_preview_metadata' },
    });
  });

  it('coalesces delayed source events without hiding newer changes or deletions', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const baseUrl = await startServer({ validCourse: true });
      const requestBody = {
        locator: { aid: 'homework', ciid: '2026/fall' },
        reuse: true,
        seed: 'watcher-race',
      };
      const create = () =>
        fetch(`${baseUrl}/assessment-preview-runs`, {
          body: JSON.stringify(requestBody),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });

      expect((await create()).status).toBe(201);
      expect((await fetch(`${baseUrl}/source-changed`, { method: 'POST' })).status).toBe(204);

      now.mockReturnValue(3_000);
      const replacement = await create();
      const replacementBody = (await replacement.json()) as { assessmentPreviewRunId: string };
      sourceWatch.mtimeMs = 2_000;
      emitSourceWatchEvent('infoAssessment.json');

      const replacementStateUrl = `${baseUrl}/assessment-preview-runs/${replacementBody.assessmentPreviewRunId}?format=json`;
      expect(await (await fetch(replacementStateUrl)).json()).toMatchObject({ invalidated: false });

      sourceWatch.mtimeMs = 4_000;
      emitSourceWatchEvent('infoAssessment.json');
      expect(await (await fetch(replacementStateUrl)).json()).toMatchObject({ invalidated: true });

      now.mockReturnValue(5_000);
      const afterDelete = await create();
      const afterDeleteBody = (await afterDelete.json()) as { assessmentPreviewRunId: string };
      sourceWatch.missing = true;
      emitSourceWatchEvent('infoAssessment.json');
      expect(
        await (
          await fetch(
            `${baseUrl}/assessment-preview-runs/${afterDeleteBody.assessmentPreviewRunId}?format=json`,
          )
        ).json(),
      ).toMatchObject({ invalidated: true });
    } finally {
      now.mockRestore();
    }
  });

  it('sanitizes run diagnostics in JSON and HTML representations', async () => {
    const baseUrl = await startServer({ validCourse: true });
    const created = await fetch(`${baseUrl}/assessment-preview-runs`, {
      body: JSON.stringify({
        locator: { aid: 'homework', ciid: '2026/fall' },
        reuse: true,
        seed: 'diagnostic-boundary',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const { assessmentPreviewRunId } = (await created.json()) as {
      assessmentPreviewRunId: string;
    };
    const actionsUrl = `${baseUrl}/assessment-preview-runs/${assessmentPreviewRunId}/actions`;
    expect(
      (
        await fetch(actionsUrl, {
          body: JSON.stringify({ action: 'start', revision: 0 }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).status,
    ).toBe(200);

    const rejectedAction = await fetch(actionsUrl, {
      body: JSON.stringify({
        action: 'cross-lockpoint',
        revision: 1,
        zoneId: '/private/local/course/new-zone',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const rejectedActionBody = await rejectedAction.json();

    expect(rejectedAction.status).toBe(200);
    expect(rejectedActionBody).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'unknown-lockpoint',
          message: 'Zone "<course>/new-zone" is not a lockpoint.',
        }),
      ]),
    });
    expect(JSON.stringify(rejectedActionBody)).not.toContain('/private/local/course');

    const overview = await fetch(`${baseUrl}/assessment-preview-runs/${assessmentPreviewRunId}`);
    const overviewHtml = await overview.text();
    expect(overview.status).toBe(200);
    expect(overviewHtml).toContain('Zone &#34;&lt;course&gt;/new-zone&#34; is not a lockpoint.');
    expect(overviewHtml).not.toContain('/private/local/course');
  });

  it('surfaces and logs a stable warning when source watcher setup fails', async () => {
    const warningMessage =
      'Automatic course source change detection is unavailable. After editing course sources, send an explicit source-change notification and recreate the assessment preview run.';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const baseUrl = await startServer({
        sourceWatcherFactory: () => {
          throw new Error('watch setup failed at /private/local/course');
        },
        validCourse: true,
      });
      const created = await fetch(`${baseUrl}/assessment-preview-runs`, {
        body: JSON.stringify({
          locator: { aid: 'homework', ciid: '2026/fall' },
          reuse: true,
          seed: 'watcher-unavailable',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const { assessmentPreviewRunId } = (await created.json()) as {
        assessmentPreviewRunId: string;
      };
      const runUrl = `${baseUrl}/assessment-preview-runs/${assessmentPreviewRunId}`;

      const runState = await (await fetch(`${runUrl}?format=json`)).json();
      expect(runState).toMatchObject({
        diagnostics: expect.arrayContaining([
          {
            code: 'source-watcher-unavailable',
            message: warningMessage,
            path: 'course-source',
            severity: 'warning',
          },
        ]),
      });
      const overviewHtml = await (await fetch(runUrl)).text();
      expect(overviewHtml).toContain('source-watcher-unavailable');
      expect(overviewHtml).toContain(warningMessage);
      expect(consoleError).toHaveBeenCalledWith(warningMessage);
    } finally {
      consoleError.mockRestore();
    }
  });
});
