import { describe, expect, it } from 'vitest';

import { AssessmentJsonSchema } from '../../schemas/infoAssessment.js';

import { compileAssessmentPlan } from './assessment-plan.js';
import { createAssessmentPreviewRun, reduceAssessmentPreviewRun } from './assessment-run.js';

describe('createAssessmentPreviewRun', () => {
  it('creates a deterministic neutral run and labels unresolved grading as an incomplete subtotal', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '81af731b-6c99-4125-a7ea-7a99271ddb19',
      type: 'Homework',
      title: 'Mixed homework',
      set: 'Homework',
      number: '4',
      zones: [
        {
          questions: [
            { id: 'internal', points: 2 },
            { id: 'external', points: 3 },
          ],
        },
      ],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        internal: {
          uuid: '33c0160a-7cff-4cf1-9198-1b8a8646df1e',
          title: 'Internal',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
        external: {
          uuid: '876a2d11-07c5-4923-af0f-ddc848eea3e8',
          title: 'External',
          gradingMethod: 'External',
          singleVariant: false,
        },
      },
    });

    const run = createAssessmentPreviewRun(plan, 'student-a', {
      nowMs: 1_000,
      creditPercent: 100,
    });

    expect(run.id).toMatch(/^[0-9a-f]{64}$/);
    expect(run.status).toBe('not_started');
    expect(run.revision).toBe(0);
    expect(run.sample.seed).toBe('student-a');
    expect(run.questions).toHaveLength(2);
    expect(run.questions[0]).toMatchObject({
      slotId: 'zone-1-pool-1-alternative-1',
      status: 'unanswered',
      open: true,
      currentValue: 2,
      autoPoints: 0,
      highestSubmissionScore: 0,
      variant: { number: 1, numTries: 0, open: true },
    });
    expect(run.score).toEqual({
      points: null,
      scorePercent: null,
      subtotalPoints: 0,
      subtotalMaxPoints: 2,
      maxPoints: 5,
      maxBonusPoints: 0,
      incomplete: true,
      unresolvedSlotIds: ['zone-1-pool-2-alternative-1'],
    });
  });
});

describe('reduceAssessmentPreviewRun', () => {
  it('starts a run and saves an opaque answer without mutating the prior states', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '53e198fd-a779-4a40-831f-fe1cc53d2716',
      type: 'Homework',
      title: 'Save answers',
      set: 'Homework',
      number: '5',
      zones: [{ questions: [{ id: 'q1', points: 1 }] }],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        q1: {
          uuid: '02e43c86-d6ab-4ef3-9d78-ef5294df4446',
          title: 'Question',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });
    const initial = createAssessmentPreviewRun(plan, 'save-seed', {
      nowMs: 10_000,
      creditPercent: 100,
    });

    const started = reduceAssessmentPreviewRun(initial, { type: 'start' });
    const saved = reduceAssessmentPreviewRun(started, {
      type: 'save',
      slotId: 'zone-1-pool-1-alternative-1',
      answer: { value: 'x = 2' },
    });

    expect(initial.status).toBe('not_started');
    expect(started).toMatchObject({ status: 'in_progress', startedAtMs: 10_000, revision: 1 });
    expect(started.questions[0].savedAnswer).toBeNull();
    expect(saved.questions[0].savedAnswer).toEqual({ value: 'x = 2' });
    expect(saved.revision).toBe(2);
  });

  it('finishes the single attempt and makes every selected question read-only', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '6',
      set: 'Exam',
      title: 'Finish attempt',
      type: 'Exam',
      uuid: '11111111-1111-4111-8111-111111111197',
      zones: [{ questions: [{ id: 'q1', points: 1 }] }],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'E', timezone: 'UTC' },
      questions: {
        q1: {
          gradingMethod: 'Internal',
          singleVariant: false,
          title: 'Finish me',
          uuid: '11111111-1111-4111-8111-111111111198',
        },
      },
    });
    const started = reduceAssessmentPreviewRun(
      createAssessmentPreviewRun(plan, 'finish', { creditPercent: 100, nowMs: 42 }),
      { type: 'start' },
    );

    const finished = reduceAssessmentPreviewRun(started, { type: 'finish' });

    expect(finished).toMatchObject({ finishedAtMs: 42, revision: 2, status: 'finished' });
    expect(finished.questions[0]).toMatchObject({
      accessMode: 'read_only_finished',
      open: false,
      variant: { open: false },
    });
  });

  it('applies Homework points, tries-per-variant, and grade-rate policy to grade outcomes', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: 'e253a0cc-d6a8-4f25-8b7d-9bf27e9010e0',
      type: 'Homework',
      title: 'Homework points',
      set: 'Homework',
      number: '6',
      zones: [
        {
          questions: [
            {
              id: 'q1',
              autoPoints: 2,
              maxAutoPoints: 4,
              triesPerVariant: 2,
              gradeRateMinutes: 5,
            },
          ],
        },
      ],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        q1: {
          uuid: '6b321f37-9c33-41cb-819b-ab28d2e4a1d6',
          title: 'Question',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });
    const initial = createAssessmentPreviewRun(plan, 'homework-grade', {
      nowMs: 0,
      creditPercent: 100,
    });
    const started = reduceAssessmentPreviewRun(initial, { type: 'start' });

    const partial = reduceAssessmentPreviewRun(started, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 0.5,
      gradable: true,
    });
    const rateLimited = reduceAssessmentPreviewRun(partial, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
    });
    const advanced = reduceAssessmentPreviewRun(rateLimited, {
      type: 'advance-time',
      nowMs: 300_000,
      creditPercent: 100,
    });
    const correct = reduceAssessmentPreviewRun(advanced, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
    });

    expect(partial.questions[0]).toMatchObject({
      status: 'incorrect',
      autoPoints: 1,
      currentValue: 2,
      highestSubmissionScore: 0.5,
      numberAttempts: 1,
      variant: { number: 1, numTries: 1, open: true },
    });
    expect(partial.score).toMatchObject({ points: 1, scorePercent: 25 });
    expect(rateLimited.questions[0]).toEqual(partial.questions[0]);
    expect(rateLimited.diagnostics.at(-1)).toMatchObject({
      code: 'grade-rate-limited',
      slotId: 'zone-1-pool-1-alternative-1',
    });
    expect(correct.questions[0]).toMatchObject({
      status: 'correct',
      autoPoints: 2,
      currentValue: 4,
      highestSubmissionScore: 1,
      numberAttempts: 2,
      variant: { number: 1, numTries: 2, open: false },
    });
    expect(correct.score).toMatchObject({ points: 2, scorePercent: 50 });
  });

  it('refreshes access credit and recomputes the score when preview time advances', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '8b900679-f4e2-44c0-badc-d986ed64806c',
      type: 'Homework',
      title: 'Changing credit',
      set: 'Homework',
      number: '9',
      zones: [{ questions: [{ id: 'q1', points: 1 }] }],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        q1: {
          uuid: 'be412e5a-03ea-4795-9f7e-98205c483db8',
          title: 'Question',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });
    const started = reduceAssessmentPreviewRun(
      createAssessmentPreviewRun(plan, 'credit', { nowMs: 0, creditPercent: 100 }),
      { type: 'start' },
    );
    const correct = reduceAssessmentPreviewRun(started, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
    });

    const reducedCredit = reduceAssessmentPreviewRun(correct, {
      type: 'advance-time',
      nowMs: 60_000,
      creditPercent: 50,
    });

    expect(correct.score).toMatchObject({ points: 1, scorePercent: 100 });
    expect(reducedCredit.facts).toEqual({ nowMs: 60_000, creditPercent: 50 });
    expect(reducedCredit.score).toMatchObject({ points: 1, scorePercent: 50 });
  });

  it('lets finish grading bypass navigation, open-state, and rate guards', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '87503405-1d90-45ba-af09-c6d977645a17',
      type: 'Homework',
      title: 'Finish grading',
      set: 'Homework',
      number: '10',
      zones: [
        {
          questions: [{ id: 'q1', points: 1, triesPerVariant: 1, gradeRateMinutes: 5 }],
        },
      ],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        q1: {
          uuid: '3438d0e6-acab-4623-b7ce-0bb549bed877',
          title: 'Question',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });
    const started = reduceAssessmentPreviewRun(
      createAssessmentPreviewRun(plan, 'finish-grading', { nowMs: 0, creditPercent: 100 }),
      { type: 'start' },
    );
    const firstAttempt = reduceAssessmentPreviewRun(started, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 0,
      gradable: true,
    });
    const blocked = {
      ...firstAttempt,
      questions: firstAttempt.questions.map((question) => ({
        ...question,
        accessMode: 'blocked_lockpoint' as const,
        open: false,
        variant: { ...question.variant, open: false },
      })),
    };

    const rejectedRealtime = reduceAssessmentPreviewRun(blocked, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
    });
    const finishGraded = reduceAssessmentPreviewRun(blocked, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
      mode: 'finish',
    });

    expect(rejectedRealtime.diagnostics.at(-1)).toMatchObject({
      code: 'question-not-editable',
    });
    expect(rejectedRealtime.questions[0]).toEqual(blocked.questions[0]);
    expect(finishGraded.questions[0]).toMatchObject({
      status: 'complete',
      autoPoints: 1,
      numberAttempts: 2,
    });
    expect(finishGraded.score).toMatchObject({ points: 1, scorePercent: 100 });
  });

  it('lets finish grading bypass a grade-rate interval that still limits realtime grading', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '7aa98347-b2cf-45f4-b683-0b5ddf454ab6',
      type: 'Homework',
      title: 'Finish grading rate',
      set: 'Homework',
      number: '11',
      zones: [{ questions: [{ id: 'q1', points: 1, gradeRateMinutes: 5, triesPerVariant: 2 }] }],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        q1: {
          uuid: '5dab84d5-26ba-4c5a-a449-daa7fb23a3f7',
          title: 'Question',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });
    const started = reduceAssessmentPreviewRun(
      createAssessmentPreviewRun(plan, 'finish-grade-rate', { nowMs: 0, creditPercent: 100 }),
      { type: 'start' },
    );
    const firstAttempt = reduceAssessmentPreviewRun(started, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 0,
      gradable: true,
    });

    const rateLimited = reduceAssessmentPreviewRun(firstAttempt, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
    });
    const finishGraded = reduceAssessmentPreviewRun(firstAttempt, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
      mode: 'finish',
    });

    expect(rateLimited.diagnostics.at(-1)).toMatchObject({ code: 'grade-rate-limited' });
    expect(finishGraded.questions[0]).toMatchObject({ status: 'complete', autoPoints: 1 });
  });

  it('marks an ungradable answer invalid without consuming an attempt', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '8fbcd8f5-e71d-4a6c-94b0-a0c35522c0ca',
      type: 'Homework',
      title: 'Invalid answer',
      set: 'Homework',
      number: '12',
      zones: [{ questions: [{ id: 'q1', points: 1 }] }],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        q1: {
          uuid: '3f6be284-49d0-40bd-ac10-6c097745a2c7',
          title: 'Question',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });
    const started = reduceAssessmentPreviewRun(
      createAssessmentPreviewRun(plan, 'invalid', { nowMs: 0, creditPercent: 100 }),
      { type: 'start' },
    );

    const invalid = reduceAssessmentPreviewRun(started, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 0,
      gradable: false,
      answer: { value: 'not parseable' },
    });

    expect(invalid.questions[0]).toMatchObject({
      status: 'invalid',
      savedAnswer: { value: 'not parseable' },
      numberAttempts: 0,
      lastGradableAtMs: null,
      variant: { numTries: 0, open: true },
    });
    expect(invalid.score).toEqual(started.score);
  });

  it('applies an Exam attempt-value list to incremental score improvements', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: 'b9232973-0829-420c-916a-f3e01a54a6b1',
      type: 'Exam',
      title: 'Exam points',
      set: 'Exam',
      number: '2',
      zones: [{ questions: [{ id: 'q1', points: [5, 3, 1] }] }],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'E' },
      questions: {
        q1: {
          uuid: '39dd1194-851f-4d10-9425-27572e5afaf6',
          title: 'Exam question',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });
    const initial = createAssessmentPreviewRun(plan, 'exam-grade', {
      nowMs: 0,
      creditPercent: 100,
    });
    const started = reduceAssessmentPreviewRun(initial, { type: 'start' });
    const partial = reduceAssessmentPreviewRun(started, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 0.5,
      gradable: true,
    });
    const correct = reduceAssessmentPreviewRun(partial, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 1,
      gradable: true,
    });

    expect(partial.questions[0]).toMatchObject({
      status: 'incorrect',
      open: true,
      autoPoints: 2.5,
      pointsList: [1.5, 0.5],
      highestSubmissionScore: 0.5,
      numberAttempts: 1,
    });
    expect(correct.questions[0]).toMatchObject({
      status: 'complete',
      open: false,
      autoPoints: 4,
      pointsList: [],
      highestSubmissionScore: 1,
      numberAttempts: 2,
    });
    expect(correct.score).toMatchObject({ points: 4, scorePercent: 80 });
  });

  it('scores only the best questions in a zone and applies the zone point cap', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '84d7229a-64f7-452b-917b-57b7a77cb4c1',
      type: 'Homework',
      title: 'Best questions',
      set: 'Homework',
      number: '7',
      maxPoints: 7,
      maxBonusPoints: 1,
      zones: [
        {
          bestQuestions: 2,
          maxPoints: 6,
          questions: [
            { id: 'q1', points: 5 },
            { id: 'q2', points: 4 },
            { id: 'q3', points: 3 },
          ],
        },
        { questions: [{ id: 'q4', points: 2 }] },
      ],
    });
    const questions = Object.fromEntries(
      ['q1', 'q2', 'q3', 'q4'].map((qid) => [
        qid,
        {
          uuid: `10000000-0000-4000-8000-0000000000${qid.slice(1).padStart(2, '0')}`,
          title: qid,
          gradingMethod: 'Internal' as const,
          singleVariant: false,
        },
      ]),
    );
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions,
    });
    let run = reduceAssessmentPreviewRun(
      createAssessmentPreviewRun(plan, 'best-zone', { nowMs: 0, creditPercent: 100 }),
      { type: 'start' },
    );
    for (const [slotId, score] of [
      ['zone-1-pool-1-alternative-1', 0.2],
      ['zone-1-pool-2-alternative-1', 0.5],
      ['zone-1-pool-3-alternative-1', 1 / 6],
      ['zone-2-pool-1-alternative-1', 1],
    ] as const) {
      run = reduceAssessmentPreviewRun(run, { type: 'grade', slotId, score, gradable: true });
    }

    expect(run.score).toEqual({
      points: 5,
      scorePercent: 500 / 7,
      subtotalPoints: 5,
      subtotalMaxPoints: 8,
      maxPoints: 7,
      maxBonusPoints: 1,
      incomplete: false,
      unresolvedSlotIds: [],
    });
  });

  it('enforces advance thresholds and explicit lockpoint crossing in display order', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '1f33397b-f21b-44a0-adbc-38197bb69b90',
      type: 'Exam',
      title: 'Sequenced exam',
      set: 'Exam',
      number: '3',
      shuffleQuestions: false,
      zones: [
        { questions: [{ id: 'q1', points: [1, 1], advanceScorePerc: 50 }] },
        { lockpoint: true, questions: [{ id: 'q2', points: 1 }] },
        { questions: [{ id: 'q3', points: 1 }] },
      ],
    });
    const questions = Object.fromEntries(
      ['q1', 'q2', 'q3'].map((qid) => [
        qid,
        {
          uuid: `20000000-0000-4000-8000-0000000000${qid.slice(1).padStart(2, '0')}`,
          title: qid,
          gradingMethod: 'Internal' as const,
          singleVariant: false,
        },
      ]),
    );
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'E' },
      questions,
    });
    const initial = createAssessmentPreviewRun(plan, 'locks', {
      nowMs: 0,
      creditPercent: 100,
    });
    const started = reduceAssessmentPreviewRun(initial, { type: 'start' });
    const rejected = reduceAssessmentPreviewRun(started, {
      type: 'cross-lockpoint',
      zoneId: 'zone-2',
    });
    const thresholdMet = reduceAssessmentPreviewRun(rejected, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 0.5,
      gradable: true,
    });
    const crossed = reduceAssessmentPreviewRun(thresholdMet, {
      type: 'cross-lockpoint',
      zoneId: 'zone-2',
    });

    expect(initial.questions.map((question) => question.accessMode)).toEqual([
      'default',
      'blocked_sequence',
      'blocked_sequence',
    ]);
    expect(rejected.diagnostics.at(-1)).toMatchObject({ code: 'lockpoint-sequence-blocked' });
    expect(thresholdMet.questions.map((question) => question.accessMode)).toEqual([
      'default',
      'blocked_lockpoint',
      'blocked_lockpoint',
    ]);
    expect(crossed.crossedLockpointIds).toEqual(['zone-2']);
    expect(crossed.questions.map((question) => question.accessMode)).toEqual([
      'read_only_lockpoint',
      'default',
      'default',
    ]);
  });

  it('creates a new Homework variant only after closure and never for single-variant questions', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '79ca5819-c607-41a0-af28-1939e4d39945',
      type: 'Homework',
      title: 'Variant policy',
      set: 'Homework',
      number: '8',
      zones: [
        {
          questions: [
            { id: 'retry', points: 1, triesPerVariant: 1 },
            { id: 'fixed', points: 1, triesPerVariant: 1 },
          ],
        },
      ],
    });
    const { plan } = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        retry: {
          uuid: '48c59f5a-33ba-459d-87a5-729fbece03a8',
          title: 'Retry',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
        fixed: {
          uuid: '6a50d574-875b-466d-ab87-683fb5a43b5c',
          title: 'Fixed',
          gradingMethod: 'Internal',
          singleVariant: true,
        },
      },
    });
    let run = reduceAssessmentPreviewRun(
      createAssessmentPreviewRun(plan, 'variants', { nowMs: 0, creditPercent: 100 }),
      { type: 'start' },
    );
    run = reduceAssessmentPreviewRun(run, {
      type: 'new-variant',
      slotId: 'zone-1-pool-1-alternative-1',
    });
    expect(run.diagnostics.at(-1)).toMatchObject({ code: 'variant-still-open' });

    run = reduceAssessmentPreviewRun(run, {
      type: 'grade',
      slotId: 'zone-1-pool-1-alternative-1',
      score: 0,
      gradable: true,
    });
    const readOnlyRun = {
      ...run,
      questions: run.questions.map((question, index) =>
        index === 0 ? { ...question, accessMode: 'read_only_lockpoint' as const } : question,
      ),
    };
    const blockedNewVariant = reduceAssessmentPreviewRun(readOnlyRun, {
      type: 'new-variant',
      slotId: 'zone-1-pool-1-alternative-1',
    });
    expect(blockedNewVariant.questions[0].variant).toEqual({
      number: 1,
      numTries: 1,
      open: false,
    });
    expect(blockedNewVariant.diagnostics.at(-1)).toMatchObject({
      code: 'question-not-editable',
    });

    run = reduceAssessmentPreviewRun(run, {
      type: 'new-variant',
      slotId: 'zone-1-pool-1-alternative-1',
    });
    expect(run.questions[0].variant).toEqual({ number: 2, numTries: 0, open: true });

    run = reduceAssessmentPreviewRun(run, {
      type: 'grade',
      slotId: 'zone-1-pool-2-alternative-1',
      score: 1,
      gradable: true,
    });
    run = reduceAssessmentPreviewRun(run, {
      type: 'new-variant',
      slotId: 'zone-1-pool-2-alternative-1',
    });
    expect(run.questions[1].variant).toEqual({ number: 1, numTries: 1, open: true });
    expect(run.diagnostics.at(-1)).toMatchObject({ code: 'new-variant-unavailable' });
  });
});
