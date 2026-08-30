import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type AssessmentJson,
  AssessmentJsonSchema,
  type CourseInstanceJson,
  CourseInstanceJsonSchema,
  type CourseJson,
  CourseJsonSchema,
  type QuestionJson,
  QuestionJsonSchema,
} from '../../schemas/index.js';
import type { AssessmentPreviewLocator } from '../assessment-preview/locator.js';
import { resolveLegacyQuestionFilePath } from '../legacy-question-file.js';

import { ExpectedQuestionPreviewError } from './expected-error.js';
import { type QuestionPreviewQid, parseQuestionPreviewQid } from './qid.js';

interface LocalPreviewCourseMetadata {
  assessmentSets?: CourseJson['assessmentSets'];
  name: string;
  options: CourseJson['options'];
  timezone: string;
  title: string;
}

export type LocalPreviewCourseResource =
  | {
      filePathSegments: string[];
      kind: 'assessment-client-file';
      locator: AssessmentPreviewLocator;
    }
  | { filePathSegments: string[]; kind: 'course-client-file' }
  | {
      filePathSegments: string[];
      kind: 'course-instance-client-file';
      locator: AssessmentPreviewLocator;
    }
  | { filePathSegments: string[]; kind: 'element-extension-file' }
  | { filePathSegments: string[]; kind: 'element-file' }
  | { filePathSegments: string[]; kind: 'question-client-file'; qid: QuestionPreviewQid };

export interface LocalPreviewCourseSource {
  courseDir: string;
  courseMetadata: LocalPreviewCourseMetadata;
  readQuestionInfo(qid: QuestionPreviewQid): Promise<QuestionJson>;
  readTemplateInfo(qid: QuestionPreviewQid): Promise<QuestionJson>;
  resolveLegacyQuestionFile(input: {
    filename: string;
    info: QuestionJson;
    qid: QuestionPreviewQid;
  }): Promise<{ effectiveFilename: string; fullPath: string; rootPath: string }>;
  resolveResource(resource: LocalPreviewCourseResource): Promise<string | null>;
  sanitizeDiagnosticValue(value: unknown): unknown;
}

export interface LocalPreviewAssessmentCourseSource extends LocalPreviewCourseSource {
  readAssessmentInfo(locator: AssessmentPreviewLocator): Promise<AssessmentJson>;
  readCourseInfo(): Promise<CourseJson>;
  readCourseInstanceInfo(locator: AssessmentPreviewLocator): Promise<CourseInstanceJson>;
}

export class InvalidLocalPreviewCourseError extends Error {
  override name = 'InvalidLocalPreviewCourseError';
}

export class QuestionPreviewQuestionNotFoundError extends ExpectedQuestionPreviewError {
  override name = 'QuestionPreviewQuestionNotFoundError';
}

function isPathInsideRoot(root: string, candidate: string) {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath.length === 0 ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function hasUnsafePathSegment(pathSegments: string[]) {
  return pathSegments.some(
    (segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      path.isAbsolute(segment),
  );
}

function resourceRootPathSegments(resource: LocalPreviewCourseResource): string[] {
  switch (resource.kind) {
    case 'assessment-client-file':
      return [
        'courseInstances',
        ...resource.locator.ciidPathSegments,
        'assessments',
        ...resource.locator.aidPathSegments,
        'clientFilesAssessment',
      ];
    case 'course-client-file':
      return ['clientFilesCourse'];
    case 'course-instance-client-file':
      return ['courseInstances', ...resource.locator.ciidPathSegments, 'clientFilesCourseInstance'];
    case 'element-file':
      return ['elements'];
    case 'element-extension-file':
      return ['elementExtensions'];
    case 'question-client-file':
      return ['questions', ...resource.qid.pathSegments, 'clientFilesQuestion'];
  }
}

const REDACTED_DIAGNOSTIC_VALUE = '<redacted>';
const SENSITIVE_DIAGNOSTIC_KEY_WORDS = new Set([
  'auth',
  'authentication',
  'authorisation',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'passphrase',
  'passwd',
  'password',
  'passwords',
  'pwd',
  'secret',
  'secrets',
  'token',
  'tokens',
]);

function isSensitiveDiagnosticKey(key: string): boolean {
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_DIAGNOSTIC_KEY_WORDS.has(word))) return true;

  const normalized = words.join('');
  return (
    normalized.includes('apikey') ||
    normalized.includes('accesskey') ||
    normalized.includes('privatekey')
  );
}

function sanitizeDiagnosticValue(value: unknown, courseDir: string): unknown {
  if (typeof value === 'string') return value.split(courseDir).join('<course>');
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, courseDir));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveDiagnosticKey(key)
          ? REDACTED_DIAGNOSTIC_VALUE
          : sanitizeDiagnosticValue(item, courseDir),
      ]),
    );
  }
  return value;
}

export async function createLocalPreviewCourseSource(
  courseDirInput: string,
): Promise<LocalPreviewAssessmentCourseSource> {
  if (!path.isAbsolute(courseDirInput)) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: course directory must be absolute.',
    );
  }

  let courseDir: string;
  try {
    courseDir = await fs.realpath(courseDirInput);
    if (!(await fs.stat(courseDir)).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: course directory is not usable.',
      { cause: err },
    );
  }

  async function readCourseInfoFile(): Promise<CourseJson> {
    let infoCoursePath: string;
    let infoCourseContents: string;
    try {
      infoCoursePath = await fs.realpath(path.join(courseDir, 'infoCourse.json'));
      if (!isPathInsideRoot(courseDir, infoCoursePath)) {
        throw new InvalidLocalPreviewCourseError(
          'Invalid Local Preview Course Source: infoCourse.json escapes the canonical course root.',
        );
      }
      infoCourseContents = await fs.readFile(infoCoursePath, 'utf8');
    } catch (err) {
      if (err instanceof InvalidLocalPreviewCourseError) throw err;
      throw new InvalidLocalPreviewCourseError(
        'Invalid Local Preview Course Source: infoCourse.json is not readable.',
        { cause: err },
      );
    }

    let rawInfoCourse: unknown;
    try {
      rawInfoCourse = JSON.parse(infoCourseContents);
    } catch (err) {
      throw new InvalidLocalPreviewCourseError(
        'Invalid Local Preview Course Source: invalid infoCourse.json JSON.',
        { cause: err },
      );
    }
    const parsedInfoCourse = CourseJsonSchema.safeParse(rawInfoCourse);
    if (!parsedInfoCourse.success) {
      throw new InvalidLocalPreviewCourseError(
        'Invalid Local Preview Course Source: invalid infoCourse.json metadata.',
        { cause: parsedInfoCourse.error },
      );
    }
    return parsedInfoCourse.data;
  }
  const infoCourse = await readCourseInfoFile();

  let questionsDir: string;
  try {
    questionsDir = await fs.realpath(path.join(courseDir, 'questions'));
    if (!(await fs.stat(questionsDir)).isDirectory()) throw new Error('not a directory');
    await fs.access(questionsDir, constants.R_OK | constants.X_OK);
  } catch (err) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: questions directory is not usable.',
      { cause: err },
    );
  }
  if (!isPathInsideRoot(courseDir, questionsDir)) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: questions directory escapes the canonical course root.',
    );
  }

  async function resolveCourseInstanceDirectory(locator: AssessmentPreviewLocator) {
    let courseInstancesDir: string;
    try {
      courseInstancesDir = await fs.realpath(path.join(courseDir, 'courseInstances'));
      if (!(await fs.stat(courseInstancesDir)).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new ExpectedQuestionPreviewError(
          `Course instance "${locator.ciid}" does not exist.`,
          { data: { ciid: locator.ciid }, phase: 'metadata' },
        );
      }
      throw err;
    }
    if (!isPathInsideRoot(courseDir, courseInstancesDir)) {
      throw new ExpectedQuestionPreviewError(
        `Course instance "${locator.ciid}" escapes the canonical course root.`,
        { data: { ciid: locator.ciid }, phase: 'metadata' },
      );
    }

    let courseInstanceDir: string;
    try {
      courseInstanceDir = await fs.realpath(
        path.join(courseInstancesDir, ...locator.ciidPathSegments),
      );
      if (!(await fs.stat(courseInstanceDir)).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new ExpectedQuestionPreviewError(
          `Course instance "${locator.ciid}" does not exist.`,
          { data: { ciid: locator.ciid }, phase: 'metadata' },
        );
      }
      throw err;
    }
    if (!isPathInsideRoot(courseInstancesDir, courseInstanceDir)) {
      throw new ExpectedQuestionPreviewError(
        `Course instance "${locator.ciid}" escapes the canonical courseInstances namespace.`,
        { data: { ciid: locator.ciid }, phase: 'metadata' },
      );
    }

    return courseInstanceDir;
  }

  async function resolveAssessmentDirectories(locator: AssessmentPreviewLocator) {
    const courseInstanceDir = await resolveCourseInstanceDirectory(locator);

    let assessmentsDir: string;
    try {
      assessmentsDir = await fs.realpath(path.join(courseInstanceDir, 'assessments'));
      if (!(await fs.stat(assessmentsDir)).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new ExpectedQuestionPreviewError(
          `Assessment "${locator.ciid}/${locator.aid}" does not exist.`,
          { data: { aid: locator.aid, ciid: locator.ciid }, phase: 'metadata' },
        );
      }
      throw err;
    }
    if (!isPathInsideRoot(courseInstanceDir, assessmentsDir)) {
      throw new ExpectedQuestionPreviewError(
        `Assessment "${locator.ciid}/${locator.aid}" escapes the canonical course root.`,
        { data: { aid: locator.aid, ciid: locator.ciid }, phase: 'metadata' },
      );
    }

    let assessmentDir: string;
    try {
      assessmentDir = await fs.realpath(path.join(assessmentsDir, ...locator.aidPathSegments));
      if (!(await fs.stat(assessmentDir)).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new ExpectedQuestionPreviewError(
          `Assessment "${locator.ciid}/${locator.aid}" does not exist.`,
          { data: { aid: locator.aid, ciid: locator.ciid }, phase: 'metadata' },
        );
      }
      throw err;
    }
    if (!isPathInsideRoot(assessmentsDir, assessmentDir)) {
      const message = isPathInsideRoot(courseInstanceDir, assessmentDir)
        ? `Assessment "${locator.ciid}/${locator.aid}" escapes the canonical assessments namespace.`
        : `Assessment "${locator.ciid}/${locator.aid}" escapes the canonical course root.`;
      throw new ExpectedQuestionPreviewError(message, {
        data: { aid: locator.aid, ciid: locator.ciid },
        phase: 'metadata',
      });
    }

    return { assessmentDir, courseInstanceDir };
  }

  async function readMetadataFile(input: {
    directory: string;
    filename: string;
    label: string;
    locator: AssessmentPreviewLocator;
  }): Promise<unknown> {
    let infoPath: string;
    try {
      infoPath = await fs.realpath(path.join(input.directory, input.filename));
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new ExpectedQuestionPreviewError(`${input.label} is missing ${input.filename}.`, {
          data: { aid: input.locator.aid, ciid: input.locator.ciid },
          phase: 'metadata',
        });
      }
      throw err;
    }
    if (!isPathInsideRoot(input.directory, infoPath)) {
      throw new ExpectedQuestionPreviewError(`${input.label} escapes the canonical course root.`, {
        data: { aid: input.locator.aid, ciid: input.locator.ciid },
        phase: 'metadata',
      });
    }

    try {
      return JSON.parse(await fs.readFile(infoPath, 'utf8'));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new ExpectedQuestionPreviewError(
          `${input.label} has invalid ${input.filename} JSON.`,
          {
            data: { aid: input.locator.aid, ciid: input.locator.ciid },
            phase: 'metadata',
          },
        );
      }
      throw err;
    }
  }

  const source: LocalPreviewAssessmentCourseSource = {
    courseDir,
    courseMetadata: {
      ...(infoCourse.assessmentSets == null ? {} : { assessmentSets: infoCourse.assessmentSets }),
      name: infoCourse.name,
      options: infoCourse.options,
      timezone: infoCourse.timezone ?? 'UTC',
      title: infoCourse.title,
    },
    async readAssessmentInfo(locator) {
      const { assessmentDir } = await resolveAssessmentDirectories(locator);
      const label = `Assessment "${locator.ciid}/${locator.aid}"`;
      const rawInfo = await readMetadataFile({
        directory: assessmentDir,
        filename: 'infoAssessment.json',
        label,
        locator,
      });
      const parsedInfo = AssessmentJsonSchema.safeParse(rawInfo);
      if (!parsedInfo.success) {
        throw new ExpectedQuestionPreviewError(
          `${label} has invalid infoAssessment.json metadata.`,
          {
            data: { issues: parsedInfo.error.issues, aid: locator.aid, ciid: locator.ciid },
            phase: 'metadata',
          },
        );
      }
      return parsedInfo.data;
    },
    readCourseInfo: readCourseInfoFile,
    async readCourseInstanceInfo(locator) {
      const { courseInstanceDir } = await resolveAssessmentDirectories(locator);
      const label = `Course instance "${locator.ciid}"`;
      const rawInfo = await readMetadataFile({
        directory: courseInstanceDir,
        filename: 'infoCourseInstance.json',
        label,
        locator,
      });
      const parsedInfo = CourseInstanceJsonSchema.safeParse(rawInfo);
      if (!parsedInfo.success) {
        throw new ExpectedQuestionPreviewError(
          `${label} has invalid infoCourseInstance.json metadata.`,
          {
            data: { issues: parsedInfo.error.issues, ciid: locator.ciid },
            phase: 'metadata',
          },
        );
      }
      return parsedInfo.data;
    },
    async readQuestionInfo(qid) {
      let questionDir: string;
      try {
        questionDir = await fs.realpath(path.join(questionsDir, ...qid.pathSegments));
        if (!(await fs.stat(questionDir)).isDirectory()) {
          throw new QuestionPreviewQuestionNotFoundError(
            `Question "${qid.decoded}" does not exist.`,
            { data: { qid: qid.decoded }, phase: 'metadata' },
          );
        }
      } catch (err) {
        if (err instanceof QuestionPreviewQuestionNotFoundError) throw err;
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          throw new QuestionPreviewQuestionNotFoundError(
            `Question "${qid.decoded}" does not exist.`,
            { data: { qid: qid.decoded }, phase: 'metadata' },
          );
        }
        throw err;
      }
      if (!isPathInsideRoot(questionsDir, questionDir)) {
        throw new ExpectedQuestionPreviewError(
          `Question "${qid.decoded}" escapes the canonical course root.`,
          { data: { qid: qid.decoded }, phase: 'metadata' },
        );
      }

      let infoPath: string;
      try {
        infoPath = await fs.realpath(path.join(questionDir, 'info.json'));
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          throw new ExpectedQuestionPreviewError(
            `Question "${qid.decoded}" is missing info.json.`,
            { data: { qid: qid.decoded }, phase: 'metadata' },
          );
        }
        throw err;
      }
      if (!isPathInsideRoot(questionDir, infoPath)) {
        throw new ExpectedQuestionPreviewError(
          `Question "${qid.decoded}" escapes the canonical course root.`,
          { data: { qid: qid.decoded }, phase: 'metadata' },
        );
      }

      let rawInfo: unknown;
      try {
        rawInfo = JSON.parse(await fs.readFile(infoPath, 'utf8'));
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new ExpectedQuestionPreviewError(
            `Question "${qid.decoded}" has invalid info.json JSON.`,
            { data: { qid: qid.decoded }, phase: 'metadata' },
          );
        }
        throw err;
      }

      const parsedInfo = QuestionJsonSchema.safeParse(rawInfo);
      if (!parsedInfo.success) {
        throw new ExpectedQuestionPreviewError(
          `Question "${qid.decoded}" has invalid info.json metadata.`,
          {
            data: { issues: parsedInfo.error.issues, qid: qid.decoded },
            phase: 'metadata',
          },
        );
      }
      return parsedInfo.data;
    },
    async readTemplateInfo(qid) {
      return source.readQuestionInfo(qid);
    },
    async resolveLegacyQuestionFile({ filename, info, qid }) {
      return resolveLegacyQuestionFilePath({
        coursePath: courseDir,
        filename,
        lookupTemplate: async ({ directory }) => {
          const templateQidResult = parseQuestionPreviewQid(directory);
          if (!templateQidResult.ok) return null;
          const templateInfo = await source.readTemplateInfo(templateQidResult.qid);
          return {
            courseId: '1',
            directory,
            templateDirectory: templateInfo.template ?? null,
            type: templateInfo.type,
          };
        },
        question: {
          courseId: '1',
          directory: qid.decoded,
          templateDirectory: info.template ?? null,
          type: info.type,
        },
      });
    },
    async resolveResource(resource) {
      const rootPathSegments = resourceRootPathSegments(resource);
      const { filePathSegments } = resource;
      if (
        hasUnsafePathSegment(rootPathSegments) ||
        hasUnsafePathSegment(filePathSegments) ||
        filePathSegments.length === 0
      ) {
        return null;
      }

      try {
        let owningDir = courseDir;
        let rootPath = path.join(courseDir, ...rootPathSegments);
        if (resource.kind === 'course-instance-client-file') {
          owningDir = await resolveCourseInstanceDirectory(resource.locator);
          rootPath = path.join(owningDir, 'clientFilesCourseInstance');
        } else if (resource.kind === 'assessment-client-file') {
          owningDir = (await resolveAssessmentDirectories(resource.locator)).assessmentDir;
          rootPath = path.join(owningDir, 'clientFilesAssessment');
        }
        const rootDir = await fs.realpath(rootPath);
        if (!isPathInsideRoot(owningDir, rootDir)) return null;
        const filePath = await fs.realpath(path.join(rootDir, ...filePathSegments));
        if (!isPathInsideRoot(rootDir, filePath)) return null;
        return (await fs.stat(filePath)).isFile() ? filePath : null;
      } catch (err) {
        if (err instanceof ExpectedQuestionPreviewError) return null;
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
        throw err;
      }
    },
    sanitizeDiagnosticValue(value) {
      return sanitizeDiagnosticValue(value, courseDir);
    },
  };
  return source;
}
