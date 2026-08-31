import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveBuildIdentity, writeBuildIdentity } from './write-build-identity.mjs';

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

test('creates and measures a missing artifact directory without trusting an empty tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'hustlexp-build-identity-'));
  const output = join(root, 'missing-dist', 'hx-build-identity.json');
  try {
    const identity = writeBuildIdentity({
      output,
      env: { NODE_ENV: 'test' },
      now: NOW,
      git: () => '',
    });

    assert.equal(existsSync(output), true);
    assert.match(identity.artifact_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(identity.artifact_verified, false);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
