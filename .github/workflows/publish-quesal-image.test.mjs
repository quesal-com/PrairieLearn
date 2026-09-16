import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('./publish-quesal-image.yml', import.meta.url);

test('publishes to Docker Hub with dedicated credentials', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^\s*REGISTRY: docker\.io$/m);
  assert.match(workflow, /^\s*IMAGE_NAME: quesal\/prairielearn$/m);
  assert.equal([...workflow.matchAll(/\$\{\{ secrets\.DOCKERHUB_USERNAME \}\}/g)].length, 2);
  assert.equal([...workflow.matchAll(/\$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/g)].length, 2);
  assert.doesNotMatch(workflow, /ghcr\.io|secrets\.GITHUB_TOKEN|packages:\s+write/);
});

test('manual releases build and tag an explicit source without moving latest', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /source_ref:\n\s+description:/);
  assert.match(workflow, /release_tag:\n\s+description:/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.source_sha \}\}/);
  assert.match(
    workflow,
    /org\.opencontainers\.image\.revision=\$\{\{ needs\.prepare\.outputs\.source_sha \}\}/,
  );
  assert.match(workflow, /type=raw,value=latest,enable=\$\{\{ github\.event_name == 'push' \}\}/);
  assert.match(
    workflow,
    /type=raw,value=\$\{\{ inputs\.release_tag \}\},enable=\$\{\{ github\.event_name == 'workflow_dispatch' \}\}/,
  );
});
