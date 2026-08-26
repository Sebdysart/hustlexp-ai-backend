import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BuildIdentity {
  schema_version: 1;
  service: 'hustlexp-engine';
  revision: string;
  built_at: string;
  environment: string;
  clean_source: boolean;
  source: string;
  source_tree?: string;
  source_archive_sha256?: string;
  migration_artifact_sha256?: string;
  provenance_sha256?: string;
}

const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function hasExactReleaseProvenance(identity: Partial<BuildIdentity>): boolean {
  return identity.source === 'release-provenance'
    && REVISION.test(identity.source_tree ?? '')
    && SHA256.test(identity.source_archive_sha256 ?? '')
    && SHA256.test(identity.migration_artifact_sha256 ?? '')
    && SHA256.test(identity.provenance_sha256 ?? '');
}

function isBuildIdentity(value: unknown): value is BuildIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BuildIdentity>;
  return (
    candidate.schema_version === 1 &&
    candidate.service === 'hustlexp-engine' &&
    typeof candidate.revision === 'string' &&
    (REVISION.test(candidate.revision) || candidate.revision === 'unattributed') &&
    typeof candidate.built_at === 'string' &&
    !Number.isNaN(Date.parse(candidate.built_at)) &&
    typeof candidate.environment === 'string' &&
    typeof candidate.clean_source === 'boolean' &&
    typeof candidate.source === 'string' &&
    (candidate.source !== 'release-provenance' || hasExactReleaseProvenance(candidate))
  );
}

export function readBuildIdentity(
  path = resolve(process.cwd(), 'dist/hx-build-identity.json')
): BuildIdentity {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isBuildIdentity(parsed)) return parsed;
  } catch {
    // A missing or malformed identity is exposed as unattributed, never invented.
  }
  return {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision: 'unattributed',
    built_at: '1970-01-01T00:00:00.000Z',
    environment: process.env.NODE_ENV || 'development',
    clean_source: false,
    source: 'none',
  };
}

export function isTrustedBuildIdentity(identity: BuildIdentity): boolean {
  return identity.environment === 'production'
    && REVISION.test(identity.revision)
    && identity.clean_source
    && hasExactReleaseProvenance(identity);
}

export const buildIdentity = readBuildIdentity();
