import { type HtmlSafeString, html, unsafeHtml } from '@prairielearn/html';

import type { AssessmentPreviewAccessResult } from './access.js';
import type { AssessmentPreviewQuestionState, AssessmentPreviewRun } from './assessment-run.js';

export type AssessmentPreviewDocumentAccessState = Pick<
  AssessmentPreviewAccessResult,
  | 'authorized'
  | 'credit'
  | 'creditDateString'
  | 'password'
  | 'source'
  | 'submittable'
  | 'visibility'
>;

export interface AssessmentPreviewDocumentDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'unsupported' | 'warning';
  slotId?: string;
}

export interface AssessmentPreviewInvalidationState {
  invalidated: boolean;
  message?: string;
}

export interface AssessmentPreviewDocumentView {
  access: AssessmentPreviewDocumentAccessState;
  assessmentText?: string | null;
  diagnostics?: readonly AssessmentPreviewDocumentDiagnostic[];
  /** Whether the active render mode can finish-grade this assessment run. */
  finishGradingAvailable: boolean;
  invalidation: AssessmentPreviewInvalidationState;
  run: AssessmentPreviewRun;
  runUrl: string;
}

export interface AssessmentPreviewQuestionDocumentView extends AssessmentPreviewDocumentView {
  questionDocumentHtml: string;
  slotId: string;
}

const ASSESSMENT_TEXT_ASSET_PLACEHOLDER =
  /(?:<%=\s*|{{\s*)(?<placeholder>clientFilesAssessment|clientFilesCourseInstance|clientFilesCourse|client_files_assessment|client_files_course_instance|client_files_course)(?:\s*%>|\s*}})/g;

function normalizeRunUrl(runUrl: string): string {
  return runUrl.replace(/\/+$/, '');
}

function assessmentAssetUrl(runUrl: string, placeholder: string): string {
  const baseUrl = normalizeRunUrl(runUrl);
  switch (placeholder) {
    case 'clientFilesAssessment':
    case 'client_files_assessment':
      return `${baseUrl}/clientFilesAssessment`;
    case 'clientFilesCourseInstance':
    case 'client_files_course_instance':
      return `${baseUrl}/clientFilesCourseInstance`;
    case 'clientFilesCourse':
    case 'client_files_course':
      return `${baseUrl}/clientFilesCourse`;
    default:
      throw new Error(`Unknown assessment text asset placeholder "${placeholder}".`);
  }
}

function renderAssessmentText(assessmentText: string | null | undefined, runUrl: string) {
  if (!assessmentText) return '';

  const fragments: HtmlSafeString[] = [];
  let endOfPreviousMatch = 0;
  for (const match of assessmentText.matchAll(ASSESSMENT_TEXT_ASSET_PLACEHOLDER)) {
    const placeholder = match.groups?.placeholder;
    if (!placeholder) throw new Error('Assessment text asset placeholder did not contain a name.');
    fragments.push(
      unsafeHtml(assessmentText.slice(endOfPreviousMatch, match.index)),
      html`${assessmentAssetUrl(runUrl, placeholder)}`,
    );
    endOfPreviousMatch = match.index + match[0].length;
  }
  fragments.push(unsafeHtml(assessmentText.slice(endOfPreviousMatch)));
  return html`${fragments}`;
}

function formatPoints(points: number): string {
  return Number.isInteger(points) ? points.toString() : points.toFixed(2).replace(/0+$/, '');
}

function questionStatusLabel(status: AssessmentPreviewQuestionState['status']): string {
  switch (status) {
    case 'unanswered':
      return 'Unanswered';
    case 'invalid':
      return 'Invalid';
    case 'incorrect':
      return 'Incorrect';
    case 'correct':
      return 'Correct';
    case 'complete':
      return 'Complete';
  }
}

function questionStatusClass(status: AssessmentPreviewQuestionState['status']): string {
  switch (status) {
    case 'unanswered':
      return 'text-bg-secondary';
    case 'invalid':
      return 'text-bg-danger';
    case 'incorrect':
      return 'text-bg-warning';
    case 'correct':
      return 'text-bg-primary';
    case 'complete':
      return 'text-bg-success';
  }
}

function questionAccessLabel(accessMode: AssessmentPreviewQuestionState['accessMode']) {
  switch (accessMode) {
    case 'default':
      return '';
    case 'blocked_sequence':
      return html`<span class="text-muted">Blocked by question sequence</span>`;
    case 'blocked_lockpoint':
      return html`<span class="text-muted">Blocked at assessment lockpoint</span>`;
    case 'read_only_lockpoint':
      return html`<span class="text-muted">Read only after lockpoint</span>`;
    case 'read_only_finished':
      return html`<span class="text-muted">Read only after assessment finish</span>`;
  }
}

function questionCanBeViewed(question: AssessmentPreviewQuestionState): boolean {
  return question.accessMode !== 'blocked_sequence' && question.accessMode !== 'blocked_lockpoint';
}

function questionIsReadOnly(question: AssessmentPreviewQuestionState): boolean {
  return (
    question.accessMode === 'read_only_lockpoint' || question.accessMode === 'read_only_finished'
  );
}

function renderDiagnostics(view: AssessmentPreviewDocumentView) {
  const diagnostics = [...(view.diagnostics ?? []), ...view.run.diagnostics];
  if (diagnostics.length === 0) return '';

  return html`
    <section class="card border-warning mb-4" aria-labelledby="assessment-preview-diagnostics">
      <div class="card-header bg-warning-subtle">
        <h2 class="h5 mb-0" id="assessment-preview-diagnostics">Preview diagnostics</h2>
      </div>
      <ul class="list-group list-group-flush">
        ${diagnostics.map(
          (diagnostic) => html`
            <li class="list-group-item">
              <span class="badge text-bg-${diagnostic.severity === 'error' ? 'danger' : 'warning'}">
                ${diagnostic.severity}
              </span>
              <code>${diagnostic.code}</code>: ${diagnostic.message}
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

function renderAvailabilityAlerts(view: AssessmentPreviewDocumentView) {
  return html`
    ${view.invalidation.invalidated
      ? html`
          <div class="alert alert-danger" role="alert">
            <strong>This preview run is out of date.</strong>
            ${view.invalidation.message ??
            'Course sources changed after this run was created. Create a new run to continue.'}
          </div>
        `
      : ''}
    ${!view.access.authorized
      ? html`
          <div class="alert alert-danger" role="alert">
            <strong>Simulated access rules deny this assessment.</strong>
            Change the preview facts or assessment access rules before starting a run.
          </div>
        `
      : !view.access.submittable
        ? html`
            <div class="alert alert-warning" role="alert">
              The simulated access state is read-only. Questions can be reviewed, but answers cannot
              be submitted.
            </div>
          `
        : ''}
  `;
}

function actionsDisabled(view: AssessmentPreviewDocumentView): boolean {
  return view.invalidation.invalidated || !view.access.authorized || !view.access.submittable;
}

const DEFAULT_HONOR_CODE =
  'I certify that I am allowed to take this assessment and will follow its rules.';

function renderStartRequirements(view: AssessmentPreviewDocumentView) {
  if (!view.run.plan.requireHonorCode && view.access.password === null) return '';

  const honorCode = view.run.plan.honorCode?.trim() || DEFAULT_HONOR_CODE;
  return html`
    <div class="assessment-preview-start-requirements mb-3">
      ${view.run.plan.requireHonorCode
        ? html`
            <fieldset class="mb-3">
              <legend class="h6">Honor code</legend>
              <p class="honor-code">${honorCode}</p>
              <div class="form-check">
                <input
                  type="checkbox"
                  class="form-check-input"
                  id="assessment-preview-honor-code-accepted"
                  name="honorCodeAccepted"
                  value="true"
                  required
                />
                <label class="form-check-label" for="assessment-preview-honor-code-accepted">
                  I accept this honor code.
                </label>
              </div>
            </fieldset>
          `
        : ''}
      ${view.access.password !== null
        ? html`
            <div class="mb-3">
              <label class="form-label" for="assessment-preview-password">
                Assessment password
              </label>
              <input
                type="password"
                class="form-control"
                id="assessment-preview-password"
                name="password"
                autocomplete="off"
                required
              />
            </div>
          `
        : ''}
    </div>
  `;
}

function renderRunAction({
  action,
  label,
  view,
}: {
  action: 'finish' | 'start';
  label: string;
  view: AssessmentPreviewDocumentView;
}) {
  const disabled =
    action === 'finish'
      ? view.invalidation.invalidated || !view.access.authorized
      : actionsDisabled(view);
  return html`
    <form method="post" action="${normalizeRunUrl(view.runUrl)}/actions">
      <input type="hidden" name="revision" value="${view.run.revision}" />
      ${action === 'start' ? renderStartRequirements(view) : ''}
      <button
        type="submit"
        class="btn btn-${action === 'start' ? 'primary' : 'outline-danger'}"
        name="action"
        value="${action}"
        ${disabled ? html`disabled aria-disabled="true"` : ''}
      >
        ${label}
      </button>
    </form>
  `;
}

function renderFinishControl(view: AssessmentPreviewDocumentView) {
  if (view.finishGradingAvailable) {
    return renderRunAction({ action: 'finish', label: 'Finish assessment', view });
  }
  return html`
    <span class="small text-muted assessment-preview-finish-unavailable">
      Finish grading is unavailable in question-only preview.
    </span>
  `;
}

function renderRunControl(view: AssessmentPreviewDocumentView) {
  if (view.run.status === 'not_started') {
    return renderRunAction({ action: 'start', label: 'Start assessment', view });
  }
  if (view.run.status === 'in_progress') {
    return renderFinishControl(view);
  }
  return html`<span class="badge text-bg-success fs-6">Finished</span>`;
}

function renderLockpointControl(view: AssessmentPreviewDocumentView) {
  if (view.run.status !== 'in_progress') return '';

  const crossedLockpointIds = new Set(view.run.crossedLockpointIds);
  const lockpoint = [...view.run.sample.zones]
    .filter((zone) => zone.lockpoint && !crossedLockpointIds.has(zone.id))
    .sort((a, b) => a.number - b.number)
    .at(0);
  if (lockpoint == null) return '';

  const zoneById = new Map(view.run.sample.zones.map((zone) => [zone.id, zone]));
  const questionBySlotId = new Map(
    view.run.questions.map((question) => [question.slotId, question]),
  );
  const sequenceBlockers = view.run.sample.selectedSlots.filter((slot) => {
    const zone = zoneById.get(slot.zoneId);
    const question = questionBySlotId.get(slot.id);
    return (
      zone != null &&
      zone.number < lockpoint.number &&
      question != null &&
      question.open &&
      question.highestSubmissionScore * 100 < slot.advanceScorePercent
    );
  });
  const disabled = actionsDisabled(view) || sequenceBlockers.length > 0;
  const lockpointLabel = lockpoint.title ?? `zone ${lockpoint.number}`;

  return html`
    <section class="card mb-4" aria-labelledby="assessment-preview-lockpoint">
      <div class="card-header">
        <h2 class="h5 mb-0" id="assessment-preview-lockpoint">Next lockpoint</h2>
      </div>
      <div class="card-body">
        <p>
          Cross the lockpoint into ${lockpointLabel}. Earlier questions become read-only after this
          action.
        </p>
        ${sequenceBlockers.length === 0
          ? ''
          : html`
              <div class="alert alert-warning" role="status">
                <strong>The advance-score sequence blocks this lockpoint.</strong>
                <ul class="mb-0">
                  ${sequenceBlockers.map(
                    (slot) => html`
                      <li>
                        ${slot.title ?? slot.qid}: ${formatPoints(slot.advanceScorePercent)}%
                        advance score required; currently
                        ${formatPoints(
                          (questionBySlotId.get(slot.id)?.highestSubmissionScore ?? 0) * 100,
                        )}%.
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `}
        <form method="post" action="${normalizeRunUrl(view.runUrl)}/actions">
          <input type="hidden" name="revision" value="${view.run.revision}" />
          <input type="hidden" name="zoneId" value="${lockpoint.id}" />
          <button
            type="submit"
            class="btn btn-outline-primary"
            name="action"
            value="cross-lockpoint"
            ${disabled ? html`disabled aria-disabled="true"` : ''}
          >
            Cross lockpoint
          </button>
        </form>
      </div>
    </section>
  `;
}

function renderScore(view: AssessmentPreviewDocumentView) {
  if (!view.access.visibility.showScore) {
    return html`<p class="mb-0 text-muted">The simulated access rules hide the score.</p>`;
  }

  const { score } = view.run;
  if (score.incomplete) {
    return html`
      <p class="mb-1">
        <strong>Final score is incomplete.</strong>
        ${formatPoints(score.subtotalPoints)} / ${formatPoints(score.subtotalMaxPoints)} available
        points are currently resolved.
      </p>
      <p class="small text-muted mb-0">
        Manual, external, shared, or unavailable questions are excluded from the preview subtotal.
      </p>
    `;
  }

  return html`
    <p class="mb-0">
      <strong>${formatPoints(score.points ?? 0)} / ${formatPoints(score.maxPoints)} points</strong>
      (${formatPoints(score.scorePercent ?? 0)}%)
      ${score.maxBonusPoints > 0
        ? html`with up to ${formatPoints(score.maxBonusPoints)} bonus points`
        : ''}
    </p>
  `;
}

function renderQuestionGradingLabel({
  question,
  slot,
}: {
  question: AssessmentPreviewQuestionState;
  slot: AssessmentPreviewRun['sample']['selectedSlots'][number];
}) {
  if (slot.grading.kind === 'unresolved') {
    switch (slot.grading.method) {
      case 'Manual':
        return html`<span class="text-muted">Manual grading unavailable in local preview</span>`;
      case 'External':
        return html`<span class="text-muted">External grading unavailable in local preview</span>`;
      case 'shared':
        return html`<span class="text-muted">Shared question unavailable in local preview</span>`;
      case 'missing':
        return html`<span class="text-muted">Question metadata unavailable</span>`;
    }
  }

  const automaticPoints = html`
    ${formatPoints(question.autoPoints)} / ${formatPoints(slot.points.maxAutoPoints)} auto-graded
    points
  `;
  if (slot.points.maxManualPoints === 0) return automaticPoints;
  return html`
    ${automaticPoints};
    ${question.manualPoints == null
      ? html`manual points unresolved`
      : html`${formatPoints(question.manualPoints)} / ${formatPoints(slot.points.maxManualPoints)}
        manual points`}
  `;
}

function renderQuestionList(view: AssessmentPreviewDocumentView) {
  if (!view.access.visibility.showQuestions) {
    return html`
      <div class="alert alert-secondary mb-0" role="status">
        The simulated access rules hide assessment questions.
      </div>
    `;
  }

  return html`
    <ol class="list-group list-group-numbered">
      ${view.run.sample.selectedSlots.map((slot) => {
        const question = view.run.questions.find((candidate) => candidate.slotId === slot.id)!;
        const questionUrl = `${normalizeRunUrl(view.runUrl)}/questions/${encodeURIComponent(slot.id)}`;
        const canOpenQuestion =
          view.access.authorized &&
          view.run.status !== 'not_started' &&
          questionCanBeViewed(question);
        return html`
          <li class="list-group-item d-flex justify-content-between align-items-start gap-3">
            <div class="ms-2 me-auto">
              <div class="fw-semibold">
                ${canOpenQuestion
                  ? html`<a href="${questionUrl}">${slot.title ?? slot.qid}</a>`
                  : (slot.title ?? slot.qid)}
              </div>
              <div class="small">${renderQuestionGradingLabel({ question, slot })}</div>
              ${question.accessMode === 'default'
                ? ''
                : html`<div class="small">${questionAccessLabel(question.accessMode)}</div>`}
            </div>
            <span class="badge ${questionStatusClass(question.status)} rounded-pill">
              ${questionStatusLabel(question.status)}
            </span>
          </li>
        `;
      })}
    </ol>
  `;
}

function overviewContents(view: AssessmentPreviewDocumentView) {
  const assessmentLabel = `${view.run.plan.assessmentSetAbbreviation}${view.run.plan.number}`;
  return html`
    <header class="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
      <div>
        <p class="text-uppercase text-muted small mb-1">${assessmentLabel} · Local simulation</p>
        <h1 class="mb-1">${view.run.plan.title}</h1>
        <p class="text-muted mb-0">
          ${view.run.plan.type} · Run ${view.run.id} · Revision ${view.run.revision}
        </p>
      </div>
      ${renderRunControl(view)}
    </header>
    ${renderAvailabilityAlerts(view)} ${renderDiagnostics(view)}
    ${view.assessmentText
      ? html`
          <section class="card mb-4" aria-labelledby="assessment-preview-instructions">
            <div class="card-header">
              <h2 class="h5 mb-0" id="assessment-preview-instructions">Instructions</h2>
            </div>
            <div class="card-body">${renderAssessmentText(view.assessmentText, view.runUrl)}</div>
          </section>
        `
      : ''}
    ${renderLockpointControl(view)}
    <section class="card mb-4" aria-labelledby="assessment-preview-score">
      <div class="card-header">
        <h2 class="h5 mb-0" id="assessment-preview-score">Score</h2>
      </div>
      <div class="card-body">
        ${renderScore(view)}
        <p class="small text-muted mt-2 mb-0">
          Simulated credit:
          ${view.access.creditDateString ??
          (view.access.credit == null ? 'not available' : `${view.access.credit}%`)}
        </p>
      </div>
    </section>
    <section class="mb-4" aria-labelledby="assessment-preview-questions">
      <h2 class="h4" id="assessment-preview-questions">Questions</h2>
      ${renderQuestionList(view)}
    </section>
  `;
}

export function renderAssessmentPreviewDocument(view: AssessmentPreviewDocumentView): string {
  return `<!doctype html>\n${html`
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${view.run.plan.title} | Assessment preview</title>
        <style>
          body {
            color: #212529;
            font-family:
              system-ui,
              -apple-system,
              sans-serif;
            line-height: 1.5;
            margin: 0;
          }
          .container {
            margin-inline: auto;
            max-width: 960px;
            padding: 2rem 1rem;
          }
          a {
            color: #0d6efd;
          }
          .card,
          .alert,
          .list-group-item {
            border: 1px solid #ced4da;
            border-radius: 0.375rem;
            padding: 1rem;
          }
          .card-header {
            border-bottom: 1px solid #ced4da;
            margin: -1rem -1rem 1rem;
            padding: 0.75rem 1rem;
          }
          .list-group {
            display: grid;
            gap: 0.5rem;
            list-style-position: inside;
            padding-left: 0;
          }
          .badge {
            font-size: 0.8rem;
          }
          .btn {
            background: #0d6efd;
            border: 1px solid #0d6efd;
            border-radius: 0.375rem;
            color: white;
            cursor: pointer;
            padding: 0.5rem 0.75rem;
          }
          .btn[disabled] {
            cursor: not-allowed;
            opacity: 0.65;
          }
          .mb-0 {
            margin-bottom: 0;
          }
          .mb-1 {
            margin-bottom: 0.25rem;
          }
          .mb-4 {
            margin-bottom: 1.5rem;
          }
          .mt-2 {
            margin-top: 0.5rem;
          }
          .text-muted {
            color: #6c757d;
          }
        </style>
      </head>
      <body>
        <main class="container">${overviewContents(view)}</main>
      </body>
    </html>
  `.toString()}`;
}

function renderNewVariantControl({
  question,
  slot,
  view,
}: {
  question: AssessmentPreviewQuestionState;
  slot: AssessmentPreviewRun['sample']['selectedSlots'][number];
  view: AssessmentPreviewDocumentView;
}) {
  const canRequestNewVariant =
    view.run.status === 'in_progress' &&
    view.run.plan.type === 'Homework' &&
    slot.grading.kind === 'internal' &&
    !slot.singleVariant &&
    question.open &&
    !question.variant.open &&
    question.accessMode === 'default';
  if (!canRequestNewVariant) return '';

  const disabled = actionsDisabled(view);
  return html`
    <form method="post" action="${normalizeRunUrl(view.runUrl)}/actions">
      <input type="hidden" name="revision" value="${view.run.revision}" />
      <input type="hidden" name="slotId" value="${slot.id}" />
      <button
        type="submit"
        class="btn btn-outline-primary"
        name="action"
        value="new-variant"
        ${disabled ? html`disabled aria-disabled="true"` : ''}
      >
        New variant
      </button>
    </form>
  `;
}

function questionNavigationContents({
  question,
  slot,
  slotIndex,
  view,
}: {
  question: AssessmentPreviewQuestionState;
  slot: AssessmentPreviewRun['sample']['selectedSlots'][number];
  slotIndex: number;
  view: AssessmentPreviewDocumentView;
}) {
  const slots = view.run.sample.selectedSlots;
  const previousSlot = slotIndex === 0 ? null : slots[slotIndex - 1];
  const nextSlot = slotIndex === slots.length - 1 ? null : slots[slotIndex + 1];
  const questionUrl = (slotId: string) =>
    `${normalizeRunUrl(view.runUrl)}/questions/${encodeURIComponent(slotId)}`;

  return html`
    <header class="card mb-3 assessment-preview-question-header">
      <div class="card-body">
        <nav
          class="d-flex flex-wrap align-items-center gap-2 mb-3"
          aria-label="Assessment questions"
        >
          <a class="btn btn-outline-secondary" href="${normalizeRunUrl(view.runUrl)}">
            Assessment overview
          </a>
          ${previousSlot == null
            ? ''
            : html`<a class="btn btn-outline-secondary" href="${questionUrl(previousSlot.id)}">
                Previous
              </a>`}
          ${nextSlot == null
            ? ''
            : html`<a class="btn btn-outline-secondary" href="${questionUrl(nextSlot.id)}">
                Next
              </a>`}
          <span class="ms-auto">Question ${slotIndex + 1} of ${slots.length}</span>
        </nav>
        <div class="d-flex flex-wrap justify-content-between align-items-start gap-3">
          <div>
            <h1 class="h4 mb-1">${slot.title ?? slot.qid}</h1>
            <p class="mb-0">
              <span class="badge ${questionStatusClass(question.status)}">
                ${questionStatusLabel(question.status)}
              </span>
              ${renderQuestionGradingLabel({ question, slot })} · Variant ${question.variant.number}
            </p>
            ${question.accessMode === 'default'
              ? ''
              : html`<p class="small mb-0">${questionAccessLabel(question.accessMode)}</p>`}
          </div>
          <div class="d-flex flex-wrap gap-2">
            ${renderNewVariantControl({ question, slot, view })}
            ${view.run.status === 'in_progress' ? renderFinishControl(view) : ''}
          </div>
        </div>
      </div>
    </header>
  `;
}

export function augmentAssessmentPreviewQuestionDocument({
  questionDocumentHtml,
  slotId,
  ...view
}: AssessmentPreviewQuestionDocumentView): string {
  const slotIndex = view.run.sample.selectedSlots.findIndex((slot) => slot.id === slotId);
  if (slotIndex === -1) throw new Error(`Unknown assessment preview slot "${slotId}".`);
  const slot = view.run.sample.selectedSlots[slotIndex];
  const question = view.run.questions.find((candidate) => candidate.slotId === slotId);
  if (!question) throw new Error(`Assessment preview slot "${slotId}" has no run state.`);

  const bodyStartMatch = /<body\b[^>]*>/i.exec(questionDocumentHtml);
  const bodyEndIndex = questionDocumentHtml.toLowerCase().lastIndexOf('</body>');
  if (!bodyStartMatch || bodyEndIndex < bodyStartMatch.index + bodyStartMatch[0].length) {
    throw new Error('Question renderer must provide a full HTML document with a body.');
  }

  const bodyContentStart = bodyStartMatch.index + bodyStartMatch[0].length;
  const originalBody = questionDocumentHtml.slice(bodyContentStart, bodyEndIndex);
  const canShowQuestion =
    !view.invalidation.invalidated &&
    view.access.authorized &&
    view.access.visibility.showQuestions &&
    view.run.status !== 'not_started' &&
    questionCanBeViewed(question);
  const readOnly =
    !view.access.submittable ||
    questionIsReadOnly(question) ||
    !question.open ||
    !question.variant.open;
  const augmentedBody = html`
    <main class="container py-4 assessment-preview-question-shell">
      ${questionNavigationContents({ question, slot, slotIndex, view })}
      ${renderAvailabilityAlerts(view)} ${renderDiagnostics(view)}
      ${canShowQuestion
        ? readOnly
          ? html`<fieldset disabled aria-label="Read-only question preview">
              ${unsafeHtml(originalBody)}
            </fieldset>`
          : unsafeHtml(originalBody)
        : html`
            <div class="alert alert-secondary" role="status">
              This question is unavailable in the current assessment preview state.
            </div>
          `}
    </main>
  `.toString();

  return `${questionDocumentHtml.slice(0, bodyContentStart)}${augmentedBody}${questionDocumentHtml.slice(bodyEndIndex)}`;
}
