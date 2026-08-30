import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { APIRequestContext, Page } from '@playwright/test';

import { expect, standaloneTest as test } from './fixtures.js';

const fixtureCourseDir = fileURLToPath(
  new URL('fixtures/standalone-preview-course', import.meta.url),
);
const previewEntrypoint = fileURLToPath(
  new URL('../../../dist/preview-server.js', import.meta.url),
);
const sourceQuestionTypeCases = [
  ['freeform/v3', 'Freeform browser contract'],
  ['legacy/calculation', 'Define the vector'],
  ['legacy/multiple-choice', 'What is two plus two?'],
  ['legacy/checkbox', 'Select the true statement.'],
  ['legacy/file', 'Upload the starter file.'],
  ['legacy/multiple-true-false', 'Classify each arithmetic statement.'],
] as const;
const assessmentLocator = { aid: 'browser-contract', ciid: 'local' } as const;
const desktopViewport = { height: 900, width: 1440 } as const;
const narrowViewport = { height: 844, width: 390 } as const;

interface AssessmentPreviewBrowserState {
  questions?: {
    accessMode: string;
    slotId: string;
    status: string;
  }[];
  revision: number;
  status: 'finished' | 'in_progress' | 'not_started';
}

async function startCompiledPreviewServer(args: string[] = []) {
  const child = spawn(
    process.execPath,
    [
      previewEntrypoint,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--workers-execution-mode',
      'native',
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting compiled preview server.\n${stderr}`));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const match = chunk.match(/listening on (?<origin>http:\/\/[^\s]+)/);
      if (match?.groups?.origin == null) return;
      clearTimeout(timeout);
      resolve(match.groups.origin);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Compiled preview server exited with code ${code}.\n${stderr}`));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return {
    close: async () => {
      if (child.exitCode != null) return;
      const exited = new Promise<void>((resolve, reject) => {
        child.once('exit', (code, signal) => {
          if (code === 0 || signal === 'SIGTERM') {
            resolve();
          } else {
            reject(new Error(`Compiled preview server exited with code ${code}.\n${stderr}`));
          }
        });
      });
      child.kill('SIGTERM');
      await exited;
    },
    origin,
  };
}

async function readAssessmentPreviewState(
  request: APIRequestContext,
  overviewUrl: string,
): Promise<AssessmentPreviewBrowserState> {
  const response = await request.get(`${overviewUrl}?format=json`);
  expect(response.status()).toBe(200);
  return (await response.json()) as AssessmentPreviewBrowserState;
}

async function createAssessmentPreview(
  request: APIRequestContext,
  origin: string,
  { started = false }: { started?: boolean } = {},
) {
  const createdSession = await request.post(`${origin}/preview-sessions`, {
    data: { courseDir: fixtureCourseDir },
  });
  expect(createdSession.status()).toBe(201);
  const { previewSessionId } = (await createdSession.json()) as {
    previewSessionId: string;
  };

  const createdRun = await request.post(
    `${origin}/preview-sessions/${previewSessionId}/assessment-preview-runs`,
    {
      data: {
        locator: assessmentLocator,
        reuse: true,
        seed: 'standalone-browser-contract',
      },
    },
  );
  expect(createdRun.status()).toBe(201);
  const createdRunBody = (await createdRun.json()) as {
    assessmentPreviewRunId: string;
    href: string;
  };
  const overviewUrl = new URL(createdRunBody.href, origin).toString();
  const actionsUrl = `${overviewUrl}actions`;

  let state = await readAssessmentPreviewState(request, overviewUrl);
  if (started) {
    const startedRun = await request.post(actionsUrl, {
      data: { action: 'start', revision: state.revision },
    });
    expect(startedRun.status()).toBe(200);
    state = (await startedRun.json()) as AssessmentPreviewBrowserState;
    expect(state.status).toBe('in_progress');
  }
  if (state.questions?.length !== 2) {
    throw new Error('The standalone assessment fixture must sample exactly two questions.');
  }

  return {
    actionsUrl,
    assessmentPreviewRunId: createdRunBody.assessmentPreviewRunId,
    overviewUrl,
    questionSlotIds: state.questions.map((question) => question.slotId),
    questionUrl(slotId: string) {
      return `${overviewUrl}questions/${encodeURIComponent(slotId)}`;
    },
  };
}

async function expectNoHorizontalDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test('creates a runtime Local Preview Session and hydrates every Source Question Type', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer();

  try {
    const health = await request.get(`${server.origin}/health`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const created = await request.post(`${server.origin}/preview-sessions`, {
      data: { courseDir: fixtureCourseDir },
    });
    expect(created.status()).toBe(201);
    const session = (await created.json()) as {
      courseDir: string;
      previewSessionId: string;
    };

    for (const [qid, visibleText] of sourceQuestionTypeCases) {
      await page.goto(
        `${server.origin}/preview-sessions/${session.previewSessionId}/questions/${qid}?variant=1`,
      );
      await expect(page.getByText(visibleText)).toBeVisible();
    }
  } finally {
    await server.close();
  }
});

test('refreshes a startup Local Preview Session and grades both native submission contracts', async ({
  page,
  request,
}) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-standalone-preview-browser-'));
  const courseDir = path.join(tempRoot, 'course');
  await fs.cp(fixtureCourseDir, courseDir, { recursive: true });
  const server = await startCompiledPreviewServer([
    '--course-dir',
    courseDir,
    '--render-mode',
    'full',
  ]);

  try {
    const listed = await request.get(`${server.origin}/preview-sessions`);
    expect(listed.status()).toBe(200);
    const listedBody = (await listed.json()) as {
      previewSessions: { previewSessionId: string }[];
    };
    expect(listedBody.previewSessions).toHaveLength(1);
    const session = listedBody.previewSessions[0];
    expect(session).toBeDefined();
    const sessionUrl = `${server.origin}/preview-sessions/${session.previewSessionId}`;

    for (const [qid, visibleText] of sourceQuestionTypeCases) {
      await page.goto(`${sessionUrl}/questions/${qid}?variant=1`);
      await expect(page.getByText(visibleText).last()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save & Grade' })).toBeVisible();
    }

    const freeformUrl = `${sessionUrl}/questions/freeform/v3?variant=1`;
    await page.goto(freeformUrl);
    await expect(page.getByText('Variant seed 1')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Variant seed 1')).toBeVisible();
    await page.goto(`${sessionUrl}/questions/freeform/v3?variant=2`);
    await expect(page.getByText('Variant seed 2')).toBeVisible();

    await fs.writeFile(
      path.join(courseDir, 'questions/freeform/v3/question.html'),
      '<p>Refreshed source for variant seed {{params.seed}}</p>\n' +
        '<pl-number-input answers-name="ans" label="$x =$"></pl-number-input>\n',
    );
    await page.goto(freeformUrl);
    await expect(page.getByText('Refreshed source for variant seed 1')).toBeVisible();

    await page.getByRole('textbox').fill('2');
    await page.getByRole('button', { name: 'Save & Grade' }).click();
    await expect(page.getByTestId('submission-status').getByText('100%')).toBeVisible();

    await page.goto(`${sessionUrl}/questions/legacy/multiple-choice?variant=1`);
    await page.getByLabel('Four').check();
    await page.getByRole('button', { name: 'Save & Grade' }).click();
    await expect(page.getByTestId('submission-status').getByText('100%')).toBeVisible();

    await page.goto(`${freeformUrl}&render-mode=question-only`);
    await expect(page.getByText('Refreshed source for variant seed 1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save & Grade' })).toHaveCount(0);
  } finally {
    await server.close();
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
});

test('renders browser-safe errors for unknown and deleted Local Preview Sessions', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer();

  try {
    const unknownResponse = await page.goto(
      `${server.origin}/preview-sessions/pvs_0000000000000000000000/questions/freeform/v3`,
    );
    expect(unknownResponse?.status()).toBe(404);
    expect(unknownResponse?.headers()['content-type']).toContain('text/html');
    await expect(page.getByRole('heading', { name: 'Question preview failed' })).toBeVisible();

    const created = await request.post(`${server.origin}/preview-sessions`, {
      data: { courseDir: fixtureCourseDir },
    });
    const session = (await created.json()) as { previewSessionId: string };
    const deleted = await request.delete(
      `${server.origin}/preview-sessions/${session.previewSessionId}`,
    );
    expect(deleted.status()).toBe(204);

    const deletedResponse = await page.goto(
      `${server.origin}/preview-sessions/${session.previewSessionId}/questions/freeform/v3`,
    );
    expect(deletedResponse?.status()).toBe(404);
    expect(deletedResponse?.headers()['content-type']).toContain('text/html');
    await expect(page.getByRole('heading', { name: 'Question preview failed' })).toBeVisible();
  } finally {
    await server.close();
  }
});

test('keeps session-owned browser resources scoped while PrairieLearn assets stay global', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const createSession = async () => {
      const response = await request.post(`${server.origin}/preview-sessions`, {
        data: { courseDir: fixtureCourseDir },
      });
      expect(response.status()).toBe(201);
      return (await response.json()) as { previewSessionId: string };
    };
    const owner = await createSession();
    const other = await createSession();
    const questionUrl = `${server.origin}/preview-sessions/${owner.previewSessionId}/questions/freeform/resources?variant=1`;

    await page.goto(questionUrl);
    const courseHref = await page.getByRole('link', { name: 'course.txt' }).getAttribute('href');
    const questionHref = await page
      .getByRole('link', { name: 'question.txt' })
      .getAttribute('href');
    const generatedHref = await page
      .getByRole('link', { name: 'generated.txt' })
      .getAttribute('href');

    expect(courseHref).toBe(
      `/preview-sessions/${owner.previewSessionId}/preview-render/clientFilesCourse/course.txt`,
    );
    expect(questionHref).toBe(
      `/preview-sessions/${owner.previewSessionId}/preview-render/questions/freeform/resources/files/question.txt`,
    );
    expect(generatedHref).toMatch(
      new RegExp(
        `^/preview-sessions/${owner.previewSessionId}/preview-render/generatedFilesQuestion/variant/[^/]+/generated\\.txt$`,
      ),
    );

    for (const [href, expectedBody] of [
      [courseHref, 'course resource\n'],
      [questionHref, 'question resource\n'],
      [generatedHref, 'generated resource for seed 1'],
    ] as const) {
      const response = await request.get(`${server.origin}${href}`);
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe(expectedBody);
    }

    const globalAsset = await request.get(
      `${server.origin}/assets/public/cache/localscripts/question.js`,
    );
    expect(globalAsset.status()).toBe(200);

    const crossSessionGenerated = await request.get(
      `${server.origin}${generatedHref?.replace(owner.previewSessionId, other.previewSessionId)}`,
    );
    expect(crossSessionGenerated.status()).toBe(404);

    const answerName = `_file_editor_${createHash('sha1').update('solution.py').digest('hex')}`;
    const graded = await request.post(questionUrl, {
      form: {
        __action: 'grade',
        [answerName]: Buffer.from('print("session owned")\n').toString('base64'),
      },
    });
    expect(graded.status()).toBe(200);
    const submissionPath = (await graded.text()).match(
      /data-submission-files-url="(?<path>\/preview-sessions\/[^"?#]+\/file)"/,
    )?.groups?.path;
    expect(submissionPath).toContain(`/preview-sessions/${owner.previewSessionId}/`);
    const submissionFile = await request.get(`${server.origin}${submissionPath}/solution.py`);
    expect(submissionFile.status()).toBe(200);
    expect(await submissionFile.text()).toBe('print("session owned")\n');
  } finally {
    await server.close();
  }
});

test('keeps the standalone assessment overview usable at desktop and narrow widths', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const preview = await createAssessmentPreview(request, server.origin, { started: true });
    await page.setViewportSize(desktopViewport);
    const response = await page.goto(preview.overviewUrl);

    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'Standalone assessment browser contract' }),
    ).toBeVisible();
    const questionsTable = page.getByRole('table', { name: 'Questions' });
    await expect(questionsTable).toBeVisible();
    await expect(page.getByRole('link', { name: 'Freeform browser contract' })).toBeVisible();
    await expect(page.getByText('Multiple choice browser contract')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish preview' })).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);

    await page.setViewportSize(narrowViewport);
    await expect(
      page.getByRole('heading', { name: 'Standalone assessment browser contract' }),
    ).toBeVisible();
    await expect(questionsTable).toBeVisible();
    await expect(page.getByRole('link', { name: 'Freeform browser contract' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish preview' })).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
    await expect(page).toHaveURL(preview.overviewUrl);
  } finally {
    await server.close();
  }
});

test('opens accessible local preview details and restores trigger focus', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const preview = await createAssessmentPreview(request, server.origin);
    await page.goto(preview.overviewUrl);
    const detailsTrigger = page.getByRole('button', { name: 'Preview details', exact: true });
    const detailsDialog = page.getByRole('dialog', { name: 'Local preview details' });

    await expect(detailsTrigger).toBeVisible();
    await detailsTrigger.click();
    await expect(detailsDialog).toBeVisible();
    await expect(detailsDialog).toHaveAttribute('aria-modal', 'true');
    await expect
      .poll(() =>
        detailsDialog.evaluate((dialog) => dialog.contains(dialog.ownerDocument.activeElement)),
      )
      .toBe(true);
    await expect(page).toHaveURL(preview.overviewUrl);

    await detailsDialog.getByRole('button', { name: 'Close' }).click();
    await expect(detailsDialog).toBeHidden();
    await expect(detailsTrigger).toBeFocused();

    await detailsTrigger.click();
    await expect(detailsDialog).toBeVisible();
    await expect
      .poll(() =>
        detailsDialog.evaluate((dialog) => dialog.contains(dialog.ownerDocument.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(detailsDialog).toBeHidden();
    await expect(detailsTrigger).toBeFocused();
    await expect(page).toHaveURL(preview.overviewUrl);
  } finally {
    await server.close();
  }
});

test('uses a responsive 9/3 assessment question and sidebar layout', async ({ page, request }) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const preview = await createAssessmentPreview(request, server.origin, { started: true });
    const questionUrl = preview.questionUrl(preview.questionSlotIds[0]);
    await page.setViewportSize(desktopViewport);
    const response = await page.goto(questionUrl);

    expect(response?.status()).toBe(200);
    await expect(page.getByText('Freeform browser contract: Variant seed')).toBeVisible();
    const questionRegion = page
      .getByRole('main')
      .getByRole('region', { name: 'Question', exact: true });
    const assessmentSidebar = page.getByRole('complementary', {
      name: 'Assessment navigation and score',
    });
    await expect(questionRegion).toBeVisible();
    await expect(assessmentSidebar).toBeVisible();

    const desktopQuestionBox = await questionRegion.boundingBox();
    const desktopSidebarBox = await assessmentSidebar.boundingBox();
    expect(desktopQuestionBox).not.toBeNull();
    expect(desktopSidebarBox).not.toBeNull();
    if (desktopQuestionBox == null || desktopSidebarBox == null) {
      throw new Error('The desktop question layout must have measurable regions.');
    }
    expect(Math.abs(desktopQuestionBox.y - desktopSidebarBox.y)).toBeLessThan(24);
    expect(desktopSidebarBox.x).toBeGreaterThanOrEqual(
      desktopQuestionBox.x + desktopQuestionBox.width - 2,
    );
    expect(desktopQuestionBox.width / desktopSidebarBox.width).toBeGreaterThan(2.4);
    expect(desktopQuestionBox.width / desktopSidebarBox.width).toBeLessThan(3.6);
    await expectNoHorizontalDocumentOverflow(page);

    await page.setViewportSize(narrowViewport);
    const narrowQuestionBox = await questionRegion.boundingBox();
    const narrowSidebarBox = await assessmentSidebar.boundingBox();
    expect(narrowQuestionBox).not.toBeNull();
    expect(narrowSidebarBox).not.toBeNull();
    if (narrowQuestionBox == null || narrowSidebarBox == null) {
      throw new Error('The narrow question layout must have measurable regions.');
    }
    expect(narrowSidebarBox.y).toBeGreaterThanOrEqual(
      narrowQuestionBox.y + narrowQuestionBox.height - 2,
    );
    expect(Math.abs(narrowQuestionBox.x - narrowSidebarBox.x)).toBeLessThan(24);
    expect(narrowQuestionBox.width / narrowSidebarBox.width).toBeGreaterThan(0.9);
    expect(narrowQuestionBox.width / narrowSidebarBox.width).toBeLessThan(1.1);
    await expectNoHorizontalDocumentOverflow(page);
    await expect(page).toHaveURL(questionUrl);
  } finally {
    await server.close();
  }
});

test('saves, reloads, and grades an assessment question through the real runtime', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const preview = await createAssessmentPreview(request, server.origin);
    await page.goto(preview.overviewUrl);
    await page.getByRole('button', { name: 'Start assessment', exact: true }).click();
    await expect(page.getByText('In progress', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Freeform browser contract' }).click();
    const answer = page.getByRole('textbox');
    const questionScore = page.getByRole('table', { name: 'Question score' });
    const assessmentScore = page.getByRole('table', { name: 'Assessment score' });
    await answer.fill('2');
    await page.getByRole('button', { name: 'Save only', exact: true }).click();

    await expect(questionScore.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByText('saved, not graded', { exact: true })).toBeVisible();
    await expect(answer).toHaveValue('2');

    await page.reload();
    await expect(answer).toHaveValue('2');
    await expect(questionScore.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByText('saved, not graded', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Save & Grade', exact: true }).click();
    await expect(page.getByTestId('submission-status').getByText('100%')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Correct answer' })).toBeVisible();
    await expect(questionScore.getByText('Complete', { exact: true })).toBeVisible();
    await expect(questionScore).toContainText('2 / 2');
    await expect(assessmentScore).toContainText('2 / 5');
  } finally {
    await server.close();
  }
});

test('confirms crossing a lockpoint before posting to the existing actions route', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const preview = await createAssessmentPreview(request, server.origin, { started: true });
    await page.goto(preview.overviewUrl);
    const stateBefore = await readAssessmentPreviewState(request, preview.overviewUrl);
    const lockpointTrigger = page.getByRole('button', {
      name: 'Proceed to next questions',
      exact: true,
    });
    const lockpointDialog = page.getByRole('dialog', {
      name: 'Proceed to next questions?',
    });

    await expect(lockpointTrigger).toBeVisible();
    await lockpointTrigger.click();
    await expect(lockpointDialog).toBeVisible();
    await expect(page).toHaveURL(preview.overviewUrl);
    const stateWhileOpen = await readAssessmentPreviewState(request, preview.overviewUrl);
    expect(stateWhileOpen.revision).toBe(stateBefore.revision);
    expect(
      stateWhileOpen.questions?.find((question) => question.slotId === preview.questionSlotIds[1])
        ?.accessMode,
    ).toBe('blocked_lockpoint');

    const safetyGate = lockpointDialog.getByRole('checkbox', {
      name: 'I understand that I will not be able to submit answers to previous questions',
    });
    const confirmButton = lockpointDialog.getByRole('button', { name: 'Confirm' });
    await expect(confirmButton).toBeDisabled();
    await safetyGate.check();
    await expect(confirmButton).toBeEnabled();
    await lockpointDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(lockpointDialog).toBeHidden();
    expect((await readAssessmentPreviewState(request, preview.overviewUrl)).revision).toBe(
      stateBefore.revision,
    );

    await lockpointTrigger.click();
    await expect(lockpointDialog).toBeVisible();
    if (!(await safetyGate.isChecked())) await safetyGate.check();
    const actionResponsePromise = page.waitForResponse(
      (response) => response.url() === preview.actionsUrl && response.request().method() === 'POST',
    );
    await confirmButton.click();
    const actionResponse = await actionResponsePromise;
    expect(actionResponse.status()).toBe(303);
    const submittedAction = new URLSearchParams(actionResponse.request().postData() ?? '');
    expect(submittedAction.get('action')).toBe('cross-lockpoint');
    expect(submittedAction.get('revision')).toBe(String(stateBefore.revision));
    expect(submittedAction.get('zoneId')).toBeTruthy();
    await expect(page).toHaveURL(preview.overviewUrl);
    await expect
      .poll(async () => (await readAssessmentPreviewState(request, preview.overviewUrl)).revision)
      .toBe(stateBefore.revision + 1);
    const stateAfter = await readAssessmentPreviewState(request, preview.overviewUrl);
    expect(
      stateAfter.questions?.find((question) => question.slotId === preview.questionSlotIds[1])
        ?.accessMode,
    ).toBe('default');
  } finally {
    await server.close();
  }
});

test('confirms finishing before posting to the existing actions route', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const preview = await createAssessmentPreview(request, server.origin, { started: true });
    await page.goto(preview.overviewUrl);
    const stateBefore = await readAssessmentPreviewState(request, preview.overviewUrl);
    const finishTrigger = page.getByRole('button', { name: 'Finish preview', exact: true });
    const finishDialog = page.getByRole('dialog', { name: 'All done?' });

    await finishTrigger.click();
    await expect(finishDialog).toBeVisible();
    await expect(finishDialog.getByText('There are still unanswered questions.')).toBeVisible();
    await expect(page).toHaveURL(preview.overviewUrl);
    expect((await readAssessmentPreviewState(request, preview.overviewUrl)).revision).toBe(
      stateBefore.revision,
    );
    await finishDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(finishDialog).toBeHidden();
    await expect(finishTrigger).toBeFocused();

    await finishTrigger.click();
    await expect(finishDialog).toBeVisible();
    const actionResponsePromise = page.waitForResponse(
      (response) => response.url() === preview.actionsUrl && response.request().method() === 'POST',
    );
    await finishDialog.getByRole('button', { name: 'Finish preview', exact: true }).click();
    const actionResponse = await actionResponsePromise;
    expect(actionResponse.status()).toBe(303);
    const submittedAction = new URLSearchParams(actionResponse.request().postData() ?? '');
    expect(submittedAction.get('action')).toBe('finish');
    expect(submittedAction.get('revision')).toBe(String(stateBefore.revision));
    await expect(page).toHaveURL(preview.overviewUrl);
    await expect
      .poll(async () => (await readAssessmentPreviewState(request, preview.overviewUrl)).status)
      .toBe('finished');
  } finally {
    await server.close();
  }
});
