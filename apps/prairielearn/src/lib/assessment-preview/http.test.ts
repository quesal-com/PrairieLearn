import type * as nodeFs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AssessmentJsonSchema,
  CourseInstanceJsonSchema,
  CourseJsonSchema,
  QuestionJsonSchema,
} from '../../schemas/index.js';
import type { LocalPreviewAssessmentCourseSource } from '../question-preview/course-source.js';
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

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function startServer({
    courseSource,
    sourceWatcherFactory,
    validCourse = false,
  }: {
    courseSource?: LocalPreviewAssessmentCourseSource;
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
      runtime,
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
