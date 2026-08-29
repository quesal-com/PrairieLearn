import { assert, describe, it } from 'vitest';

import { parseAssessmentPreviewLocator } from './locator.js';

describe('assessment preview locator', () => {
  it('parses nested course-instance and assessment ids into safe path forms', () => {
    const result = parseAssessmentPreviewLocator({
      aid: 'module one/homework 1',
      ciid: '2026/fall',
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.error.message);
    assert.deepEqual(
      {
        aid: result.locator.aid,
        aidEncodedPath: result.locator.aidEncodedPath,
        aidPathSegments: result.locator.aidPathSegments,
        ciid: result.locator.ciid,
        ciidEncodedPath: result.locator.ciidEncodedPath,
        ciidPathSegments: result.locator.ciidPathSegments,
      },
      {
        aid: 'module one/homework 1',
        aidEncodedPath: 'module%20one/homework%201',
        aidPathSegments: ['module one', 'homework 1'],
        ciid: '2026/fall',
        ciidEncodedPath: '2026/fall',
        ciidPathSegments: ['2026', 'fall'],
      },
    );
  });

  it('rejects locators that can escape or confuse either source namespace', () => {
    for (const input of [
      { aid: '', ciid: 'fall' },
      { aid: 'homework', ciid: '' },
      { aid: '../homework', ciid: 'fall' },
      { aid: 'homework', ciid: 'fall/../secret' },
      { aid: 'homework\\one', ciid: 'fall' },
      { aid: 'homework', ciid: '/fall' },
    ]) {
      const result = parseAssessmentPreviewLocator(input);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error('Expected an invalid assessment preview locator.');
      assert.equal(
        result.error.message,
        'Invalid assessment locator. Expected relative course-instance and assessment ids.',
      );
    }
  });
});
