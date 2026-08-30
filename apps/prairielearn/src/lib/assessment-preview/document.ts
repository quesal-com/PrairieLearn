import { type HtmlSafeString, html, unsafeHtml } from '@prairielearn/html';

import { HeadContents } from '../../components/HeadContents.js';
import { Modal } from '../../components/Modal.js';
import { ScorebarHtml } from '../../components/Scorebar.js';
import { formatStudentQuestionTitle } from '../assessment.shared.js';

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
  data?: unknown;
  message: string;
  path?: string;
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
  /** Whether the active render mode can accept assessment submissions and finish-grade the run. */
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

type AssessmentPreviewSampledSlot = AssessmentPreviewRun['sample']['selectedSlots'][number];

function questionDisplayNumber(slot: AssessmentPreviewSampledSlot, slotIndex: number): string {
  return slot.questionNumber.trim() || String(slotIndex + 1);
}

function questionDisplayTitle(
  slot: AssessmentPreviewSampledSlot,
  slotIndex: number,
  plan: Pick<AssessmentPreviewRun['plan'], 'showQuestionTitles' | 'type'>,
): string {
  return formatStudentQuestionTitle({
    assessmentType: plan.type,
    questionNumber: questionDisplayNumber(slot, slotIndex),
    questionTitle: slot.title,
    showQuestionTitles: plan.showQuestionTitles,
  });
}

function questionDisplayStatus(question: AssessmentPreviewQuestionState): {
  className: string;
  label: string;
} {
  if (question.accessMode === 'blocked_lockpoint') {
    return { className: 'text-bg-secondary', label: 'Locked' };
  }
  return {
    className: questionStatusClass(question.status),
    label: questionStatusLabel(question.status),
  };
}

function questionStatusLabel(status: AssessmentPreviewQuestionState['status']): string {
  switch (status) {
    case 'unanswered':
      return 'Unanswered';
    case 'invalid':
      return 'Invalid';
    case 'saved':
      return 'Saved';
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
      return 'text-bg-warning';
    case 'invalid':
      return 'text-bg-danger';
    case 'saved':
      return 'text-bg-info';
    case 'incorrect':
      return 'text-bg-danger';
    case 'correct':
      return 'text-bg-success';
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

function questionReadOnlyReason(
  view: AssessmentPreviewDocumentView,
  question: AssessmentPreviewQuestionState,
): string | null {
  if (!view.access.submittable) {
    return 'The simulated access state makes this question read-only. You can review previous submissions but cannot make new ones.';
  }
  if (question.accessMode === 'read_only_lockpoint') {
    return 'This question is read-only because you advanced past a lockpoint. You can review your previous submissions but cannot make new ones.';
  }
  if (question.accessMode === 'read_only_finished') {
    return 'This question is read-only because the assessment is finished. You can review your previous submissions but cannot make new ones.';
  }
  if (!question.open) {
    return 'This question is closed. You can review its previous submissions but cannot make new ones.';
  }
  if (!question.variant.open) {
    return 'The current variant is closed. Request a new variant to continue.';
  }
  return null;
}

const PREVIEW_DETAILS_MODAL_ID = 'assessmentPreviewDetailsModal';

function diagnosticsForView(
  view: AssessmentPreviewDocumentView,
): AssessmentPreviewDocumentDiagnostic[] {
  return [...(view.diagnostics ?? []), ...view.run.diagnostics];
}

function formatDiagnosticData(data: unknown): string {
  const serialized = JSON.stringify(
    data,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  ) as string | undefined;
  return serialized ?? String(data);
}

function renderCriticalDiagnostics(view: AssessmentPreviewDocumentView) {
  if (!diagnosticsForView(view).some((diagnostic) => diagnostic.severity === 'error')) return '';

  return html`
    <div class="alert alert-danger" role="alert">
      <strong>Preview error:</strong>
      This preview could not be completed. Open Preview details for diagnostic information.
    </div>
  `;
}

function renderPreviewDetailsTrigger(view: AssessmentPreviewDocumentView) {
  const diagnostics = diagnosticsForView(view);
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const unsupportedCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'unsupported',
  ).length;
  const hasErrors = errorCount > 0;
  const diagnosticCounts = [
    errorCount === 0 ? '' : `${errorCount} error${errorCount === 1 ? '' : 's'}`,
    warningCount === 0 ? '' : `${warningCount} warning${warningCount === 1 ? '' : 's'}`,
    unsupportedCount === 0
      ? ''
      : `${unsupportedCount} unsupported issue${unsupportedCount === 1 ? '' : 's'}`,
  ].filter(Boolean);
  const diagnosticLabel =
    diagnosticCounts.length < 3
      ? diagnosticCounts.join(' and ')
      : `${diagnosticCounts.slice(0, -1).join(', ')}, and ${diagnosticCounts.at(-1)}`;
  return html`
    <button
      type="button"
      class="btn btn-outline-secondary"
      data-bs-toggle="modal"
      data-bs-target="#${PREVIEW_DETAILS_MODAL_ID}"
      aria-controls="${PREVIEW_DETAILS_MODAL_ID}"
      aria-haspopup="dialog"
      aria-label="Preview details${diagnostics.length === 0 ? '' : `, ${diagnosticLabel}`}"
    >
      Preview details
      ${diagnostics.length === 0
        ? ''
        : html`<span
            class="badge text-bg-${hasErrors ? 'danger' : 'warning'} ms-1"
            aria-hidden="true"
          >
            ${diagnostics.length}
          </span>`}
    </button>
  `;
}

function renderPreviewDetailsModal(view: AssessmentPreviewDocumentView) {
  const diagnostics = diagnosticsForView(view);
  const accessDescription = !view.access.authorized
    ? 'Denied'
    : view.access.submittable
      ? 'Authorized and submittable'
      : 'Authorized, read only';

  return Modal({
    id: PREVIEW_DETAILS_MODAL_ID,
    title: 'Local preview details',
    form: false,
    body: html`
      <section aria-labelledby="assessment-preview-run-details-heading">
        <h3 class="h5" id="assessment-preview-run-details-heading">Run metadata</h3>
        <p class="mb-1"><strong>Run ID</strong> ${view.run.id}</p>
        <p class="mb-1"><strong>Revision</strong> ${view.run.revision}</p>
        <p class="mb-1"><strong>Sample seed</strong> ${view.run.sample.seed}</p>
        <p class="mb-1"><strong>Run status</strong> ${view.run.status.replaceAll('_', ' ')}</p>
        <p class="mb-1"><strong>Assessment type</strong> ${view.run.plan.type}</p>
        <p class="mb-1"><strong>Access</strong> ${accessDescription}</p>
        <p class="mb-1"><strong>Access source</strong> ${view.access.source}</p>
        <p class="mb-1">
          <strong>Question visibility</strong>
          ${view.access.visibility.showQuestions ? 'Shown' : 'Hidden'}
        </p>
        <p class="mb-1">
          <strong>Score visibility</strong> ${view.access.visibility.showScore ? 'Shown' : 'Hidden'}
        </p>
        <p class="mb-1">
          <strong>Available credit</strong>
          ${view.access.creditDateString ??
          (view.access.credit == null ? 'Not available' : `${view.access.credit}%`)}
        </p>
        <p class="mb-0">
          <strong>Render capability</strong>
          ${view.finishGradingAvailable
            ? 'Full question rendering and finish grading'
            : 'Question-only rendering; finish grading unavailable'}
        </p>
      </section>
      <section class="mt-4" aria-labelledby="assessment-preview-diagnostics-heading">
        <h3 class="h5" id="assessment-preview-diagnostics-heading">Diagnostics</h3>
        ${diagnostics.length === 0
          ? html`<p class="mb-0 text-muted">No preview diagnostics.</p>`
          : html`
              <ul class="list-group list-group-flush">
                ${diagnostics.map(
                  (diagnostic) => html`
                    <li class="list-group-item px-0">
                      <span
                        class="badge text-bg-${diagnostic.severity === 'error'
                          ? 'danger'
                          : 'warning'}"
                      >
                        ${diagnostic.severity}
                      </span>
                      <code>${diagnostic.code}</code>: ${diagnostic.message}
                      ${diagnostic.path == null && diagnostic.slotId == null
                        ? ''
                        : html`
                            <div class="small text-muted mt-1">
                              ${diagnostic.path == null
                                ? ''
                                : html`<span class="me-3"
                                    ><strong>Path:</strong> <code>${diagnostic.path}</code></span
                                  >`}
                              ${diagnostic.slotId == null
                                ? ''
                                : html`<span
                                    ><strong>Slot ID:</strong>
                                    <code>${diagnostic.slotId}</code></span
                                  >`}
                            </div>
                          `}
                      ${diagnostic.data === undefined
                        ? ''
                        : html`
                            <div class="small fw-semibold mt-2">Data</div>
                            <pre
                              class="bg-body-tertiary border rounded p-2 mb-0 text-wrap text-break"
                            ><code>${formatDiagnosticData(diagnostic.data)}</code></pre>
                          `}
                    </li>
                  `,
                )}
              </ul>
            `}
      </section>
    `,
    footer: html`
      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
    `,
  });
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

const FINISH_MODAL_ID = 'assessmentPreviewFinishModal';

function finishDisabled(view: AssessmentPreviewDocumentView): boolean {
  return view.invalidation.invalidated || !view.access.authorized || !view.access.submittable;
}

function questionCountsAsUnanswered(question: AssessmentPreviewQuestionState): boolean {
  return question.status === 'unanswered';
}

function finishActionLabel(view: AssessmentPreviewDocumentView): string {
  return view.run.plan.type === 'Exam' ? 'Finish assessment' : 'Finish preview';
}

function renderFinishControl(view: AssessmentPreviewDocumentView) {
  if (view.finishGradingAvailable) {
    const disabled = finishDisabled(view);
    return html`
      <button
        type="button"
        class="btn btn-danger"
        name="action"
        value="finish"
        ${disabled
          ? html`disabled aria-disabled="true"`
          : html`
              data-bs-toggle="modal" data-bs-target="#${FINISH_MODAL_ID}"
              aria-controls="${FINISH_MODAL_ID}" aria-haspopup="dialog"
            `}
      >
        ${finishActionLabel(view)}
      </button>
    `;
  }
  return html`
    <span class="small text-muted assessment-preview-finish-unavailable">
      Finish grading is unavailable in question-only preview.
    </span>
  `;
}

function renderFinishModal(view: AssessmentPreviewDocumentView) {
  if (view.run.status !== 'in_progress' || !view.finishGradingAvailable) return '';

  const unansweredQuestions = view.run.questions.filter(questionCountsAsUnanswered);
  return Modal({
    id: FINISH_MODAL_ID,
    title: 'All done?',
    formAction: `${normalizeRunUrl(view.runUrl)}/actions`,
    body: html`
      ${unansweredQuestions.length === 0
        ? ''
        : html`
            <div class="alert alert-warning" role="status">
              There are still unanswered questions.
            </div>
          `}
      <p class="text-danger">
        <strong>Warning:</strong> You will not be able to answer any more questions after finishing
        the assessment.
      </p>
      <p class="mb-0">Are you sure you want to finish and close out the assessment?</p>
    `,
    footer: html`
      <input type="hidden" name="revision" value="${view.run.revision}" />
      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
      <button
        type="submit"
        class="btn btn-danger"
        name="action"
        value="finish"
        ${finishDisabled(view) ? html`disabled` : ''}
      >
        ${finishActionLabel(view)}
      </button>
    `,
  });
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

interface AssessmentPreviewLockpointView {
  disabled: boolean;
  disabledReason: string | null;
  label: string;
  plan: Pick<AssessmentPreviewRun['plan'], 'showQuestionTitles' | 'type'>;
  sequenceBlockers: AssessmentPreviewRun['sample']['selectedSlots'];
  zone: AssessmentPreviewRun['sample']['zones'][number];
}

const LOCKPOINT_MODAL_ID = 'assessmentPreviewLockpointModal';
const LOCKPOINT_CONFIRM_ID = 'assessmentPreviewLockpointConfirm';
const LOCKPOINT_SUBMIT_ID = 'assessmentPreviewLockpointSubmit';
const LOCKPOINT_REASON_ID = 'assessmentPreviewLockpointReason';

function nextLockpointView(
  view: AssessmentPreviewDocumentView,
): AssessmentPreviewLockpointView | null {
  if (view.run.status !== 'in_progress') return null;

  const crossedLockpointIds = new Set(view.run.crossedLockpointIds);
  const lockpointZone = [...view.run.sample.zones]
    .filter((zone) => zone.lockpoint && !crossedLockpointIds.has(zone.id))
    .sort((a, b) => a.number - b.number)
    .at(0);
  if (lockpointZone == null) return null;

  const zoneById = new Map(view.run.sample.zones.map((zone) => [zone.id, zone]));
  const questionBySlotId = new Map(
    view.run.questions.map((question) => [question.slotId, question]),
  );
  const sequenceBlockers = view.run.sample.selectedSlots.filter((slot) => {
    const slotZone = zoneById.get(slot.zoneId);
    const question = questionBySlotId.get(slot.id);
    return (
      slotZone != null &&
      slotZone.number < lockpointZone.number &&
      question != null &&
      question.open &&
      question.highestSubmissionScore * 100 < slot.advanceScorePercent
    );
  });
  const disabledReason = view.invalidation.invalidated
    ? 'This preview run is out of date. Create a new run to proceed.'
    : !view.access.authorized
      ? 'Simulated access rules deny this assessment.'
      : !view.access.submittable
        ? 'The simulated access state is read-only.'
        : sequenceBlockers.length > 0
          ? 'The advance-score sequence blocks this lockpoint.'
          : null;
  return {
    disabled: disabledReason != null,
    disabledReason,
    label: lockpointZone.title ?? `zone ${lockpointZone.number}`,
    plan: view.run.plan,
    sequenceBlockers,
    zone: lockpointZone,
  };
}

function renderLockpointRow(lockpoint: AssessmentPreviewLockpointView) {
  const button = html`
    <button
      type="button"
      class="btn btn-warning btn-sm text-nowrap"
      name="action"
      value="cross-lockpoint"
      ${lockpoint.disabled
        ? html`disabled aria-disabled="true" aria-describedby="${LOCKPOINT_REASON_ID}"`
        : html`
            data-bs-toggle="modal" data-bs-target="#${LOCKPOINT_MODAL_ID}"
            aria-controls="${LOCKPOINT_MODAL_ID}" aria-haspopup="dialog"
          `}
    >
      Proceed to next questions
    </button>
  `;

  return html`
    <tr class="${lockpoint.disabled ? 'table-light' : 'table-warning'}">
      <td colspan="4" class="py-2">
        <div
          class="d-flex flex-column flex-sm-row justify-content-between align-items-sm-center gap-2"
        >
          <div class="d-flex">
            <i
              class="fas fa-lock ${lockpoint.disabled
                ? 'text-secondary'
                : 'text-warning'} me-2 mt-1"
              aria-hidden="true"
            ></i>
            <div>
              <span class="fw-bold${lockpoint.disabled ? ' text-muted' : ''}">Next lockpoint</span>
              <small
                class="text-muted d-block"
                ${lockpoint.disabled ? html`id="${LOCKPOINT_REASON_ID}"` : ''}
              >
                ${lockpoint.disabledReason ??
                `Proceed into ${lockpoint.label}. Previous questions will become read-only.`}
              </small>
              ${lockpoint.sequenceBlockers.length === 0
                ? ''
                : html`
                    <ul class="small mb-0">
                      ${lockpoint.sequenceBlockers.map(
                        (slot) => html`
                          <li>
                            ${questionDisplayTitle(slot, slot.displayOrder, lockpoint.plan)}:
                            ${formatPoints(slot.advanceScorePercent)}% advance score required.
                          </li>
                        `,
                      )}
                    </ul>
                  `}
            </div>
          </div>
          ${button}
        </div>
      </td>
    </tr>
  `;
}

function renderLockpointModal(
  view: AssessmentPreviewDocumentView,
  lockpoint: AssessmentPreviewLockpointView | null,
) {
  if (lockpoint == null) return '';

  return Modal({
    id: LOCKPOINT_MODAL_ID,
    title: 'Proceed to next questions?',
    formAction: `${normalizeRunUrl(view.runUrl)}/actions`,
    body: html`
      <p>
        After proceeding into ${lockpoint.label}, you will not be able to submit answers to previous
        questions. You can still review your previous submissions.
      </p>
      ${lockpoint.sequenceBlockers.length === 0
        ? ''
        : html`
            <div class="alert alert-warning" role="status">
              <strong>The advance-score sequence blocks this lockpoint.</strong>
              <ul class="mb-0">
                ${lockpoint.sequenceBlockers.map(
                  (slot) => html`
                    <li>
                      ${questionDisplayTitle(slot, slot.displayOrder, lockpoint.plan)}:
                      ${formatPoints(slot.advanceScorePercent)}% advance score required.
                    </li>
                  `,
                )}
              </ul>
            </div>
          `}
      <div class="form-check">
        <input
          class="form-check-input"
          type="checkbox"
          id="${LOCKPOINT_CONFIRM_ID}"
          required
          ${lockpoint.disabled
            ? html`disabled`
            : html`onchange="document.getElementById('${LOCKPOINT_SUBMIT_ID}').disabled =
              !this.checked"`}
        />
        <label class="form-check-label" for="${LOCKPOINT_CONFIRM_ID}">
          I understand that I will not be able to submit answers to previous questions.
        </label>
      </div>
    `,
    footer: html`
      <input type="hidden" name="revision" value="${view.run.revision}" />
      <input type="hidden" name="zoneId" value="${lockpoint.zone.id}" />
      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
      <button
        id="${LOCKPOINT_SUBMIT_ID}"
        type="submit"
        class="btn btn-warning"
        name="action"
        value="cross-lockpoint"
        disabled
      >
        Confirm
      </button>
    `,
  });
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
    ${question.status === 'saved'
      ? html`<span class="badge text-bg-info">pending</span>`
      : formatPoints(question.autoPoints)}
    / ${formatPoints(slot.points.maxAutoPoints)} auto-graded points
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

function renderQuestionTable(
  view: AssessmentPreviewDocumentView,
  lockpoint: AssessmentPreviewLockpointView | null,
) {
  if (!view.access.visibility.showQuestions) {
    return html`
      <div class="card-body border-top">
        <div class="alert alert-secondary mb-0" role="status">
          The simulated access rules hide assessment questions.
        </div>
      </div>
    `;
  }

  return html`
    <div class="table-responsive">
      <table
        class="table table-sm table-hover mb-0"
        aria-label="Questions"
        data-testid="assessment-questions"
      >
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col">Value</th>
            <th scope="col">Status</th>
            <th scope="col" class="text-end">Awarded points</th>
          </tr>
        </thead>
        ${view.run.sample.zones.map((zone) => {
          const slots = view.run.sample.selectedSlots.filter((slot) => slot.zoneId === zone.id);
          if (slots.length === 0) return '';
          return html`
            <tbody>
              ${lockpoint?.zone.id === zone.id ? renderLockpointRow(lockpoint) : ''}
              ${zone.title == null
                ? ''
                : html`
                    <tr class="table-light">
                      <th colspan="4" scope="rowgroup">${zone.title}</th>
                    </tr>
                  `}
              ${slots.map((slot) => {
                const slotIndex = view.run.sample.selectedSlots.findIndex(
                  (candidate) => candidate.id === slot.id,
                );
                const question = view.run.questions.find(
                  (candidate) => candidate.slotId === slot.id,
                )!;
                const displayStatus = questionDisplayStatus(question);
                const questionUrl = `${normalizeRunUrl(view.runUrl)}/questions/${encodeURIComponent(slot.id)}`;
                const canOpenQuestion =
                  !view.invalidation.invalidated &&
                  view.access.authorized &&
                  view.run.status !== 'not_started' &&
                  questionCanBeViewed(question);
                return html`
                  <tr
                    class="${question.accessMode === 'blocked_sequence' ||
                    question.accessMode === 'blocked_lockpoint'
                      ? 'table-light pl-sequence-locked'
                      : ''}"
                  >
                    <th scope="row">
                      ${canOpenQuestion
                        ? html`<a href="${questionUrl}"
                            >${questionDisplayTitle(slot, slotIndex, view.run.plan)}</a
                          >`
                        : questionDisplayTitle(slot, slotIndex, view.run.plan)}
                      ${question.accessMode === 'default'
                        ? ''
                        : html`<div class="small fw-normal">
                            ${questionAccessLabel(question.accessMode)}
                          </div>`}
                    </th>
                    <td>${formatPoints(question.currentValue ?? slot.points.maxPoints)}</td>
                    <td>
                      ${view.access.visibility.showScore
                        ? html`<span class="badge ${displayStatus.className} rounded-pill">
                            ${displayStatus.label}
                          </span>`
                        : html`<span class="text-muted">Hidden</span>`}
                    </td>
                    <td class="small text-end">
                      ${view.access.visibility.showScore
                        ? renderQuestionGradingLabel({ question, slot })
                        : html`<span class="text-muted">Score hidden</span>`}
                    </td>
                  </tr>
                `;
              })}
            </tbody>
          `;
        })}
      </table>
    </div>
  `;
}

function renderRunStatus(view: AssessmentPreviewDocumentView) {
  switch (view.run.status) {
    case 'not_started':
      return html`<span class="badge text-bg-secondary fs-6">Not started</span>`;
    case 'in_progress':
      return html`<span class="badge text-bg-light text-dark fs-6">In progress</span>`;
    case 'finished':
      return html`<span class="badge text-bg-success fs-6">Finished</span>`;
  }
}

function renderOverviewSummary(view: AssessmentPreviewDocumentView) {
  const { score } = view.run;
  return html`
    <div class="row align-items-center g-3">
      <div class="col-md-3 col-sm-6">
        <strong>Total points:</strong>
        ${!view.access.visibility.showScore
          ? formatPoints(score.maxPoints)
          : score.points == null
            ? html`${formatPoints(score.subtotalPoints)} / ${formatPoints(score.subtotalMaxPoints)}
              resolved (${formatPoints(score.maxPoints)} total)`
            : html`${formatPoints(score.points)} / ${formatPoints(score.maxPoints)}`}
        ${score.maxBonusPoints > 0
          ? html`<div class="small text-muted">
              Up to ${formatPoints(score.maxBonusPoints)} bonus points
            </div>`
          : ''}
      </div>
      <div class="col-md-5 col-sm-6">
        ${view.access.visibility.showScore && score.scorePercent != null
          ? ScorebarHtml(score.scorePercent, { maxWidth: '100%' })
          : renderScore(view)}
      </div>
      <div class="col-md-4 col-sm-12">
        <strong>Available credit:</strong>
        ${view.access.creditDateString ??
        (view.access.credit == null ? 'Not available' : `${view.access.credit}%`)}
      </div>
    </div>
  `;
}

function overviewContents(
  view: AssessmentPreviewDocumentView,
  lockpoint: AssessmentPreviewLockpointView | null,
) {
  const assessmentLabel = `${view.run.plan.assessmentSetAbbreviation}${view.run.plan.number}`;
  return html`
    ${renderAvailabilityAlerts(view)} ${renderCriticalDiagnostics(view)}
    <div class="card mb-4">
      <div
        class="card-header bg-primary text-white d-flex flex-wrap justify-content-between align-items-center gap-3"
      >
        <h1 class="mb-0">${assessmentLabel}: ${view.run.plan.title}</h1>
        ${renderRunStatus(view)}
      </div>
      <div class="card-body">
        ${renderOverviewSummary(view)}
        ${view.assessmentText
          ? html`
              <section
                class="card bg-light mb-0 mt-4"
                aria-labelledby="assessment-preview-instructions"
              >
                <div class="card-body">
                  <h2 class="h5" id="assessment-preview-instructions">Instructions</h2>
                  ${renderAssessmentText(view.assessmentText, view.runUrl)}
                </div>
              </section>
            `
          : ''}
      </div>
      ${renderQuestionTable(view, lockpoint)}
      <div class="card-footer d-flex flex-wrap justify-content-between align-items-center gap-3">
        <div>${renderRunControl(view)}</div>
        ${renderPreviewDetailsTrigger(view)}
      </div>
    </div>
  `;
}

export function renderAssessmentPreviewDocument(view: AssessmentPreviewDocumentView): string {
  const assessmentLabel = `${view.run.plan.assessmentSetAbbreviation}${view.run.plan.number}`;
  const lockpoint = nextLockpointView(view);
  return `<!doctype html>\n${html`
    <html lang="en">
      <head>
        ${HeadContents({
          pageTitle: `${assessmentLabel}: ${view.run.plan.title} (Preview)`,
          resLocals: {},
        })}
      </head>
      <body>
        <main class="container py-4">${overviewContents(view, lockpoint)}</main>
        ${renderPreviewDetailsModal(view)} ${renderFinishModal(view)}
        ${renderLockpointModal(view, lockpoint)}
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

function renderQuestionNavigation({
  slotIndex,
  view,
}: {
  slotIndex: number;
  view: AssessmentPreviewDocumentView;
}) {
  const slots = view.run.sample.selectedSlots;
  const currentSlot = slots[slotIndex];
  const previousSlot = slotIndex === 0 ? null : slots[slotIndex - 1];
  const nextSlot = slotIndex === slots.length - 1 ? null : slots[slotIndex + 1];
  const questionUrl = (slotId: string) =>
    `${normalizeRunUrl(view.runUrl)}/questions/${encodeURIComponent(slotId)}`;
  const control = (
    candidate: (typeof slots)[number] | null,
    label: 'Next question' | 'Previous question',
  ) => {
    const candidateState = view.run.questions.find((question) => question.slotId === candidate?.id);
    if (candidate == null || candidateState == null || !view.access.authorized) {
      return html`<button type="button" class="btn btn-primary disabled" disabled>
        ${label}
      </button>`;
    }
    if (!questionCanBeViewed(candidateState)) {
      const blockedReason =
        candidateState.accessMode === 'blocked_sequence'
          ? currentSlot.advanceScorePercent > 0
            ? `A required score of ${formatPoints(currentSlot.advanceScorePercent)}% must be reached before continuing.`
            : 'The required question score must be reached before continuing.'
          : 'Cross the assessment lockpoint from the assessment overview before continuing.';
      return html`
        <button
          type="button"
          class="btn btn-secondary"
          aria-disabled="true"
          aria-label="${label}. ${blockedReason}"
          data-bs-toggle="popover"
          data-bs-container="body"
          data-bs-placement="auto"
          data-bs-content="${blockedReason}"
        >
          ${label} <i class="fas fa-lock ms-1" aria-hidden="true"></i>
        </button>
      `;
    }
    return html`<a class="btn btn-primary" href="${questionUrl(candidate.id)}">${label}</a>`;
  };

  return html`
    <nav class="d-grid gap-2 mb-4" aria-label="Assessment question navigation">
      <a class="btn btn-info" href="${normalizeRunUrl(view.runUrl)}">Assessment overview</a>
      <div class="d-flex flex-wrap justify-content-center gap-2">
        ${control(previousSlot, 'Previous question')} ${control(nextSlot, 'Next question')}
      </div>
    </nav>
  `;
}

function renderAssessmentScoreCard(view: AssessmentPreviewDocumentView) {
  const assessmentLabel = `${view.run.plan.assessmentSetAbbreviation}${view.run.plan.number}`;
  const { score } = view.run;
  return html`
    <section class="card mb-4" aria-labelledby="assessment-preview-sidebar-title">
      <div class="card-header bg-secondary text-white">
        <h2 class="h5 mb-0" id="assessment-preview-sidebar-title">
          ${assessmentLabel}: ${view.run.plan.title}
        </h2>
      </div>
      <table class="table table-sm mb-0" aria-label="Assessment score">
        <tbody>
          <tr>
            <th scope="row">Total points:</th>
            <td>
              ${!view.access.visibility.showScore
                ? formatPoints(score.maxPoints)
                : score.points == null
                  ? html`${formatPoints(score.subtotalPoints)} /
                    ${formatPoints(score.subtotalMaxPoints)} resolved`
                  : html`${formatPoints(score.points)} / ${formatPoints(score.maxPoints)}`}
            </td>
          </tr>
          ${view.access.visibility.showScore && score.scorePercent != null
            ? html`
                <tr>
                  <th scope="row">Score:</th>
                  <td>${ScorebarHtml(score.scorePercent)}</td>
                </tr>
              `
            : ''}
        </tbody>
      </table>
      ${view.access.visibility.showScore
        ? ''
        : html`<div class="card-footer small">${renderScore(view)}</div>`}
    </section>
  `;
}

function renderQuestionScoreCard({
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
  const awardedPoints = question.autoPoints + (question.manualPoints ?? 0);
  const displayStatus = questionDisplayStatus(question);
  const questionPositionLabel = `Question ${questionDisplayNumber(slot, slotIndex)} of ${view.run.sample.selectedSlots.length}`;
  const scoreIsUnresolved =
    slot.grading.kind === 'unresolved' ||
    (slot.points.maxManualPoints > 0 && question.manualPoints == null);

  return html`
    <section class="card mb-4" aria-labelledby="assessment-preview-question-score-title">
      <div class="card-header bg-secondary text-white">
        <h2 class="h5 mb-0" id="assessment-preview-question-score-title">
          ${questionPositionLabel}
        </h2>
      </div>
      <table class="table table-sm mb-0" aria-label="Question score">
        <tbody>
          ${view.access.visibility.showScore
            ? html`
                <tr>
                  <th scope="row">Status:</th>
                  <td>
                    <span class="badge ${displayStatus.className}">${displayStatus.label}</span>
                  </td>
                </tr>
              `
            : ''}
          <tr>
            <th scope="row">Value:</th>
            <td>${formatPoints(question.currentValue ?? slot.points.maxPoints)}</td>
          </tr>
          <tr>
            <th scope="row">Total points:</th>
            <td>
              ${!view.access.visibility.showScore
                ? html`<span class="text-muted">Score hidden</span>`
                : question.status === 'saved'
                  ? html`<span class="badge text-bg-info">pending</span>
                      <small
                        >/<span class="text-muted"
                          >${formatPoints(slot.points.maxPoints)}</span
                        ></small
                      >`
                  : scoreIsUnresolved
                    ? renderQuestionGradingLabel({ question, slot })
                    : html`${formatPoints(awardedPoints)} / ${formatPoints(slot.points.maxPoints)}`}
            </td>
          </tr>
        </tbody>
      </table>
      ${question.accessMode === 'default'
        ? ''
        : html`<div class="card-footer small">${questionAccessLabel(question.accessMode)}</div>`}
    </section>
  `;
}

function renderQuestionSidebar({
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
  return html`
    <aside class="col-lg-3 col-sm-12" aria-label="Assessment navigation and score">
      ${renderAssessmentScoreCard(view)}
      ${renderQuestionScoreCard({ question, slot, slotIndex, view })}
      ${renderQuestionNavigation({ slotIndex, view })}
      <div class="d-grid gap-2 mb-4">
        ${renderNewVariantControl({ question, slot, view })}
        ${view.run.status === 'in_progress' ? renderFinishControl(view) : ''}
        ${renderPreviewDetailsTrigger(view)}
      </div>
    </aside>
  `;
}

function normalizeQuestionDocument(questionDocumentHtml: string, pageTitle: string): string {
  let normalizedDocument = questionDocumentHtml;
  const htmlStartMatch = /<html\b[^>]*>/i.exec(normalizedDocument);
  if (htmlStartMatch && !/\blang\s*=/i.test(htmlStartMatch[0])) {
    const normalizedHtmlStart = htmlStartMatch[0].replace(/>$/, ' lang="en">');
    normalizedDocument = `${normalizedDocument.slice(0, htmlStartMatch.index)}${normalizedHtmlStart}${normalizedDocument.slice(htmlStartMatch.index + htmlStartMatch[0].length)}`;
  }

  const titleHtml = html`<title>${pageTitle}</title>`.toString();
  const titleMatch = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i.exec(normalizedDocument);
  if (titleMatch) {
    normalizedDocument = `${normalizedDocument.slice(0, titleMatch.index)}${titleHtml}${normalizedDocument.slice(titleMatch.index + titleMatch[0].length)}`;
  } else {
    const headStartMatch = /<head\b[^>]*>/i.exec(normalizedDocument);
    if (headStartMatch) {
      const titleInsertionIndex = headStartMatch.index + headStartMatch[0].length;
      normalizedDocument = `${normalizedDocument.slice(0, titleInsertionIndex)}${titleHtml}${normalizedDocument.slice(titleInsertionIndex)}`;
    }
  }

  const hasBootstrapStyles = normalizedDocument.includes('/bootstrap/dist/css/bootstrap.min.css');
  const hasBootstrapScripts = normalizedDocument.includes(
    '/bootstrap/dist/js/bootstrap.bundle.min.js',
  );
  if (hasBootstrapStyles && hasBootstrapScripts) return normalizedDocument;

  const headContents = HeadContents({ pageTitle, resLocals: {} }).toString();
  const headStartMatch = /<head\b[^>]*>/i.exec(normalizedDocument);
  const headEndIndex = normalizedDocument.toLowerCase().indexOf('</head>');
  if (headStartMatch && headEndIndex >= headStartMatch.index + headStartMatch[0].length) {
    const headContentStart = headStartMatch.index + headStartMatch[0].length;
    const existingHead = normalizedDocument
      .slice(headContentStart, headEndIndex)
      .replaceAll(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '');
    return `${normalizedDocument.slice(0, headContentStart)}${headContents}${existingHead}${normalizedDocument.slice(headEndIndex)}`;
  }

  const normalizedHtmlStartMatch = /<html\b[^>]*>/i.exec(normalizedDocument);
  if (normalizedHtmlStartMatch) {
    const headInsertionIndex = normalizedHtmlStartMatch.index + normalizedHtmlStartMatch[0].length;
    return `${normalizedDocument.slice(0, headInsertionIndex)}<head>${headContents}</head>${normalizedDocument.slice(headInsertionIndex)}`;
  }
  return normalizedDocument;
}

function unwrapSoleOuterMain(bodyHtml: string): string {
  const trimmedBody = bodyHtml.trim();
  const openingMain = /^<main\b[^>]*>/i.exec(trimmedBody);
  if (!openingMain) return bodyHtml;

  const mainTags = /<\/?main\b[^>]*>/gi;
  mainTags.lastIndex = openingMain[0].length;
  let depth = 1;
  for (const match of trimmedBody.matchAll(mainTags)) {
    depth += /^<\/main\b/i.test(match[0]) ? -1 : 1;
    if (depth !== 0) continue;
    if (trimmedBody.slice(match.index + match[0].length).trim() !== '') return bodyHtml;
    return trimmedBody.slice(openingMain[0].length, match.index);
  }
  return bodyHtml;
}

const VOID_HTML_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function bodyHasUsableHeading(bodyHtml: string): boolean {
  const stack: { hidden: boolean; tagName: string }[] = [];
  const tokens = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
  for (const token of bodyHtml.matchAll(tokens)) {
    if (token[0].startsWith('<!--')) continue;
    const tag = /^<(\/)?([a-z][\w:-]*)/i.exec(token[0]);
    if (!tag) continue;
    const tagName = tag[2].toLowerCase();
    if (tag[1]) {
      let matchingIndex = stack.length - 1;
      while (matchingIndex >= 0 && stack[matchingIndex].tagName !== tagName) matchingIndex -= 1;
      if (matchingIndex !== -1) stack.splice(matchingIndex);
      continue;
    }

    const parentHidden = stack.at(-1)?.hidden ?? false;
    const elementHidden =
      parentHidden ||
      tagName === 'script' ||
      tagName === 'template' ||
      /\shidden(?:\s|=|\/?>)/i.test(token[0]) ||
      /\saria-hidden\s*=\s*(?:"true"|'true'|true)(?:\s|\/?>)/i.test(token[0]);
    if (tagName === 'h1' && !elementHidden) return true;
    if (!VOID_HTML_ELEMENTS.has(tagName) && !/\/\s*>$/.test(token[0])) {
      stack.push({ hidden: elementHidden, tagName });
    }
  }
  return false;
}

type GradeButtonAttributeName = 'aria-disabled' | 'class' | 'disabled' | 'name' | 'value';

interface HtmlOpeningTagAttribute {
  name: string;
  value: string | null;
  valueEndIndex: number | null;
  valueStartIndex: number | null;
}

function htmlOpeningTagAttributes(openingTag: string): HtmlOpeningTagAttribute[] {
  const tagName = /^<\s*[a-z][\w:-]*/i.exec(openingTag);
  if (tagName == null) return [];

  const attributes: HtmlOpeningTagAttribute[] = [];
  let cursor = tagName[0].length;
  while (cursor < openingTag.length) {
    while (/\s/.test(openingTag[cursor] ?? '')) cursor += 1;
    if (cursor >= openingTag.length || openingTag[cursor] === '>' || openingTag[cursor] === '/') {
      break;
    }

    const nameStartIndex = cursor;
    while (!/[\s=/>]/.test(openingTag[cursor] ?? '>')) cursor += 1;
    const name = openingTag.slice(nameStartIndex, cursor).toLowerCase();
    while (/\s/.test(openingTag[cursor] ?? '')) cursor += 1;

    let value: string | null = null;
    let valueEndIndex: number | null = null;
    let valueStartIndex: number | null = null;
    if (openingTag[cursor] === '=') {
      cursor += 1;
      while (/\s/.test(openingTag[cursor] ?? '')) cursor += 1;
      const quote = openingTag[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        valueStartIndex = cursor;
        while (cursor < openingTag.length && openingTag[cursor] !== quote) cursor += 1;
        valueEndIndex = cursor;
        value = openingTag.slice(valueStartIndex, valueEndIndex);
        if (openingTag[cursor] === quote) cursor += 1;
      } else {
        valueStartIndex = cursor;
        while (!/[\s>]/.test(openingTag[cursor] ?? '>')) cursor += 1;
        valueEndIndex = cursor;
        value = openingTag.slice(valueStartIndex, valueEndIndex);
      }
    }
    attributes.push({ name, value, valueEndIndex, valueStartIndex });
  }

  return attributes;
}

function openingTagAttribute(
  openingTag: string,
  attributeName: GradeButtonAttributeName,
): HtmlOpeningTagAttribute | null {
  return (
    htmlOpeningTagAttributes(openingTag).find(
      (attribute) => attribute.name === attributeName.toLowerCase(),
    ) ?? null
  );
}

function openingTagAttributeValue(
  openingTag: string,
  attributeName: GradeButtonAttributeName,
): string | null {
  return openingTagAttribute(openingTag, attributeName)?.value ?? null;
}

function transformOpeningTagAttributeValue(
  openingTag: string,
  attributeName: GradeButtonAttributeName,
  transform: (value: string) => string,
): string {
  const attribute = openingTagAttribute(openingTag, attributeName);
  if (
    attribute?.value == null ||
    attribute.valueStartIndex == null ||
    attribute.valueEndIndex == null
  ) {
    return openingTag;
  }
  const transformedValue = transform(attribute.value);
  if (transformedValue === attribute.value) return openingTag;
  return `${openingTag.slice(0, attribute.valueStartIndex)}${transformedValue}${openingTag.slice(
    attribute.valueEndIndex,
  )}`;
}

function openingTagHasAttribute(
  openingTag: string,
  attributeName: GradeButtonAttributeName,
): boolean {
  return openingTagAttribute(openingTag, attributeName) != null;
}

function openingTagHasClass(openingTag: string, className: string): boolean {
  return openingTagAttributeValue(openingTag, 'class')?.split(/\s+/).includes(className) ?? false;
}

function htmlTagEndIndex(htmlSource: string, tagStartIndex: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = tagStartIndex + 1; index < htmlSource.length; index += 1) {
    const character = htmlSource[index];
    if (quote == null && (character === '"' || character === "'")) {
      quote = character;
    } else if (character === quote) {
      quote = null;
    } else if (quote == null && character === '>') {
      return index;
    }
  }
  return null;
}

const RAW_TEXT_HTML_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

function addAssessmentPreviewQuestionIdentity(
  bodyHtml: string,
  revision: number,
  variantNumber: number,
): string {
  const identityFields = html`
    <input
      type="hidden"
      name="__assessment_preview_revision"
      value="${revision}"
      data-skip-unload-check="true"
    />
    <input
      type="hidden"
      name="__assessment_preview_variant_number"
      value="${variantNumber}"
      data-skip-unload-check="true"
    />
  `.toString();
  const output: string[] = [];
  let cursor = 0;
  let templateDepth = 0;

  while (cursor < bodyHtml.length) {
    const tagStartIndex = bodyHtml.indexOf('<', cursor);
    if (tagStartIndex === -1) {
      output.push(bodyHtml.slice(cursor));
      break;
    }
    output.push(bodyHtml.slice(cursor, tagStartIndex));

    if (bodyHtml.startsWith('<!--', tagStartIndex)) {
      const commentEndIndex = bodyHtml.indexOf('-->', tagStartIndex + 4);
      if (commentEndIndex === -1) {
        output.push(bodyHtml.slice(tagStartIndex));
        break;
      }
      cursor = commentEndIndex + 3;
      output.push(bodyHtml.slice(tagStartIndex, cursor));
      continue;
    }

    const tag = /^<\s*(\/)?\s*([a-z][\w:-]*)/i.exec(bodyHtml.slice(tagStartIndex));
    if (!tag) {
      output.push('<');
      cursor = tagStartIndex + 1;
      continue;
    }
    const tagEndIndex = htmlTagEndIndex(bodyHtml, tagStartIndex);
    if (tagEndIndex == null) {
      output.push(bodyHtml.slice(tagStartIndex));
      break;
    }

    const tagName = tag[2].toLowerCase();
    const tagHtml = bodyHtml.slice(tagStartIndex, tagEndIndex + 1);
    const closing = tag[1] === '/';
    const selfClosing = /\/\s*>$/.test(tagHtml);
    output.push(tagHtml);
    cursor = tagEndIndex + 1;

    if (closing) {
      if (tagName === 'template' && templateDepth > 0) templateDepth -= 1;
      continue;
    }
    if (tagName === 'form' && templateDepth === 0 && openingTagHasClass(tagHtml, 'question-form')) {
      output.push(identityFields);
    }
    if (tagName === 'template' && !selfClosing) {
      templateDepth += 1;
      continue;
    }
    if (!RAW_TEXT_HTML_ELEMENTS.has(tagName) || selfClosing) continue;

    const closingTag = new RegExp(`</${tagName}\\s*>`, 'gi');
    closingTag.lastIndex = cursor;
    const closingMatch = closingTag.exec(bodyHtml);
    if (closingMatch == null) {
      output.push(bodyHtml.slice(cursor));
      break;
    }
    cursor = closingMatch.index + closingMatch[0].length;
    output.push(bodyHtml.slice(tagEndIndex + 1, cursor));
  }

  return output.join('');
}

function replaceRenderedQuestionHeading(bodyHtml: string, heading: string): string {
  const stack: { hidden: boolean; insideQuestionBlock: boolean; tagName: string }[] = [];
  const tokens = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
  for (const token of bodyHtml.matchAll(tokens)) {
    if (token[0].startsWith('<!--')) continue;
    const tag = /^<(\/)?([a-z][\w:-]*)/i.exec(token[0]);
    if (!tag) continue;
    const tagName = tag[2].toLowerCase();
    if (tag[1]) {
      let matchingIndex = stack.length - 1;
      while (matchingIndex >= 0 && stack[matchingIndex].tagName !== tagName) matchingIndex -= 1;
      if (matchingIndex !== -1) stack.splice(matchingIndex);
      continue;
    }

    const parent = stack.at(-1);
    const hidden =
      (parent?.hidden ?? false) ||
      tagName === 'script' ||
      tagName === 'template' ||
      /\shidden(?:\s|=|\/?>)/i.test(token[0]) ||
      /\saria-hidden\s*=\s*(?:"true"|'true'|true)(?:\s|\/?>)/i.test(token[0]);
    const insideQuestionBlock =
      (parent?.insideQuestionBlock ?? false) || openingTagHasClass(token[0], 'question-block');
    if (tagName === 'h1' && !hidden && insideQuestionBlock) {
      const closingHeading = /<\/h1\s*>/gi;
      closingHeading.lastIndex = token.index + token[0].length;
      const closingMatch = closingHeading.exec(bodyHtml);
      if (!closingMatch) return bodyHtml;
      const contentStart = token.index + token[0].length;
      const escapedHeading = html`${heading}`.toString();
      return `${bodyHtml.slice(0, contentStart)}${escapedHeading}${bodyHtml.slice(closingMatch.index)}`;
    }
    if (!VOID_HTML_ELEMENTS.has(tagName) && !/\/\s*>$/.test(token[0])) {
      stack.push({ hidden, insideQuestionBlock, tagName });
    }
  }
  return bodyHtml;
}

interface QuestionGradingUiState {
  deferred: boolean;
  rateLimitMinutes: number | null;
  submissionAvailable: boolean;
  unresolvedGradingMethod: 'External' | 'Manual' | 'missing' | 'shared' | null;
}

function questionGradingUiState({
  question,
  slot,
  view,
}: {
  question: AssessmentPreviewQuestionState;
  slot: AssessmentPreviewSampledSlot;
  view: AssessmentPreviewDocumentView;
}): QuestionGradingUiState {
  if (slot.grading.kind === 'unresolved') {
    return {
      deferred: false,
      rateLimitMinutes: null,
      submissionAvailable: view.finishGradingAvailable,
      unresolvedGradingMethod: slot.grading.method,
    };
  }
  if (!slot.allowRealTimeGrading) {
    return {
      deferred: true,
      rateLimitMinutes: null,
      submissionAvailable: view.finishGradingAvailable,
      unresolvedGradingMethod: null,
    };
  }
  if (question.lastGradableAtMs == null || slot.gradeRateMinutes <= 0) {
    return {
      deferred: false,
      rateLimitMinutes: null,
      submissionAvailable: view.finishGradingAvailable,
      unresolvedGradingMethod: null,
    };
  }
  const waitMs = question.lastGradableAtMs + slot.gradeRateMinutes * 60_000 - view.run.facts.nowMs;
  return {
    deferred: false,
    rateLimitMinutes: waitMs > 0 ? Math.ceil(waitMs / 60_000) : null,
    submissionAvailable: view.finishGradingAvailable,
    unresolvedGradingMethod: null,
  };
}

function replaceOpeningTagClassToken(
  openingTag: string,
  originalClass: string,
  replacementClass: string,
): string {
  return transformOpeningTagAttributeValue(openingTag, 'class', (classes) =>
    classes
      .split(/(\s+)/)
      .map((classToken) => (classToken === originalClass ? replacementClass : classToken))
      .join(''),
  );
}

function disableButtonOpeningTag(openingTag: string): string {
  let disabledOpeningTag = openingTag;
  if (!openingTagHasAttribute(disabledOpeningTag, 'disabled')) {
    disabledOpeningTag = disabledOpeningTag.replace(/>$/, ' disabled>');
  }
  if (!openingTagHasAttribute(disabledOpeningTag, 'aria-disabled')) {
    disabledOpeningTag = disabledOpeningTag.replace(/>$/, ' aria-disabled="true">');
  } else {
    disabledOpeningTag = transformOpeningTagAttributeValue(
      disabledOpeningTag,
      'aria-disabled',
      () => 'true',
    );
  }
  return disabledOpeningTag;
}

interface HtmlClosingTagRange {
  endIndex: number;
  startIndex: number;
}

function findHtmlElementClosingTag(
  htmlSource: string,
  elementName: string,
  contentStartIndex: number,
): HtmlClosingTagRange | null {
  let cursor = contentStartIndex;
  let elementDepth = 1;
  let templateDepth = 0;

  while (cursor < htmlSource.length) {
    const tagStartIndex = htmlSource.indexOf('<', cursor);
    if (tagStartIndex === -1) return null;

    if (htmlSource.startsWith('<!--', tagStartIndex)) {
      const commentEndIndex = htmlSource.indexOf('-->', tagStartIndex + 4);
      if (commentEndIndex === -1) return null;
      cursor = commentEndIndex + 3;
      continue;
    }

    const tag = /^<\s*(\/)?\s*([a-z][\w:-]*)/i.exec(htmlSource.slice(tagStartIndex));
    if (!tag) {
      cursor = tagStartIndex + 1;
      continue;
    }
    const tagEndIndex = htmlTagEndIndex(htmlSource, tagStartIndex);
    if (tagEndIndex == null) return null;

    const tagName = tag[2].toLowerCase();
    const tagHtml = htmlSource.slice(tagStartIndex, tagEndIndex + 1);
    const closing = tag[1] === '/';
    const selfClosing = /\/\s*>$/.test(tagHtml);
    cursor = tagEndIndex + 1;

    if (closing) {
      if (tagName === 'template' && templateDepth > 0) {
        templateDepth -= 1;
      } else if (templateDepth === 0 && tagName === elementName) {
        elementDepth -= 1;
        if (elementDepth === 0) {
          return { endIndex: tagEndIndex + 1, startIndex: tagStartIndex };
        }
      }
      continue;
    }

    if (tagName === 'template' && !selfClosing) {
      templateDepth += 1;
      continue;
    }
    if (templateDepth === 0 && tagName === elementName && !selfClosing) {
      elementDepth += 1;
    }
    if (!RAW_TEXT_HTML_ELEMENTS.has(tagName) || selfClosing) continue;

    const closingTag = new RegExp(`</${tagName}\\s*>`, 'gi');
    closingTag.lastIndex = cursor;
    const closingMatch = closingTag.exec(htmlSource);
    if (closingMatch == null) return null;
    cursor = closingMatch.index + closingMatch[0].length;
  }

  return null;
}

function transformGradeButton(
  openingTag: string,
  buttonContents: string,
  gradingUiState: QuestionGradingUiState,
): string | null {
  const hasExplicitGradeAction =
    openingTagAttributeValue(openingTag, 'name') === '__action' &&
    openingTagAttributeValue(openingTag, 'value') === 'grade';
  const isGradeAction = hasExplicitGradeAction || openingTagHasClass(openingTag, 'question-grade');
  if (!isGradeAction) return null;

  let saveOpeningTag = hasExplicitGradeAction
    ? transformOpeningTagAttributeValue(openingTag, 'value', (value) =>
        value === 'grade' ? 'save' : value,
      )
    : openingTag;
  saveOpeningTag = replaceOpeningTagClassToken(saveOpeningTag, 'question-grade', 'question-save');
  saveOpeningTag = replaceOpeningTagClassToken(saveOpeningTag, 'btn-primary', 'btn-info');

  if (!gradingUiState.submissionAvailable) {
    return `${disableButtonOpeningTag(saveOpeningTag)}Saving unavailable</button>`;
  }

  if (gradingUiState.deferred) {
    return `${saveOpeningTag}Save</button>`;
  }

  const gradeOpeningTag =
    gradingUiState.rateLimitMinutes == null ? openingTag : disableButtonOpeningTag(openingTag);
  return `${saveOpeningTag}Save only</button> ${gradeOpeningTag}${buttonContents}</button>`;
}

function transformGradeButtons(bodyHtml: string, gradingUiState: QuestionGradingUiState): string {
  const output: string[] = [];
  let cursor = 0;
  let templateDepth = 0;

  while (cursor < bodyHtml.length) {
    const tagStartIndex = bodyHtml.indexOf('<', cursor);
    if (tagStartIndex === -1) {
      output.push(bodyHtml.slice(cursor));
      break;
    }
    output.push(bodyHtml.slice(cursor, tagStartIndex));

    if (bodyHtml.startsWith('<!--', tagStartIndex)) {
      const commentEndIndex = bodyHtml.indexOf('-->', tagStartIndex + 4);
      if (commentEndIndex === -1) {
        output.push(bodyHtml.slice(tagStartIndex));
        break;
      }
      cursor = commentEndIndex + 3;
      output.push(bodyHtml.slice(tagStartIndex, cursor));
      continue;
    }

    const tag = /^<\s*(\/)?\s*([a-z][\w:-]*)/i.exec(bodyHtml.slice(tagStartIndex));
    if (!tag) {
      output.push('<');
      cursor = tagStartIndex + 1;
      continue;
    }
    const tagEndIndex = htmlTagEndIndex(bodyHtml, tagStartIndex);
    if (tagEndIndex == null) {
      output.push(bodyHtml.slice(tagStartIndex));
      break;
    }

    const tagName = tag[2].toLowerCase();
    const tagHtml = bodyHtml.slice(tagStartIndex, tagEndIndex + 1);
    const closing = tag[1] === '/';
    const selfClosing = /\/\s*>$/.test(tagHtml);
    cursor = tagEndIndex + 1;

    if (closing) {
      output.push(tagHtml);
      if (tagName === 'template' && templateDepth > 0) templateDepth -= 1;
      continue;
    }
    if (tagName === 'template' && !selfClosing) {
      output.push(tagHtml);
      templateDepth += 1;
      continue;
    }
    if (tagName === 'button' && templateDepth === 0 && !selfClosing) {
      const closingTag = findHtmlElementClosingTag(bodyHtml, tagName, cursor);
      if (closingTag != null) {
        const buttonContents = bodyHtml.slice(cursor, closingTag.startIndex);
        const transformedButton = transformGradeButton(tagHtml, buttonContents, gradingUiState);
        if (transformedButton != null) {
          output.push(transformedButton);
          cursor = closingTag.endIndex;
          continue;
        }
      }
    }
    output.push(tagHtml);

    if (!RAW_TEXT_HTML_ELEMENTS.has(tagName) || selfClosing) continue;
    const closingTag = new RegExp(`</${tagName}\\s*>`, 'gi');
    closingTag.lastIndex = cursor;
    const closingMatch = closingTag.exec(bodyHtml);
    if (closingMatch == null) {
      output.push(bodyHtml.slice(cursor));
      break;
    }
    cursor = closingMatch.index + closingMatch[0].length;
    output.push(bodyHtml.slice(tagEndIndex + 1, cursor));
  }

  return output.join('');
}

function renderQuestionGradingNotice(gradingUiState: QuestionGradingUiState, readOnly: boolean) {
  if (gradingUiState.unresolvedGradingMethod != null) {
    const message =
      gradingUiState.unresolvedGradingMethod === 'Manual' ||
      gradingUiState.unresolvedGradingMethod === 'External'
        ? `${gradingUiState.unresolvedGradingMethod} grading is unavailable in local preview.`
        : gradingUiState.unresolvedGradingMethod === 'shared'
          ? 'Shared-question grading is unavailable in local preview.'
          : 'Question grading is unavailable because its metadata could not be loaded.';
    return html`<div class="alert alert-secondary" role="status">${message}</div>`;
  }
  if (!gradingUiState.submissionAvailable) {
    return html`
      <div class="alert alert-secondary" role="status">
        Saving and grading are unavailable in question-only preview.
      </div>
    `;
  }
  if (readOnly) return '';
  if (gradingUiState.deferred) {
    return html`
      <div class="alert alert-info" role="status">
        Your answer will be saved now; grading happens when you finish the assessment.
      </div>
    `;
  }
  if (gradingUiState.rateLimitMinutes != null) {
    return html`
      <div class="alert alert-info" role="status">
        Grade-rate limit active. Grading will be available again in
        ${gradingUiState.rateLimitMinutes}
        ${gradingUiState.rateLimitMinutes === 1 ? 'minute' : 'minutes'}. Your answer can still be
        saved.
      </div>
    `;
  }
  return '';
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

  const normalizedQuestionDocument = normalizeQuestionDocument(
    questionDocumentHtml,
    `${questionDisplayTitle(slot, slotIndex, view.run.plan)} (Preview)`,
  );
  const bodyStartMatch = /<body\b[^>]*>/i.exec(normalizedQuestionDocument);
  const bodyEndIndex = normalizedQuestionDocument.toLowerCase().lastIndexOf('</body>');
  if (!bodyStartMatch || bodyEndIndex < bodyStartMatch.index + bodyStartMatch[0].length) {
    throw new Error('Question renderer must provide a full HTML document with a body.');
  }

  const bodyContentStart = bodyStartMatch.index + bodyStartMatch[0].length;
  const gradingUiState = questionGradingUiState({ question, slot, view });
  const displayTitle = questionDisplayTitle(slot, slotIndex, view.run.plan);
  const originalBody = transformGradeButtons(
    addAssessmentPreviewQuestionIdentity(
      replaceRenderedQuestionHeading(
        unwrapSoleOuterMain(normalizedQuestionDocument.slice(bodyContentStart, bodyEndIndex)),
        displayTitle,
      ),
      view.run.revision,
      question.variant.number,
    ),
    gradingUiState,
  );
  const originalBodyHasHeading = bodyHasUsableHeading(originalBody);
  const canShowQuestion =
    !view.invalidation.invalidated &&
    view.access.authorized &&
    view.access.visibility.showQuestions &&
    view.run.status !== 'not_started' &&
    questionCanBeViewed(question);
  const readOnlyReason = questionReadOnlyReason(view, question);
  const augmentedBody = html`
    <main class="container py-4 assessment-preview-question-shell">
      ${renderAvailabilityAlerts(view)} ${renderCriticalDiagnostics(view)}
      <div class="row">
        <section class="col-lg-9 col-sm-12" role="region" aria-label="Question">
          ${!originalBodyHasHeading || !canShowQuestion
            ? html`<h1 class="h4 mb-3">${displayTitle}</h1>`
            : ''}
          ${canShowQuestion
            ? html`
                ${readOnlyReason == null
                  ? ''
                  : html`
                      <div
                        class="alert alert-warning assessment-preview-read-only-reason"
                        role="status"
                      >
                        ${readOnlyReason}
                      </div>
                    `}
                ${renderQuestionGradingNotice(gradingUiState, readOnlyReason != null)}
                ${readOnlyReason != null
                  ? html`<fieldset disabled aria-label="Read-only question preview">
                      ${unsafeHtml(originalBody)}
                    </fieldset>`
                  : unsafeHtml(originalBody)}
              `
            : html`
                <div class="alert alert-secondary" role="status">
                  This question is unavailable in the current assessment preview state.
                </div>
              `}
        </section>
        ${renderQuestionSidebar({ question, slot, slotIndex, view })}
      </div>
    </main>
    ${renderPreviewDetailsModal(view)} ${renderFinishModal(view)}
  `.toString();

  return `${normalizedQuestionDocument.slice(0, bodyContentStart)}${augmentedBody}${normalizedQuestionDocument.slice(bodyEndIndex)}`;
}
