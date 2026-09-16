import * as cheerio from 'cheerio';
import { assert, beforeAll, describe, it } from 'vitest';

import { init as initAssets } from '../assets.js';

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
      showQuestionTitles: true,
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

function makeCleanRun(options: Parameters<typeof makeRun>[0] = {}): AssessmentPreviewRun {
  return { ...makeRun(options), diagnostics: [] };
}

function makeRenderedQuestionDocument(): string {
  return `<!doctype html>
    <html>
      <head><title>Question</title></head>
      <body>
        <div class="card mb-3 question-block" data-testid="rendered-question-card">
          <div class="card-header bg-primary text-white">
            <h1>Original rendered question title</h1>
          </div>
          <div class="card-body">
            <form class="question-form">Rendered question</form>
          </div>
        </div>
      </body>
    </html>`;
}

function makeGradableRenderedQuestionDocument(): string {
  return `<!doctype html>
    <html lang="en">
      <head><title>Question</title></head>
      <body>
        <div class="card mb-3 question-block">
          <div class="card-header bg-primary text-white"><h1>Rendered question</h1></div>
          <form class="question-form">
            <button
              type="submit"
              class="btn btn-primary question-grade disable-on-submit"
              name="__action"
              value="grade"
            >Save &amp; Grade</button>
          </form>
        </div>
      </body>
    </html>`;
}

function makeLegacyGradableRenderedQuestionDocument(): string {
  return `<!doctype html>
    <html lang="en">
      <head><title>Question</title></head>
      <body>
        <div class="card mb-3 question-block">
          <div class="card-header bg-primary text-white"><h1>Rendered question</h1></div>
          <form class="question-form">
            <button
              type="submit"
              class="btn btn-primary question-grade disable-on-submit"
            >Save &amp; Grade</button>
            <input type="hidden" name="postData" class="postData" />
            <input type="hidden" name="__action" class="__action" />
          </form>
        </div>
      </body>
    </html>`;
}

beforeAll(async () => {
  await initAssets();
});

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
  it('renders a clean overview with PrairieLearn assets and assessment structure', () => {
    const documentHtml = renderAssessmentPreviewDocument(makeView({ run: makeCleanRun() }));
    const $ = cheerio.load(documentHtml);

    assert.lengthOf(
      $('head link[href$="/bootstrap/dist/css/bootstrap.min.css"]'),
      1,
      'loads PrairieLearn Bootstrap styles',
    );
    assert.lengthOf(
      $('head script[src$="/bootstrap/dist/js/bootstrap.bundle.min.js"]'),
      1,
      'loads PrairieLearn Bootstrap behavior',
    );
    assert.lengthOf(
      $('head link[href$="/stylesheets/local.css"]'),
      1,
      'loads PrairieLearn application styles',
    );

    const primaryAssessmentCards = $('main').children('.card');
    assert.lengthOf(primaryAssessmentCards, 1, 'renders one primary assessment card');
    const assessmentCard = primaryAssessmentCards.first();
    const primaryHeader = assessmentCard.children('.card-header.bg-primary.text-white');
    assert.lengthOf(primaryHeader, 1);
    assert.include(primaryHeader.text(), 'HW3:');
    assert.include(primaryHeader.text(), 'Vectors <and> matrices');

    assert.include(assessmentCard.text(), 'Total points:');
    assert.include(assessmentCard.text(), 'Available credit:');
    const questionTable = assessmentCard.find(
      'table[aria-label="Questions"][data-testid="assessment-questions"]',
    );
    assert.lengthOf(questionTable, 1);
    assert.include(questionTable.text(), 'Dot product <basics>');
    assert.include(questionTable.text(), 'Written proof');
    assert.deepEqual(
      questionTable
        .find('tbody a')
        .map((_, link) => $(link).text().replaceAll(/\s+/g, ' ').trim())
        .get(),
      ['1. Dot product <basics>', '2. Written proof'],
    );
  });

  it('formats question labels like PrairieLearn for hidden homework titles and visible exam titles', () => {
    const homeworkRun = makeCleanRun();
    const homeworkDocument = renderAssessmentPreviewDocument({
      ...makeView(),
      run: {
        ...homeworkRun,
        plan: { ...homeworkRun.plan, showQuestionTitles: false },
      },
    });
    const $homework = cheerio.load(homeworkDocument);
    assert.deepEqual(
      $homework('table[aria-label="Questions"] tbody a')
        .map((_, link) => $homework(link).text().replaceAll(/\s+/g, ' ').trim())
        .get(),
      ['1', '2'],
    );

    const examRun = makeCleanRun();
    const examDocument = renderAssessmentPreviewDocument({
      ...makeView(),
      run: {
        ...examRun,
        plan: { ...examRun.plan, showQuestionTitles: true, type: 'Exam' },
      },
    });
    const $exam = cheerio.load(examDocument);
    assert.deepEqual(
      $exam('table[aria-label="Questions"] tbody a')
        .map((_, link) => $exam(link).text().replaceAll(/\s+/g, ' ').trim())
        .get(),
      ['Question 1: Dot product <basics>', 'Question 2: Written proof'],
    );
  });

  it('keeps run metadata and nonblocking diagnostics in accessible preview details', () => {
    const run: AssessmentPreviewRun = {
      ...makeCleanRun(),
      diagnostics: [
        {
          code: 'source-watcher-unavailable',
          severity: 'warning',
          message: 'Source watching is unavailable; refresh manually.',
        },
      ],
    };
    const documentHtml = renderAssessmentPreviewDocument(
      makeView({
        run,
        diagnostics: [
          {
            code: 'shared-question-unsupported',
            data: { attempt: 2, detail: '<script>alert("detail")</script>' },
            path: 'questions/proof <unsafe>',
            severity: 'unsupported',
            message: 'A shared question cannot be grade-tested locally.',
            slotId: 'slot-manual',
          },
        ],
      }),
    );
    const $ = cheerio.load(documentHtml);

    const detailsTrigger = $('button[data-bs-toggle="modal"]').filter(
      (_, element) =>
        $(element).attr('aria-label')?.startsWith('Preview details') === true ||
        $(element).text().replaceAll(/\s+/g, ' ').trimStart().startsWith('Preview details'),
    );
    assert.lengthOf(detailsTrigger, 1);
    const accessibleDetailsText = [
      detailsTrigger.attr('aria-label'),
      detailsTrigger.find('.visually-hidden').text(),
    ]
      .filter(Boolean)
      .join(' ');
    assert.equal(accessibleDetailsText, 'Preview details, 1 warning and 1 unsupported issue');
    const diagnosticBadge = detailsTrigger.find('.badge');
    assert.lengthOf(diagnosticBadge, 1);
    assert.include(diagnosticBadge.text(), '2');
    assert.include(diagnosticBadge.attr('class') ?? '', 'text-bg-warning');
    assert.equal(diagnosticBadge.attr('aria-hidden'), 'true');
    const modalTarget = detailsTrigger.attr('data-bs-target');
    assert.match(modalTarget ?? '', /^#[A-Za-z][\w-]*$/);

    const detailsModal = $(modalTarget);
    assert.lengthOf(detailsModal, 1);
    assert.isTrue(detailsModal.hasClass('modal'));
    assert.isTrue(detailsModal.hasClass('fade'));
    assert.equal(detailsModal.attr('role'), 'dialog');
    assert.equal(detailsModal.attr('tabindex'), '-1');
    const modalTitleId = detailsModal.attr('aria-labelledby');
    assert.isNotEmpty(modalTitleId);
    assert.equal(detailsModal.find(`#${modalTitleId}`).text().trim(), 'Local preview details');
    assert.lengthOf(detailsModal.find('button[data-bs-dismiss="modal"]'), 1);

    const normalPage = $('body').clone();
    normalPage.find(modalTarget).remove();
    const normalPageText = normalPage.text();
    assert.notInclude(normalPageText, 'Run run-1');
    assert.notInclude(normalPageText, 'Revision 7');
    assert.notInclude(normalPageText, 'source-watcher-unavailable');
    assert.notInclude(normalPageText, 'Source watching is unavailable; refresh manually.');
    assert.notInclude(normalPageText, 'shared-question-unsupported');
    assert.notInclude(normalPageText, 'A shared question cannot be grade-tested locally.');
    assert.notInclude(normalPageText, 'questions/proof <unsafe>');
    assert.notInclude(normalPageText, '<script>alert("detail")</script>');

    const detailsText = detailsModal.text();
    assert.include(detailsText, 'Run ID');
    assert.include(detailsText, 'run-1');
    assert.match(detailsText, /Revision\s+7/);
    assert.include(detailsText, 'source-watcher-unavailable');
    assert.include(detailsText, 'Source watching is unavailable; refresh manually.');
    assert.include(detailsText, 'shared-question-unsupported');
    assert.include(detailsText, 'A shared question cannot be grade-tested locally.');
    assert.include(detailsText, 'questions/proof <unsafe>');
    assert.include(detailsText, 'slot-manual');
    assert.include(detailsText, '"attempt": 2');
    assert.include(detailsText, '<script>alert(\\"detail\\")</script>');
    assert.lengthOf(detailsModal.find('script'), 0);
    assert.include(detailsModal.html() ?? '', '&lt;script&gt;alert(\\"detail\\")&lt;/script&gt;');
  });

  it('keeps availability failures inline while confining technical errors to Preview details', () => {
    const cleanView = makeView({ run: makeCleanRun() });
    const documentHtml = renderAssessmentPreviewDocument({
      ...cleanView,
      access: {
        ...cleanView.access,
        authorized: false,
        submittable: false,
      },
      invalidation: {
        invalidated: true,
        message: 'infoAssessment.json changed; create a new run.',
      },
      diagnostics: [
        {
          code: 'assessment-definition-invalid',
          data: { field: '<script>definition</script>' },
          path: 'assessments/exam <unsafe>',
          severity: 'error',
          message: 'Compilation failed for the assessment definition.',
          slotId: 'slot-internal',
        },
        {
          code: 'source-watcher-unavailable',
          severity: 'warning',
          message: 'Source watching is unavailable; refresh manually.',
        },
      ],
    });
    const $ = cheerio.load(documentHtml);

    const normalPage = $('main').clone();
    normalPage.find('[role="dialog"]').remove();
    const normalPageText = normalPage.text();
    const inlineAlertText = normalPage.find('[role="alert"]').text();
    assert.include(inlineAlertText, 'Simulated access rules deny this assessment');
    assert.include(inlineAlertText, 'infoAssessment.json changed; create a new run.');
    assert.include(inlineAlertText, 'Preview error');
    assert.include(inlineAlertText, 'Open Preview details');
    assert.notInclude(normalPageText, 'assessment-definition-invalid');
    assert.notInclude(normalPageText, 'Compilation failed for the assessment definition.');
    assert.notInclude(normalPageText, 'assessments/exam <unsafe>');
    assert.notInclude(normalPageText, '<script>definition</script>');
    assert.notInclude(normalPageText, 'source-watcher-unavailable');
    assert.notInclude(normalPageText, 'Source watching is unavailable; refresh manually.');
    const detailsModalText = $('#assessmentPreviewDetailsModal').text();
    assert.include(detailsModalText, 'assessment-definition-invalid');
    assert.include(detailsModalText, 'Compilation failed for the assessment definition.');
    assert.include(detailsModalText, 'assessments/exam <unsafe>');
    assert.include(detailsModalText, '<script>definition</script>');
    assert.equal(
      $('button[data-bs-target="#assessmentPreviewDetailsModal"]').attr('aria-label'),
      'Preview details, 1 error and 1 warning',
    );
  });

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
    assert.include(finishButton[0], 'disabled');
  });

  it('makes overview question links inert when the preview run is out of date', () => {
    const activeHtml = renderAssessmentPreviewDocument(makeView({ run: makeCleanRun() }));
    const $active = cheerio.load(activeHtml);
    assert.lengthOf($active('table[aria-label="Questions"] a[href*="/questions/"]'), 2);

    const invalidatedHtml = renderAssessmentPreviewDocument(
      makeView({
        invalidation: {
          invalidated: true,
          message: 'Assessment sources changed; create a new run.',
        },
        run: makeCleanRun(),
      }),
    );
    const $invalidated = cheerio.load(invalidatedHtml);
    const questionTable = $invalidated('table[aria-label="Questions"]');
    assert.lengthOf(questionTable.find('a[href*="/questions/"]'), 0);
    assert.include(questionTable.text(), 'Dot product <basics>');
    assert.include(questionTable.text(), 'Written proof');
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

  it('labels the Homework-only completion affordance as a local preview action', () => {
    const homeworkHtml = renderAssessmentPreviewDocument(makeView({ run: makeCleanRun() }));
    const $homework = cheerio.load(homeworkHtml);
    assert.equal(
      $homework('button[name="action"][value="finish"]').first().text().trim(),
      'Finish preview',
    );

    const examRun = makeCleanRun();
    const examHtml = renderAssessmentPreviewDocument(
      makeView({ run: { ...examRun, plan: { ...examRun.plan, type: 'Exam' } } }),
    );
    const $exam = cheerio.load(examHtml);
    assert.equal(
      $exam('button[name="action"][value="finish"]').first().text().trim(),
      'Finish assessment',
    );
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

  it('uses PrairieLearn status colors and labels lockpoint-blocked questions as locked', () => {
    for (const [status, expectedClass] of [
      ['unanswered', 'text-bg-warning'],
      ['incorrect', 'text-bg-danger'],
      ['correct', 'text-bg-success'],
    ] as const) {
      const run = makeCleanRun();
      const statusRun: AssessmentPreviewRun = {
        ...run,
        questions: run.questions.map((question) =>
          question.slotId === 'slot-internal' ? { ...question, status } : question,
        ),
      };
      const $ = cheerio.load(renderAssessmentPreviewDocument(makeView({ run: statusRun })));
      const row = $('table[aria-label="Questions"] tbody tr').filter((_, candidate) =>
        $(candidate).text().includes('Dot product'),
      );
      assert.include(row.find('.badge').attr('class') ?? '', expectedClass, status);
    }

    const run = makeLockpointRun({ thresholdMet: true });
    const lockedRun: AssessmentPreviewRun = {
      ...run,
      questions: run.questions.map((question) =>
        question.slotId === 'slot-manual'
          ? { ...question, accessMode: 'blocked_lockpoint', status: 'unanswered' }
          : question,
      ),
    };
    const $locked = cheerio.load(renderAssessmentPreviewDocument(makeView({ run: lockedRun })));
    const lockedRow = $locked('table[aria-label="Questions"] tbody tr').filter((_, candidate) =>
      $locked(candidate).text().includes('Written proof'),
    );
    assert.include(lockedRow.find('.badge').text(), 'Locked');
    assert.notInclude(lockedRow.find('.badge').text(), 'Unanswered');
    assert.isTrue(lockedRow.hasClass('pl-sequence-locked'));
  });

  it('does not disclose earned scores when simulated access hides them', () => {
    const run = makeCleanRun();
    const hiddenScoreRun: AssessmentPreviewRun = {
      ...run,
      questions: run.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? { ...question, autoPoints: 3.25, status: 'correct' }
          : question,
      ),
      score: {
        points: 5.25,
        scorePercent: 75.5,
        subtotalPoints: 4.75,
        subtotalMaxPoints: 6.5,
        maxPoints: 7,
        maxBonusPoints: 0,
        incomplete: false,
        unresolvedSlotIds: [],
      },
    };
    const visibleView = makeView({ run: hiddenScoreRun });
    const hiddenScoreView: AssessmentPreviewDocumentView = {
      ...visibleView,
      access: {
        ...visibleView.access,
        visibility: { showQuestions: true, showScore: false },
      },
    };
    const renderedDocuments = [
      {
        documentHtml: renderAssessmentPreviewDocument(hiddenScoreView),
        page: 'assessment overview',
      },
      {
        documentHtml: augmentAssessmentPreviewQuestionDocument({
          ...hiddenScoreView,
          questionDocumentHtml: makeRenderedQuestionDocument(),
          slotId: 'slot-internal',
        }),
        page: 'question page',
      },
    ];

    for (const { documentHtml, page } of renderedDocuments) {
      const $ = cheerio.load(documentHtml);
      const pageText = $('body').text().replaceAll(/\s+/g, ' ');
      assert.include(pageText, 'The simulated access rules hide the score.', page);
      assert.include(pageText, 'Total points:', page);
      assert.match(pageText, /\bValue\b/, page);
      for (const hiddenValue of ['3.25', '4.75', '5.25', '6.5', '75.5']) {
        assert.notInclude(documentHtml, hiddenValue, `${page} hides ${hiddenValue}`);
      }
    }
  });

  it('confirms an available lockpoint while preserving its action payload', () => {
    const blockedHtml = renderAssessmentPreviewDocument(makeView({ run: makeLockpointRun() }));
    const $blocked = cheerio.load(blockedHtml);

    assert.include(blockedHtml, 'Next lockpoint');
    assert.include(blockedHtml, 'Dot product &lt;basics&gt;');
    assert.match(blockedHtml, /80%\s+advance\s+score/);
    const blockedTrigger = $blocked('button[name="action"][value="cross-lockpoint"]').first();
    assert.isTrue(blockedTrigger.is('[disabled]'));
    assert.isUndefined(blockedTrigger.attr('data-bs-toggle'));
    const blockedReasonId = blockedTrigger.attr('aria-describedby');
    assert.isNotEmpty(blockedReasonId);
    assert.match(
      $blocked(`#${blockedReasonId}`).text().replaceAll(/\s+/g, ' ').trim(),
      /advance-score sequence blocks this lockpoint/i,
    );

    const invalidatedHtml = renderAssessmentPreviewDocument(
      makeView({
        invalidation: { invalidated: true },
        run: makeLockpointRun({ thresholdMet: true }),
      }),
    );
    const $invalidated = cheerio.load(invalidatedHtml);
    const invalidatedTrigger = $invalidated(
      'button[name="action"][value="cross-lockpoint"]',
    ).first();
    assert.isTrue(invalidatedTrigger.is('[disabled]'));
    assert.isUndefined(invalidatedTrigger.attr('data-bs-toggle'));
    const invalidatedReasonId = invalidatedTrigger.attr('aria-describedby');
    assert.isNotEmpty(invalidatedReasonId);
    const invalidatedReason = $invalidated(`#${invalidatedReasonId}`)
      .text()
      .replaceAll(/\s+/g, ' ')
      .trim();
    assert.match(invalidatedReason, /preview run is out of date/i);
    assert.match(invalidatedReason, /create a new run/i);
    assert.notMatch(invalidatedReason, /proceed into/i);

    const documentHtml = renderAssessmentPreviewDocument(
      makeView({ run: makeLockpointRun({ thresholdMet: true }) }),
    );
    const $ = cheerio.load(documentHtml);
    const confirmationModal = $('[role="dialog"]').filter((_, dialog) => {
      const titleId = $(dialog).attr('aria-labelledby');
      return (
        titleId != null &&
        $(dialog).find(`#${titleId}`).text().trim() === 'Proceed to next questions?'
      );
    });
    assert.lengthOf(confirmationModal, 1);
    assert.isTrue(confirmationModal.hasClass('modal'));
    assert.isTrue(confirmationModal.hasClass('fade'));

    const confirmationModalId = confirmationModal.attr('id');
    assert.isNotEmpty(confirmationModalId);
    const confirmationTrigger = $(`button[data-bs-target="#${confirmationModalId}"]`);
    assert.lengthOf(confirmationTrigger, 1);
    assert.equal(confirmationTrigger.attr('type'), 'button');
    assert.equal(confirmationTrigger.attr('data-bs-toggle'), 'modal');
    assert.isUndefined(confirmationTrigger.attr('disabled'));

    const acknowledgement = confirmationModal.find('input[type="checkbox"]');
    assert.lengthOf(acknowledgement, 1);
    const acknowledgementId = acknowledgement.attr('id');
    assert.isNotEmpty(acknowledgementId);
    const acknowledgementLabel = confirmationModal.find(`label[for="${acknowledgementId}"]`);
    assert.lengthOf(acknowledgementLabel, 1);
    assert.match(
      acknowledgementLabel.text().replaceAll(/\s+/g, ' ').trim(),
      /I understand that I will not be able to submit answers to previous questions/i,
    );

    const confirmAction = confirmationModal.find(
      'button[type="submit"][name="action"][value="cross-lockpoint"]',
    );
    assert.lengthOf(confirmAction, 1);
    assert.isTrue(confirmAction.is('[disabled]'));
    const confirmationForm =
      confirmationModal.closest('form').length > 0
        ? confirmationModal.closest('form')
        : confirmationModal.find('form').first();
    assert.lengthOf(confirmationForm, 1);
    assert.equal(confirmationForm.attr('method')?.toLowerCase(), 'post');
    assert.equal(confirmationForm.attr('action'), '/preview/assessment-preview-runs/run-1/actions');
    assert.lengthOf(confirmationForm.find('input[name="revision"][value="7"]'), 1);
    assert.lengthOf(confirmationForm.find('input[name="zoneId"][value="zone-2"]'), 1);
    assert.lengthOf(confirmationForm.find('[name="action"][value="cross-lockpoint"]'), 1);

    const crossedRun = makeLockpointRun({ thresholdMet: true });
    const crossedHtml = renderAssessmentPreviewDocument(
      makeView({ run: { ...crossedRun, crossedLockpointIds: ['zone-2'] } }),
    );
    assert.notMatch(crossedHtml, /name="action"\s+value="cross-lockpoint"/);
  });
});

describe('augmentAssessmentPreviewQuestionDocument', () => {
  it('normalizes an assetless question failure document into a functional preview shell', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: makeCleanRun() }),
      questionDocumentHtml: `<!doctype html>
        <html>
          <head><title>Question Preview Error</title></head>
          <body>
            <main>
              <h1>Question preview failed</h1>
              <p>Check the preview server console for details.</p>
            </main>
          </body>
        </html>`,
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    assert.equal($('html').attr('lang'), 'en');
    assert.lengthOf($('head link[href$="/bootstrap/dist/css/bootstrap.min.css"]'), 1);
    assert.lengthOf($('head script[src$="/bootstrap/dist/js/bootstrap.bundle.min.js"]'), 1);
    assert.lengthOf($('body main'), 1, 'does not nest the failure document main landmark');
    assert.equal($('body main h1').text().trim(), 'Question preview failed');
    assert.include($('body main').text(), 'Check the preview server console for details.');

    const detailsTrigger = $('button[data-bs-toggle="modal"][aria-label="Preview details"]');
    assert.lengthOf(detailsTrigger, 1);
    const modalTarget = detailsTrigger.attr('data-bs-target');
    assert.match(modalTarget ?? '', /^#[A-Za-z][\w-]*$/);
    const detailsModal = $(modalTarget);
    assert.lengthOf(detailsModal, 1);
    assert.isTrue(detailsModal.hasClass('modal'));
    assert.isTrue(detailsModal.hasClass('fade'));
    assert.isFalse(detailsModal.hasClass('show'));
    assert.equal(detailsModal.attr('role'), 'dialog');
    assert.equal(detailsModal.attr('tabindex'), '-1');
    const detailsTitleId = detailsModal.attr('aria-labelledby');
    assert.isNotEmpty(detailsTitleId);
    assert.equal(detailsModal.find(`#${detailsTitleId}`).text().trim(), 'Local preview details');
    assert.lengthOf(detailsModal.find('button[data-bs-dismiss="modal"]'), 1);
  });

  it('sets the assessment question title when the rendered document already has assets', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: makeCleanRun() }),
      questionDocumentHtml: `<!doctype html>
        <html lang="en">
          <head>
            <title>Generic question preview</title>
            <link rel="stylesheet" href="/node_modules/bootstrap/dist/css/bootstrap.min.css">
            <script src="/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js"></script>
          </head>
          <body><p>Rendered question</p></body>
        </html>`,
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    assert.equal($('head title').text(), '1. Dot product <basics> (Preview)');
    assert.lengthOf($('head title'), 1);
    assert.lengthOf($('head link[href$="/bootstrap/dist/css/bootstrap.min.css"]'), 1);
    assert.lengthOf($('head script[src$="/bootstrap/dist/js/bootstrap.bundle.min.js"]'), 1);
  });

  it('adds a visible fallback heading when h1 markup exists only in hidden fragments', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: makeCleanRun() }),
      questionDocumentHtml: `<!doctype html>
        <html>
          <head><title>Question without a visible heading</title></head>
          <body>
            <!-- <h1>Comment heading</h1> -->
            <script type="text/plain"><h1>Script heading</h1></script>
            <template><h1>Template heading</h1></template>
            <div hidden><h1>Hidden heading</h1></div>
            <p>Visible rendered question content.</p>
          </body>
        </html>`,
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    const controlledHeading = $('section[aria-label="Question"] > h1');
    assert.lengthOf(controlledHeading, 1);
    assert.equal(
      controlledHeading.text().replaceAll(/\s+/g, ' ').trim(),
      '1. Dot product <basics>',
    );
    const usableHeadings = $('body h1').filter(
      (_, heading) => $(heading).closest('[hidden], template, script').length === 0,
    );
    assert.lengthOf(usableHeadings, 1);
    assert.equal(usableHeadings[0], controlledHeading[0]);
  });

  it('does not present unresolved grading as zero points', () => {
    for (const method of ['Manual', 'External'] as const) {
      const run = makeCleanRun();
      const unresolvedRun: AssessmentPreviewRun = {
        ...run,
        sample: {
          ...run.sample,
          selectedSlots: run.sample.selectedSlots.map((slot) =>
            slot.id === 'slot-manual'
              ? { ...slot, grading: { kind: 'unresolved' as const, method } }
              : slot,
          ),
        },
      };
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run: unresolvedRun }),
        questionDocumentHtml: makeRenderedQuestionDocument(),
        slotId: 'slot-manual',
      });
      const $ = cheerio.load(documentHtml);
      const scoreCardText = $('table[aria-label="Question score"]')
        .closest('.card')
        .text()
        .replaceAll(/\s+/g, ' ')
        .trim();

      assert.match(scoreCardText, /(?:unavailable|unresolved)/i, method);
      assert.notMatch(scoreCardText, /\b0(?:\.0+)?\s*\/\s*3\b/, method);
    }
  });

  it('does not promise saving or finish grading for unresolved grading methods', () => {
    for (const method of ['Manual', 'External'] as const) {
      const run = makeCleanRun();
      const unresolvedRun: AssessmentPreviewRun = {
        ...run,
        sample: {
          ...run.sample,
          selectedSlots: run.sample.selectedSlots.map((slot) =>
            slot.id === 'slot-manual'
              ? {
                  ...slot,
                  allowRealTimeGrading: false,
                  grading: { kind: 'unresolved' as const, method },
                }
              : slot,
          ),
        },
      };
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run: unresolvedRun }),
        questionDocumentHtml: makeRenderedQuestionDocument(),
        slotId: 'slot-manual',
      });
      const pageText = cheerio.load(documentHtml)('body').text().replaceAll(/\s+/g, ' ').trim();

      assert.include(pageText, `${method} grading is unavailable in local preview`, method);
      assert.notInclude(pageText, 'Your answer will be saved now', method);
      assert.notInclude(pageText, 'grading happens when you finish', method);
    }
  });

  it('presents saved answers as pending instead of graded points', () => {
    const run = makeCleanRun();
    const savedRun: AssessmentPreviewRun = {
      ...run,
      questions: run.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? { ...question, savedAnswer: { ans: 'updated' }, status: 'saved' }
          : question,
      ),
    };
    const overviewHtml = renderAssessmentPreviewDocument(makeView({ run: savedRun }));
    const $overview = cheerio.load(overviewHtml);
    const overviewRow = $overview('table[aria-label="Questions"] tbody tr').filter((_, row) =>
      $overview(row).text().includes('Dot product'),
    );

    assert.include(overviewRow.text(), 'pending');
    assert.notMatch(overviewRow.text(), /1\.5\s*\/\s*4/);

    const questionHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: savedRun }),
      questionDocumentHtml: makeGradableRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    const $question = cheerio.load(questionHtml);
    const questionScore = $question('table[aria-label="Question score"]');
    assert.include(questionScore.text(), 'pending');
    assert.notMatch(questionScore.text(), /1\.5\s*\/\s*4/);
  });

  it('explains deferred grading and treats a saved answer as saved before Finish', () => {
    const run = makeCleanRun();
    const deferredRun: AssessmentPreviewRun = {
      ...run,
      sample: {
        ...run.sample,
        selectedSlots: run.sample.selectedSlots.map((slot) =>
          slot.id === 'slot-internal' ? { ...slot, allowRealTimeGrading: false } : slot,
        ),
      },
      questions: run.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? {
              ...question,
              lastGradableAtMs: null,
              status: 'unanswered',
              variant: { ...question.variant, open: true },
            }
          : question,
      ),
    };
    const deferredHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: deferredRun }),
      questionDocumentHtml: makeGradableRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    const deferred$ = cheerio.load(deferredHtml);
    const deferredPageText = deferred$('body').text().replaceAll(/\s+/g, ' ').trim();
    assert.match(deferredPageText, /(?:grading|graded).{0,80}finish/i);
    const saveAction = deferred$('.question-form button[type="submit"]');
    assert.lengthOf(saveAction, 1);
    assert.equal(saveAction.text().replaceAll(/\s+/g, ' ').trim(), 'Save');
    assert.equal(saveAction.attr('name'), '__action');
    assert.equal(saveAction.attr('value'), 'save');
    assert.notInclude(deferredPageText, 'Save & Grade');

    const savedRun: AssessmentPreviewRun = {
      ...deferredRun,
      questions: deferredRun.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? { ...question, savedAnswer: { value: 42 }, status: 'saved' }
          : { ...question, savedAnswer: null, status: 'complete' },
      ),
    };
    const savedHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: savedRun }),
      questionDocumentHtml: makeGradableRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    const saved$ = cheerio.load(savedHtml);
    const questionScoreText = saved$('table[aria-label="Question score"]').closest('.card').text();
    assert.include(questionScoreText, 'Saved');
    assert.notInclude(questionScoreText, 'Unanswered');
    const finishModal = saved$('[role="dialog"]').filter((_, dialog) => {
      const titleId = saved$(dialog).attr('aria-labelledby');
      return titleId != null && saved$(dialog).find(`#${titleId}`).text().trim() === 'All done?';
    });
    assert.lengthOf(finishModal, 1);
    assert.notInclude(finishModal.text(), 'There are still unanswered questions.');
  });

  it('does not promise deferred saving in question-only preview', () => {
    const run = makeCleanRun();
    const deferredRun: AssessmentPreviewRun = {
      ...run,
      sample: {
        ...run.sample,
        selectedSlots: run.sample.selectedSlots.map((slot) =>
          slot.id === 'slot-internal' ? { ...slot, allowRealTimeGrading: false } : slot,
        ),
      },
    };
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ finishGradingAvailable: false, run: deferredRun }),
      questionDocumentHtml: makeGradableRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    assert.include(documentHtml, 'Saving and grading are unavailable');
    assert.notInclude(documentHtml, 'Your answer will be saved now');
    const unavailableAction = $('.question-form button[name="__action"]');
    assert.lengthOf(unavailableAction, 1);
    assert.isTrue(unavailableAction.is('[disabled]'));
  });

  it('disables ordinary realtime submission controls in question-only preview', () => {
    for (const [questionType, questionDocumentHtml] of [
      ['modern', makeGradableRenderedQuestionDocument()],
      ['legacy', makeLegacyGradableRenderedQuestionDocument()],
    ] as const) {
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ finishGradingAvailable: false, run: makeCleanRun() }),
        questionDocumentHtml,
        slotId: 'slot-internal',
      });
      const $ = cheerio.load(documentHtml);
      const submissionControls = $('.question-form button[type="submit"]');

      assert.lengthOf(submissionControls, 1, questionType);
      assert.isTrue(submissionControls.is('[disabled][aria-disabled="true"]'), questionType);
      assert.equal(
        submissionControls.text().replaceAll(/\s+/g, ' ').trim(),
        'Saving unavailable',
        questionType,
      );
      assert.include(
        $('section[aria-label="Question"]').text().replaceAll(/\s+/g, ' '),
        'Saving and grading are unavailable in question-only preview.',
        questionType,
      );
    }
  });

  it('offers PrairieLearn Save only and Save & Grade controls for modern and legacy questions', () => {
    for (const [questionType, questionDocumentHtml] of [
      ['modern', makeGradableRenderedQuestionDocument()],
      ['legacy', makeLegacyGradableRenderedQuestionDocument()],
    ] as const) {
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run: makeCleanRun() }),
        questionDocumentHtml,
        slotId: 'slot-internal',
      });
      const $ = cheerio.load(documentHtml);
      const saveAction = $('.question-form button.question-save');
      const gradeAction = $('.question-form button.question-grade');

      assert.lengthOf(saveAction, 1, questionType);
      assert.equal(saveAction.text().replaceAll(/\s+/g, ' ').trim(), 'Save only', questionType);
      assert.include(saveAction.attr('class') ?? '', 'btn-info', questionType);
      assert.isFalse(saveAction.is('[disabled]'), questionType);
      assert.lengthOf(gradeAction, 1, questionType);
      assert.include(gradeAction.text(), 'Save & Grade', questionType);
      assert.isFalse(gradeAction.is('[disabled]'), questionType);
      if (questionType === 'modern') {
        assert.equal(saveAction.attr('name'), '__action');
        assert.equal(saveAction.attr('value'), 'save');
      } else {
        assert.isUndefined(saveAction.attr('name'));
        assert.lengthOf($('.question-form input.__action[name="__action"]'), 1);
      }
    }
  });

  it('adds the current assessment run and variant identity to modern and legacy question forms', () => {
    for (const [questionType, questionDocumentHtml] of [
      ['modern', makeGradableRenderedQuestionDocument()],
      ['legacy', makeLegacyGradableRenderedQuestionDocument()],
    ] as const) {
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run: makeCleanRun() }),
        questionDocumentHtml,
        slotId: 'slot-internal',
      });
      const $ = cheerio.load(documentHtml);
      const questionForm = $('form.question-form');

      assert.lengthOf(questionForm, 1, questionType);
      assert.lengthOf(
        questionForm.find('input[name="__assessment_preview_revision"][value="7"]'),
        1,
        questionType,
      );
      assert.lengthOf(
        questionForm.find('input[name="__assessment_preview_variant_number"][value="1"]'),
        1,
        questionType,
      );
    }
  });

  it('adds assessment identity only to active question forms', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: makeCleanRun() }),
      questionDocumentHtml: `<!doctype html>
        <html>
          <head><title>Question</title></head>
          <body>
            <!-- <form class="question-form">comment-only</form> -->
            <script>window.formMarkup = '<form class="question-form">script-only</form>';</script>
            <style>.preview::after { content: '<form class="question-form">style-only</form>'; }</style>
            <textarea><form class="question-form">textarea-only</form></textarea>
            <template><form class="question-form">template-only</form></template>
            <form class="question-form" data-question-type="modern" data-note="2 > 1"></form>
            <form class="legacy question-form" data-question-type="legacy"></form>
          </body>
        </html>`,
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    const activeForms = $('form[data-question-type]');
    assert.lengthOf(activeForms, 2);
    activeForms.each((_, form) => {
      assert.lengthOf($(form).find('input[name="__assessment_preview_revision"][value="7"]'), 1);
      assert.lengthOf(
        $(form).find('input[name="__assessment_preview_variant_number"][value="1"]'),
        1,
      );
    });
    assert.equal(activeForms.filter('[data-question-type="modern"]').attr('data-note'), '2 > 1');

    assert.include(documentHtml, '<!-- <form class="question-form">comment-only</form> -->');
    for (const inertElement of $('script, style, textarea, template')) {
      assert.notInclude($(inertElement).html() ?? '', '__assessment_preview_');
    }
  });

  it('transforms only active grade buttons and preserves unrelated markup and attributes', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: makeCleanRun() }),
      questionDocumentHtml: `<!doctype html>
        <html>
          <head><title>Question</title></head>
          <body>
            <!-- <button class="question-grade btn-primary">Comment grade</button> -->
            <script>window.gradeMarkup = '<button class="question-grade btn-primary">Script grade</button>';</script>
            <style>.grade::after { content: '<button class="question-grade btn-primary">Style grade</button>'; }</style>
            <textarea><button class="question-grade btn-primary">Textarea grade</button></textarea>
            <template><button class="question-grade btn-primary">Template grade</button></template>
            <form class="question-form">
              <button
                type="button"
                class="not-question-grade btn-primary-helper"
                name="not-__action"
                value="grade"
              >Unrelated action</button>
              <button
                type="button"
                data-description=' class="question-grade btn-primary" name="__action" value="grade"'
              >Quoted attribute text</button>
              <button
                type="submit"
                data-note="2 > 1"
                class="btn btn-primary question-grade disable-on-submit"
                name="__action"
                value="grade"
                data-owner="question-grade"
                aria-describedby="btn-primary-help question-grade-help"
              >Save &amp; Grade</button>
            </form>
          </body>
        </html>`,
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    assert.include(
      documentHtml,
      '<!-- <button class="question-grade btn-primary">Comment grade</button> -->',
    );
    for (const inertContent of [
      'Script grade',
      'Style grade',
      'Textarea grade',
      'Template grade',
    ]) {
      assert.match(
        documentHtml,
        new RegExp(`question-grade btn-primary[^<]*>${inertContent}</button>`),
      );
    }

    const unrelatedAction = $('.question-form button').filter((_, button) =>
      $(button).text().includes('Unrelated action'),
    );
    assert.equal(unrelatedAction.attr('class'), 'not-question-grade btn-primary-helper');
    assert.equal(unrelatedAction.attr('name'), 'not-__action');
    assert.equal(unrelatedAction.attr('value'), 'grade');
    const quotedAttributeAction = $('.question-form button').filter((_, button) =>
      $(button).text().includes('Quoted attribute text'),
    );
    assert.equal(
      quotedAttributeAction.attr('data-description'),
      ' class="question-grade btn-primary" name="__action" value="grade"',
    );
    assert.isUndefined(quotedAttributeAction.attr('class'));

    const saveAction = $('.question-form button.question-save');
    const gradeAction = $('.question-form button.question-grade');
    assert.lengthOf($('.question-form button'), 4);
    assert.lengthOf(saveAction, 1);
    assert.lengthOf(gradeAction, 1);
    assert.equal(saveAction.attr('data-note'), '2 > 1');
    assert.equal(saveAction.attr('data-owner'), 'question-grade');
    assert.equal(saveAction.attr('aria-describedby'), 'btn-primary-help question-grade-help');
    assert.equal(saveAction.attr('value'), 'save');
    assert.include(saveAction.attr('class') ?? '', 'btn-info');
    assert.notInclude(saveAction.attr('class') ?? '', 'btn-primary');
    assert.equal(gradeAction.attr('data-note'), '2 > 1');
    assert.equal(gradeAction.attr('value'), 'grade');
  });

  it('shows and enforces the active grade-rate limit', () => {
    const run = makeCleanRun();
    const rateLimitedRun: AssessmentPreviewRun = {
      ...run,
      facts: { ...run.facts, nowMs: 1_700_000_300_000 },
      sample: {
        ...run.sample,
        selectedSlots: run.sample.selectedSlots.map((slot) =>
          slot.id === 'slot-internal' ? { ...slot, gradeRateMinutes: 10 } : slot,
        ),
      },
      questions: run.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? {
              ...question,
              lastGradableAtMs: 1_700_000_000_000,
              variant: { ...question.variant, open: true },
            }
          : question,
      ),
    };
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: rateLimitedRun }),
      questionDocumentHtml: makeGradableRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    const rateLimitMessage = $('[role="status"], [role="alert"]').filter((_, message) =>
      /(?:wait|rate limit|grading (?:will be|is) available again)/i.test($(message).text()),
    );
    assert.lengthOf(rateLimitMessage, 1);
    const saveAction = $('.question-form button[name="__action"][value="save"]');
    const gradeAction = $('.question-form button[name="__action"][value="grade"]');
    assert.lengthOf(saveAction, 1);
    assert.isFalse(saveAction.is('[disabled]'));
    assert.lengthOf(gradeAction, 1);
    assert.include(gradeAction.text(), 'Save & Grade');
    assert.isTrue(gradeAction.is('[disabled]'));
  });

  it('adapts legacy controls for deferred grading and active grade-rate limits', () => {
    const baseRun = makeCleanRun();
    const deferredRun: AssessmentPreviewRun = {
      ...baseRun,
      sample: {
        ...baseRun.sample,
        selectedSlots: baseRun.sample.selectedSlots.map((slot) =>
          slot.id === 'slot-internal' ? { ...slot, allowRealTimeGrading: false } : slot,
        ),
      },
    };
    const rateLimitedRun: AssessmentPreviewRun = {
      ...baseRun,
      sample: {
        ...baseRun.sample,
        selectedSlots: baseRun.sample.selectedSlots.map((slot) =>
          slot.id === 'slot-internal' ? { ...slot, gradeRateMinutes: 10 } : slot,
        ),
      },
    };

    for (const [mode, run, expectedSaveLabel, expectedGradeCount] of [
      ['deferred', deferredRun, 'Save', 0],
      ['rate limited', rateLimitedRun, 'Save only', 1],
    ] as const) {
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run }),
        questionDocumentHtml: makeLegacyGradableRenderedQuestionDocument(),
        slotId: 'slot-internal',
      });
      const $ = cheerio.load(documentHtml);
      const saveAction = $('.question-form button.question-save');
      const gradeAction = $('.question-form button.question-grade');
      assert.lengthOf(saveAction, 1, mode);
      assert.equal(saveAction.text().replaceAll(/\s+/g, ' ').trim(), expectedSaveLabel, mode);
      assert.lengthOf(gradeAction, expectedGradeCount, mode);
      if (expectedGradeCount === 1) assert.isTrue(gradeAction.is('[disabled]'), mode);
    }
  });

  it('suppresses active saving and grading notices for read-only questions', () => {
    const baseRun = makeCleanRun();
    const deferredFinishedRun: AssessmentPreviewRun = {
      ...baseRun,
      sample: {
        ...baseRun.sample,
        selectedSlots: baseRun.sample.selectedSlots.map((slot) =>
          slot.id === 'slot-internal' ? { ...slot, allowRealTimeGrading: false } : slot,
        ),
      },
      questions: baseRun.questions.map((question) =>
        question.slotId === 'slot-internal'
          ? {
              ...question,
              accessMode: 'read_only_finished',
              variant: { ...question.variant, open: true },
            }
          : question,
      ),
    };
    const rateLimitedClosedRun: AssessmentPreviewRun = {
      ...baseRun,
      sample: {
        ...baseRun.sample,
        selectedSlots: baseRun.sample.selectedSlots.map((slot) =>
          slot.id === 'slot-internal' ? { ...slot, gradeRateMinutes: 10 } : slot,
        ),
      },
    };

    for (const [readOnlyState, run] of [
      ['finished', deferredFinishedRun],
      ['closed', rateLimitedClosedRun],
    ] as const) {
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run }),
        questionDocumentHtml: makeGradableRenderedQuestionDocument(),
        slotId: 'slot-internal',
      });
      const $ = cheerio.load(documentHtml);
      const questionRegion = $('section[aria-label="Question"]');
      const questionText = questionRegion.text().replaceAll(/\s+/g, ' ');

      assert.lengthOf(
        questionRegion.find('.assessment-preview-read-only-reason'),
        1,
        readOnlyState,
      );
      assert.notInclude(questionText, 'Your answer will be saved now', readOnlyState);
      assert.notInclude(questionText, 'Your answer can still be saved', readOnlyState);
      assert.notInclude(questionText, 'Grade-rate limit active', readOnlyState);
    }
  });

  it('keeps blocked Next controls focusable and explains why they are locked', () => {
    for (const blockedState of [
      { accessMode: 'blocked_sequence' as const, expectedReason: /80%|required score/i },
      {
        accessMode: 'blocked_lockpoint' as const,
        expectedReason: /assessment lockpoint|lockpoint.*overview/i,
      },
    ]) {
      const run = makeCleanRun();
      const blockedRun: AssessmentPreviewRun = {
        ...run,
        sample: {
          ...run.sample,
          selectedSlots: run.sample.selectedSlots.map((slot) =>
            slot.id === 'slot-internal' ? { ...slot, advanceScorePercent: 80 } : slot,
          ),
        },
        questions: run.questions.map((question) =>
          question.slotId === 'slot-manual'
            ? { ...question, accessMode: blockedState.accessMode }
            : question,
        ),
      };
      const documentHtml = augmentAssessmentPreviewQuestionDocument({
        ...makeView({ run: blockedRun }),
        questionDocumentHtml: makeRenderedQuestionDocument(),
        slotId: 'slot-internal',
      });
      const $ = cheerio.load(documentHtml);
      const nextControl = $('nav[aria-label="Assessment question navigation"]')
        .find('a, button')
        .filter((_, control) => /^Next(?: question)?$/i.test($(control).text().trim()));
      assert.lengthOf(nextControl, 1);
      assert.equal(nextControl.prop('tagName'), 'BUTTON', blockedState.accessMode);
      assert.isUndefined(nextControl.attr('href'), blockedState.accessMode);
      assert.equal(nextControl.attr('type'), 'button', blockedState.accessMode);
      assert.isFalse(nextControl.is('[disabled]'), blockedState.accessMode);
      assert.notEqual(nextControl.attr('tabindex'), '-1', blockedState.accessMode);
      assert.equal(nextControl.attr('aria-disabled'), 'true', blockedState.accessMode);
      assert.include(nextControl.attr('class') ?? '', 'btn-secondary', blockedState.accessMode);
      assert.notInclude(nextControl.attr('class') ?? '', 'btn-primary', blockedState.accessMode);
      assert.equal(nextControl.attr('data-bs-toggle'), 'popover', blockedState.accessMode);
      assert.match(
        nextControl.attr('data-bs-content') ?? '',
        blockedState.expectedReason,
        blockedState.accessMode,
      );
      assert.lengthOf(nextControl.find('.fa-lock'), 1, blockedState.accessMode);

      const describedByText = (nextControl.attr('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => $(`#${id}`).text())
        .join(' ');
      const accessibleReason = [
        nextControl.attr('aria-label'),
        nextControl.attr('title'),
        describedByText,
      ]
        .filter(Boolean)
        .join(' ');
      assert.match(accessibleReason, blockedState.expectedReason, blockedState.accessMode);
    }
  });

  it('uses the student assessment title in the rendered question card without a duplicate heading', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: makeCleanRun() }),
      questionDocumentHtml: makeRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    assert.match(documentHtml, /^<!doctype html>/i);
    const renderedQuestionCard = $('[data-testid="rendered-question-card"]');
    assert.lengthOf(renderedQuestionCard, 1);
    assert.lengthOf($('body h1'), 1, 'does not add a second question heading');
    assert.equal(renderedQuestionCard.find('h1').text().trim(), '1. Dot product <basics>');

    const hiddenTitleRun = makeCleanRun();
    const hiddenTitleHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({
        run: {
          ...hiddenTitleRun,
          plan: { ...hiddenTitleRun.plan, showQuestionTitles: false },
        },
      }),
      questionDocumentHtml: makeRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    assert.equal(
      cheerio.load(hiddenTitleHtml)('[data-testid="rendered-question-card"] h1').text().trim(),
      '1',
    );

    const desktopRow = $('main').children('.row');
    assert.lengthOf(desktopRow, 1);
    const questionRegion = desktopRow.children('.col-lg-9');
    assert.lengthOf(questionRegion, 1);
    assert.lengthOf(questionRegion.find('[data-testid="rendered-question-card"]'), 1);
    const assessmentAside = desktopRow.children(
      'aside[aria-label="Assessment navigation and score"]',
    );
    assert.lengthOf(assessmentAside, 1);
    assert.isTrue(assessmentAside.hasClass('col-lg-3'));

    const assessmentScoreTable = assessmentAside.find('table[aria-label="Assessment score"]');
    assert.lengthOf(assessmentScoreTable, 1);
    assert.lengthOf(assessmentScoreTable.closest('.card'), 1);
    assert.include(assessmentScoreTable.text(), 'Total points:');

    const questionScoreTable = assessmentAside.find('table[aria-label="Question score"]');
    assert.lengthOf(questionScoreTable, 1);
    const questionScoreCard = questionScoreTable.closest('.card');
    assert.lengthOf(questionScoreCard, 1);
    assert.include(questionScoreCard.text(), 'Question 1');
    assert.include(questionScoreCard.text(), 'Incorrect');
    assert.include(questionScoreTable.text(), 'Total points:');

    const questionNavigation = assessmentAside
      .find('nav')
      .filter((_, nav) => $(nav).text().includes('Assessment overview'));
    assert.lengthOf(questionNavigation, 1);
    assert.match(questionNavigation.attr('aria-label') ?? '', /question/i);
    const overviewControl = questionNavigation
      .find('a')
      .filter(
        (_, control) => $(control).text().replaceAll(/\s+/g, ' ').trim() === 'Assessment overview',
      );
    assert.lengthOf(overviewControl, 1);
    assert.equal(overviewControl.attr('href'), '/preview/assessment-preview-runs/run-1');
    const previousControl = questionNavigation
      .find('button')
      .filter((_, control) => /^Previous(?: question)?$/i.test($(control).text().trim()));
    assert.lengthOf(previousControl, 1);
    assert.isTrue(previousControl.is('[disabled]'));
    const nextControl = questionNavigation
      .find('a')
      .filter((_, control) => /^Next(?: question)?$/i.test($(control).text().trim()));
    assert.lengthOf(nextControl, 1);
    assert.equal(
      nextControl.attr('href'),
      '/preview/assessment-preview-runs/run-1/questions/slot-manual',
    );

    const detailsTrigger = $('button[data-bs-toggle="modal"]').filter(
      (_, control) =>
        $(control).attr('aria-label') === 'Preview details' ||
        $(control).text().replaceAll(/\s+/g, ' ').trimStart().startsWith('Preview details'),
    );
    assert.lengthOf(detailsTrigger, 1);
    assert.equal(detailsTrigger.attr('aria-label'), 'Preview details');
    assert.lengthOf(detailsTrigger.find('.badge'), 0);
    assert.equal(detailsTrigger.find('.visually-hidden').text().trim(), '');
    const detailsModalTarget = detailsTrigger.attr('data-bs-target');
    assert.match(detailsModalTarget ?? '', /^#[A-Za-z][\w-]*$/);
    const detailsModal = $(detailsModalTarget);
    assert.lengthOf(detailsModal, 1);
    assert.equal(detailsModal.attr('role'), 'dialog');
    const detailsTitleId = detailsModal.attr('aria-labelledby');
    assert.isNotEmpty(detailsTitleId);
    assert.equal(detailsModal.find(`#${detailsTitleId}`).text().trim(), 'Local preview details');

    assert.lengthOf($('button[name="action"][value="new-variant"]'), 1);
    assert.lengthOf($('input[name="slotId"][value="slot-internal"]'), 1);
  });

  it('confirms finishing while preserving its action payload', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ run: makeCleanRun() }),
      questionDocumentHtml: makeRenderedQuestionDocument(),
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    const confirmationModal = $('[role="dialog"]').filter((_, dialog) => {
      const titleId = $(dialog).attr('aria-labelledby');
      return titleId != null && $(dialog).find(`#${titleId}`).text().trim() === 'All done?';
    });
    assert.lengthOf(confirmationModal, 1);
    assert.isTrue(confirmationModal.hasClass('modal'));
    assert.isTrue(confirmationModal.hasClass('fade'));

    const confirmationModalId = confirmationModal.attr('id');
    assert.isNotEmpty(confirmationModalId);
    const confirmationTrigger = $(`button[data-bs-target="#${confirmationModalId}"]`).filter(
      (_, control) => /^Finish (?:assessment|preview)$/i.test($(control).text().trim()),
    );
    assert.lengthOf(confirmationTrigger, 1);
    assert.equal(confirmationTrigger.attr('type'), 'button');
    assert.equal(confirmationTrigger.attr('data-bs-toggle'), 'modal');

    const finishAction = confirmationModal.find(
      'button[type="submit"][name="action"][value="finish"]',
    );
    assert.lengthOf(finishAction, 1);
    assert.lengthOf(finishAction.closest('[role="dialog"]'), 1);
    const confirmationForm =
      confirmationModal.closest('form').length > 0
        ? confirmationModal.closest('form')
        : confirmationModal.find('form').first();
    assert.lengthOf(confirmationForm, 1);
    assert.equal(confirmationForm.attr('method')?.toLowerCase(), 'post');
    assert.equal(confirmationForm.attr('action'), '/preview/assessment-preview-runs/run-1/actions');
    assert.lengthOf(confirmationForm.find('input[name="revision"][value="7"]'), 1);
    assert.lengthOf(confirmationForm.find('[name="action"][value="finish"]'), 1);
  });

  it('keeps question navigation but replaces Finish when finish grading is unavailable', () => {
    const documentHtml = augmentAssessmentPreviewQuestionDocument({
      ...makeView({ finishGradingAvailable: false }),
      questionDocumentHtml:
        '<!doctype html><html><body><div class="question-body">Rendered question</div></body></html>',
      slotId: 'slot-internal',
    });
    const $ = cheerio.load(documentHtml);

    assert.include(documentHtml, 'Assessment overview');
    assert.include(documentHtml, 'Question 1 of 2');
    assert.equal(
      $('section[aria-label="Question"] > h1').text().replaceAll(/\s+/g, ' ').trim(),
      '1. Dot product <basics>',
    );
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
    const $readOnly = cheerio.load(readOnlyHtml);
    const readOnlyRegion = $readOnly('section[aria-label="Question"]');
    const readOnlyReason = readOnlyRegion.find('.assessment-preview-read-only-reason');
    assert.lengthOf(readOnlyReason, 1);
    assert.match(
      readOnlyReason.text().replaceAll(/\s+/g, ' ').trim(),
      /read-only because you advanced past a lockpoint/i,
    );
    assert.lengthOf(readOnlyRegion.find('fieldset[disabled]'), 1);
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
    for (const { expectedReason, questionState } of [
      {
        expectedReason: /question is closed/i,
        questionState: { open: false, variant: { number: 1, numTries: 0, open: true } },
      },
      {
        expectedReason: /current variant is closed/i,
        questionState: { open: true, variant: { number: 1, numTries: 1, open: false } },
      },
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

      const $ = cheerio.load(documentHtml);
      const questionRegion = $('section[aria-label="Question"]');
      const reason = questionRegion.find('.assessment-preview-read-only-reason');
      assert.lengthOf(reason, 1);
      assert.match(reason.text().replaceAll(/\s+/g, ' ').trim(), expectedReason);
      assert.lengthOf(questionRegion.find('fieldset[disabled]'), 1);
      assert.include(questionRegion.text(), 'Closed question body');
    }
  });
});
