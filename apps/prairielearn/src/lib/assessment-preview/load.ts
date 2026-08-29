import type { AssessmentJson, CourseInstanceJson } from '../../schemas/index.js';
import type { LocalPreviewAssessmentCourseSource } from '../question-preview/course-source.js';
import { parseQuestionPreviewQid } from '../question-preview/qid.js';

import { validateAssessmentPreviewAccessControl } from './access.js';
import {
  type AssessmentPlan,
  type AssessmentPlanDiagnostic,
  type AssessmentPlanQuestionMetadata,
  compileAssessmentPlan,
} from './assessment-plan.js';
import type { AssessmentPreviewLocator } from './locator.js';

export interface LoadAssessmentPreviewPlanInput {
  courseSource: LocalPreviewAssessmentCourseSource;
  locator: AssessmentPreviewLocator;
}

export interface LoadedAssessmentPreviewPlan {
  assessment: AssessmentJson;
  courseInstance: CourseInstanceJson;
  diagnostics: readonly AssessmentPlanDiagnostic[];
  locator: AssessmentPreviewLocator;
  plan: AssessmentPlan;
}

export class InvalidAssessmentPreviewMetadataError extends Error {
  override name = 'InvalidAssessmentPreviewMetadataError';

  constructor(public readonly diagnostics: readonly AssessmentPlanDiagnostic[]) {
    super('Assessment preview metadata could not be loaded.');
  }
}

function assessmentQids(assessment: AssessmentJson): string[] {
  const qids = new Set<string>();
  for (const zone of assessment.zones) {
    for (const block of zone.questions) {
      if (block.alternatives != null) {
        for (const alternative of block.alternatives) qids.add(alternative.id);
      } else if (block.id != null) {
        qids.add(block.id);
      }
    }
  }
  return [...qids];
}

export async function loadAssessmentPreviewPlan({
  courseSource,
  locator,
}: LoadAssessmentPreviewPlanInput): Promise<LoadedAssessmentPreviewPlan> {
  let assessment: AssessmentJson;
  let course: Awaited<ReturnType<LocalPreviewAssessmentCourseSource['readCourseInfo']>>;
  let courseInstance: CourseInstanceJson;
  try {
    [assessment, course, courseInstance] = await Promise.all([
      courseSource.readAssessmentInfo(locator),
      courseSource.readCourseInfo(),
      courseSource.readCourseInstanceInfo(locator),
    ]);
  } catch (err) {
    throw new InvalidAssessmentPreviewMetadataError([
      {
        code: 'assessment-metadata-unavailable',
        message:
          err instanceof Error
            ? `Assessment preview metadata could not be loaded: ${err.message}`
            : 'Assessment preview metadata could not be loaded.',
        path: 'assessment-source',
        severity: 'error',
      },
    ]);
  }
  const questions: Record<string, AssessmentPlanQuestionMetadata> = {};
  const loadDiagnostics: AssessmentPlanDiagnostic[] = validateAssessmentPreviewAccessControl(
    assessment.accessControl ?? [],
    new Set(courseInstance.studentLabels?.map(({ name }) => name)),
  );

  await Promise.all(
    assessmentQids(assessment).map(async (qid) => {
      if (qid.startsWith('@')) return;
      const parsedQid = parseQuestionPreviewQid(qid);
      if (!parsedQid.ok) {
        loadDiagnostics.push({
          code: 'invalid-local-question-id',
          message: `Question "${qid}" is not a valid local question id.`,
          path: 'zones',
          severity: 'error',
        });
        return;
      }

      try {
        const info = await courseSource.readQuestionInfo(parsedQid.qid);
        questions[qid] = {
          gradingMethod: info.gradingMethod,
          preferencesSchema: info.preferences,
          singleVariant: info.singleVariant,
          title: info.title,
          uuid: info.uuid,
        };
      } catch (err) {
        loadDiagnostics.push({
          code: 'question-metadata-unavailable',
          message:
            err instanceof Error
              ? `Question "${qid}" could not be loaded: ${err.message}`
              : `Question "${qid}" could not be loaded.`,
          path: 'zones',
          severity: 'error',
        });
      }
    }),
  );

  const assessmentSetAbbreviation =
    course.assessmentSets?.find((set) => set.name === assessment.set)?.abbreviation ??
    assessment.set;
  const compiled = compileAssessmentPlan({
    assessment,
    course: {
      assessmentSetAbbreviation,
      timezone: courseInstance.timezone ?? course.timezone ?? 'UTC',
    },
    questions,
  });

  return {
    assessment,
    courseInstance,
    diagnostics: [...loadDiagnostics, ...compiled.diagnostics],
    locator,
    plan: compiled.plan,
  };
}
