import { createHash } from 'node:crypto';

import type {
  AssessmentJson,
  QuestionPreferences,
  QuestionPreferencesSchemaJson,
} from '../../schemas/index.js';
import { isDraftQid } from '../draft-question.js';
import { extractDefaultPreferences } from '../question-preferences.js';
import { validatePreferencesSchema } from '../question-settings/validation.js';

export type AssessmentPlanDiagnosticSeverity = 'error' | 'warning' | 'unsupported';

export interface AssessmentPlanDiagnostic {
  code: string;
  severity: AssessmentPlanDiagnosticSeverity;
  message: string;
  path: string;
  slotId?: string;
}

export interface AssessmentPlanQuestionMetadata {
  uuid: string;
  title: string;
  gradingMethod: 'Internal' | 'External' | 'Manual';
  singleVariant: boolean;
  preferencesSchema?: QuestionPreferencesSchemaJson;
}

export interface CompileAssessmentPlanInput {
  assessment: AssessmentJson;
  course: {
    timezone: string;
    assessmentSetAbbreviation: string;
  };
  questions: Readonly<Record<string, AssessmentPlanQuestionMetadata | undefined>>;
}

export interface AssessmentPlanQuestionPoints {
  initialValue: number;
  maxAutoPoints: number;
  maxManualPoints: number;
  maxPoints: number;
  attemptValues: readonly number[] | null;
}

export type AssessmentPlanQuestionGrading =
  | { kind: 'internal' }
  | { kind: 'unresolved'; method: 'External' | 'Manual' | 'missing' | 'shared' };

export interface AssessmentPlanSlot {
  id: string;
  qid: string;
  questionUuid: string | null;
  title: string | null;
  sourceNumber: number;
  grading: AssessmentPlanQuestionGrading;
  singleVariant: boolean;
  points: AssessmentPlanQuestionPoints;
  triesPerVariant: number;
  allowRealTimeGrading: boolean;
  gradeRateMinutes: number;
  advanceScorePercent: number;
  preferences: Readonly<QuestionPreferences>;
}

export interface AssessmentPlanPool {
  id: string;
  number: number;
  numberChoose: number | null;
  alternatives: readonly AssessmentPlanSlot[];
}

export interface AssessmentPlanZone {
  id: string;
  number: number;
  title: string | null;
  numberChoose: number | null;
  bestQuestions: number | null;
  maxPoints: number | null;
  lockpoint: boolean;
  pools: readonly AssessmentPlanPool[];
}

export interface AssessmentPlan {
  id: string;
  definitionHash: string;
  type: 'Homework' | 'Exam';
  title: string;
  number: string;
  assessmentSet: string;
  assessmentSetAbbreviation: string;
  courseTimezone: string;
  shuffleQuestions: boolean;
  requireHonorCode: boolean;
  honorCode: string | null;
  constantQuestionValue: boolean;
  configuredMaxPoints: number | null;
  maxBonusPoints: number;
  zones: readonly AssessmentPlanZone[];
  validationErrors?: readonly AssessmentPlanDiagnostic[];
}

export interface CompileAssessmentPlanResult {
  plan: AssessmentPlan;
  diagnostics: readonly AssessmentPlanDiagnostic[];
}

export type AssessmentSampleSeed = string | number;

export interface AssessmentSamplingPins {
  slotIds: readonly string[];
}

export interface SampledAssessmentPlanSlot extends AssessmentPlanSlot {
  zoneId: string;
  poolId: string;
  poolRank: number;
  displayOrder: number;
  questionNumber: string;
}

export interface SampledAssessmentPlanZone {
  id: string;
  number: number;
  title: string | null;
  bestQuestions: number | null;
  maxPoints: number | null;
  lockpoint: boolean;
  selectedSlotIds: readonly string[];
  selectedMaxPoints: number;
}

export interface SampledAssessmentPlan {
  assessmentId: string;
  definitionHash: string;
  sampleHash: string;
  seed: string;
  selectedSlots: readonly SampledAssessmentPlanSlot[];
  zones: readonly SampledAssessmentPlanZone[];
  maxPoints: number;
  maxBonusPoints: number;
}

export interface SampleAssessmentPlanResult {
  sample: SampledAssessmentPlan | null;
  diagnostics: readonly AssessmentPlanDiagnostic[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function deterministicRank(seed: string, scope: string, id: string): string {
  return stableHash([seed, scope, id]);
}

function compilePreferences(
  schema: QuestionPreferencesSchemaJson | undefined,
  overrides: QuestionPreferences | undefined,
): { errors: string[]; preferences: QuestionPreferences } {
  if (schema == null) {
    return {
      errors:
        overrides != null && Object.keys(overrides).length > 0
          ? ['does not define a preferences schema, but assessment preferences were provided']
          : [],
      preferences: {},
    };
  }

  const preferences = { ...extractDefaultPreferences(schema), ...overrides };
  const errors = validatePreferencesSchema(schema);
  if (errors.length > 0) return { errors, preferences };

  for (const key of Object.keys(overrides ?? {})) {
    if (!(key in schema)) errors.push(`preferences.${key} is not defined by the question`);
  }
  for (const [key, field] of Object.entries(schema)) {
    const value = preferences[key];
    if (typeof value !== field.type) {
      errors.push(`preferences.${key} must be a ${field.type}`);
      continue;
    }
    if (field.enum != null && !field.enum.includes(value as string | number)) {
      errors.push(`preferences.${key} must be one of: ${field.enum.join(', ')}`);
    }
  }
  return { errors, preferences };
}

function asPointList(points: number | number[]): readonly number[] {
  return Array.isArray(points) ? points : [points];
}

function compileQuestionPoints({
  assessmentType,
  gradingMethod,
  points,
  autoPoints,
  maxPoints,
  maxAutoPoints,
  manualPoints,
}: {
  assessmentType: AssessmentJson['type'];
  gradingMethod: AssessmentPlanQuestionMetadata['gradingMethod'] | undefined;
  points: number | number[] | null;
  autoPoints: number | number[] | null;
  maxPoints: number | null;
  maxAutoPoints: number | null;
  manualPoints: number | null;
}): AssessmentPlanQuestionPoints {
  const hasSplitPoints = autoPoints !== null || maxAutoPoints !== null || manualPoints !== null;
  const configuredAutoPoints = (hasSplitPoints ? autoPoints : points) ?? 0;
  const configuredManualPoints = hasSplitPoints ? (manualPoints ?? 0) : 0;

  if (assessmentType === 'Exam') {
    const autoPointList = asPointList(configuredAutoPoints);
    const configuredMaxAutoPoints = Math.max(...autoPointList);

    if (!hasSplitPoints && gradingMethod === 'Manual') {
      return {
        initialValue: autoPointList[0] ?? 0,
        maxAutoPoints: 0,
        maxManualPoints: configuredMaxAutoPoints,
        maxPoints: configuredMaxAutoPoints,
        attemptValues: autoPointList,
      };
    }

    const attemptValues = hasSplitPoints
      ? autoPointList.map((value) => value + configuredManualPoints)
      : autoPointList;
    return {
      initialValue: attemptValues[0] ?? 0,
      maxAutoPoints: configuredMaxAutoPoints,
      maxManualPoints: configuredManualPoints,
      maxPoints: configuredMaxAutoPoints + configuredManualPoints,
      attemptValues,
    };
  }

  const initialAutoPoints = Array.isArray(configuredAutoPoints)
    ? (configuredAutoPoints[0] ?? 0)
    : configuredAutoPoints;
  const configuredMaximum = maxAutoPoints ?? maxPoints ?? initialAutoPoints;
  if (!hasSplitPoints && gradingMethod === 'Manual') {
    return {
      initialValue: initialAutoPoints,
      maxAutoPoints: 0,
      maxManualPoints: configuredMaximum,
      maxPoints: configuredMaximum,
      attemptValues: null,
    };
  }

  return {
    initialValue: initialAutoPoints + configuredManualPoints,
    maxAutoPoints: configuredMaximum,
    maxManualPoints: configuredManualPoints,
    maxPoints: configuredMaximum + configuredManualPoints,
    attemptValues: null,
  };
}

function firstDisabledHomeworkRealTimeGradingPath(assessment: AssessmentJson): string | null {
  if (assessment.allowRealTimeGrading === false) return 'allowRealTimeGrading';

  for (const [zoneIndex, zone] of assessment.zones.entries()) {
    if (zone.allowRealTimeGrading === false) {
      return `zones[${zoneIndex}].allowRealTimeGrading`;
    }
    for (const [poolIndex, block] of zone.questions.entries()) {
      if (block.allowRealTimeGrading === false) {
        return `zones[${zoneIndex}].questions[${poolIndex}].allowRealTimeGrading`;
      }
      for (const [alternativeIndex, alternative] of (block.alternatives ?? []).entries()) {
        if (alternative.allowRealTimeGrading === false) {
          return `zones[${zoneIndex}].questions[${poolIndex}].alternatives[${alternativeIndex}].allowRealTimeGrading`;
        }
      }
    }
  }

  return null;
}

function isNonIncreasing(points: readonly number[]): boolean {
  return points.every((value, index) => index === 0 || value <= points[index - 1]);
}

function addUnsupportedGroupDiagnostics(
  assessment: AssessmentJson,
  diagnostics: AssessmentPlanDiagnostic[],
): void {
  const groupConfigurationPath = (() => {
    if (assessment.groups != null) return 'groups';
    if (assessment.groupWork) return 'groupWork';
    if (assessment.groupRoles.length > 0) return 'groupRoles';
    if (assessment.groupMinSize != null) return 'groupMinSize';
    if (assessment.groupMaxSize != null) return 'groupMaxSize';
    if (assessment.studentGroupCreate) return 'studentGroupCreate';
    if (assessment.studentGroupJoin) return 'studentGroupJoin';
    if (assessment.studentGroupLeave) return 'studentGroupLeave';
    return null;
  })();
  if (groupConfigurationPath !== null) {
    diagnostics.push({
      code: 'group-assessment',
      severity: 'unsupported',
      message:
        'Group membership and roles cannot be simulated by the local single-attempt preview.',
      path: groupConfigurationPath,
    });
  }

  const addRoleNavigationDiagnostic = (path: string, roles: readonly string[]): void => {
    if (roles.length === 0) return;
    diagnostics.push({
      code: 'group-role-navigation',
      severity: 'unsupported',
      message: `Group role navigation policy "${path}" cannot be evaluated without a real group role assignment.`,
      path,
    });
  };

  addRoleNavigationDiagnostic(
    'groups.rolePermissions.canView',
    assessment.groups?.rolePermissions.canView ?? [],
  );
  addRoleNavigationDiagnostic(
    'groups.rolePermissions.canSubmit',
    assessment.groups?.rolePermissions.canSubmit ?? [],
  );
  addRoleNavigationDiagnostic('canView', assessment.canView);
  addRoleNavigationDiagnostic('canSubmit', assessment.canSubmit);
  for (const [zoneIndex, zone] of assessment.zones.entries()) {
    addRoleNavigationDiagnostic(`zones[${zoneIndex}].canView`, zone.canView);
    addRoleNavigationDiagnostic(`zones[${zoneIndex}].canSubmit`, zone.canSubmit);
    for (const [questionIndex, question] of zone.questions.entries()) {
      addRoleNavigationDiagnostic(
        `zones[${zoneIndex}].questions[${questionIndex}].canView`,
        question.canView,
      );
      addRoleNavigationDiagnostic(
        `zones[${zoneIndex}].questions[${questionIndex}].canSubmit`,
        question.canSubmit,
      );
    }
  }
}

export function compileAssessmentPlan({
  assessment,
  course,
  questions,
}: CompileAssessmentPlanInput): CompileAssessmentPlanResult {
  const diagnostics: AssessmentPlanDiagnostic[] = [];
  const seenLocalQids = new Set<string>();
  let sourceNumber = 0;

  if (assessment.allowAccess !== undefined && assessment.accessControl !== undefined) {
    diagnostics.push({
      code: 'conflicting-access-control',
      severity: 'error',
      message: 'An assessment cannot use both allowAccess and accessControl.',
      path: 'accessControl',
    });
  }

  if (assessment.allowAccess !== undefined) {
    diagnostics.push({
      code: 'legacy-access-control',
      severity: 'unsupported',
      message: 'Legacy allowAccess rules require PrairieLearn database authorization procedures.',
      path: 'allowAccess',
    });
  }

  addUnsupportedGroupDiagnostics(assessment, diagnostics);

  if (assessment.zones[0]?.lockpoint) {
    diagnostics.push({
      code: 'first-zone-lockpoint',
      severity: 'error',
      message: 'The first assessment zone cannot be a lockpoint.',
      path: 'zones[0].lockpoint',
    });
  }

  if (assessment.type === 'Homework') {
    if (assessment.multipleInstance) {
      diagnostics.push({
        code: 'homework-multiple-instance',
        severity: 'error',
        message: 'Homework assessments cannot enable multipleInstance.',
        path: 'multipleInstance',
      });
    }
    if (assessment.requireHonorCode) {
      diagnostics.push({
        code: 'homework-require-honor-code',
        severity: 'error',
        message: 'Homework assessments cannot require an honor code.',
        path: 'requireHonorCode',
      });
    }
    if (assessment.honorCode != null) {
      diagnostics.push({
        code: 'homework-custom-honor-code',
        severity: 'error',
        message: 'Homework assessments cannot define a custom honor code.',
        path: 'honorCode',
      });
    }

    const disabledPath = firstDisabledHomeworkRealTimeGradingPath(assessment);
    if (disabledPath !== null) {
      diagnostics.push({
        code: 'homework-real-time-grading-disabled',
        severity: 'error',
        message: 'Real-time grading cannot be disabled for Homework assessments.',
        path: disabledPath,
      });
    }
  }

  const zones = assessment.zones.map((zone, zoneIndex): AssessmentPlanZone => {
    const zoneId = `zone-${zoneIndex + 1}`;
    const zoneGradeRateMinutes = zone.gradeRateMinutes ?? assessment.gradeRateMinutes ?? 0;
    const zoneAllowRealTimeGrading = zone.allowRealTimeGrading ?? assessment.allowRealTimeGrading;

    if (zone.lockpoint && zone.numberChoose === 0) {
      diagnostics.push({
        code: 'empty-lockpoint-zone',
        severity: 'error',
        message: 'A lockpoint zone must include at least one selectable question.',
        path: `zones[${zoneIndex}].numberChoose`,
      });
    }

    const pools = zone.questions.map((block, poolIndex): AssessmentPlanPool => {
      const poolId = `${zoneId}-pool-${poolIndex + 1}`;
      const blockPath = `zones[${zoneIndex}].questions[${poolIndex}]`;
      const hasId = Boolean(block.id);
      const hasAlternatives = block.alternatives !== undefined;
      if (hasId && hasAlternatives) {
        diagnostics.push({
          code: 'question-block-both-id-and-alternatives',
          severity: 'error',
          message: 'A question block cannot specify both id and alternatives.',
          path: blockPath,
        });
      } else if (!hasId && !hasAlternatives) {
        diagnostics.push({
          code: 'question-block-missing-id-or-alternatives',
          severity: 'error',
          message: 'A question block must specify either id or alternatives.',
          path: blockPath,
        });
      }
      if (hasAlternatives && block.preferences !== undefined) {
        diagnostics.push({
          code: 'alternative-pool-preferences',
          severity: 'error',
          message: 'Preferences must be set on each alternative, not on an alternative pool.',
          path: `${blockPath}.preferences`,
        });
      }

      const alternatives = block.alternatives ?? (block.id ? [{ id: block.id }] : []);
      const blockGradeRateMinutes = block.gradeRateMinutes ?? zoneGradeRateMinutes;
      const blockAllowRealTimeGrading =
        block.allowRealTimeGrading ?? zoneAllowRealTimeGrading ?? true;

      const slots = alternatives.map((alternative, alternativeIndex): AssessmentPlanSlot => {
        sourceNumber += 1;
        const slotId = `${poolId}-alternative-${alternativeIndex + 1}`;
        const metadata = questions[alternative.id];
        const path = block.alternatives
          ? `zones[${zoneIndex}].questions[${poolIndex}].alternatives[${alternativeIndex}]`
          : `zones[${zoneIndex}].questions[${poolIndex}]`;
        const isShared = alternative.id.startsWith('@');
        if (!isShared) {
          if (isDraftQid(alternative.id)) {
            diagnostics.push({
              code: 'draft-assessment-question',
              severity: 'error',
              message: `Draft question "${alternative.id}" cannot be used in an assessment.`,
              path: `${path}.id`,
              slotId,
            });
          }
          if (seenLocalQids.has(alternative.id)) {
            diagnostics.push({
              code: 'duplicate-assessment-question',
              severity: 'error',
              message: `Question "${alternative.id}" is used more than once in this assessment.`,
              path: `${path}.id`,
              slotId,
            });
          } else {
            seenLocalQids.add(alternative.id);
          }
        }
        const grading: AssessmentPlanQuestionGrading = (() => {
          if (isShared) {
            diagnostics.push({
              code: 'shared-question',
              severity: 'unsupported',
              message: `Shared question "${alternative.id}" cannot be resolved from local course metadata.`,
              path,
              slotId,
            });
            return { kind: 'unresolved', method: 'shared' };
          }
          if (!metadata) {
            diagnostics.push({
              code: 'missing-question-metadata',
              severity: 'error',
              message: `Question "${alternative.id}" has no local metadata.`,
              path,
              slotId,
            });
            return { kind: 'unresolved', method: 'missing' };
          }
          if (metadata.gradingMethod === 'Internal') return { kind: 'internal' };

          diagnostics.push({
            code: 'unresolved-grading-method',
            severity: 'unsupported',
            message: `${metadata.gradingMethod} grading is not available in the database-free assessment preview.`,
            path,
            slotId,
          });
          return { kind: 'unresolved', method: metadata.gradingMethod };
        })();
        const points = alternative.points ?? block.points ?? null;
        const autoPoints = alternative.autoPoints ?? block.autoPoints ?? null;
        const maxPoints = alternative.maxPoints ?? block.maxPoints ?? null;
        const maxAutoPoints = alternative.maxAutoPoints ?? block.maxAutoPoints ?? null;
        const manualPoints = alternative.manualPoints ?? block.manualPoints ?? null;
        const allowRealTimeGrading = alternative.allowRealTimeGrading ?? blockAllowRealTimeGrading;
        if (
          !allowRealTimeGrading &&
          ((Array.isArray(autoPoints) && autoPoints.length > 1) ||
            (Array.isArray(points) && points.length > 1))
        ) {
          diagnostics.push({
            code: 'point-list-without-real-time-grading',
            severity: 'error',
            message: `Question "${alternative.id}" cannot use multiple point values when real-time grading is disabled.`,
            path: `${path}.${Array.isArray(autoPoints) ? 'autoPoints' : 'points'}`,
            slotId,
          });
        }
        if (points === null && autoPoints === null && manualPoints === null) {
          diagnostics.push({
            code: 'missing-question-points',
            severity: 'error',
            message: `Question "${alternative.id}" must specify points, autoPoints, or manualPoints.`,
            path,
            slotId,
          });
        }
        if (
          points !== null &&
          (autoPoints !== null || manualPoints !== null || maxAutoPoints !== null)
        ) {
          diagnostics.push({
            code: 'mixed-question-points',
            severity: 'error',
            message: `Question "${alternative.id}" cannot combine points with autoPoints, manualPoints, or maxAutoPoints.`,
            path,
            slotId,
          });
        }
        if (assessment.type === 'Exam') {
          if (maxPoints !== null || maxAutoPoints !== null) {
            diagnostics.push({
              code: 'exam-question-maximum',
              severity: 'error',
              message: `Question "${alternative.id}" cannot specify maxPoints or maxAutoPoints in an Exam assessment.`,
              path: `${path}.${maxPoints !== null ? 'maxPoints' : 'maxAutoPoints'}`,
              slotId,
            });
          }
          const hasSplitPoints =
            autoPoints !== null || maxAutoPoints !== null || manualPoints !== null;
          const configuredAutoPoints = (hasSplitPoints ? autoPoints : points) ?? 0;
          if (!isNonIncreasing(asPointList(configuredAutoPoints))) {
            diagnostics.push({
              code: 'increasing-exam-points',
              severity: 'error',
              message: `Question "${alternative.id}" has an Exam point list that is not non-increasing.`,
              path: `${path}.${hasSplitPoints ? 'autoPoints' : 'points'}`,
              slotId,
            });
          }
        } else {
          if (
            maxPoints !== null &&
            (autoPoints !== null || manualPoints !== null || maxAutoPoints !== null)
          ) {
            diagnostics.push({
              code: 'mixed-homework-maximum',
              severity: 'error',
              message: `Question "${alternative.id}" cannot combine maxPoints with autoPoints, manualPoints, or maxAutoPoints.`,
              path,
              slotId,
            });
          }
          if (Array.isArray(autoPoints ?? points)) {
            diagnostics.push({
              code: 'homework-point-list',
              severity: 'error',
              message: `Question "${alternative.id}" cannot use a points or autoPoints list in a Homework assessment.`,
              path: `${path}.${Array.isArray(autoPoints) ? 'autoPoints' : 'points'}`,
              slotId,
            });
          }
          if (points === 0 && maxPoints !== null && maxPoints > 0) {
            diagnostics.push({
              code: 'zero-homework-points-with-maximum',
              severity: 'error',
              message: `Question "${alternative.id}" cannot specify points: 0 when maxPoints is positive.`,
              path: `${path}.points`,
              slotId,
            });
          }
          if (autoPoints === 0 && maxAutoPoints !== null && maxAutoPoints > 0) {
            diagnostics.push({
              code: 'zero-homework-auto-points-with-maximum',
              severity: 'error',
              message: `Question "${alternative.id}" cannot specify autoPoints: 0 when maxAutoPoints is positive.`,
              path: `${path}.autoPoints`,
              slotId,
            });
          }
          if (typeof points === 'number' && maxPoints !== null && points > maxPoints) {
            diagnostics.push({
              code: 'homework-points-exceed-maximum',
              severity: 'warning',
              message: `Question "${alternative.id}" points (${points}) should not exceed maxPoints (${maxPoints}).`,
              path: `${path}.points`,
              slotId,
            });
          }
          if (
            typeof autoPoints === 'number' &&
            maxAutoPoints !== null &&
            autoPoints > maxAutoPoints
          ) {
            diagnostics.push({
              code: 'homework-auto-points-exceed-maximum',
              severity: 'warning',
              message: `Question "${alternative.id}" autoPoints (${autoPoints}) should not exceed maxAutoPoints (${maxAutoPoints}).`,
              path: `${path}.autoPoints`,
              slotId,
            });
          }
        }
        const compiledPreferences = isShared
          ? { errors: [], preferences: {} }
          : compilePreferences(
              metadata?.preferencesSchema,
              alternative.preferences ?? (block.alternatives ? undefined : block.preferences),
            );
        for (const preferenceError of compiledPreferences.errors) {
          diagnostics.push({
            code: 'invalid-question-preferences',
            message: `Question "${alternative.id}" ${preferenceError}.`,
            path: `${path}.preferences`,
            severity: 'error',
            slotId,
          });
        }

        return {
          id: slotId,
          qid: alternative.id,
          questionUuid: metadata?.uuid ?? null,
          title: metadata?.title ?? null,
          sourceNumber,
          grading,
          singleVariant: metadata?.singleVariant ?? false,
          points: compileQuestionPoints({
            assessmentType: assessment.type,
            gradingMethod: metadata?.gradingMethod,
            points,
            autoPoints,
            maxPoints,
            maxAutoPoints,
            manualPoints,
          }),
          triesPerVariant: alternative.triesPerVariant ?? block.triesPerVariant ?? 1,
          allowRealTimeGrading,
          gradeRateMinutes: alternative.gradeRateMinutes ?? blockGradeRateMinutes,
          advanceScorePercent:
            alternative.advanceScorePerc ??
            block.advanceScorePerc ??
            zone.advanceScorePerc ??
            assessment.advanceScorePerc ??
            0,
          preferences: compiledPreferences.preferences,
        };
      });

      return {
        id: poolId,
        number: poolIndex + 1,
        numberChoose: block.numberChoose ?? null,
        alternatives: slots,
      };
    });

    return {
      id: zoneId,
      number: zoneIndex + 1,
      title: zone.title ?? null,
      numberChoose: zone.numberChoose ?? null,
      bestQuestions: zone.bestQuestions ?? null,
      maxPoints: zone.maxPoints ?? null,
      lockpoint: zone.lockpoint,
      pools,
    };
  });

  const planWithoutHash = {
    id: assessment.uuid,
    type: assessment.type,
    title: assessment.title,
    number: assessment.number,
    assessmentSet: assessment.set,
    assessmentSetAbbreviation: course.assessmentSetAbbreviation,
    courseTimezone: course.timezone,
    shuffleQuestions: assessment.shuffleQuestions ?? assessment.type === 'Exam',
    requireHonorCode: assessment.requireHonorCode ?? assessment.type === 'Exam',
    honorCode: assessment.honorCode ?? null,
    constantQuestionValue: assessment.constantQuestionValue,
    configuredMaxPoints: assessment.maxPoints ?? null,
    maxBonusPoints: assessment.maxBonusPoints ?? 0,
    zones,
  };
  const validationErrors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

  return {
    plan: {
      ...planWithoutHash,
      definitionHash: stableHash(planWithoutHash),
      validationErrors,
    },
    diagnostics,
  };
}

function computeSelectedZoneMaxPoints(
  slots: readonly SampledAssessmentPlanSlot[],
  zone: AssessmentPlanZone,
): number {
  const maximums = slots.map((slot) => slot.points.maxPoints).sort((a, b) => b - a);
  const included = zone.bestQuestions === null ? maximums : maximums.slice(0, zone.bestQuestions);
  const total = included.reduce((sum, value) => sum + value, 0);
  return zone.maxPoints === null ? total : Math.min(total, zone.maxPoints);
}

export function sampleAssessmentPlan(
  plan: AssessmentPlan,
  seedInput: AssessmentSampleSeed,
  pins: AssessmentSamplingPins = { slotIds: [] },
): SampleAssessmentPlanResult {
  if (plan.validationErrors != null && plan.validationErrors.length > 0) {
    return { sample: null, diagnostics: [...plan.validationErrors] };
  }

  const seed = String(seedInput);
  const diagnostics: AssessmentPlanDiagnostic[] = [];
  const allSlots = plan.zones.flatMap((zone) => zone.pools.flatMap((pool) => pool.alternatives));
  const allSlotIds = new Set(allSlots.map((slot) => slot.id));
  const pinnedSlotIds = new Set(pins.slotIds);

  for (const slotId of pinnedSlotIds) {
    if (!allSlotIds.has(slotId)) {
      diagnostics.push({
        code: 'unknown-sampling-pin',
        severity: 'error',
        message: `Sampling pin "${slotId}" does not identify a slot in this assessment plan.`,
        path: 'pins.slotIds',
        slotId,
      });
    }
  }

  const selectedByZone = new Map<
    string,
    { slot: AssessmentPlanSlot; poolId: string; poolRank: number }[]
  >();

  for (const zone of plan.zones) {
    const poolCandidates: { slot: AssessmentPlanSlot; poolId: string; poolRank: number }[] = [];
    for (const pool of zone.pools) {
      const limit = Math.min(
        pool.numberChoose ?? pool.alternatives.length,
        pool.alternatives.length,
      );
      const pinned = pool.alternatives.filter((slot) => pinnedSlotIds.has(slot.id));
      if (pinned.length > limit) {
        diagnostics.push({
          code: 'too-many-pins-for-pool',
          severity: 'error',
          message: `Pool "${pool.id}" selects ${limit} slots but has ${pinned.length} pins.`,
          path: 'pins.slotIds',
        });
        continue;
      }

      const unpinned = pool.alternatives
        .filter((slot) => !pinnedSlotIds.has(slot.id))
        .sort((a, b) =>
          deterministicRank(seed, `pool:${pool.id}`, a.id).localeCompare(
            deterministicRank(seed, `pool:${pool.id}`, b.id),
          ),
        );
      const selected = [...pinned, ...unpinned.slice(0, limit - pinned.length)];
      selected.forEach((slot, index) => {
        poolCandidates.push({ slot, poolId: pool.id, poolRank: index + 1 });
      });
    }

    const zoneLimit = Math.min(zone.numberChoose ?? poolCandidates.length, poolCandidates.length);
    const pinned = poolCandidates.filter(({ slot }) => pinnedSlotIds.has(slot.id));
    if (pinned.length > zoneLimit) {
      diagnostics.push({
        code: 'too-many-pins-for-zone',
        severity: 'error',
        message: `Zone "${zone.id}" selects ${zoneLimit} slots but has ${pinned.length} pins.`,
        path: 'pins.slotIds',
      });
      continue;
    }

    const unpinned = poolCandidates
      .filter(({ slot }) => !pinnedSlotIds.has(slot.id))
      .sort(
        (a, b) =>
          a.poolRank - b.poolRank ||
          deterministicRank(seed, `zone:${zone.id}`, a.slot.id).localeCompare(
            deterministicRank(seed, `zone:${zone.id}`, b.slot.id),
          ),
      );
    selectedByZone.set(zone.id, [...pinned, ...unpinned.slice(0, zoneLimit - pinned.length)]);
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { sample: null, diagnostics };
  }

  const selectedSlots: SampledAssessmentPlanSlot[] = [];
  const sampledZones: SampledAssessmentPlanZone[] = [];
  let displayOrder = 0;
  for (const zone of plan.zones) {
    const candidates = selectedByZone.get(zone.id) ?? [];
    const ordered = [...candidates].sort((a, b) => {
      if (!plan.shuffleQuestions) return a.slot.sourceNumber - b.slot.sourceNumber;
      return deterministicRank(seed, `display:${zone.id}`, a.slot.id).localeCompare(
        deterministicRank(seed, `display:${zone.id}`, b.slot.id),
      );
    });

    const zoneSlots = ordered.map(({ slot, poolId, poolRank }) => {
      displayOrder += 1;
      return {
        ...slot,
        zoneId: zone.id,
        poolId,
        poolRank,
        displayOrder,
        questionNumber:
          plan.type === 'Exam'
            ? String(displayOrder)
            : plan.shuffleQuestions
              ? `#${slot.sourceNumber}`
              : `${plan.assessmentSetAbbreviation}${plan.number}.${displayOrder}`,
      } satisfies SampledAssessmentPlanSlot;
    });
    selectedSlots.push(...zoneSlots);
    sampledZones.push({
      id: zone.id,
      number: zone.number,
      title: zone.title,
      bestQuestions: zone.bestQuestions,
      maxPoints: zone.maxPoints,
      lockpoint: zone.lockpoint,
      selectedSlotIds: zoneSlots.map((slot) => slot.id),
      selectedMaxPoints: computeSelectedZoneMaxPoints(zoneSlots, zone),
    });
  }

  const computedMaxPoints = sampledZones.reduce((sum, zone) => sum + zone.selectedMaxPoints, 0);
  const maxPoints =
    plan.configuredMaxPoints ?? Math.max(0, computedMaxPoints - plan.maxBonusPoints);
  const sampleIdentity = {
    definitionHash: plan.definitionHash,
    seed,
    pinnedSlotIds: [...pinnedSlotIds].sort(),
    selectedSlotIds: selectedSlots.map((slot) => slot.id),
  };

  return {
    sample: {
      assessmentId: plan.id,
      definitionHash: plan.definitionHash,
      sampleHash: stableHash(sampleIdentity),
      seed,
      selectedSlots,
      zones: sampledZones,
      maxPoints,
      maxBonusPoints: plan.maxBonusPoints,
    },
    diagnostics,
  };
}
