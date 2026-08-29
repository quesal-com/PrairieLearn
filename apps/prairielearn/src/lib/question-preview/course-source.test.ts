import nodeAssert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { parseAssessmentPreviewLocator } from '../assessment-preview/locator.js';

import { createLocalPreviewCourseSource } from './course-source.js';
import { parseQuestionPreviewQid } from './qid.js';

async function makeCourseRoot(infoCourse: Record<string, unknown>) {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-course-source-'));
  await fs.writeFile(path.join(courseDir, 'infoCourse.json'), JSON.stringify(infoCourse));
  await fs.mkdir(path.join(courseDir, 'questions'));
  return courseDir;
}

describe('Local Preview Course Source', () => {
  it('rejects relative course directories', async () => {
    await nodeAssert.rejects(createLocalPreviewCourseSource('relative/course'), {
      message: 'Invalid Local Preview Course Source: course directory must be absolute.',
      name: 'InvalidLocalPreviewCourseError',
    });
  });

  it('rejects invalid course metadata with a stable registration error', async () => {
    const courseDir = await makeCourseRoot({ title: 'Missing required course fields' });

    try {
      await nodeAssert.rejects(createLocalPreviewCourseSource(courseDir), {
        message: 'Invalid Local Preview Course Source: invalid infoCourse.json metadata.',
        name: 'InvalidLocalPreviewCourseError',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects a course without a usable questions directory', async () => {
    const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-course-source-'));
    await fs.writeFile(
      path.join(courseDir, 'infoCourse.json'),
      JSON.stringify({
        name: 'TST 101',
        title: 'Preview source testing',
        topics: [{ color: 'blue1', name: 'Testing' }],
      }),
    );

    try {
      await nodeAssert.rejects(createLocalPreviewCourseSource(courseDir), {
        message: 'Invalid Local Preview Course Source: questions directory is not usable.',
        name: 'InvalidLocalPreviewCourseError',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('registers canonical course metadata with a UTC timezone fallback', async () => {
    const courseDir = await makeCourseRoot({
      assessmentSets: [
        { abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
      ],
      name: 'TST 101',
      options: { questionsReceiveUserData: true },
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-course-link-'));
    const linkedCourseDir = path.join(linkRoot, 'course');
    await fs.symlink(courseDir, linkedCourseDir);

    try {
      const source = await createLocalPreviewCourseSource(linkedCourseDir);

      assert.equal(source.courseDir, await fs.realpath(courseDir));
      assert.deepEqual(source.courseMetadata, {
        assessmentSets: [
          { abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
        ],
        name: 'TST 101',
        options: { questionsReceiveUserData: true },
        timezone: 'UTC',
        title: 'Preview source testing',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(linkRoot, { force: true, recursive: true });
    }
  });

  it('reads edited course metadata fresh and rejects invalid replacements', async () => {
    const courseDir = await makeCourseRoot({
      assessmentSets: [
        { abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
      ],
      name: 'TST 101',
      timezone: 'America/Chicago',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      await fs.writeFile(
        path.join(courseDir, 'infoCourse.json'),
        JSON.stringify({
          assessmentSets: [
            { abbreviation: 'HMW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
          ],
          name: 'TST 101',
          timezone: 'America/Los_Angeles',
          title: 'Edited preview source testing',
          topics: [{ color: 'blue1', name: 'Testing' }],
        }),
      );

      const edited = await source.readCourseInfo();
      assert.equal(edited.assessmentSets?.[0].abbreviation, 'HMW');
      assert.equal(edited.timezone, 'America/Los_Angeles');

      await fs.writeFile(
        path.join(courseDir, 'infoCourse.json'),
        JSON.stringify({ title: 'Invalid replacement' }),
      );
      await nodeAssert.rejects(source.readCourseInfo(), {
        message: 'Invalid Local Preview Course Source: invalid infoCourse.json metadata.',
        name: 'InvalidLocalPreviewCourseError',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects a questions directory that resolves outside the canonical course root', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-outside-questions-'));
    await fs.rm(path.join(courseDir, 'questions'), { recursive: true });
    await fs.symlink(outsideDir, path.join(courseDir, 'questions'));

    try {
      await nodeAssert.rejects(createLocalPreviewCourseSource(courseDir), {
        message:
          'Invalid Local Preview Course Source: questions directory escapes the canonical course root.',
        name: 'InvalidLocalPreviewCourseError',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('reads changing question metadata fresh through the Course Source', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const questionDir = path.join(courseDir, 'questions', 'unit', 'question');
    await fs.mkdir(questionDir, { recursive: true });
    const infoPath = path.join(questionDir, 'info.json');
    const qidResult = parseQuestionPreviewQid('unit/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    try {
      await fs.writeFile(
        infoPath,
        JSON.stringify({
          title: 'Before edit',
          topic: 'Testing',
          type: 'v3',
          uuid: '11111111-1111-4111-8111-111111111160',
        }),
      );
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal((await source.readQuestionInfo(qidResult.qid)).title, 'Before edit');

      await fs.writeFile(
        infoPath,
        JSON.stringify({
          title: 'After edit',
          topic: 'Testing',
          type: 'v3',
          uuid: '11111111-1111-4111-8111-111111111160',
        }),
      );

      assert.equal((await source.readQuestionInfo(qidResult.qid)).title, 'After edit');
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('reads nested course-instance and assessment metadata fresh through the Course Source', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const assessmentDir = path.join(
      courseDir,
      'courseInstances',
      '2026',
      'fall',
      'assessments',
      'module one',
      'homework 1',
    );
    await fs.mkdir(assessmentDir, { recursive: true });
    const courseInstanceInfoPath = path.join(
      courseDir,
      'courseInstances',
      '2026',
      'fall',
      'infoCourseInstance.json',
    );
    const assessmentInfoPath = path.join(assessmentDir, 'infoAssessment.json');
    const locatorResult = parseAssessmentPreviewLocator({
      aid: 'module one/homework 1',
      ciid: '2026/fall',
    });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      await fs.writeFile(
        courseInstanceInfoPath,
        JSON.stringify({
          longName: 'Fall 2026',
          uuid: '11111111-1111-4111-8111-111111111170',
        }),
      );
      await fs.writeFile(
        assessmentInfoPath,
        JSON.stringify({
          number: '1',
          set: 'Homework',
          title: 'Before edit',
          type: 'Homework',
          uuid: '11111111-1111-4111-8111-111111111171',
        }),
      );
      const source = await createLocalPreviewCourseSource(courseDir);

      assert.equal(
        (await source.readCourseInstanceInfo(locatorResult.locator)).longName,
        'Fall 2026',
      );
      assert.equal((await source.readAssessmentInfo(locatorResult.locator)).title, 'Before edit');

      await fs.writeFile(
        assessmentInfoPath,
        JSON.stringify({
          number: '1',
          set: 'Homework',
          title: 'After edit',
          type: 'Homework',
          uuid: '11111111-1111-4111-8111-111111111171',
        }),
      );

      assert.equal((await source.readAssessmentInfo(locatorResult.locator)).title, 'After edit');
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('allows assessment namespace segments that begin with two dots without traversing', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const courseInstanceDir = path.join(courseDir, 'courseInstances', '..fall');
    const assessmentDir = path.join(courseInstanceDir, 'assessments', '..homework');
    await fs.mkdir(assessmentDir, { recursive: true });
    await fs.writeFile(
      path.join(courseInstanceDir, 'infoCourseInstance.json'),
      JSON.stringify({
        longName: 'Dot-prefixed fall',
        uuid: '11111111-1111-4111-8111-111111111177',
      }),
    );
    await fs.writeFile(
      path.join(assessmentDir, 'infoAssessment.json'),
      JSON.stringify({
        number: '1',
        set: 'Homework',
        title: 'Dot-prefixed assessment',
        type: 'Homework',
        uuid: '11111111-1111-4111-8111-111111111178',
      }),
    );
    const locatorResult = parseAssessmentPreviewLocator({ aid: '..homework', ciid: '..fall' });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal(
        (await source.readCourseInstanceInfo(locatorResult.locator)).longName,
        'Dot-prefixed fall',
      );
      assert.equal(
        (await source.readAssessmentInfo(locatorResult.locator)).title,
        'Dot-prefixed assessment',
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects a course instance reached through an in-course symlink outside courseInstances', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const privateCourseInstanceDir = path.join(courseDir, 'private', 'fall');
    await fs.mkdir(path.join(courseDir, 'courseInstances'), { recursive: true });
    await fs.mkdir(path.join(privateCourseInstanceDir, 'assessments', 'homework'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(privateCourseInstanceDir, 'infoCourseInstance.json'),
      JSON.stringify({
        longName: 'Private fall',
        uuid: '11111111-1111-4111-8111-111111111174',
      }),
    );
    await fs.symlink(privateCourseInstanceDir, path.join(courseDir, 'courseInstances', 'fall'));
    const locatorResult = parseAssessmentPreviewLocator({ aid: 'homework', ciid: 'fall' });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      await nodeAssert.rejects(source.readCourseInstanceInfo(locatorResult.locator), {
        message: 'Course instance "fall" escapes the canonical courseInstances namespace.',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it("rejects an assessment reached through an in-course symlink outside its course instance's assessments", async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const courseInstanceDir = path.join(courseDir, 'courseInstances', 'fall');
    const assessmentsDir = path.join(courseInstanceDir, 'assessments');
    const privateAssessmentDir = path.join(courseInstanceDir, 'private', 'homework');
    await fs.mkdir(assessmentsDir, { recursive: true });
    await fs.mkdir(privateAssessmentDir, { recursive: true });
    await fs.writeFile(
      path.join(courseInstanceDir, 'infoCourseInstance.json'),
      JSON.stringify({
        longName: 'Fall',
        uuid: '11111111-1111-4111-8111-111111111175',
      }),
    );
    await fs.writeFile(
      path.join(privateAssessmentDir, 'infoAssessment.json'),
      JSON.stringify({
        number: '1',
        set: 'Homework',
        title: 'Private assessment',
        type: 'Homework',
        uuid: '11111111-1111-4111-8111-111111111176',
      }),
    );
    await fs.symlink(privateAssessmentDir, path.join(assessmentsDir, 'homework'));
    const locatorResult = parseAssessmentPreviewLocator({ aid: 'homework', ciid: 'fall' });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      await nodeAssert.rejects(source.readAssessmentInfo(locatorResult.locator), {
        message: 'Assessment "fall/homework" escapes the canonical assessments namespace.',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects assessment metadata reached through an escaping symlink', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const courseInstanceDir = path.join(courseDir, 'courseInstances', 'fall');
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-outside-assessment-'));
    await fs.mkdir(path.join(courseInstanceDir, 'assessments'), { recursive: true });
    await fs.writeFile(
      path.join(courseInstanceDir, 'infoCourseInstance.json'),
      JSON.stringify({
        longName: 'Fall',
        uuid: '11111111-1111-4111-8111-111111111172',
      }),
    );
    await fs.writeFile(
      path.join(outsideDir, 'infoAssessment.json'),
      JSON.stringify({
        number: '1',
        set: 'Homework',
        title: 'Outside assessment',
        type: 'Homework',
        uuid: '11111111-1111-4111-8111-111111111173',
      }),
    );
    await fs.symlink(outsideDir, path.join(courseInstanceDir, 'assessments', 'homework'));
    const locatorResult = parseAssessmentPreviewLocator({ aid: 'homework', ciid: 'fall' });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      await nodeAssert.rejects(source.readAssessmentInfo(locatorResult.locator), {
        message: 'Assessment "fall/homework" escapes the canonical course root.',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('resolves template metadata through the contained Course Source lookup', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const templateDir = path.join(courseDir, 'questions', 'templates', 'base');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(
      path.join(templateDir, 'info.json'),
      JSON.stringify({
        title: 'Base template',
        topic: 'Testing',
        type: 'v3',
        uuid: '11111111-1111-4111-8111-111111111162',
      }),
    );
    const qidResult = parseQuestionPreviewQid('templates/base');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal((await source.readTemplateInfo(qidResult.qid)).title, 'Base template');
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('resolves inherited legacy files through bounded on-disk template metadata', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const questionDir = path.join(courseDir, 'questions', 'legacy', 'question');
    const templateDir = path.join(courseDir, 'questions', 'legacy', 'template');
    await fs.mkdir(questionDir, { recursive: true });
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(
      path.join(questionDir, 'info.json'),
      JSON.stringify({
        template: 'legacy/template',
        title: 'Inherited legacy question',
        topic: 'Testing',
        type: 'Calculation',
        uuid: '11111111-1111-4111-8111-111111111163',
      }),
    );
    await fs.writeFile(
      path.join(templateDir, 'info.json'),
      JSON.stringify({
        title: 'Legacy template',
        topic: 'Testing',
        type: 'Calculation',
        uuid: '11111111-1111-4111-8111-111111111164',
      }),
    );
    const inheritedServerPath = path.join(templateDir, 'server.js');
    await fs.writeFile(inheritedServerPath, 'inherited server');
    const qidResult = parseQuestionPreviewQid('legacy/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      const info = await source.readQuestionInfo(qidResult.qid);
      const resolved = await source.resolveLegacyQuestionFile({
        filename: 'server.js',
        info,
        qid: qidResult.qid,
      });

      assert.equal(resolved.fullPath, await fs.realpath(inheritedServerPath));
      assert.equal(resolved.rootPath, await fs.realpath(templateDir));
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects question metadata reached through an escaping symlink', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-outside-question-'));
    await fs.writeFile(
      path.join(outsideDir, 'info.json'),
      JSON.stringify({
        title: 'Outside question',
        topic: 'Testing',
        type: 'v3',
        uuid: '11111111-1111-4111-8111-111111111161',
      }),
    );
    await fs.mkdir(path.join(courseDir, 'questions', 'unit'));
    await fs.symlink(outsideDir, path.join(courseDir, 'questions', 'unit', 'question'));
    const qidResult = parseQuestionPreviewQid('unit/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      await nodeAssert.rejects(source.readQuestionInfo(qidResult.qid), {
        message: 'Question "unit/question" escapes the canonical course root.',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('resolves only files contained by a canonical course-owned root', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const assetsDir = path.join(courseDir, 'clientFilesCourse');
    await fs.mkdir(assetsDir);
    const courseAsset = path.join(assetsDir, 'course.txt');
    await fs.writeFile(courseAsset, 'course');
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-outside-asset-'));
    const outsideAsset = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideAsset, 'secret');
    await fs.symlink(outsideAsset, path.join(assetsDir, 'secret.txt'));

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal(
        await source.resolveResource({
          filePathSegments: ['course.txt'],
          kind: 'course-client-file',
        }),
        await fs.realpath(courseAsset),
      );
      assert.isNull(
        await source.resolveResource({
          filePathSegments: ['secret.txt'],
          kind: 'course-client-file',
        }),
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('preserves course-wide clientFilesCourse roots that resolve elsewhere inside the course', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const sharedAssetsDir = path.join(courseDir, 'shared-assets');
    const courseAsset = path.join(sharedAssetsDir, 'course.txt');
    await fs.mkdir(sharedAssetsDir);
    await fs.writeFile(courseAsset, 'course');
    await fs.symlink(sharedAssetsDir, path.join(courseDir, 'clientFilesCourse'));

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal(
        await source.resolveResource({
          filePathSegments: ['course.txt'],
          kind: 'course-client-file',
        }),
        await fs.realpath(courseAsset),
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects a course-instance asset root that leaves its canonical course instance', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const courseInstanceDir = path.join(courseDir, 'courseInstances', 'fall');
    const privateAssetsDir = path.join(courseDir, 'private-assets');
    await fs.mkdir(courseInstanceDir, { recursive: true });
    await fs.mkdir(privateAssetsDir);
    await fs.writeFile(path.join(privateAssetsDir, 'secret.txt'), 'private course asset');
    await fs.symlink(privateAssetsDir, path.join(courseInstanceDir, 'clientFilesCourseInstance'));
    const locatorResult = parseAssessmentPreviewLocator({ aid: 'homework', ciid: 'fall' });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.isNull(
        await source.resolveResource({
          filePathSegments: ['secret.txt'],
          kind: 'course-instance-client-file',
          locator: locatorResult.locator,
        }),
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects an assessment asset root that leaves its canonical assessment', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const courseInstanceDir = path.join(courseDir, 'courseInstances', 'fall');
    const assessmentDir = path.join(courseInstanceDir, 'assessments', 'homework');
    const privateAssetsDir = path.join(courseInstanceDir, 'private-assets');
    await fs.mkdir(assessmentDir, { recursive: true });
    await fs.mkdir(privateAssetsDir);
    await fs.writeFile(path.join(privateAssetsDir, 'secret.txt'), 'private assessment asset');
    await fs.symlink(privateAssetsDir, path.join(assessmentDir, 'clientFilesAssessment'));
    const locatorResult = parseAssessmentPreviewLocator({ aid: 'homework', ciid: 'fall' });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.isNull(
        await source.resolveResource({
          filePathSegments: ['secret.txt'],
          kind: 'assessment-client-file',
          locator: locatorResult.locator,
        }),
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('resolves course-instance and assessment assets only inside their owned roots', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const courseInstanceDir = path.join(courseDir, 'courseInstances', 'fall');
    const assessmentDir = path.join(courseInstanceDir, 'assessments', 'homework');
    const courseInstanceAssetsDir = path.join(courseInstanceDir, 'clientFilesCourseInstance');
    const assessmentAssetsDir = path.join(assessmentDir, 'clientFilesAssessment');
    await fs.mkdir(courseInstanceAssetsDir, { recursive: true });
    await fs.mkdir(assessmentAssetsDir, { recursive: true });
    const courseInstanceAsset = path.join(courseInstanceAssetsDir, 'instance.txt');
    const assessmentAsset = path.join(assessmentAssetsDir, 'assessment.txt');
    await fs.writeFile(courseInstanceAsset, 'instance');
    await fs.writeFile(assessmentAsset, 'assessment');
    const locatorResult = parseAssessmentPreviewLocator({ aid: 'homework', ciid: 'fall' });
    if (!locatorResult.ok) throw new Error(locatorResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal(
        await source.resolveResource({
          filePathSegments: ['instance.txt'],
          kind: 'course-instance-client-file',
          locator: locatorResult.locator,
        }),
        await fs.realpath(courseInstanceAsset),
      );
      assert.equal(
        await source.resolveResource({
          filePathSegments: ['assessment.txt'],
          kind: 'assessment-client-file',
          locator: locatorResult.locator,
        }),
        await fs.realpath(assessmentAsset),
      );
      assert.isNull(
        await source.resolveResource({
          filePathSegments: ['..', 'infoAssessment.json'],
          kind: 'assessment-client-file',
          locator: locatorResult.locator,
        }),
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('sanitizes its canonical path from nested diagnostic values', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.deepEqual(
        source.sanitizeDiagnosticValue({
          message: `Failed below ${source.courseDir}/questions`,
          paths: [source.courseDir],
        }),
        {
          message: 'Failed below <course>/questions',
          paths: ['<course>'],
        },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});
