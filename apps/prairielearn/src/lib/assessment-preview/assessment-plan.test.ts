import { describe, expect, it } from 'vitest';

import { AssessmentJsonSchema } from '../../schemas/infoAssessment.js';

import { compileAssessmentPlan, sampleAssessmentPlan } from './assessment-plan.js';

function internalQuestionMetadata(qids: readonly string[]) {
  return Object.fromEntries(
    qids.map((qid) => [
      qid,
      {
        gradingMethod: 'Internal' as const,
        singleVariant: false,
        title: qid,
        uuid: '11111111-1111-4111-8111-111111111299',
      },
    ]),
  );
}

describe('compileAssessmentPlan', () => {
  it('compiles a validated Homework into a stable normalized plan', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: '40a64db1-7f41-4f2f-9bd1-914994a40a4d',
      type: 'Homework',
      title: 'Functions',
      set: 'Homework',
      number: '1',
      zones: [
        {
          questions: [
            {
              id: 'function-domain',
              points: 2,
              preferences: { difficulty: 'hard' },
            },
          ],
        },
      ],
    });

    const result = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        'function-domain': {
          uuid: '399928e4-56b2-4c21-b16d-1cc0df57a93d',
          title: 'Find the domain',
          gradingMethod: 'Internal',
          singleVariant: false,
          preferencesSchema: {
            difficulty: { type: 'string', default: 'normal', enum: ['normal', 'hard'] },
          },
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.plan.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan).toMatchObject({
      id: '40a64db1-7f41-4f2f-9bd1-914994a40a4d',
      type: 'Homework',
      shuffleQuestions: false,
      requireHonorCode: false,
      assessmentSetAbbreviation: 'HW',
      maxBonusPoints: 0,
    });
    expect(result.plan.zones[0]).toMatchObject({
      id: 'zone-1',
      number: 1,
      lockpoint: false,
    });
    expect(result.plan.zones[0].pools[0].alternatives[0]).toMatchObject({
      id: 'zone-1-pool-1-alternative-1',
      qid: 'function-domain',
      sourceNumber: 1,
      grading: { kind: 'internal' },
      points: {
        initialValue: 2,
        maxAutoPoints: 2,
        maxManualPoints: 0,
        maxPoints: 2,
        attemptValues: null,
      },
      triesPerVariant: 1,
      allowRealTimeGrading: true,
      gradeRateMinutes: 0,
      advanceScorePercent: 0,
      preferences: { difficulty: 'hard' },
    });
  });

  it('normalizes inherited Exam point lists and attempt policies', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: 'a13d8f2b-600e-4c14-a926-530702b2bb92',
      type: 'Exam',
      title: 'Midterm',
      set: 'Exam',
      number: '1',
      gradeRateMinutes: 3,
      advanceScorePerc: 50,
      zones: [
        {
          advanceScorePerc: 60,
          questions: [
            {
              autoPoints: [3, 2, 1],
              manualPoints: 2,
              triesPerVariant: 4,
              alternatives: [
                {
                  id: 'explain-proof',
                  gradeRateMinutes: 7,
                  advanceScorePerc: 80,
                },
              ],
            },
          ],
        },
      ],
    });

    const result = compileAssessmentPlan({
      assessment,
      course: { timezone: 'America/Chicago', assessmentSetAbbreviation: 'E' },
      questions: {
        'explain-proof': {
          uuid: 'e3217802-ff9d-43bd-8636-29396db626e8',
          title: 'Explain the proof',
          gradingMethod: 'Internal',
          singleVariant: false,
        },
      },
    });

    expect(result.plan).toMatchObject({
      shuffleQuestions: true,
      requireHonorCode: true,
    });
    expect(result.plan.zones[0].pools[0].alternatives[0]).toMatchObject({
      points: {
        initialValue: 5,
        maxAutoPoints: 3,
        maxManualPoints: 2,
        maxPoints: 5,
        attemptValues: [5, 4, 3],
      },
      triesPerVariant: 4,
      gradeRateMinutes: 7,
      advanceScorePercent: 80,
    });
  });

  it('resolves question title visibility from assessment type defaults and explicit overrides', () => {
    const compile = (type: 'Homework' | 'Exam', showQuestionTitles?: boolean) => {
      const assessment = AssessmentJsonSchema.parse({
        uuid: '11111111-1111-4111-8111-111111111298',
        type,
        title: `${type} title visibility`,
        set: type,
        number: '1',
        ...(showQuestionTitles === undefined ? {} : { showQuestionTitles }),
        zones: [],
      });

      return compileAssessmentPlan({
        assessment,
        course: {
          timezone: 'UTC',
          assessmentSetAbbreviation: type === 'Homework' ? 'HW' : 'E',
        },
        questions: {},
      }).plan;
    };

    expect({
      defaultHomework: compile('Homework').showQuestionTitles,
      defaultExam: compile('Exam').showQuestionTitles,
      explicitHomework: compile('Homework', false).showQuestionTitles,
      explicitExam: compile('Exam', true).showQuestionTitles,
    }).toEqual({
      defaultHomework: true,
      defaultExam: false,
      explicitHomework: false,
      explicitExam: true,
    });
  });

  it('keeps unsupported source in the plan and reports structured diagnostics', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: 'aeaf3e40-5782-46dc-8dc7-ff0abe5df574',
      type: 'Homework',
      title: 'Mixed grading',
      set: 'Homework',
      number: '2',
      allowAccess: [{}],
      zones: [
        {
          questions: [
            { id: '@shared/calculus/derivative', points: 1 },
            { id: 'external-code', points: 4 },
          ],
        },
      ],
    });

    const result = compileAssessmentPlan({
      assessment,
      course: { timezone: 'UTC', assessmentSetAbbreviation: 'HW' },
      questions: {
        'external-code': {
          uuid: '03375901-40c9-47b6-9896-75a49a655338',
          title: 'External code',
          gradingMethod: 'External',
          singleVariant: false,
        },
      },
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'legacy-access-control',
        severity: 'unsupported',
        path: 'allowAccess',
      }),
      expect.objectContaining({
        code: 'shared-question',
        severity: 'unsupported',
        path: 'zones[0].questions[0]',
        slotId: 'zone-1-pool-1-alternative-1',
      }),
      expect.objectContaining({
        code: 'unresolved-grading-method',
        severity: 'unsupported',
        path: 'zones[0].questions[1]',
        slotId: 'zone-1-pool-2-alternative-1',
      }),
    ]);
    expect(result.plan.zones[0].pools[0].alternatives[0].grading).toEqual({
      kind: 'unresolved',
      method: 'shared',
    });
    expect(result.plan.zones[0].pools[1].alternatives[0].grading).toEqual({
      kind: 'unresolved',
      method: 'External',
    });
  });

  it('keeps shared questions with assessment preferences sampleable without shared metadata', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '8',
      set: 'Homework',
      title: 'Shared preferences',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111198',
      zones: [
        {
          questions: [
            {
              id: '@shared/calculus/derivative',
              points: 2,
              preferences: { difficulty: 'hard' },
            },
          ],
        },
      ],
    });

    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: {},
    });
    const sampled = sampleAssessmentPlan(result.plan, 'shared-preferences');

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'shared-question',
        severity: 'unsupported',
        slotId: 'zone-1-pool-1-alternative-1',
      }),
    ]);
    expect(sampled.sample).not.toBeNull();
    expect(sampled.sample?.selectedSlots[0]).toMatchObject({
      grading: { kind: 'unresolved', method: 'shared' },
      preferences: {},
    });
  });

  it('validates effective assessment question preferences without sync or Postgres', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '9',
      set: 'Homework',
      title: 'Preference validation',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111199',
      zones: [
        {
          questions: [
            { id: 'with-schema', preferences: { difficulty: 'impossible' } },
            { id: 'without-schema', preferences: { surprise: true } },
          ],
        },
      ],
    });

    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: {
        'with-schema': {
          gradingMethod: 'Internal',
          preferencesSchema: {
            difficulty: { default: 'normal', enum: ['normal', 'hard'], type: 'string' },
          },
          singleVariant: false,
          title: 'With schema',
          uuid: '11111111-1111-4111-8111-111111111201',
        },
        'without-schema': {
          gradingMethod: 'Internal',
          singleVariant: false,
          title: 'Without schema',
          uuid: '11111111-1111-4111-8111-111111111202',
        },
      },
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid-question-preferences',
          message: expect.stringContaining('difficulty'),
          slotId: 'zone-1-pool-1-alternative-1',
        }),
        expect.objectContaining({
          code: 'invalid-question-preferences',
          message: expect.stringContaining('does not define a preferences schema'),
          slotId: 'zone-1-pool-2-alternative-1',
        }),
      ]),
    );
  });

  it('rejects preference schemas that production question validation rejects', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '10',
      set: 'Homework',
      title: 'Invalid preference schema',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111209',
      zones: [{ questions: [{ id: 'bad-preferences', points: 1 }] }],
    });

    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: {
        'bad-preferences': {
          gradingMethod: 'Internal',
          preferencesSchema: {
            difficulty: { default: 'normal', enum: ['normal', 2], type: 'string' },
          },
          singleVariant: false,
          title: 'Bad preferences',
          uuid: '11111111-1111-4111-8111-111111111210',
        },
      },
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid-question-preferences',
          message: expect.stringContaining('enum values must be of type "string"'),
          severity: 'error',
          slotId: 'zone-1-pool-1-alternative-1',
        }),
      ]),
    );
    expect(sampleAssessmentPlan(result.plan, 'invalid-preferences')).toMatchObject({
      sample: null,
    });
  });

  it('blocks sampling when Homework semantics would be rejected during production sync', () => {
    const assessment = AssessmentJsonSchema.parse({
      allowRealTimeGrading: false,
      number: '11',
      set: 'Homework',
      title: 'Invalid Homework',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111211',
      zones: [
        {
          lockpoint: true,
          questions: [
            { id: 'duplicate', points: 1 },
            { id: 'duplicate', points: 1 },
            { id: 'missing-points' },
          ],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: {
        duplicate: {
          gradingMethod: 'Internal',
          singleVariant: false,
          title: 'Duplicate',
          uuid: '11111111-1111-4111-8111-111111111212',
        },
        'missing-points': {
          gradingMethod: 'Internal',
          singleVariant: false,
          title: 'Missing points',
          uuid: '11111111-1111-4111-8111-111111111213',
        },
      },
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'homework-real-time-grading-disabled',
          severity: 'error',
        }),
        expect.objectContaining({ code: 'first-zone-lockpoint', severity: 'error' }),
        expect.objectContaining({
          code: 'duplicate-assessment-question',
          severity: 'error',
          slotId: 'zone-1-pool-2-alternative-1',
        }),
        expect.objectContaining({
          code: 'missing-question-points',
          severity: 'error',
          slotId: 'zone-1-pool-3-alternative-1',
        }),
      ]),
    );

    const sampled = sampleAssessmentPlan(result.plan, 'invalid-homework');
    expect(sampled.sample).toBeNull();
    expect(sampled.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'homework-real-time-grading-disabled' }),
        expect.objectContaining({ code: 'first-zone-lockpoint' }),
        expect.objectContaining({ code: 'duplicate-assessment-question' }),
        expect.objectContaining({ code: 'missing-question-points' }),
      ]),
    );
  });

  it('blocks sampling for an increasing Exam point list', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '12',
      set: 'Exam',
      title: 'Invalid Exam',
      type: 'Exam',
      uuid: '11111111-1111-4111-8111-111111111214',
      zones: [{ questions: [{ id: 'increasing', points: [2, 3] }] }],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'E', timezone: 'UTC' },
      questions: {
        increasing: {
          gradingMethod: 'Internal',
          singleVariant: false,
          title: 'Increasing points',
          uuid: '11111111-1111-4111-8111-111111111215',
        },
      },
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'increasing-exam-points',
          severity: 'error',
          slotId: 'zone-1-pool-1-alternative-1',
        }),
      ]),
    );
    expect(sampleAssessmentPlan(result.plan, 'invalid-exam').sample).toBeNull();
  });

  it('rejects ambiguous and empty question blocks and preferences on alternative pools', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '13',
      set: 'Homework',
      title: 'Malformed pools',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111216',
      zones: [
        {
          questions: [
            {
              id: 'ignored-id',
              alternatives: [{ id: 'both', points: 1 }],
            },
            { points: 1 },
            {
              alternatives: [{ id: 'pooled', points: 1 }],
              preferences: { difficulty: 'hard' },
            },
          ],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: internalQuestionMetadata(['both', 'pooled']),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'question-block-both-id-and-alternatives',
          path: 'zones[0].questions[0]',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'question-block-missing-id-or-alternatives',
          path: 'zones[0].questions[1]',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'alternative-pool-preferences',
          path: 'zones[0].questions[2].preferences',
          severity: 'error',
        }),
      ]),
    );
    expect(sampleAssessmentPlan(result.plan, 'malformed-pools').sample).toBeNull();
  });

  it('rejects Exam point policies that production cannot score consistently', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '14',
      set: 'Exam',
      title: 'Invalid Exam point policies',
      type: 'Exam',
      uuid: '11111111-1111-4111-8111-111111111217',
      zones: [
        {
          questions: [
            {
              alternatives: [{ id: 'mixed' }],
              manualPoints: 1,
              points: 3,
            },
            { id: 'exam-max', maxPoints: 4, points: 3 },
            { autoPoints: 3, id: 'exam-max-auto', maxAutoPoints: 4 },
            {
              allowRealTimeGrading: false,
              alternatives: [{ id: 'deferred-list' }],
              points: [3, 2],
            },
          ],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'E', timezone: 'UTC' },
      questions: internalQuestionMetadata(['mixed', 'exam-max', 'exam-max-auto', 'deferred-list']),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'mixed-question-points',
          slotId: 'zone-1-pool-1-alternative-1',
        }),
        expect.objectContaining({
          code: 'exam-question-maximum',
          slotId: 'zone-1-pool-2-alternative-1',
        }),
        expect.objectContaining({
          code: 'exam-question-maximum',
          slotId: 'zone-1-pool-3-alternative-1',
        }),
        expect.objectContaining({
          code: 'point-list-without-real-time-grading',
          slotId: 'zone-1-pool-4-alternative-1',
        }),
      ]),
    );
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(
      4,
    );
    expect(sampleAssessmentPlan(result.plan, 'invalid-exam-points').sample).toBeNull();
  });

  it('rejects Homework-only settings and point policies that production rejects', () => {
    const assessment = AssessmentJsonSchema.parse({
      honorCode: 'I promise.',
      multipleInstance: true,
      number: '15',
      requireHonorCode: true,
      set: 'Homework',
      title: 'Invalid Homework settings',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111218',
      zones: [
        {
          questions: [
            { id: 'points-list', points: [3, 2] },
            { autoPoints: [3, 2], id: 'auto-list' },
            { id: 'mixed-max-auto', maxAutoPoints: 4, points: 3 },
            { autoPoints: 3, id: 'mixed-max-points', maxPoints: 4 },
          ],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: internalQuestionMetadata([
        'points-list',
        'auto-list',
        'mixed-max-auto',
        'mixed-max-points',
      ]),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'homework-multiple-instance', severity: 'error' }),
        expect.objectContaining({ code: 'homework-require-honor-code', severity: 'error' }),
        expect.objectContaining({ code: 'homework-custom-honor-code', severity: 'error' }),
        expect.objectContaining({
          code: 'homework-point-list',
          slotId: 'zone-1-pool-1-alternative-1',
        }),
        expect.objectContaining({
          code: 'homework-point-list',
          slotId: 'zone-1-pool-2-alternative-1',
        }),
        expect.objectContaining({
          code: 'mixed-question-points',
          slotId: 'zone-1-pool-3-alternative-1',
        }),
        expect.objectContaining({
          code: 'mixed-homework-maximum',
          slotId: 'zone-1-pool-4-alternative-1',
        }),
      ]),
    );
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(
      7,
    );
    expect(sampleAssessmentPlan(result.plan, 'invalid-homework-settings').sample).toBeNull();
  });

  it('rejects zero-valued Homework points with a positive retry maximum', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '15b',
      set: 'Homework',
      title: 'Unreachable Homework retry maximums',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111222',
      zones: [
        {
          questions: [
            { id: 'zero-points', maxPoints: 2, points: 0 },
            { autoPoints: 0, id: 'zero-auto-points', maxAutoPoints: 2 },
          ],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: internalQuestionMetadata(['zero-points', 'zero-auto-points']),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'zero-homework-points-with-maximum',
          path: 'zones[0].questions[0].points',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'zero-homework-auto-points-with-maximum',
          path: 'zones[0].questions[1].autoPoints',
          severity: 'error',
        }),
      ]),
    );
    expect(sampleAssessmentPlan(result.plan, 'zero-homework-points').sample).toBeNull();
  });

  it('warns when Homework points start above their retry maximum', () => {
    const assessment = AssessmentJsonSchema.parse({
      number: '15c',
      set: 'Homework',
      title: 'Homework points above retry maximums',
      type: 'Homework',
      uuid: '11111111-1111-4111-8111-111111111223',
      zones: [
        {
          questions: [
            { id: 'high-points', maxPoints: 2, points: 3 },
            { autoPoints: 3, id: 'high-auto-points', maxAutoPoints: 2 },
          ],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'HW', timezone: 'UTC' },
      questions: internalQuestionMetadata(['high-points', 'high-auto-points']),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'homework-points-exceed-maximum',
          path: 'zones[0].questions[0].points',
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'homework-auto-points-exceed-maximum',
          path: 'zones[0].questions[1].autoPoints',
          severity: 'warning',
        }),
      ]),
    );
    expect(sampleAssessmentPlan(result.plan, 'high-homework-points').sample).not.toBeNull();
  });

  it('rejects conflicting access formats, empty lockpoints, and draft questions', () => {
    const assessment = AssessmentJsonSchema.parse({
      accessControl: [{}],
      allowAccess: [{}],
      number: '16',
      set: 'Exam',
      title: 'Invalid structural semantics',
      type: 'Exam',
      uuid: '11111111-1111-4111-8111-111111111219',
      zones: [
        { questions: [{ id: 'ordinary', points: 1 }] },
        {
          lockpoint: true,
          numberChoose: 0,
          questions: [{ id: '__drafts__/draft-one', points: 1 }],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'E', timezone: 'UTC' },
      questions: internalQuestionMetadata(['ordinary', '__drafts__/draft-one']),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'conflicting-access-control',
          path: 'accessControl',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'empty-lockpoint-zone',
          path: 'zones[1].numberChoose',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'draft-assessment-question',
          slotId: 'zone-2-pool-1-alternative-1',
          severity: 'error',
        }),
      ]),
    );
    expect(sampleAssessmentPlan(result.plan, 'invalid-structure').sample).toBeNull();
  });

  it('reports unsupported group and role navigation without inventing a synthetic role', () => {
    const assessment = AssessmentJsonSchema.parse({
      groups: {
        rolePermissions: { canSubmit: ['Editor'], canView: ['Viewer'] },
        roles: [{ name: 'Editor' }, { name: 'Viewer' }],
      },
      number: '17',
      set: 'Exam',
      title: 'Group Exam',
      type: 'Exam',
      uuid: '11111111-1111-4111-8111-111111111220',
      zones: [
        {
          canView: ['Viewer'],
          questions: [{ canSubmit: ['Editor'], id: 'group-question', points: 1 }],
        },
      ],
    });
    const result = compileAssessmentPlan({
      assessment,
      course: { assessmentSetAbbreviation: 'E', timezone: 'UTC' },
      questions: internalQuestionMetadata(['group-question']),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'group-assessment',
          path: 'groups',
          severity: 'unsupported',
        }),
        expect.objectContaining({
          code: 'group-role-navigation',
          path: 'groups.rolePermissions.canView',
          severity: 'unsupported',
        }),
        expect.objectContaining({
          code: 'group-role-navigation',
          path: 'groups.rolePermissions.canSubmit',
          severity: 'unsupported',
        }),
        expect.objectContaining({
          code: 'group-role-navigation',
          path: 'zones[0].canView',
          severity: 'unsupported',
        }),
        expect.objectContaining({
          code: 'group-role-navigation',
          path: 'zones[0].questions[0].canSubmit',
          severity: 'unsupported',
        }),
      ]),
    );
    expect(sampleAssessmentPlan(result.plan, 'group-policy')).toMatchObject({
      diagnostics: [],
      sample: expect.any(Object),
    });
  });
});

describe('sampleAssessmentPlan', () => {
  it('deterministically applies alternative-pool and zone limits while preserving pins', () => {
    const assessment = AssessmentJsonSchema.parse({
      uuid: 'd847d547-f240-456c-bb47-e614086ae74b',
      type: 'Homework',
      title: 'Sampled homework',
      set: 'Homework',
      number: '3',
      shuffleQuestions: true,
      zones: [
        {
          numberChoose: 3,
          questions: [
            {
              numberChoose: 2,
              alternatives: [
                { id: 'q1', points: 1 },
                { id: 'q2', points: 2 },
                { id: 'q3', points: 3 },
              ],
            },
            { id: 'q4', points: 4 },
            { id: 'q5', points: 5 },
          ],
        },
      ],
    });
    const questions = Object.fromEntries(
      ['q1', 'q2', 'q3', 'q4', 'q5'].map((qid) => [
        qid,
        {
          uuid: `00000000-0000-4000-8000-0000000000${qid.slice(1).padStart(2, '0')}`,
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
    const pins = {
      slotIds: [
        'zone-1-pool-1-alternative-2',
        'zone-1-pool-1-alternative-3',
        'zone-1-pool-3-alternative-1',
      ],
    };

    const first = sampleAssessmentPlan(plan, 'seed-a', pins);
    const second = sampleAssessmentPlan(plan, 'seed-a', pins);

    expect(first.diagnostics).toEqual([]);
    expect(first.sample).not.toBeNull();
    expect(first.sample).toEqual(second.sample);
    expect(first.sample!.sampleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sample!.selectedSlots).toHaveLength(3);
    expect(
      first.sample!.selectedSlots.filter((slot) => slot.poolId === 'zone-1-pool-1'),
    ).toHaveLength(2);
    expect(first.sample!.selectedSlots.map((slot) => slot.id)).toEqual(
      expect.arrayContaining(pins.slotIds),
    );
    expect(first.sample!.selectedSlots.map((slot) => slot.displayOrder)).toEqual([1, 2, 3]);
  });
});
