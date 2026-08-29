import { assert, describe, it } from 'vitest';

import type { AssessmentPreviewRun } from './assessment-run.js';
import {
  type AssessmentPreviewDocumentView,
  augmentAssessmentPreviewQuestionDocument,
  renderAssessmentPreviewDocument,
} from './document.js';

function makeRun({
  honorCode = null,
  requireHonorCode = false,
  status = 'in_progress',
}: {
  honorCode?: string | null;
  requireHonorCode?: boolean;
  status?: AssessmentPreviewRun['status'];
} = {}): AssessmentPreviewRun {
  return {
    id: 'run-1',
    revision: 7,
    plan: {
      id: 'assessment-1',
      definitionHash: 'definition-hash',
      type: 'Homework',
      title: 'Vectors <and> matrices',
      number: '3',
      assessmentSet: 'Homework',
      assessmentSetAbbreviation: 'HW',
      courseTimezone: 'UTC',
      shuffleQuestions: false,
      requireHonorCode,
      honorCode,
      constantQuestionValue: false,
      configuredMaxPoints: null,
      maxBonusPoints: 0,
      zones: [],
    },
    sample: {
      assessmentId: 'assessment-1',
      definitionHash: 'definition-hash',
      sampleHash: 'sample-hash',
      seed: 'seed',
      selectedSlots: [
        {
          id: 'slot-internal',
          qid: 'vectors/dot-product',
          questionUuid: '00000000-0000-4000-8000-000000000001',
          title: 'Dot product <basics>',
          sourceNumber: 1,
          grading: { kind: 'internal' },
          singleVariant: false,
          points: {
            initialValue: 2,
            maxAutoPoints: 4,
            maxManualPoints: 0,
            maxPoints: 4,
            attemptValues: null,
          },
          triesPerVariant: 1,
          allowRealTimeGrading: true,
          gradeRateMinutes: 0,
          advanceScorePercent: 0,
          preferences: {},
          zoneId: 'zone-1',
          poolId: 'pool-1',
          poolRank: 0,
          displayOrder: 0,
          questionNumber: '1',
        },
        {
          id: 'slot-manual',
          qid: 'proof',
          questionUuid: '00000000-0000-4000-8000-000000000002',
          title: 'Written proof',
          sourceNumber: 2,
          grading: { kind: 'unresolved', method: 'Manual' },
          singleVariant: true,
          points: {
            initialValue: 3,
            maxAutoPoints: 0,
            maxManualPoints: 3,
            maxPoints: 3,
            attemptValues: null,
          },
          triesPerVariant: 1,
          allowRealTimeGrading: true,
          gradeRateMinutes: 0,
          advanceScorePercent: 0,
          preferences: {},
          zoneId: 'zone-1',
          poolId: 'pool-2',
          poolRank: 0,
          displayOrder: 1,
          questionNumber: '2',
        },
      ],
      zones: [
        {
          id: 'zone-1',
          number: 1,
          title: null,
          bestQuestions: null,
          maxPoints: null,
          lockpoint: false,
          selectedSlotIds: ['slot-internal', 'slot-manual'],
          selectedMaxPoints: 7,
        },
      ],
      maxPoints: 7,
      maxBonusPoints: 0,
    },
    status,
    facts: { nowMs: 1_700_000_000_000, creditPercent: 100 },
    startedAtMs: status === 'not_started' ? null : 1_700_000_000_000,
    finishedAtMs: status === 'finished' ? 1_700_000_001_000 : null,
    crossedLockpointIds: [],
    questions: [
      {
        slotId: 'slot-internal',
        accessMode: 'default',
        status: 'incorrect',
        open: true,
        savedAnswer: null,
        autoPoints: 1.5,
        manualPoints: 0,
        currentValue: 2,
        pointsList: null,
        pointsListOriginal: null,
        variantsPointsList: [1.5],
        highestSubmissionScore: 0.75,
        numberAttempts: 1,
        lastGradableAtMs: 1_700_000_000_000,
        variant: { number: 1, numTries: 1, open: false },
      },
      {
        slotId: 'slot-manual',
        accessMode: 'default',
        status: 'unanswered',
        open: true,
        savedAnswer: null,
        autoPoints: 0,
        manualPoints: null,
        currentValue: 3,
        pointsList: null,
        pointsListOriginal: null,
        variantsPointsList: [],
        highestSubmissionScore: 0,
        numberAttempts: 0,
        lastGradableAtMs: null,
        variant: { number: 1, numTries: 0, open: true },
      },
    ],
    score: {
      points: null,
      scorePercent: null,
      subtotalPoints: 1.5,
      subtotalMaxPoints: 4,
      maxPoints: 7,
      maxBonusPoints: 0,
      incomplete: true,
      unresolvedSlotIds: ['slot-manual'],
    },
    diagnostics: [
      {
        code: 'run-warning',
        severity: 'warning',
        message: 'Run warning <unsafe>',
      },
    ],
  };
}

function makeView(
  overrides: Partial<AssessmentPreviewDocumentView> = {},
): AssessmentPreviewDocumentView {
  return {
    run: makeRun(),
    finishGradingAvailable: true,
    assessmentText:
      '<p>Open <a href="<%= clientFilesAssessment %>/formula.pdf">formula sheet</a> and <a href="{{ client_files_course_instance }}/policy.html">policy</a>.</p>',
    runUrl: '/preview/assessment-preview-runs/run-1',
    access: {
      authorized: true,
      submittable: true,
      credit: 100,
      creditDateString: '100% (Local preview default)',
      source: 'preview-default',
      password: null,
      visibility: { showQuestions: true, showScore: true },
    },
    invalidation: { invalidated: false },
    diagnostics: [],
    ...overrides,
  };
}

function makeLockpointRun({ thresholdMet = false }: { thresholdMet?: boolean } = {}) {
  const run = makeRun();
  const [firstSlot, secondSlot] = run.sample.selectedSlots;
  return {
    ...run,
    sample: {
      ...run.sample,
      selectedSlots: [
        { ...firstSlot, advanceScorePercent: 80, zoneId: 'zone-1' },
        { ...secondSlot, zoneId: 'zone-2' },
      ],
      zones: [
        {
          ...run.sample.zones[0],
          id: 'zone-1',
          number: 1,
          selectedSlotIds: [firstSlot.id],
          selectedMaxPoints: firstSlot.points.maxPoints,
        },
        {
          ...run.sample.zones[0],
          id: 'zone-2',
          number: 2,
          title: 'Part two',
          lockpoint: true,
          selectedSlotIds: [secondSlot.id],
          selectedMaxPoints: secondSlot.points.maxPoints,
        },
      ],
    },
    questions: run.questions.map((question) =>
      question.slotId === firstSlot.id
        ? { ...question, highestSubmissionScore: thresholdMet ? 0.8 : 0.75 }
        : { ...question, accessMode: 'blocked_sequence' as const },
    ),
  } satisfies AssessmentPreviewRun;
}

describe('renderAssessmentPreviewDocument', () => {
  it('renders a full overview with run-scoped assessment assets and escaped metadata', () => {
    const documentHtml = renderAssessmentPreviewDocument(
      makeView({
        diagnostics: [
          {
            code: 'compile-error',
            severity: 'error',
            message: 'Compiler says <script>alert(1)</script>',
          },
        ],
      }),
    );

    assert.match(documentHtml, /^<!doctype html>/i);
    assert.include(documentHtml, 'Vectors &lt;and&gt; matrices');
    assert.include(documentHtml, '<p>Open <a href="');
    assert.include(
      documentHtml,
      '/preview/assessment-preview-runs/run-1/clientFilesAssessment/formula.pdf',
    );
    assert.include(
      documentHtml,
      '/preview/assessment-preview-runs/run-1/clientFilesCourseInstance/policy.html',
    );
    assert.include(documentHtml, 'Dot product &lt;basics&gt;');
    assert.match(documentHtml, /1\.5\s*\/\s*4 auto-graded\s+points/);
    assert.include(documentHtml, 'Manual grading unavailable in local preview');
    assert.include(documentHtml, 'Final score is incomplete');
    assert.include(documentHtml, 'Compiler says &lt;script&gt;alert(1)&lt;/script&gt;');
    assert.include(documentHtml, 'Run warning &lt;unsafe&gt;');
    assert.notInclude(documentHtml, '<script>alert(1)</script>');
    assert.notInclude(documentHtml, 'student@example.com');
  });

  it('shows only the controls allowed by run, access, and invalidation state', () => {
    const startHtml = renderAssessmentPreviewDocument(
      makeView({ run: makeRun({ status: 'not_started' }) }),
    );
    assert.match(startHtml, /name="action"\s+value="start"/);
    assert.notMatch(startHtml, /name="action"\s+value="finish"/);

    const invalidatedHtml = renderAssessmentPreviewDocument(
      makeView({
        access: {
          authorized: false,
          submittable: false,
          credit: 0,
          creditDateString: 'None',
          source: 'modern-access-control',
          password: null,
          visibility: { showQuestions: true, showScore: true },
        },
        invalidation: {
          invalidated: true,
          message: 'infoAssessment.json changed; create a new run.',
        },
        run: makeRun({ status: 'not_started' }),
      }),
    );
    assert.include(invalidatedHtml, 'Simulated access rules deny this assessment');
    assert.include(invalidatedHtml, 'infoAssessment.json changed; create a new run.');
    assert.match(invalidatedHtml, /value="start"[^>]*disabled/);

    const readOnlyHtml = renderAssessmentPreviewDocument(
      makeView({
        access: {
          authorized: true,
          submittable: false,
          credit: 0,
          creditDateString: 'None',
          source: 'modern-access-control',
          password: null,
          visibility: { showQuestions: true, showScore: true },
        },
      }),
    );
    const finishButton = readOnlyHtml.match(/<button[^>]*name="action"[^>]*value="finish"[^>]*>/);
    assert.isNotNull(finishButton);
    assert.notInclude(finishButton[0], 'disabled');
  });

  it('keeps Start but replaces Finish when finish grading is unavailable', () => {
    const inProgressHtml = renderAssessmentPreviewDocument(
      makeView({ finishGradingAvailable: false }),
    );
    assert.notMatch(inProgressHtml, /name="action"\s+value="finish"/);
    assert.include(inProgressHtml, 'Finish grading is unavailable in question-only preview.');

    const notStartedHtml = renderAssessmentPreviewDocument(
      makeView({
        finishGradingAvailable: false,
        run: makeRun({ status: 'not_started' }),
      }),
    );
    assert.match(notStartedHtml, /name="action"\s+value="start"/);
  });

  it('requires the configured honor code and assessment password before starting', () => {
    const run = makeRun({
      status: 'not_started',
      requireHonorCode: true,
      honorCode: 'I will work honestly <and independently>.',
    });
    const documentHtml = renderAssessmentPreviewDocument(
      makeView({
        run,
        access: {
          ...makeView().access,
          password: 'expected-secret',
        },
      }),
    );

    assert.include(documentHtml, 'I will work honestly &lt;and independently&gt;.');
    assert.match(documentHtml, /type="checkbox"[^>]*name="honorCodeAccepted"[^>]*required/);
    assert.match(documentHtml, /type="password"[^>]*name="password"[^>]*required/);
    assert.notInclude(documentHtml, 'expected-secret');

    const defaultHonorCodeHtml = renderAssessmentPreviewDocument(
      makeView({
        run: makeRun({ status: 'not_started', requireHonorCode: true }),
      }),
    );
    assert.include(defaultHonorCodeHtml, 'I certify that I am allowed to take this assessment');
  });

  it('identifies external grading as incomplete', () => {
    const run = makeRun();
    const manualSlot = run.sample.selectedSlots[1];
    const externalRun: AssessmentPreviewRun = {
      ...run,
      sample: {
        ...run.sample,
        selectedSlots: [
          run.sample.selectedSlots[0],
          { ...manualSlot, grading: { kind: 'unresolved', method: 'External' } },
        ],
      },
    };

    const documentHtml = renderAssessmentPreviewDocument(makeView({ run: externalRun }));

    assert.include(documentHtml, 'External grading unavailable in local preview');
    assert.include(documentHtml, 'Final score is incomplete');
  });

  it('labels an ungradable question answer as invalid', () => {
    const run = makeRun();
    const invalidRun: AssessmentPreviewRun = {
      ...run,
      questions: run.questions.map((question) =>
        question.slotId === 'slot-internal' ? { ...question, status: 'invalid' } : question,
      ),
    };

    const documentHtml = renderAssessmentPreviewDocument(makeView({ run: invalidRun }));

    assert.include(documentHtml, 'Invalid');
    assert.include(documentHtml, 'text-bg-danger');
  });

  it('renders the next lockpoint action and explains advance-score blocking', () => {
    const blockedHtml = renderAssessmentPreviewDocument(makeView({ run: makeLockpointRun() }));

    assert.include(blockedHtml, 'Next lockpoint');
    assert.match(blockedHtml, /name="revision"\s+value="7"/);
    assert.match(blockedHtml, /name="zoneId"\s+value="zone-2"/);
    assert.match(blockedHtml, /name="action"\s+value="cross-lockpoint"[^>]*disabled/);
    assert.include(blockedHtml, 'Dot product &lt;basics&gt;');
    assert.match(blockedHtml, /80%\s+advance\s+score/);

    const availableHtml = renderAssessmentPreviewDocument(
      makeView({ run: makeLockpointRun({ thresholdMet: true }) }),
    );
    const availableButton = availableHtml.match(
      /<button[^>]*name="action"[^>]*value="cross-lockpoint"[^>]*>/,
    );
    assert.isNotNull(availableButton);
    assert.notInclude(availableButton[0], 'disabled');

    const unavailableHtml = renderAssessmentPreviewDocument(
      makeView({
        invalidation: { invalidated: true },
        run: makeLockpointRun({ thresholdMet: true }),
      }),
    );
    assert.match(unavailableHtml, /name="action"\s+value="cross-lockpoint"[^>]*disabled/);

    const crossedRun = makeLockpointRun({ thresholdMet: true });
    const crossedHtml = renderAssessmentPreviewDocument(
      makeView({ run: { ...crossedRun, crossedLockpointIds: ['zone-2'] } }),
    );
    assert.notMatch(crossedHtml, /name="action"\s+value="cross-lockpoint"/);
  });
});

describe('augmentAssessmentPreviewQuestionDocument', () => {
  it('wraps one rendered question with assessment navigation, status, and controls', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView(),
      questionDocumentHtml:
        '<!doctype html><html><head><title>Question</title></head><body><form class="question-form">Rendered question</form></body></html>',
      slotId: 'slot-internal',
    });

    assert.match(documentHtml, /^<!doctype html>/i);
    assert.include(documentHtml, '<form class="question-form">Rendered question</form>');
    assert.include(documentHtml, 'Question 1 of 2');
    assert.include(documentHtml, 'Dot product &lt;basics&gt;');
    assert.include(documentHtml, 'href="/preview/assessment-preview-runs/run-1"');
    assert.include(
      documentHtml,
      'href="/preview/assessment-preview-runs/run-1/questions/slot-manual"',
    );
    assert.match(documentHtml, /name="action"\s+value="new-variant"/);
    assert.match(documentHtml, /name="action"\s+value="finish"/);
    assert.match(documentHtml, /name="slotId"\s+value="slot-internal"/);
  });

  it('keeps question navigation but replaces Finish when finish grading is unavailable', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ finishGradingAvailable: false }),
      questionDocumentHtml:
        '<!doctype html><html><body><div class="question-body">Rendered question</div></body></html>',
      slotId: 'slot-internal',
    });

    assert.include(documentHtml, 'Assessment overview');
    assert.include(documentHtml, 'Question 1 of 2');
    assert.notMatch(documentHtml, /name="action"\s+value="finish"/);
    assert.include(documentHtml, 'Finish grading is unavailable in question-only preview.');
  });

  it('rejects documents that do not contain a complete body', () => {
    assert.throws(
      () =>
        augmentAssessmentPreviewQuestionDocument({
          ...makeView(),
          questionDocumentHtml: '<div>Question fragment</div>',
          slotId: 'slot-internal',
        }),
      /full HTML document with a body/i,
    );
  });

  it('makes lockpoint review questions read-only and hides sequence-blocked questions', () => {
    const run = makeRun();
    const readOnlyRun: AssessmentPreviewRun = {
      ...run,
      questions: run.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? { ...question, accessMode: 'read_only_lockpoint' }
          : question,
      ),
    };
    const readOnlyHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: readOnlyRun }),
      questionDocumentHtml:
        '<!doctype html><html><body><form class="question-form">Rendered question</form></body></html>',
      slotId: 'slot-internal',
    });
    assert.include(readOnlyHtml, 'Read only after lockpoint');
    assert.include(readOnlyHtml, '<fieldset disabled');
    assert.notMatch(readOnlyHtml, /name="action"\s+value="new-variant"/);

    const blockedRun: AssessmentPreviewRun = {
      ...run,
      questions: run.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? { ...question, accessMode: 'blocked_sequence' }
          : question,
      ),
    };
    const blockedHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: blockedRun }),
      questionDocumentHtml:
        '<!doctype html><html><body><form class="question-form">Secret body</form></body></html>',
      slotId: 'slot-internal',
    });
    assert.include(blockedHtml, 'Blocked by question sequence');
    assert.include(blockedHtml, 'question is unavailable');
    assert.notInclude(blockedHtml, 'Secret body');
  });

  it('makes closed questions and closed current variants read-only', () => {
    const run = makeRun();
    for (const questionState of [
      { open: false, variant: { number: 1, numTries: 0, open: true } },
      { open: true, variant: { number: 1, numTries: 1, open: false } },
    ]) {
      const closedRun: AssessmentPreviewRun = {
        ...run,
        questions: run.questions.map((question) =>
          question.slotId === 'slot-internal' ? { ...question, ...questionState } : question,
        ),
      };
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run: closedRun }),
        questionDocumentHtml:
          '<!doctype html><html><body><form class="question-form">Closed question body</form></body></html>',
        slotId: 'slot-internal',
      });

      assert.include(documentHtml, '<fieldset disabled');
      assert.include(documentHtml, 'Closed question body');
    }
  });
});
