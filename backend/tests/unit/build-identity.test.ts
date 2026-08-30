import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compiledArtifactDigest,
  isTrustedBuildIdentity,
  readBuildIdentity,
} from '../../src/buildIdentity';

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
    const artifactRoot = join(directory, 'dist');
    mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, 'server.js'), 'export const exact = true;\n');
    const artifactDigest = compiledArtifactDigest(artifactRoot);
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
        artifact_digest: artifactDigest,
        artifact_verified: true,
      })
    );

    const identity = readBuildIdentity(path, artifactRoot);
    expect(identity.revision).toBe('c'.repeat(40));
    expect(isTrustedBuildIdentity(identity)).toBe(true);
  });

  it('detects executable artifact substitution even when serialized identity claims trust', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hx-build-'));
    directories.push(directory);
    const path = join(directory, 'identity.json');
    const artifactRoot = join(directory, 'dist');
    mkdirSync(artifactRoot);
    const executable = join(artifactRoot, 'server.js');
    writeFileSync(executable, 'export const exact = true;\n');
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      service: 'hustlexp-engine',
      revision: 'd'.repeat(40),
      built_at: '2026-07-21T20:00:00.000Z',
      environment: 'production',
      clean_source: true,
      source: 'RAILWAY_GIT_COMMIT_SHA',
      artifact_digest: compiledArtifactDigest(artifactRoot),
      artifact_verified: true,
    }));
    writeFileSync(executable, 'export const substituted = true;\n');

    const identity = readBuildIdentity(path, artifactRoot);
    expect(identity.artifact_verified).toBe(false);
    expect(isTrustedBuildIdentity(identity)).toBe(false);
  });

  it('never trusts an empty executable artifact tree', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hx-build-'));
    directories.push(directory);
    const path = join(directory, 'identity.json');
    const artifactRoot = join(directory, 'dist');
    mkdirSync(artifactRoot);
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      service: 'hustlexp-engine',
      revision: 'e'.repeat(40),
      built_at: '2026-07-21T20:00:00.000Z',
      environment: 'production',
      clean_source: true,
      source: 'RAILWAY_GIT_COMMIT_SHA',
      artifact_digest: compiledArtifactDigest(artifactRoot),
      artifact_verified: true,
    }));

    const identity = readBuildIdentity(path, artifactRoot);
    expect(identity.artifact_verified).toBe(false);
    expect(isTrustedBuildIdentity(identity)).toBe(false);
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
