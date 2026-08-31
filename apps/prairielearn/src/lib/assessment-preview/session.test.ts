import { describe, expect, it, vi } from 'vitest';

import {
  AssessmentJsonSchema,
  CourseInstanceJsonSchema,
  CourseJsonSchema,
  QuestionJsonSchema,
} from '../../schemas/index.js';
import type { LocalPreviewAssessmentCourseSource } from '../question-preview/course-source.js';

import type { AssessmentPreviewStudentFacts } from './access.js';
import { parseAssessmentPreviewLocator } from './locator.js';
import {
  AssessmentPreviewSession,
  InvalidAssessmentPreviewPlanError,
  sanitizeAssessmentPreviewDiagnostics,
} from './session.js';

const assessment = AssessmentJsonSchema.parse({
  number: '1',
  set: 'Homework',
  title: 'Session store assessment',
  type: 'Homework',
  uuid: '11111111-1111-4111-8111-111111111201',
  zones: [{ questions: [{ id: 'local/question', points: 2 }] }],
});

const course = CourseJsonSchema.parse({
  assessmentSets: [{ abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' }],
  name: 'TST 101',
  title: 'Session store course',
  topics: [{ color: 'blue1', name: 'Testing' }],
});

const courseInstance = CourseInstanceJsonSchema.parse({
  longName: 'Fall 2026',
  uuid: '11111111-1111-4111-8111-111111111202',
});

const question = QuestionJsonSchema.parse({
  title: 'Local question',
  topic: 'Testing',
  type: 'v3',
  uuid: '11111111-1111-4111-8111-111111111203',
});

function locator(aid = 'homework') {
  const result = parseAssessmentPreviewLocator({ aid, ciid: '2026/fall' });
  if (!result.ok) throw new Error(result.error.message);
  return result.locator;
}

function studentFacts(
  overrides: Partial<AssessmentPreviewStudentFacts> = {},
): Partial<AssessmentPreviewStudentFacts> {
  return {
    now: new Date('2026-08-29T12:00:00.000Z'),
    uid: 'author@example.com',
    ...overrides,
  };
}

function makeCourseSource({
  onRead,
  readAssessmentInfo = vi.fn(async () => assessment),
  readCourseInfo = vi.fn(async () => course),
  readCourseInstanceInfo = vi.fn(async () => courseInstance),
  readQuestionInfo = vi.fn(async () => question),
  sanitizeDiagnosticValue = (value: unknown) => value,
}: {
  onRead?: (kind: 'assessment' | 'course' | 'course-instance' | 'question') => void;
  readAssessmentInfo?: LocalPreviewAssessmentCourseSource['readAssessmentInfo'];
  readCourseInfo?: LocalPreviewAssessmentCourseSource['readCourseInfo'];
  readCourseInstanceInfo?: LocalPreviewAssessmentCourseSource['readCourseInstanceInfo'];
  readQuestionInfo?: LocalPreviewAssessmentCourseSource['readQuestionInfo'];
  sanitizeDiagnosticValue?: LocalPreviewAssessmentCourseSource['sanitizeDiagnosticValue'];
} = {}): LocalPreviewAssessmentCourseSource {
  return {
    courseDir: '/local/course',
    courseMetadata: {
      assessmentSets: [
        { abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
      ],
      name: 'TST 101',
      options: {},
      timezone: 'UTC',
      title: 'Session store course',
    },
    async readAssessmentInfo(locator) {
      onRead?.('assessment');
      return await readAssessmentInfo(locator);
    },
    async readCourseInfo() {
      onRead?.('course');
      return await readCourseInfo();
    },
    readCourseInstanceInfo: vi.fn(async (locator) => {
      onRead?.('course-instance');
      return await readCourseInstanceInfo(locator);
    }),
    async readQuestionInfo(qid) {
      onRead?.('question');
      return await readQuestionInfo(qid);
    },
    readTemplateInfo: vi.fn(async () => question),
    resolveLegacyQuestionFile: vi.fn(async () => {
      throw new Error('not used by assessment preview sessions');
    }),
    resolveResource: vi.fn(async () => null),
    sanitizeDiagnosticValue,
  };
}

describe('AssessmentPreviewSession', () => {
  it('sanitizes structured diagnostic data and routing context', () => {
    const source = makeCourseSource({
      sanitizeDiagnosticValue: (value) =>
        JSON.parse(JSON.stringify(value).replaceAll('/local/course', '<course>')),
    });

    expect(
      sanitizeAssessmentPreviewDiagnostics(source, [
        {
          code: 'question-preview-render',
          data: {
            files: ['/local/course/questions/local/question/server.py'],
          },
          message: 'Render failed in /local/course/questions/local/question/server.py.',
          path: 'questions/local/question at /local/course',
          severity: 'error' as const,
          slotId: 'slot from /local/course',
        },
      ]),
    ).toEqual([
      {
        code: 'question-preview-render',
        data: {
          files: ['<course>/questions/local/question/server.py'],
        },
        message: 'Render failed in <course>/questions/local/question/server.py.',
        path: 'questions/local/question at <course>',
        severity: 'error',
        slotId: 'slot from <course>',
      },
    ]);
  });

  it('owns one opaque, retrievable run and replaces it with a different sample', async () => {
    const session = new AssessmentPreviewSession(makeCourseSource());

    const first = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'first',
    });
    expect(first.reused).toBe(false);
    expect(first.record.assessmentPreviewRunId).toMatch(/^apr_[A-Za-z0-9_-]{22}$/);
    expect(first.record.run).toMatchObject({ status: 'not_started' });
    expect(session.get(first.record.assessmentPreviewRunId)).toBe(first.record);

    const second = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'second',
    });
    expect(second.reused).toBe(false);
    expect(second.record.assessmentPreviewRunId).not.toBe(first.record.assessmentPreviewRunId);
    expect(session.get(first.record.assessmentPreviewRunId)).toBeNull();
    expect(session.get(second.record.assessmentPreviewRunId)).toBe(second.record);
  });

  it('reuses equivalent requests, including concurrent creates, without loading twice', async () => {
    const reads: string[] = [];
    const source = makeCourseSource({ onRead: (kind) => reads.push(kind) });
    const session = new AssessmentPreviewSession(source);
    const input = {
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'stable',
    } as const;

    const [first, second] = await Promise.all([session.create(input), session.create(input)]);

    expect(first.reused).toBe(false);
    expect(second).toEqual({ record: first.record, reused: true });
    expect(reads).toEqual(['assessment', 'course', 'course-instance', 'question']);
  });

  it('does not reuse a run when its simulated student facts change', async () => {
    const session = new AssessmentPreviewSession(makeCourseSource());
    const first = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'stable',
    });

    const changed = await session.create({
      facts: studentFacts({ studentLabels: ['extended-time'] }),
      locator: locator(),
      reuse: true,
      seed: 'stable',
    });

    expect(changed.reused).toBe(false);
    expect(changed.record.assessmentPreviewRunId).not.toBe(first.record.assessmentPreviewRunId);
  });

  it('rejects a blocking sanitized plan diagnostic without replacing the active run', async () => {
    const invalidAssessment = AssessmentJsonSchema.parse({
      ...assessment,
      zones: [{ questions: [{ id: 'missing/question', points: 2 }] }],
    });
    let invalid = false;
    const source = makeCourseSource({
      readAssessmentInfo: vi.fn(async () => (invalid ? invalidAssessment : assessment)),
      readQuestionInfo: vi.fn(async (qid) => {
        if (invalid) {
          throw new Error(`Cannot read /local/course/questions/${qid.decoded}/info.json`);
        }
        return question;
      }),
      sanitizeDiagnosticValue: (value) =>
        typeof value === 'string' ? value.replaceAll('/local/course', '<course>') : value,
    });
    const session = new AssessmentPreviewSession(source);
    const first = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'valid',
    });
    invalid = true;

    const failedCreate = session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'invalid',
    });
    await expect(failedCreate).rejects.toBeInstanceOf(InvalidAssessmentPreviewPlanError);
    await expect(failedCreate).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'question-metadata-unavailable',
          message:
            'Question "missing/question" could not be loaded: Cannot read <course>/questions/missing/question/info.json',
          severity: 'error',
        }),
      ]),
    });
    expect(session.get(first.record.assessmentPreviewRunId)).toBe(first.record);
  });

  it('invalidates the active run and will not dispatch into it or reuse it', async () => {
    const session = new AssessmentPreviewSession(makeCourseSource());
    const input = {
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'stable',
    } as const;
    const created = await session.create(input);

    session.invalidate('infoAssessment.json changed.');

    expect(session.get(created.record.assessmentPreviewRunId)).toMatchObject({
      invalidated: true,
      invalidationMessage: 'infoAssessment.json changed.',
    });
    expect(
      session.dispatch(created.record.assessmentPreviewRunId, {
        answer: { value: 'stale' },
        gradable: true,
        slotId: created.record.run.questions[0].slotId,
        type: 'save',
      }),
    ).toBeNull();

    const recreated = await session.create(input);
    expect(recreated.reused).toBe(false);
    expect(recreated.record.invalidated).toBe(false);
    expect(recreated.record.assessmentPreviewRunId).not.toBe(created.record.assessmentPreviewRunId);
  });

  it('coalesces a delayed watcher event already represented by a replacement load', async () => {
    vi.useFakeTimers();
    try {
      let replacementRead = false;
      let beginRead: () => void = () => {};
      const readStarted = new Promise<void>((resolve) => {
        beginRead = resolve;
      });
      let finishRead: () => void = () => {};
      const mayFinishRead = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      const source = makeCourseSource({
        readAssessmentInfo: vi.fn(async () => {
          if (replacementRead) {
            beginRead();
            await mayFinishRead;
          }
          return assessment;
        }),
      });
      const session = new AssessmentPreviewSession(source);

      vi.setSystemTime('2026-08-29T12:00:01.000Z');
      await session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'original',
      });
      vi.setSystemTime('2026-08-29T12:00:02.000Z');
      session.invalidate('Explicit source change.');

      replacementRead = true;
      vi.setSystemTime('2026-08-29T12:00:03.000Z');
      const replacing = session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'replacement',
      });
      await readStarted;
      session.invalidateFromWatcher(new Date('2026-08-29T12:00:02.000Z').getTime());
      finishRead();

      const replacement = await replacing;
      expect(replacement.record.invalidated).toBe(false);
      expect(session.get(replacement.record.assessmentPreviewRunId)).toBe(replacement.record);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a delayed watcher event already represented by the active run', async () => {
    vi.useFakeTimers();
    try {
      const session = new AssessmentPreviewSession(makeCourseSource());

      vi.setSystemTime('2026-08-29T12:00:01.000Z');
      await session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'original',
      });
      vi.setSystemTime('2026-08-29T12:00:02.000Z');
      session.invalidate('Explicit source change.');
      vi.setSystemTime('2026-08-29T12:00:03.000Z');
      const replacement = await session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'replacement',
      });

      session.invalidateFromWatcher(new Date('2026-08-29T12:00:02.000Z').getTime());

      expect(session.get(replacement.record.assessmentPreviewRunId)).toMatchObject({
        invalidated: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates the active run for a genuinely newer watcher event', async () => {
    vi.useFakeTimers();
    try {
      const session = new AssessmentPreviewSession(makeCourseSource());
      vi.setSystemTime('2026-08-29T12:00:03.000Z');
      const created = await session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'before-new-change',
      });

      session.invalidateFromWatcher(new Date('2026-08-29T12:00:04.000Z').getTime());

      expect(session.get(created.record.assessmentPreviewRunId)).toMatchObject({
        invalidated: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates a loading run when a watcher event is not older than the load', async () => {
    vi.useFakeTimers();
    try {
      let beginRead: () => void = () => {};
      const readStarted = new Promise<void>((resolve) => {
        beginRead = resolve;
      });
      let finishRead: () => void = () => {};
      const mayFinishRead = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      const source = makeCourseSource({
        readAssessmentInfo: vi.fn(async () => {
          beginRead();
          await mayFinishRead;
          return assessment;
        }),
      });
      const session = new AssessmentPreviewSession(source);
      const sourceReadStartedAt = new Date('2026-08-29T12:00:03.000Z');
      vi.setSystemTime(sourceReadStartedAt);

      const creating = session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'changing-during-load',
      });
      await readStarted;
      session.invalidateFromWatcher(sourceReadStartedAt.getTime());
      finishRead();

      const created = await creating;
      expect(created.record.invalidated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates conservatively when a watcher event has no file timestamp', async () => {
    const session = new AssessmentPreviewSession(makeCourseSource());
    const created = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'before-delete',
    });

    session.invalidateFromWatcher(null);

    expect(session.get(created.record.assessmentPreviewRunId)).toMatchObject({
      invalidated: true,
    });
  });

  it('invalidates a run when source changes while its plan is loading', async () => {
    let beginRead: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      beginRead = resolve;
    });
    let finishRead: () => void = () => {};
    const mayFinishRead = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const source = makeCourseSource({
      readAssessmentInfo: vi.fn(async () => {
        beginRead();
        await mayFinishRead;
        return assessment;
      }),
    });
    const session = new AssessmentPreviewSession(source);

    const creating = session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'stable',
    });
    await readStarted;
    session.invalidate('Source changed during loading.');
    finishRead();

    const created = await creating;
    expect(created.record).toMatchObject({
      invalidated: true,
      invalidationMessage: 'Source changed during loading.',
    });
  });

  it('re-evaluates modern access when simulated time advances', async () => {
    const timedAssessment = AssessmentJsonSchema.parse({
      ...assessment,
      accessControl: [
        {
          dateControl: {
            due: { date: '2026-08-30T00:00:00' },
            lateDeadlines: [{ credit: 50, date: '2026-09-05T00:00:00' }],
            release: { date: '2026-08-01T00:00:00' },
          },
        },
      ],
    });
    const session = new AssessmentPreviewSession(
      makeCourseSource({ readAssessmentInfo: vi.fn(async () => timedAssessment) }),
    );
    const created = await session.create({
      facts: studentFacts({ now: new Date('2026-08-29T12:00:00.000Z') }),
      locator: locator(),
      reuse: true,
      seed: 'timed-access',
    });
    expect(created.record.access).toMatchObject({ credit: 100, submittable: true });
    const slotId = created.record.run.questions[0].slotId;
    session.dispatch(created.record.assessmentPreviewRunId, { type: 'start' });
    const graded = session.dispatch(created.record.assessmentPreviewRunId, {
      gradable: true,
      score: 1,
      slotId,
      type: 'grade',
    });
    expect(graded?.run.score.scorePercent).toBe(100);

    const advanced = session.dispatch(created.record.assessmentPreviewRunId, {
      nowMs: new Date('2026-09-01T12:00:00.000Z').getTime(),
      type: 'advance-time',
    });

    expect(advanced).toMatchObject({
      access: { credit: 50, source: 'modern-access-control', submittable: true },
      facts: { now: new Date('2026-09-01T12:00:00.000Z') },
      run: {
        facts: { creditPercent: 50 },
        score: { scorePercent: 50 },
      },
    });

    const afterLateDeadline = session.dispatch(created.record.assessmentPreviewRunId, {
      nowMs: new Date('2026-09-06T12:00:00.000Z').getTime(),
      type: 'advance-time',
    });
    expect(afterLateDeadline).toMatchObject({
      access: { credit: 0, submittable: false },
      run: {
        facts: { creditPercent: 0 },
        score: { scorePercent: 0 },
      },
    });
  });

  it('applies hidden and delayed after-completion visibility when a run finishes', async () => {
    const protectedAssessment = AssessmentJsonSchema.parse({
      ...assessment,
      accessControl: [
        {
          afterComplete: {
            questions: { hidden: true, visibleFromDate: '2026-09-01T00:00:00' },
            score: { hidden: true, visibleFromDate: '2026-09-01T00:00:00' },
          },
          dateControl: {
            due: { date: '2026-08-30T00:00:00' },
            release: { date: '2026-08-01T00:00:00' },
          },
        },
      ],
    });
    const session = new AssessmentPreviewSession(
      makeCourseSource({ readAssessmentInfo: vi.fn(async () => protectedAssessment) }),
    );
    const created = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'after-complete',
    });
    const started = session.dispatch(created.record.assessmentPreviewRunId, { type: 'start' });
    const finished = session.dispatch(created.record.assessmentPreviewRunId, { type: 'finish' });

    expect(started?.access).toMatchObject({
      complete: false,
      submittable: true,
      visibility: { showQuestions: true, showScore: true },
    });
    expect(finished?.access).toMatchObject({
      complete: true,
      password: null,
      submittable: false,
      visibility: { showQuestions: false, showScore: false },
      visibilitySource: 'afterComplete',
    });

    const afterReveal = session.dispatch(created.record.assessmentPreviewRunId, {
      nowMs: new Date('2026-09-02T00:00:00.000Z').getTime(),
      type: 'advance-time',
    });
    expect(afterReveal?.access).toMatchObject({
      complete: true,
      creditDateString: 'None',
      password: null,
      submittable: false,
      timeLimitMin: null,
      visibility: { showQuestions: true, showScore: true },
      visibilitySource: 'afterComplete',
    });
  });

  it('rejects access-control definition errors before sampling', async () => {
    const malformedAssessment = AssessmentJsonSchema.parse({
      ...assessment,
      accessControl: [
        {
          labels: ['Extended'],
          dateControl: { release: { date: '2026-08-01T00:00:00' } },
        },
      ],
    });
    const session = new AssessmentPreviewSession(
      makeCourseSource({ readAssessmentInfo: vi.fn(async () => malformedAssessment) }),
    );

    await expect(
      session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'invalid-access',
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-access-control', severity: 'error' }),
      ]),
      name: 'InvalidAssessmentPreviewPlanError',
    });
  });

  it('rejects access rules that target labels absent from the course instance', async () => {
    const labeledAssessment = AssessmentJsonSchema.parse({
      ...assessment,
      accessControl: [
        {},
        {
          labels: ['Missing label'],
          uuid: '11111111-1111-4111-8111-111111111205',
        },
      ],
    });
    const session = new AssessmentPreviewSession(
      makeCourseSource({
        readAssessmentInfo: vi.fn(async () => labeledAssessment),
        readCourseInstanceInfo: vi.fn(async () =>
          CourseInstanceJsonSchema.parse({
            ...courseInstance,
            studentLabels: [
              {
                color: 'blue1',
                name: 'Known label',
                uuid: '11111111-1111-4111-8111-111111111206',
              },
            ],
          }),
        ),
      }),
    );

    await expect(
      session.create({
        facts: studentFacts(),
        locator: locator(),
        reuse: true,
        seed: 'missing-label',
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-access-control', severity: 'error' }),
      ]),
    });
  });

  it('expires an Exam duration from the simulated start time', async () => {
    const timedExam = AssessmentJsonSchema.parse({
      ...assessment,
      accessControl: [
        {
          afterComplete: {
            questions: { hidden: true },
            score: { hidden: true },
          },
          dateControl: {
            due: { date: '2026-08-30T00:00:00' },
            durationMinutes: 10,
            release: { date: '2026-08-01T00:00:00' },
          },
        },
      ],
      requireHonorCode: false,
      type: 'Exam',
    });
    const session = new AssessmentPreviewSession(
      makeCourseSource({ readAssessmentInfo: vi.fn(async () => timedExam) }),
    );
    const created = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'duration-limit',
    });
    expect(created.record.access.timeLimitMin).toBe(10);
    session.dispatch(created.record.assessmentPreviewRunId, { type: 'start' });

    const expired = session.dispatch(created.record.assessmentPreviewRunId, {
      nowMs: new Date('2026-08-29T12:11:00.000Z').getTime(),
      type: 'advance-time',
    });

    expect(expired).toMatchObject({
      access: {
        complete: true,
        password: null,
        submittable: false,
        timeLimitMin: null,
        visibility: { showQuestions: false, showScore: false },
        visibilitySource: 'afterComplete',
      },
      run: { status: 'in_progress' },
    });
  });

  it('preserves PrairieTest visibility when an Exam-mode run finishes', async () => {
    const examUuid = '11111111-1111-4111-8111-111111111204';
    const prairieTestAssessment = AssessmentJsonSchema.parse({
      ...assessment,
      accessControl: [
        {
          afterComplete: {
            questions: { hidden: true },
            score: { hidden: true },
          },
          integrations: {
            prairieTest: { exams: [{ examUuid }] },
          },
        },
      ],
    });
    const session = new AssessmentPreviewSession(
      makeCourseSource({ readAssessmentInfo: vi.fn(async () => prairieTestAssessment) }),
    );
    const created = await session.create({
      facts: studentFacts({
        mode: 'Exam',
        prairieTestReservations: [{ accessEnd: new Date('2026-08-29T14:00:00.000Z'), examUuid }],
      }),
      locator: locator(),
      reuse: true,
      seed: 'prairie-test',
    });
    expect(created.record.access).toMatchObject({
      submittable: true,
      visibility: { showQuestions: true, showScore: true },
      visibilitySource: 'prairieTest',
    });

    session.dispatch(created.record.assessmentPreviewRunId, { type: 'start' });
    const finished = session.dispatch(created.record.assessmentPreviewRunId, { type: 'finish' });

    expect(finished?.run.status).toBe('finished');
    expect(finished?.access).toMatchObject({
      complete: false,
      submittable: true,
      visibility: { showQuestions: true, showScore: true },
      visibilitySource: 'prairieTest',
    });
  });

  it('authorizes PrairieTest review after the preview run finishes', async () => {
    const prairieTestAssessment = AssessmentJsonSchema.parse({
      ...assessment,
      accessControl: [
        {
          afterComplete: { questions: { hidden: false } },
          integrations: {
            prairieTest: {
              exams: [{ examUuid: '11111111-1111-4111-8111-111111111207' }],
            },
          },
        },
      ],
    });
    const session = new AssessmentPreviewSession(
      makeCourseSource({ readAssessmentInfo: vi.fn(async () => prairieTestAssessment) }),
    );
    const created = await session.create({
      facts: studentFacts(),
      locator: locator(),
      reuse: true,
      seed: 'prairie-test-review',
    });

    expect(created.record.access).toMatchObject({
      authorization: 'requires-completed-instance',
      authorized: false,
      visibility: { showQuestions: false },
    });

    session.dispatch(created.record.assessmentPreviewRunId, { type: 'start' });
    const finished = session.dispatch(created.record.assessmentPreviewRunId, { type: 'finish' });

    expect(finished?.access).toMatchObject({
      authorization: 'requires-completed-instance',
      authorized: true,
      visibility: { showQuestions: true },
      visibilitySource: 'afterComplete',
    });
  });
});
