import path from 'node:path';

const ASSESSMENT_PREVIEW_LOCATOR_ERROR_MESSAGE =
  'Invalid assessment locator. Expected relative course-instance and assessment ids.';

const assessmentPreviewLocatorBrand: unique symbol = Symbol('AssessmentPreviewLocator');

export interface AssessmentPreviewLocatorInput {
  aid: string;
  ciid: string;
}

export interface AssessmentPreviewLocatorValidationError {
  input: AssessmentPreviewLocatorInput;
  message: string;
}

export interface AssessmentPreviewLocator {
  readonly [assessmentPreviewLocatorBrand]: true;
  readonly aid: string;
  readonly aidEncodedPath: string;
  readonly aidPathSegments: readonly string[];
  readonly ciid: string;
  readonly ciidEncodedPath: string;
  readonly ciidPathSegments: readonly string[];
}

export type AssessmentPreviewLocatorParseResult =
  | { locator: AssessmentPreviewLocator; ok: true }
  | { error: AssessmentPreviewLocatorValidationError; ok: false };

function isValidRelativeId(value: string, segments: readonly string[]): boolean {
  return !(
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        segment.includes('\0') ||
        path.isAbsolute(segment),
    )
  );
}

export function parseAssessmentPreviewLocator(
  input: AssessmentPreviewLocatorInput,
): AssessmentPreviewLocatorParseResult {
  const aidPathSegments = input.aid.split('/');
  const ciidPathSegments = input.ciid.split('/');

  if (
    !isValidRelativeId(input.aid, aidPathSegments) ||
    !isValidRelativeId(input.ciid, ciidPathSegments)
  ) {
    return {
      error: {
        input,
        message: ASSESSMENT_PREVIEW_LOCATOR_ERROR_MESSAGE,
      },
      ok: false,
    };
  }

  const frozenAidPathSegments = Object.freeze([...aidPathSegments]);
  const frozenCiidPathSegments = Object.freeze([...ciidPathSegments]);
  const locator: AssessmentPreviewLocator = {
    [assessmentPreviewLocatorBrand]: true,
    aid: frozenAidPathSegments.join('/'),
    aidEncodedPath: frozenAidPathSegments.map(encodeURIComponent).join('/'),
    aidPathSegments: frozenAidPathSegments,
    ciid: frozenCiidPathSegments.join('/'),
    ciidEncodedPath: frozenCiidPathSegments.map(encodeURIComponent).join('/'),
    ciidPathSegments: frozenCiidPathSegments,
  };

  Object.defineProperty(locator, assessmentPreviewLocatorBrand, { enumerable: false });
  return { locator: Object.freeze(locator), ok: true };
}
