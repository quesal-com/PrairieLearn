import { Temporal } from '@js-temporal/polyfill';

import type { AccessControlJson, AssessmentJson } from '../../schemas/index.js';
import {
  type AccessControlResolverResult,
  type AccessControlRuleInput,
  type DefaultRuleBody,
  type PrairieTestReservation,
  resolveAccessControl,
} from '../assessment-access-control/resolver.js';
import { validateAccessControlRules } from '../assessment-access-control/validation.js';
import type { EnumCourseInstanceRole, EnumCourseRole, EnumMode } from '../db-types.js';

import type { AssessmentPlanDiagnostic } from './assessment-plan.js';

export interface AssessmentPreviewStudentFacts {
  courseInstanceRole: EnumCourseInstanceRole;
  courseRole: EnumCourseRole;
  enrollmentId: string;
  mode: EnumMode;
  now: Date;
  prairieTestReservations: PrairieTestReservation[];
  studentLabels: string[];
  uid: string;
}

export interface EvaluateAssessmentPreviewAccessInput {
  assessment: AssessmentJson;
  facts: AssessmentPreviewStudentFacts;
  timezone: string;
  validStudentLabelNames?: Set<string>;
}

export type AssessmentPreviewAccessResult = AccessControlResolverResult & {
  diagnostics: readonly AssessmentPlanDiagnostic[];
  source: 'modern-access-control' | 'preview-default';
};

function localDate(value: string, timezone: string): Date {
  const zonedDateTime = Temporal.PlainDateTime.from(value).toZonedDateTime(timezone);
  return new Date(zonedDateTime.epochMilliseconds);
}

function localDateIso(value: string, timezone: string): string {
  return localDate(value, timezone).toISOString();
}

function makeRuleBody(
  rule: AccessControlJson,
  timezone: string,
  includeDefaultFields: boolean,
): DefaultRuleBody {
  const dateControl = rule.dateControl;
  const afterComplete = rule.afterComplete;

  return {
    ...(includeDefaultFields
      ? {
          beforeRelease: rule.beforeRelease,
          prairieTestExams: (rule.integrations?.prairieTest?.exams ?? []).map((exam) => ({
            questionsHidden: exam.afterComplete?.questions?.hidden ?? false,
            readOnly: exam.readOnly ?? false,
            scoreHidden: exam.afterComplete?.score?.hidden ?? false,
            uuid: exam.examUuid,
          })),
        }
      : { prairieTestExams: [] }),
    ...(dateControl == null
      ? {}
      : {
          dateControl: {
            ...dateControl,
            earlyDeadlines: dateControl.earlyDeadlines?.map((deadline) => ({
              ...deadline,
              date: localDateIso(deadline.date, timezone),
            })),
            lateDeadlines: dateControl.lateDeadlines?.map((deadline) => ({
              ...deadline,
              date: localDateIso(deadline.date, timezone),
            })),
            release:
              dateControl.release == null
                ? undefined
                : { date: localDate(dateControl.release.date, timezone) },
            due:
              dateControl.due == null
                ? undefined
                : {
                    ...dateControl.due,
                    date:
                      dateControl.due.date == null
                        ? null
                        : localDate(dateControl.due.date, timezone),
                  },
          },
        }),
    ...(afterComplete == null
      ? {}
      : {
          afterComplete: {
            questions:
              afterComplete.questions == null
                ? undefined
                : {
                    ...afterComplete.questions,
                    visibleFromDate:
                      afterComplete.questions.visibleFromDate == null
                        ? undefined
                        : localDate(afterComplete.questions.visibleFromDate, timezone),
                    visibleUntilDate:
                      afterComplete.questions.visibleUntilDate == null
                        ? undefined
                        : localDate(afterComplete.questions.visibleUntilDate, timezone),
                  },
            score:
              afterComplete.score == null
                ? undefined
                : {
                    ...afterComplete.score,
                    visibleFromDate:
                      afterComplete.score.visibleFromDate == null
                        ? undefined
                        : localDate(afterComplete.score.visibleFromDate, timezone),
                  },
          },
        }),
  };
}

function makeRuntimeRules(
  accessControl: readonly AccessControlJson[],
  timezone: string,
): AccessControlRuleInput[] {
  if (accessControl.length === 0) return [];
  const defaultRule = accessControl[0];
  const rules: AccessControlRuleInput[] = [
    {
      number: 0,
      rule: makeRuleBody(defaultRule, timezone, true),
      targetType: 'none',
    },
  ];
  let overrideNumber = 0;
  for (const rule of accessControl.slice(1)) {
    if (rule.labels == null) continue;
    overrideNumber += 1;
    const { prairieTestExams: _prairieTestExams, ...overrideBody } = makeRuleBody(
      rule,
      timezone,
      false,
    );
    rules.push({
      number: overrideNumber,
      rule: overrideBody,
      studentLabelIds: [...(rule.labels ?? [])],
      targetType: 'student_label',
    });
  }
  return rules;
}

function deniedModernAccess(
  diagnostics: readonly AssessmentPlanDiagnostic[],
): AssessmentPreviewAccessResult {
  return {
    accessTimeline: [],
    afterCompleteVisibility: { showQuestions: true, showScore: true },
    authorized: false,
    complete: false,
    credit: 0,
    creditDateString: 'None',
    diagnostics,
    examAccessEnd: null,
    nextActiveDate: null,
    password: null,
    showBeforeRelease: false,
    source: 'modern-access-control',
    submittable: false,
    timeLimitMin: null,
    visibility: { showQuestions: true, showScore: true },
    visibilitySource: 'default',
  };
}

export function validateAssessmentPreviewAccessControl(
  accessControl: readonly AccessControlJson[],
  validStudentLabelNames?: Set<string>,
): AssessmentPlanDiagnostic[] {
  const { errors, warnings } = validateAccessControlRules({
    rules: [...accessControl],
    validStudentLabelNames,
  });
  const diagnostics: AssessmentPlanDiagnostic[] = [
    ...errors.map((message) => ({
      code: 'invalid-access-control',
      message,
      path: 'accessControl',
      severity: 'error' as const,
    })),
    ...warnings.map((message) => ({
      code: 'access-control-validation-warning',
      message,
      path: 'accessControl',
      severity: 'warning' as const,
    })),
  ];

  for (const [index, rule] of accessControl.entries()) {
    if (index === 0 || rule.labels != null) continue;
    diagnostics.push({
      code: 'student-specific-access-control',
      message:
        'Student-specific access control targets cannot be resolved from local course files.',
      path: `accessControl[${index}]`,
      severity: 'unsupported',
    });
  }
  return diagnostics;
}

export function evaluateAssessmentPreviewAccess({
  assessment,
  facts,
  timezone,
  validStudentLabelNames,
}: EvaluateAssessmentPreviewAccessInput): AssessmentPreviewAccessResult {
  if (assessment.accessControl == null) {
    return {
      accessTimeline: [],
      afterCompleteVisibility: { showQuestions: true, showScore: true },
      authorized: true,
      complete: false,
      credit: 100,
      creditDateString: '100% (Local preview default)',
      diagnostics: [],
      examAccessEnd: null,
      nextActiveDate: null,
      password: null,
      showBeforeRelease: false,
      source: 'preview-default',
      submittable: true,
      timeLimitMin: null,
      visibility: { showQuestions: true, showScore: true },
      visibilitySource: 'default',
    };
  }

  const diagnostics = validateAssessmentPreviewAccessControl(
    assessment.accessControl,
    validStudentLabelNames,
  );
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return deniedModernAccess(diagnostics);
  }

  const result = resolveAccessControl({
    authzMode: facts.mode,
    courseInstanceRole: facts.courseInstanceRole,
    courseRole: facts.courseRole,
    date: facts.now,
    displayTimezone: timezone,
    enrollment: {
      enrollmentId: facts.enrollmentId,
      studentLabelIds: facts.studentLabels,
    },
    prairieTestReservations: facts.prairieTestReservations.filter(
      (reservation) => reservation.accessEnd.getTime() >= facts.now.getTime(),
    ),
    rules: makeRuntimeRules(assessment.accessControl, timezone),
  });

  return { ...result, diagnostics, source: 'modern-access-control' };
}
