import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { createLocalPreviewCourseSource } from '../question-preview/course-source.js';

import { loadAssessmentPreviewPlan } from './load.js';
import { parseAssessmentPreviewLocator } from './locator.js';

it('loads a nested assessment with fresh course and question metadata into the pure compiler', async () => {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-assessment-preview-load-'));
  const locatorResult = parseAssessmentPreviewLocator({
    aid: 'module/homework',
    ciid: '2026/fall',
  });
  if (!locatorResult.ok) throw new Error(locatorResult.error.message);

  try {
    await fs.writeFile(
      path.join(courseDir, 'infoCourse.json'),
      JSON.stringify({
        assessmentSets: [
          { abbreviation: 'HW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
        ],
        name: 'TST 101',
        timezone: 'America/Chicago',
        title: 'Assessment preview loading',
        topics: [{ color: 'blue1', name: 'Testing' }],
      }),
    );
    await fs.mkdir(path.join(courseDir, 'questions', 'local', 'one'), { recursive: true });
    await fs.writeFile(
      path.join(courseDir, 'questions', 'local', 'one', 'info.json'),
      JSON.stringify({
        gradingMethod: 'Internal',
        preferences: { difficulty: { default: 'normal', type: 'string' } },
        title: 'Local one',
        topic: 'Testing',
        type: 'v3',
        uuid: '11111111-1111-4111-8111-111111111191',
      }),
    );
    const courseInstanceDir = path.join(courseDir, 'courseInstances', '2026', 'fall');
    const assessmentDir = path.join(courseInstanceDir, 'assessments', 'module', 'homework');
    await fs.mkdir(assessmentDir, { recursive: true });
    await fs.writeFile(
      path.join(courseInstanceDir, 'infoCourseInstance.json'),
      JSON.stringify({
        longName: 'Fall 2026',
        uuid: '11111111-1111-4111-8111-111111111192',
      }),
    );
    await fs.writeFile(
      path.join(assessmentDir, 'infoAssessment.json'),
      JSON.stringify({
        number: '2',
        set: 'Homework',
        title: 'Loaded homework',
        type: 'Homework',
        uuid: '11111111-1111-4111-8111-111111111193',
        zones: [
          {
            questions: [
              { id: 'local/one', points: 2 },
              { id: '@shared/missing', points: 3 },
            ],
          },
        ],
      }),
    );

    const courseSource = await createLocalPreviewCourseSource(courseDir);
    const loaded = await loadAssessmentPreviewPlan({
      courseSource,
      locator: locatorResult.locator,
    });

    expect(loaded.courseInstance.longName).toBe('Fall 2026');
    expect(loaded.assessment.title).toBe('Loaded homework');
    expect(loaded.plan).toMatchObject({
      assessmentSetAbbreviation: 'HW',
      courseTimezone: 'America/Chicago',
    });
    expect(loaded.plan.zones[0].pools[0].alternatives[0]).toMatchObject({
      qid: 'local/one',
      title: 'Local one',
      preferences: { difficulty: 'normal' },
    });
    expect(loaded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'shared-question', severity: 'unsupported' }),
      ]),
    );

    await fs.writeFile(
      path.join(courseDir, 'infoCourse.json'),
      JSON.stringify({
        assessmentSets: [
          { abbreviation: 'HMW', color: 'green1', heading: 'Homeworks', name: 'Homework' },
        ],
        name: 'TST 101',
        timezone: 'America/Los_Angeles',
        title: 'Edited assessment preview loading',
        topics: [{ color: 'blue1', name: 'Testing' }],
      }),
    );

    const reloaded = await loadAssessmentPreviewPlan({
      courseSource,
      locator: locatorResult.locator,
    });
    expect(reloaded.plan).toMatchObject({
      assessmentSetAbbreviation: 'HMW',
      courseTimezone: 'America/Los_Angeles',
    });
  } finally {
    await fs.rm(courseDir, { force: true, recursive: true });
  }
});
