import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseProvenance, resolveBuildIdentity } from './write-build-identity.mjs';

const SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const SHA256 = 'd'.repeat(64);
const NOW = () => new Date('2026-07-21T20:00:00.000Z');

function releaseProvenance(overrides = {}) {
  return parseReleaseProvenance(`${JSON.stringify({
    schema_version: 1,
    source: 'git-archive',
    revision: SHA,
    source_tree: 'a'.repeat(40),
    source_archive_sha256: SHA256,
    migration_artifact_sha256: 'e'.repeat(64),
    built_at: '2026-07-21T20:00:00.000Z',
    clean_source: true,
    ...overrides,
  })}\n`);
}

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

test('binds production identity to content-addressed release provenance', () => {
  const provenance = releaseProvenance();
  const identity = resolveBuildIdentity({
    env: {
      HX_BUILD_ENVIRONMENT: 'production',
      RAILWAY_GIT_COMMIT_SHA: SHA,
    },
    releaseProvenance: provenance,
    now: NOW,
    git: () => '',
  });

  assert.equal(identity.revision, SHA);
  assert.equal(identity.clean_source, true);
  assert.equal(identity.source, 'release-provenance');
  assert.equal(identity.source_tree, 'a'.repeat(40));
  assert.equal(identity.source_archive_sha256, SHA256);
  assert.equal(identity.migration_artifact_sha256, 'e'.repeat(64));
  assert.match(identity.provenance_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(identity.built_at, '2026-07-21T20:00:00.000Z');
});

test('rejects conflicting revision or timestamp sources', () => {
  const provenance = releaseProvenance();
  assert.throws(
    () => resolveBuildIdentity({
      env: {
        HX_BUILD_ENVIRONMENT: 'production',
        RAILWAY_GIT_COMMIT_SHA: OTHER_SHA,
      },
      releaseProvenance: provenance,
      now: NOW,
      git: () => '',
    }),
    /Conflicting build revision sources/
  );
  assert.throws(
    () => resolveBuildIdentity({
      env: {
        HX_BUILD_ENVIRONMENT: 'production',
        GITHUB_SHA: SHA,
        HX_BUILD_TIMESTAMP: '2026-07-21T20:00:01.000Z',
      },
      releaseProvenance: provenance,
      now: NOW,
      git: () => '',
    }),
    /Conflicting build timestamps/
  );
});

test('rejects malformed release provenance and invalid production revision sources', () => {
  assert.throws(
    () => parseReleaseProvenance('{"schema_version":1}'),
    /malformed or incomplete/
  );
  assert.throws(
    () => resolveBuildIdentity({
      env: {
        HX_BUILD_ENVIRONMENT: 'production',
        GITHUB_SHA: 'not-a-sha',
      },
      releaseProvenance: null,
      now: NOW,
      git: () => '',
    }),
    /invalid revision source/
  );
});
