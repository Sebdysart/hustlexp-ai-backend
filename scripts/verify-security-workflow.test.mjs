import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/security.yml', import.meta.url);

test('public-repository security checks cannot be disabled by a repository variable', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.doesNotMatch(workflow, /ENABLE_GITHUB_ADVANCED_SECURITY/);
  assert.match(workflow, /github\/codeql-action\/init@v3/);
  assert.match(workflow, /github\/codeql-action\/analyze@v3/);
  assert.match(workflow, /actions\/dependency-review-action@v4/);
  assert.match(
    workflow,
    /dependency-review:\s*[\s\S]*?if:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/
  );
});
