import { describe, expect, it } from 'vitest';

import { AssessmentJsonSchema } from '../../schemas/index.js';

import { evaluateAssessmentPreviewAccess } from './access.js';

const studentFacts = {
  courseInstanceRole: 'None' as const,
  courseRole: 'None' as const,
  enrollmentId: 'local-preview',
  mode: 'Public' as const,
  now: new Date('2026-08-29T19:00:00.000Z'),
  prairieTestReservations: [],
  studentLabels: [],
  uid: 'student@example.com',
};

function assessmentWithAccessControl(accessControl?: unknown[]) {
  return AssessmentJsonSchema.parse({
    accessControl,
    number: '1',
    set: 'Homework',
    title: 'Access control preview',
    type: 'Homework',
    uuid: '11111111-1111-4111-8111-111111111180',
  });
}

describe('assessment preview access', () => {
  it('uses an author-friendly open rule when modern accessControl is absent', () => {
    const result = evaluateAssessmentPreviewAccess({
      assessment: assessmentWithAccessControl(),
      facts: studentFacts,
      timezone: 'America/Vancouver',
    });

    expect(result).toMatchObject({
      authorization: 'granted',
      authorized: true,
      credit: 100,
      source: 'preview-default',
      submittable: true,
    });
  });

  it('treats an explicitly empty modern policy as no student access while preserving staff override', () => {
    const assessment = assessmentWithAccessControl([]);

    expect(
      evaluateAssessmentPreviewAccess({ assessment, facts: studentFacts, timezone: 'UTC' }),
    ).toMatchObject({
      authorization: 'denied',
      authorized: false,
      diagnostics: [],
      source: 'modern-access-control',
      submittable: false,
    });
    expect(
      evaluateAssessmentPreviewAccess({
        assessment,
        facts: { ...studentFacts, courseRole: 'Previewer' },
        timezone: 'UTC',
      }),
    ).toMatchObject({
      authorization: 'granted',
      authorized: true,
      credit: 100,
      diagnostics: [],
      source: 'modern-access-control',
      submittable: true,
    });
  });

  it('evaluates local assessment dates in the course-instance timezone', () => {
    const assessment = assessmentWithAccessControl([
      {
        beforeRelease: { listed: true },
        dateControl: {
          release: { date: '2026-08-29T12:30:00' },
          due: { date: '2026-08-30T12:30:00' },
        },
      },
    ]);

    const beforeRelease = evaluateAssessmentPreviewAccess({
      assessment,
      facts: studentFacts,
      timezone: 'America/Vancouver',
    });
    const afterRelease = evaluateAssessmentPreviewAccess({
      assessment,
      facts: { ...studentFacts, now: new Date('2026-08-29T20:00:00.000Z') },
      timezone: 'America/Vancouver',
    });

    expect(beforeRelease).toMatchObject({
      authorized: false,
      showBeforeRelease: true,
      submittable: false,
    });
    expect(afterRelease).toMatchObject({ authorized: true, credit: 100, submittable: true });
  });

  it('applies matching student-label overrides and preserves staff override behavior', () => {
    const assessment = assessmentWithAccessControl([
      {
        dateControl: {
          release: { date: '2026-08-01T00:00:00' },
          due: { date: '2026-08-29T11:00:00' },
          afterLastDeadline: { allowSubmissions: false },
        },
      },
      {
        uuid: '11111111-1111-4111-8111-111111111181',
        labels: ['Extended'],
        dateControl: { due: { date: '2026-08-30T11:00:00' } },
      },
    ]);

    expect(
      evaluateAssessmentPreviewAccess({ assessment, facts: studentFacts, timezone: 'UTC' }),
    ).toMatchObject({ authorized: true, credit: 0, submittable: false });
    expect(
      evaluateAssessmentPreviewAccess({
        assessment,
        facts: { ...studentFacts, studentLabels: ['Extended'] },
        timezone: 'UTC',
      }),
    ).toMatchObject({ authorized: true, credit: 100, submittable: true });
    expect(
      evaluateAssessmentPreviewAccess({
        assessment,
        facts: { ...studentFacts, courseRole: 'Previewer' },
        timezone: 'UTC',
      }),
    ).toMatchObject({ authorized: true, credit: 100, submittable: true });
  });

  it('denies malformed rules instead of treating a later unlabeled rule as the default', () => {
    const assessment = assessmentWithAccessControl([
      {
        labels: ['Extended'],
        dateControl: {
          release: { date: '2026-08-01T00:00:00' },
          due: { date: '2026-09-30T00:00:00' },
        },
      },
      {
        uuid: '11111111-1111-4111-8111-111111111182',
        dateControl: {
          release: { date: '2026-08-01T00:00:00' },
          due: { date: '2026-09-30T00:00:00' },
        },
      },
    ]);

    const result = evaluateAssessmentPreviewAccess({
      assessment,
      facts: { ...studentFacts, studentLabels: ['Extended'] },
      timezone: 'UTC',
    });

    expect(result).toMatchObject({
      authorized: false,
      source: 'modern-access-control',
      submittable: false,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'invalid-access-control',
        message: expect.stringContaining('first element of accessControl'),
        severity: 'error',
      }),
    );
  });

  it('reports trailing student-specific rules as unsupported without applying them', () => {
    const assessment = assessmentWithAccessControl([
      {
        dateControl: {
          release: { date: '2026-08-01T00:00:00' },
          due: { date: '2026-08-29T11:00:00' },
          afterLastDeadline: { allowSubmissions: false },
        },
      },
      {
        uuid: '11111111-1111-4111-8111-111111111183',
        dateControl: { due: { date: '2026-09-30T00:00:00' } },
      },
    ]);

    const result = evaluateAssessmentPreviewAccess({
      assessment,
      facts: { ...studentFacts, enrollmentId: 'cannot-be-resolved-from-disk' },
      timezone: 'UTC',
    });

    expect(result).toMatchObject({ authorized: true, credit: 0, submittable: false });
    expect(result.diagnostics).toContainEqual({
      code: 'student-specific-access-control',
      message: expect.stringContaining('cannot be resolved from local course files'),
      path: 'accessControl[1]',
      severity: 'unsupported',
    });
  });

  it('does not use an expired PrairieTest reservation', () => {
    const examUuid = '11111111-1111-4111-8111-111111111184';
    const assessment = assessmentWithAccessControl([
      {
        integrations: { prairieTest: { exams: [{ examUuid }] } },
      },
    ]);

    const result = evaluateAssessmentPreviewAccess({
      assessment,
      facts: {
        ...studentFacts,
        mode: 'Exam',
        prairieTestReservations: [{ accessEnd: new Date('2026-08-29T18:59:59.000Z'), examUuid }],
      },
      timezone: 'UTC',
    });

    expect(result.examAccessEnd).toBeNull();
    expect(result.visibilitySource).not.toBe('prairieTest');
  });

  it('requires a completed instance for PrairieTest review outside a reservation', () => {
    const assessment = assessmentWithAccessControl([
      {
        afterComplete: { questions: { hidden: false } },
        integrations: {
          prairieTest: {
            exams: [{ examUuid: '11111111-1111-4111-8111-111111111186' }],
          },
        },
      },
    ]);

    const result = evaluateAssessmentPreviewAccess({
      assessment,
      facts: studentFacts,
      timezone: 'UTC',
    });

    expect(result).toMatchObject({
      authorization: 'requires-completed-instance',
      authorized: false,
      submittable: false,
      visibility: { showQuestions: false, showScore: false },
    });
  });

  it('keeps a PrairieTest reservation active through its inclusive end instant', () => {
    const examUuid = '11111111-1111-4111-8111-111111111185';
    const assessment = assessmentWithAccessControl([
      {
        integrations: { prairieTest: { exams: [{ examUuid }] } },
      },
    ]);

    const result = evaluateAssessmentPreviewAccess({
      assessment,
      facts: {
        ...studentFacts,
        mode: 'Exam',
        prairieTestReservations: [{ accessEnd: studentFacts.now, examUuid }],
      },
      timezone: 'UTC',
    });

    expect(result).toMatchObject({
      authorized: true,
      examAccessEnd: studentFacts.now,
      visibilitySource: 'prairieTest',
    });
  });
});
