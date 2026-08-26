import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTrustedBuildIdentity, readBuildIdentity } from '../../src/buildIdentity';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('engine build identity', () => {
  it('trusts only an exact content-addressed production release artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hx-build-'));
    directories.push(directory);
    const path = join(directory, 'identity.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        service: 'hustlexp-engine',
        revision: 'c'.repeat(40),
        built_at: '2026-07-21T20:00:00.000Z',
        environment: 'production',
        clean_source: true,
        source: 'release-provenance',
        source_tree: 'd'.repeat(40),
        source_archive_sha256: '1'.repeat(64),
        migration_artifact_sha256: '2'.repeat(64),
        provenance_sha256: '3'.repeat(64),
      })
    );

    const identity = readBuildIdentity(path);
    expect(identity.revision).toBe('c'.repeat(40));
    expect(isTrustedBuildIdentity(identity)).toBe(true);
  });

  it.each([
    { source: 'RAILWAY_GIT_COMMIT_SHA' },
    { source: 'GITHUB_SHA' },
    { source: 'release-provenance', source_tree: undefined },
    { source: 'release-provenance', provenance_sha256: 'not-a-digest' },
    { source: 'release-provenance', environment: 'development' },
  ])('does not trust an environment-derived or incomplete production identity: %o', (override) => {
    const directory = mkdtempSync(join(tmpdir(), 'hx-build-'));
    directories.push(directory);
    const path = join(directory, 'identity.json');
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      service: 'hustlexp-engine',
      revision: 'c'.repeat(40),
      built_at: '2026-07-21T20:00:00.000Z',
      environment: 'production',
      clean_source: true,
      source: 'release-provenance',
      source_tree: 'd'.repeat(40),
      source_archive_sha256: '1'.repeat(64),
      migration_artifact_sha256: '2'.repeat(64),
      provenance_sha256: '3'.repeat(64),
      ...override,
    }));

    expect(isTrustedBuildIdentity(readBuildIdentity(path))).toBe(false);
  });

  it('fails closed for missing, malformed, or dirty identity data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hx-build-'));
    directories.push(directory);
    const malformed = join(directory, 'malformed.json');
    writeFileSync(malformed, '{"revision":"invented"}');

    expect(readBuildIdentity(join(directory, 'missing.json')).revision).toBe('unattributed');
    expect(isTrustedBuildIdentity(readBuildIdentity(malformed))).toBe(false);
  });
});
