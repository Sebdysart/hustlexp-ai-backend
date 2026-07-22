import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBuildIdentity } from './write-build-identity.mjs';

const SHA = 'b'.repeat(40);
const NOW = () => new Date('2026-07-21T20:00:00.000Z');

test('trusts Railway commit provenance for a production engine artifact', () => {
  const identity = resolveBuildIdentity({
    env: { HX_BUILD_ENVIRONMENT: 'production', RAILWAY_GIT_COMMIT_SHA: SHA },
    now: NOW,
    git: () => '',
  });
  assert.equal(identity.revision, SHA);
  assert.equal(identity.clean_source, true);
  assert.equal(identity.source, 'RAILWAY_GIT_COMMIT_SHA');
  assert.equal(identity.service, 'hustlexp-engine');
});

test('marks a dirty local Git fallback without blocking development', () => {
  const identity = resolveBuildIdentity({
    env: {},
    now: NOW,
    git: (args) => (args[0] === 'rev-parse' ? SHA : ' M backend/src/server.ts'),
  });
  assert.equal(identity.revision, SHA);
  assert.equal(identity.clean_source, false);
  assert.equal(identity.source, 'git');
});

test('rejects unattributed or dirty production engine artifacts', () => {
  assert.throws(
    () => resolveBuildIdentity({ env: { NODE_ENV: 'production' }, now: NOW, git: () => '' }),
    /clean, immutable 40-character Git revision/
  );
  assert.throws(
    () =>
      resolveBuildIdentity({
        env: { NODE_ENV: 'production', HX_BUILD_REVISION: SHA },
        now: NOW,
        git: () => '',
      }),
    /clean, immutable 40-character Git revision/
  );
});
