import {
  type AssessmentPlan,
  type SampledAssessmentPlan,
  type SampledAssessmentPlanSlot,
  sampleAssessmentPlan,
} from './assessment-plan.js';

export interface AssessmentPreviewFacts {
  nowMs: number;
  creditPercent: number;
}

export type AssessmentPreviewRunStatus = 'not_started' | 'in_progress' | 'finished';

export interface AssessmentPreviewVariantState {
  number: number;
  numTries: number;
  open: boolean;
}

export interface AssessmentPreviewQuestionState {
  slotId: string;
  accessMode:
    | 'default'
    | 'blocked_sequence'
    | 'blocked_lockpoint'
    | 'read_only_lockpoint'
    | 'read_only_finished';
  status: 'unanswered' | 'invalid' | 'incorrect' | 'correct' | 'complete';
  open: boolean;
  savedAnswer: unknown;
  autoPoints: number;
  manualPoints: number | null;
  currentValue: number | null;
  pointsList: readonly number[] | null;
  pointsListOriginal: readonly number[] | null;
  variantsPointsList: readonly number[];
  highestSubmissionScore: number;
  numberAttempts: number;
  lastGradableAtMs: number | null;
  variant: AssessmentPreviewVariantState;
}

export interface AssessmentPreviewScore {
  points: number | null;
  scorePercent: number | null;
  subtotalPoints: number;
  subtotalMaxPoints: number;
  maxPoints: number;
  maxBonusPoints: number;
  incomplete: boolean;
  unresolvedSlotIds: readonly string[];
}

export interface AssessmentPreviewRunDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  slotId?: string;
}

export interface AssessmentPreviewRun {
  id: string;
  revision: number;
  plan: AssessmentPlan;
  sample: SampledAssessmentPlan;
  status: AssessmentPreviewRunStatus;
  facts: AssessmentPreviewFacts;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  crossedLockpointIds: readonly string[];
  questions: readonly AssessmentPreviewQuestionState[];
  score: AssessmentPreviewScore;
  diagnostics: readonly AssessmentPreviewRunDiagnostic[];
}

export type AssessmentPreviewRunAction =
  | { type: 'start' }
  | { type: 'finish' }
  | { type: 'save'; slotId: string; answer: unknown }
  | { type: 'new-variant'; slotId: string }
  | {
      type: 'grade';
      slotId: string;
      score: number;
      gradable: boolean;
      answer?: unknown;
      mode?: 'realtime' | 'finish';
    }
  | { type: 'advance-time'; nowMs: number; creditPercent: number }
  | { type: 'cross-lockpoint'; zoneId: string };

function isUnresolved(sample: SampledAssessmentPlan, slotId: string): boolean {
  const slot = sample.selectedSlots.find((candidate) => candidate.id === slotId);
  if (!slot) return true;
  return slot.grading.kind === 'unresolved' || slot.points.maxManualPoints > 0;
}

function computeZoneSubtotalMaxPoints(
  sample: SampledAssessmentPlan,
  zoneId: string,
  unresolvedSlotIds: ReadonlySet<string>,
): number {
  const zone = sample.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) return 0;
  const maximums = sample.selectedSlots
    .filter((slot) => slot.zoneId === zoneId && !unresolvedSlotIds.has(slot.id))
    .map((slot) => slot.points.maxPoints)
    .sort((a, b) => b - a);
  const included = zone.bestQuestions === null ? maximums : maximums.slice(0, zone.bestQuestions);
  const total = included.reduce((sum, value) => sum + value, 0);
  return zone.maxPoints === null ? total : Math.min(total, zone.maxPoints);
}

function computeZoneSubtotalPoints(
  sample: SampledAssessmentPlan,
  zoneId: string,
  questions: readonly AssessmentPreviewQuestionState[],
  unresolvedSlotIds: ReadonlySet<string>,
): number {
  const zone = sample.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) return 0;
  const slotIds = new Set(zone.selectedSlotIds);
  const awardedPoints = questions
    .filter((question) => slotIds.has(question.slotId) && !unresolvedSlotIds.has(question.slotId))
    .map((question) => question.autoPoints + (question.manualPoints ?? 0))
    .sort((a, b) => b - a);
  const included =
    zone.bestQuestions === null ? awardedPoints : awardedPoints.slice(0, zone.bestQuestions);
  const total = included.reduce((sum, value) => sum + value, 0);
  return zone.maxPoints === null ? total : Math.min(total, zone.maxPoints);
}

function computeScore(
  sample: SampledAssessmentPlan,
  questions: readonly AssessmentPreviewQuestionState[],
  creditPercent: number,
): AssessmentPreviewScore {
  const unresolvedSlotIds = new Set(
    questions
      .filter((question) => isUnresolved(sample, question.slotId))
      .map((question) => question.slotId),
  );
  const subtotalPoints = Math.min(
    sample.zones.reduce(
      (sum, zone) => sum + computeZoneSubtotalPoints(sample, zone.id, questions, unresolvedSlotIds),
      0,
    ),
    sample.maxPoints + sample.maxBonusPoints,
  );
  const subtotalMaxPoints = sample.zones.reduce(
    (sum, zone) => sum + computeZoneSubtotalMaxPoints(sample, zone.id, unresolvedSlotIds),
    0,
  );
  const incomplete = unresolvedSlotIds.size > 0;
  const points = incomplete
    ? null
    : Math.min(subtotalPoints, sample.maxPoints + sample.maxBonusPoints);
  let scorePercent = points === null ? null : (points * 100) / (sample.maxPoints || 1);
  if (scorePercent !== null && creditPercent < 100) {
    scorePercent = Math.min(scorePercent, creditPercent);
  } else if (
    scorePercent !== null &&
    points !== null &&
    creditPercent > 100 &&
    points >= sample.maxPoints
  ) {
    scorePercent = (creditPercent * scorePercent) / 100;
  }

  return {
    points,
    scorePercent,
    subtotalPoints,
    subtotalMaxPoints,
    maxPoints: sample.maxPoints,
    maxBonusPoints: sample.maxBonusPoints,
    incomplete,
    unresolvedSlotIds: [...unresolvedSlotIds],
  };
}

function applyQuestionAccessModes({
  sample,
  questions,
  crossedLockpointIds,
  status,
}: {
  sample: SampledAssessmentPlan;
  questions: readonly AssessmentPreviewQuestionState[];
  crossedLockpointIds: readonly string[];
  status: AssessmentPreviewRunStatus;
}): AssessmentPreviewQuestionState[] {
  const questionBySlotId = new Map(questions.map((question) => [question.slotId, question]));
  const zoneById = new Map(sample.zones.map((zone) => [zone.id, zone]));
  const crossed = new Set(crossedLockpointIds);
  const firstUncrossedLockpointNumber = sample.zones
    .filter((zone) => zone.lockpoint && !crossed.has(zone.id))
    .reduce<
      number | null
    >((first, zone) => (first === null ? zone.number : Math.min(first, zone.number)), null);
  const crossedLockpointNumbers = sample.zones
    .filter((zone) => crossed.has(zone.id))
    .map((zone) => zone.number);
  let priorQuestionLocksSequence = false;

  return sample.selectedSlots.map((slot) => {
    const question = questionBySlotId.get(slot.id);
    if (!question) throw new Error(`Missing run state for selected slot "${slot.id}".`);
    const zone = zoneById.get(slot.zoneId);
    if (!zone) throw new Error(`Missing sampled zone "${slot.zoneId}".`);
    const sequenceLocked = priorQuestionLocksSequence;
    priorQuestionLocksSequence =
      priorQuestionLocksSequence ||
      (question.open && question.highestSubmissionScore * 100 < slot.advanceScorePercent);
    const lockpointBlocked =
      firstUncrossedLockpointNumber !== null && zone.number >= firstUncrossedLockpointNumber;
    const lockpointReadOnly = crossedLockpointNumbers.some(
      (lockpointNumber) => lockpointNumber > zone.number,
    );
    const accessMode = (() => {
      if (status === 'finished') return 'read_only_finished' as const;
      if (sequenceLocked) return 'blocked_sequence' as const;
      if (lockpointBlocked) return 'blocked_lockpoint' as const;
      if (lockpointReadOnly) return 'read_only_lockpoint' as const;
      return 'default' as const;
    })();
    return { ...question, accessMode };
  });
}

export function createAssessmentPreviewRun(
  plan: AssessmentPlan,
  seed: string | number,
  facts: AssessmentPreviewFacts,
): AssessmentPreviewRun {
  const { sample } = sampleAssessmentPlan(plan, seed);
  if (!sample) throw new Error('Unable to sample assessment plan without pins.');

  const initialQuestions = sample.selectedSlots.map(
    (slot): AssessmentPreviewQuestionState => ({
      slotId: slot.id,
      accessMode: 'default',
      status: 'unanswered',
      open: true,
      savedAnswer: null,
      autoPoints: 0,
      manualPoints: slot.points.maxManualPoints > 0 ? null : 0,
      currentValue: slot.points.initialValue,
      pointsList: slot.points.attemptValues ? [...slot.points.attemptValues] : null,
      pointsListOriginal: slot.points.attemptValues ? [...slot.points.attemptValues] : null,
      variantsPointsList: [],
      highestSubmissionScore: 0,
      numberAttempts: 0,
      lastGradableAtMs: null,
      variant: { number: 1, numTries: 0, open: true },
    }),
  );
  const questions = applyQuestionAccessModes({
    sample,
    questions: initialQuestions,
    crossedLockpointIds: [],
    status: 'not_started',
  });

  return {
    id: sample.sampleHash,
    revision: 0,
    plan,
    sample,
    status: 'not_started',
    facts: { ...facts },
    startedAtMs: null,
    finishedAtMs: null,
    crossedLockpointIds: [],
    questions,
    score: computeScore(sample, questions, facts.creditPercent),
    diagnostics: [],
  };
}

function gradeHomeworkQuestion({
  plan,
  slot,
  question,
  score,
}: {
  plan: AssessmentPlan;
  slot: SampledAssessmentPlanSlot;
  question: AssessmentPreviewQuestionState;
  score: number;
}): AssessmentPreviewQuestionState {
  const maxAutoPoints = slot.points.maxAutoPoints;
  const maxManualPoints = slot.points.maxManualPoints;
  const highestSubmissionScore = Math.max(question.highestSubmissionScore, score);
  const correct = score >= 1;
  let currentValue = (correct ? question.currentValue : slot.points.initialValue) ?? 0;
  const currentAutoValue = currentValue - maxManualPoints;
  const baseAutoValue = slot.points.initialValue - maxManualPoints;
  const variantsPointsList = [...question.variantsPointsList];
  const previousVariantPoints = variantsPointsList.at(-1) ?? 0;
  const newVariantPoints = score * currentAutoValue;

  if (variantsPointsList.length === 0 || previousVariantPoints >= baseAutoValue) {
    variantsPointsList.push(newVariantPoints);
  } else if (newVariantPoints > previousVariantPoints) {
    variantsPointsList[variantsPointsList.length - 1] = newVariantPoints;
  }

  if (correct && !plan.constantQuestionValue) {
    currentValue = Math.min(currentValue + baseAutoValue, slot.points.maxPoints);
  }

  const autoPoints = Math.min(
    variantsPointsList.reduce((sum, points) => sum + points, 0),
    maxAutoPoints,
  );
  const status = (() => {
    if (autoPoints >= maxAutoPoints && maxManualPoints === 0) return 'complete' as const;
    if (highestSubmissionScore >= 1 && question.status !== 'complete') return 'correct' as const;
    return 'incorrect' as const;
  })();

  return {
    ...question,
    status,
    open: true,
    autoPoints,
    currentValue,
    pointsList: null,
    variantsPointsList,
    highestSubmissionScore,
  };
}

function gradeExamQuestion({
  slot,
  question,
  score,
}: {
  slot: SampledAssessmentPlanSlot;
  question: AssessmentPreviewQuestionState;
  score: number;
}): AssessmentPreviewQuestionState {
  const maxAutoPoints = slot.points.maxAutoPoints;
  const maxManualPoints = slot.points.maxManualPoints;
  const correct = score >= 1;
  const currentAttemptWorth =
    (question.pointsListOriginal?.at(question.numberAttempts) ?? 0) - maxManualPoints;
  const eligibleScoreIncrease = Math.max(0, score - question.highestSubmissionScore);
  const autoPoints =
    correct && currentAttemptWorth === maxAutoPoints
      ? maxAutoPoints
      : question.autoPoints + currentAttemptWorth * eligibleScoreIncrease;
  const highestSubmissionScore = Math.max(question.highestSubmissionScore, score);

  if ((correct && maxManualPoints === 0) || (question.pointsList?.length ?? 0) <= 1) {
    return {
      ...question,
      open: false,
      status: 'complete',
      autoPoints,
      highestSubmissionScore,
      currentValue: null,
      pointsList: [],
    };
  }

  return {
    ...question,
    open: true,
    status: correct ? 'correct' : 'incorrect',
    autoPoints,
    highestSubmissionScore,
    currentValue: question.pointsList?.[0] ?? null,
    pointsList:
      question.pointsListOriginal
        ?.slice(question.numberAttempts + 1)
        .map(
          (points) => (points - maxManualPoints) * (1 - highestSubmissionScore) + maxManualPoints,
        ) ?? [],
  };
}

function rejectAction(
  state: AssessmentPreviewRun,
  diagnostic: AssessmentPreviewRunDiagnostic,
): AssessmentPreviewRun {
  return {
    ...state,
    revision: state.revision + 1,
    diagnostics: [...state.diagnostics, diagnostic],
  };
}

export function reduceAssessmentPreviewRun(
  state: AssessmentPreviewRun,
  action: AssessmentPreviewRunAction,
): AssessmentPreviewRun {
  switch (action.type) {
    case 'start':
      if (state.status !== 'not_started') {
        return rejectAction(state, {
          code: 'run-already-started',
          severity: 'warning',
          message: 'The assessment preview run has already started.',
        });
      }
      return {
        ...state,
        revision: state.revision + 1,
        status: 'in_progress',
        startedAtMs: state.facts.nowMs,
      };

    case 'finish': {
      if (state.status !== 'in_progress') {
        return rejectAction(state, {
          code: 'run-not-in-progress',
          severity: 'error',
          message: 'Only an in-progress assessment preview run can be finished.',
        });
      }
      const status = 'finished' as const;
      const closedQuestions = state.questions.map((question) => ({
        ...question,
        open: false,
        variant: { ...question.variant, open: false },
      }));
      return {
        ...state,
        finishedAtMs: state.facts.nowMs,
        questions: applyQuestionAccessModes({
          crossedLockpointIds: state.crossedLockpointIds,
          questions: closedQuestions,
          sample: state.sample,
          status,
        }),
        revision: state.revision + 1,
        status,
      };
    }

    case 'save': {
      if (state.status !== 'in_progress') {
        return rejectAction(state, {
          code: 'run-not-in-progress',
          severity: 'error',
          message: 'Answers can only be saved while the assessment preview run is in progress.',
          slotId: action.slotId,
        });
      }
      const questionIndex = state.questions.findIndex(
        (question) => question.slotId === action.slotId,
      );
      if (questionIndex === -1) {
        return rejectAction(state, {
          code: 'unknown-slot',
          severity: 'error',
          message: `No selected assessment question has slot ID "${action.slotId}".`,
          slotId: action.slotId,
        });
      }
      const question = state.questions[questionIndex];
      if (question.accessMode !== 'default' || !question.open || !question.variant.open) {
        return rejectAction(state, {
          code: 'question-not-editable',
          severity: 'warning',
          message: 'This question is not currently editable.',
          slotId: action.slotId,
        });
      }
      const questions = [...state.questions];
      questions[questionIndex] = {
        ...question,
        savedAnswer: action.answer,
      };
      return { ...state, revision: state.revision + 1, questions };
    }

    case 'new-variant': {
      if (state.status !== 'in_progress') {
        return rejectAction(state, {
          code: 'run-not-in-progress',
          severity: 'error',
          message: 'A new variant can only be requested while the run is in progress.',
          slotId: action.slotId,
        });
      }
      const questionIndex = state.questions.findIndex(
        (question) => question.slotId === action.slotId,
      );
      const slot = state.sample.selectedSlots.find((candidate) => candidate.id === action.slotId);
      if (questionIndex === -1 || !slot) {
        return rejectAction(state, {
          code: 'unknown-slot',
          severity: 'error',
          message: `No selected assessment question has slot ID "${action.slotId}".`,
          slotId: action.slotId,
        });
      }
      const question = state.questions[questionIndex];
      if (state.plan.type !== 'Homework' || slot.singleVariant || !question.open) {
        return rejectAction(state, {
          code: 'new-variant-unavailable',
          severity: 'warning',
          message: 'This question does not allow another variant.',
          slotId: action.slotId,
        });
      }
      if (question.accessMode !== 'default') {
        return rejectAction(state, {
          code: 'question-not-editable',
          severity: 'warning',
          message: 'This question is not currently editable.',
          slotId: action.slotId,
        });
      }
      if (question.variant.open) {
        return rejectAction(state, {
          code: 'variant-still-open',
          severity: 'warning',
          message: 'The current variant must be completed before requesting another one.',
          slotId: action.slotId,
        });
      }
      const questions = [...state.questions];
      questions[questionIndex] = {
        ...question,
        savedAnswer: null,
        variant: { number: question.variant.number + 1, numTries: 0, open: true },
      };
      return { ...state, revision: state.revision + 1, questions };
    }

    case 'grade': {
      if (state.status !== 'in_progress') {
        return rejectAction(state, {
          code: 'run-not-in-progress',
          severity: 'error',
          message: 'Answers can only be graded while the assessment preview run is in progress.',
          slotId: action.slotId,
        });
      }
      const questionIndex = state.questions.findIndex(
        (question) => question.slotId === action.slotId,
      );
      const slot = state.sample.selectedSlots.find((candidate) => candidate.id === action.slotId);
      if (questionIndex === -1 || !slot) {
        return rejectAction(state, {
          code: 'unknown-slot',
          severity: 'error',
          message: `No selected assessment question has slot ID "${action.slotId}".`,
          slotId: action.slotId,
        });
      }
      if (slot.grading.kind !== 'internal') {
        return rejectAction(state, {
          code: 'grading-unresolved',
          severity: 'warning',
          message: `The preview cannot execute ${slot.grading.method} grading for this question.`,
          slotId: action.slotId,
        });
      }
      const mode = action.mode ?? 'realtime';
      if (!slot.allowRealTimeGrading && mode === 'realtime') {
        return rejectAction(state, {
          code: 'real-time-grading-disabled',
          severity: 'warning',
          message: 'This question is graded only when the assessment is finished.',
          slotId: action.slotId,
        });
      }

      let question = state.questions[questionIndex];
      if (
        mode === 'realtime' &&
        (question.accessMode !== 'default' || !question.open || !question.variant.open)
      ) {
        return rejectAction(state, {
          code: 'question-not-editable',
          severity: 'warning',
          message: 'This question is not currently editable.',
          slotId: action.slotId,
        });
      }
      const nextAllowedAtMs =
        question.lastGradableAtMs === null
          ? null
          : question.lastGradableAtMs + slot.gradeRateMinutes * 60_000;
      if (mode === 'realtime' && nextAllowedAtMs !== null && state.facts.nowMs < nextAllowedAtMs) {
        return rejectAction(state, {
          code: 'grade-rate-limited',
          severity: 'warning',
          message: `This question can be graded again at ${nextAllowedAtMs}.`,
          slotId: action.slotId,
        });
      }

      if (action.answer !== undefined) question = { ...question, savedAnswer: action.answer };
      if (!action.gradable) {
        const questions = [...state.questions];
        questions[questionIndex] = { ...question, status: 'invalid' };
        return { ...state, revision: state.revision + 1, questions };
      }

      if (state.plan.type === 'Homework') {
        question = gradeHomeworkQuestion({ plan: state.plan, slot, question, score: action.score });
      } else {
        question = gradeExamQuestion({ slot, question, score: action.score });
      }
      const numTries = question.variant.numTries + 1;
      const closeVariant =
        state.plan.type === 'Homework' &&
        !slot.singleVariant &&
        (numTries >= slot.triesPerVariant || action.score >= 1);
      question = {
        ...question,
        numberAttempts: question.numberAttempts + 1,
        lastGradableAtMs: state.facts.nowMs,
        variant: {
          ...question.variant,
          numTries,
          open: closeVariant ? false : question.variant.open,
        },
      };

      const questions = [...state.questions];
      questions[questionIndex] = question;
      const questionsWithAccess = applyQuestionAccessModes({
        sample: state.sample,
        questions,
        crossedLockpointIds: state.crossedLockpointIds,
        status: state.status,
      });
      return {
        ...state,
        revision: state.revision + 1,
        questions: questionsWithAccess,
        score: computeScore(state.sample, questionsWithAccess, state.facts.creditPercent),
      };
    }

    case 'advance-time':
      if (action.nowMs < state.facts.nowMs) {
        return rejectAction(state, {
          code: 'time-cannot-move-backward',
          severity: 'error',
          message: 'Assessment preview time can only move forward.',
        });
      }
      return {
        ...state,
        revision: state.revision + 1,
        facts: { nowMs: action.nowMs, creditPercent: action.creditPercent },
        score: computeScore(state.sample, state.questions, action.creditPercent),
      };

    case 'cross-lockpoint': {
      if (state.status !== 'in_progress') {
        return rejectAction(state, {
          code: 'run-not-in-progress',
          severity: 'error',
          message: 'Lockpoints can only be crossed while the run is in progress.',
        });
      }
      const zone = state.sample.zones.find((candidate) => candidate.id === action.zoneId);
      if (!zone?.lockpoint) {
        return rejectAction(state, {
          code: 'unknown-lockpoint',
          severity: 'error',
          message: `Zone "${action.zoneId}" is not a lockpoint.`,
        });
      }
      const crossed = new Set(state.crossedLockpointIds);
      const hasEarlierUncrossedLockpoint = state.sample.zones.some(
        (candidate) =>
          candidate.lockpoint && candidate.number < zone.number && !crossed.has(candidate.id),
      );
      if (hasEarlierUncrossedLockpoint) {
        return rejectAction(state, {
          code: 'earlier-lockpoint-not-crossed',
          severity: 'warning',
          message: 'Earlier lockpoints must be crossed first.',
        });
      }
      const questionBySlotId = new Map(
        state.questions.map((question) => [question.slotId, question]),
      );
      const priorQuestionBlocks = state.sample.selectedSlots.some((slot) => {
        const slotZone = state.sample.zones.find((candidate) => candidate.id === slot.zoneId);
        const question = questionBySlotId.get(slot.id);
        return (
          slotZone !== undefined &&
          slotZone.number < zone.number &&
          question !== undefined &&
          question.open &&
          question.highestSubmissionScore * 100 < slot.advanceScorePercent
        );
      });
      if (priorQuestionBlocks) {
        return rejectAction(state, {
          code: 'lockpoint-sequence-blocked',
          severity: 'warning',
          message: 'A prior question has not met its advance score threshold.',
        });
      }

      const crossedLockpointIds = crossed.has(zone.id)
        ? state.crossedLockpointIds
        : [...state.crossedLockpointIds, zone.id];
      return {
        ...state,
        revision: state.revision + 1,
        crossedLockpointIds,
        questions: applyQuestionAccessModes({
          sample: state.sample,
          questions: state.questions,
          crossedLockpointIds,
          status: state.status,
        }),
      };
    }
  }
}
