import path from 'node:path';

import { LRUCache } from 'lru-cache';

const SUBMISSION_FILE_QUESTION_PREFIX = '/question/';
const DEFAULT_LOCAL_PREVIEW_SUBMISSION_REGISTRY_MAX = 256;
const DEFAULT_LOCAL_PREVIEW_SUBMISSION_REGISTRY_MAX_SIZE = 256 * 1024 * 1024;

/** A graded submission file, matching a `submitted_answer._files` entry. */
export interface PreviewSubmittedFile {
  /** Base64-encoded file contents. */
  contents: string;
  name: string;
}

export type LocalPreviewSubmissionFilesRegistrationResult =
  | { ok: true }
  | { maxSize: number; ok: false; reason: 'size-limit-exceeded' };

type QuestionPreviewSubmissionFileResolveResult =
  | { found: false }
  | { contents: Buffer; filename: string; found: true };

interface SubmissionFileRequest {
  filename: string;
  submissionId: string;
}

function submissionFilesSize(filesByName: Map<string, Buffer>): number {
  let size = 0;
  for (const [name, contents] of filesByName) {
    size += Buffer.byteLength(name) + contents.byteLength;
  }
  // `lru-cache` requires every retained entry to have a positive size.
  return Math.max(1, size);
}

function encodedSubmissionFilesSize(files: readonly PreviewSubmittedFile[]): number {
  const sizesByName = new Map<string, number>();
  for (const file of files) {
    sizesByName.set(
      file.name,
      Buffer.byteLength(file.name) + Buffer.byteLength(file.contents, 'base64'),
    );
  }
  return Math.max(
    1,
    [...sizesByName.values()].reduce((sum, size) => sum + size, 0),
  );
}

function decodeSafeUrlPathSegments(encodedPath: string) {
  if (encodedPath.length === 0) return null;

  const decodedSegments: string[] = [];
  for (const segment of encodedPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }

    if (
      decoded.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\0') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      path.isAbsolute(decoded)
    ) {
      return null;
    }

    decodedSegments.push(decoded);
  }

  return decodedSegments;
}

function submissionFileRequestFromPathname({
  pathname,
  urlPrefix,
}: {
  pathname: string;
  urlPrefix: string;
}): SubmissionFileRequest | null {
  const routePrefix = `${urlPrefix}${SUBMISSION_FILE_QUESTION_PREFIX}`;
  if (!pathname.startsWith(routePrefix)) return null;

  const segments = decodeSafeUrlPathSegments(pathname.slice(routePrefix.length));
  // Segments are [questionId, 'submission', submissionId, 'file', ...fileSegments].
  // The question id is a constant in the preview, so only the submission id
  // discriminates a request.
  if (segments == null || segments.length < 5) return null;

  const [, submissionKeyword, submissionId, fileKeyword, ...fileSegments] = segments;
  if (submissionKeyword !== 'submission' || fileKeyword !== 'file') return null;

  return {
    filename: fileSegments.join('/'),
    submissionId,
  };
}

/**
 * An in-memory, LRU-bounded store of the files a Preview Answer Check graded,
 * keyed by a per-render submission id. It lets `pl-file-preview` download and
 * inline-preview graded files for the render that produced them, without any
 * persistence or filesystem access.
 */
export class LocalPreviewSubmissionFiles {
  private nextSubmissionId = 1;
  private readonly entries: LRUCache<string, Map<string, Buffer>>;
  private readonly maxSize: number;
  private readonly urlPrefix: string;

  constructor({
    max = DEFAULT_LOCAL_PREVIEW_SUBMISSION_REGISTRY_MAX,
    maxSize = DEFAULT_LOCAL_PREVIEW_SUBMISSION_REGISTRY_MAX_SIZE,
    urlPrefix,
  }: {
    max?: number;
    maxSize?: number;
    urlPrefix: string;
  }) {
    this.entries = new LRUCache({ max, maxSize, sizeCalculation: submissionFilesSize });
    this.maxSize = maxSize;
    this.urlPrefix = urlPrefix;
  }

  get routePattern() {
    return `${this.urlPrefix}${SUBMISSION_FILE_QUESTION_PREFIX}*`;
  }

  createSubmissionId(): string {
    return String(this.nextSubmissionId++);
  }

  registerFiles({
    files,
    id,
  }: {
    files: PreviewSubmittedFile[];
    id: string;
  }): LocalPreviewSubmissionFilesRegistrationResult {
    if (encodedSubmissionFilesSize(files) > this.maxSize) {
      this.entries.delete(id);
      return { maxSize: this.maxSize, ok: false, reason: 'size-limit-exceeded' };
    }

    const filesByName = new Map<string, Buffer>();
    for (const file of files) {
      filesByName.set(file.name, Buffer.from(file.contents, 'base64'));
    }
    if (submissionFilesSize(filesByName) > this.maxSize) {
      this.entries.delete(id);
      return { maxSize: this.maxSize, ok: false, reason: 'size-limit-exceeded' };
    }
    this.entries.set(id, filesByName);
    return { ok: true };
  }

  resolveRequest(pathname: string): QuestionPreviewSubmissionFileResolveResult | null {
    const request = submissionFileRequestFromPathname({ pathname, urlPrefix: this.urlPrefix });
    if (request == null) return null;

    const contents = this.entries.get(request.submissionId)?.get(request.filename);
    if (contents == null) return { found: false };

    return {
      contents,
      filename: request.filename,
      found: true,
    };
  }
}
