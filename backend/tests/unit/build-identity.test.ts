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
  it('reads an attributable clean build artifact', () => {
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
        source: 'RAILWAY_GIT_COMMIT_SHA',
      })
    );

    const identity = readBuildIdentity(path);
    expect(identity.revision).toBe('c'.repeat(40));
    expect(isTrustedBuildIdentity(identity)).toBe(true);
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
