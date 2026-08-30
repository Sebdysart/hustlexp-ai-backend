import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export interface BuildIdentity {
  schema_version: 1;
  service: 'hustlexp-engine';
  revision: string;
  built_at: string;
  environment: string;
  clean_source: boolean;
  source: string;
  artifact_digest: string;
  /** Derived at runtime; a serialized value is never trusted. */
  artifact_verified: boolean;
}

const REVISION = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EXCLUDED_ARTIFACT_FILES = new Set([
  'hx-build-identity.json',
  'hx-release-manifest.json',
  'hx-release-manifest.json.sig',
]);

function artifactEntries(root: string, directory = root): Array<{ path: string; sha256: string }> {
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...artifactEntries(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const artifactPath = relative(root, absolutePath).replaceAll('\\', '/');
    if (EXCLUDED_ARTIFACT_FILES.has(artifactPath)) continue;
    entries.push({
      path: artifactPath,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
    });
  }
  return entries;
}

/** Deterministic measurement of the executable dist tree, excluding evidence files. */
export function compiledArtifactDigest(root: string): string {
  const entries = artifactEntries(root).sort((left, right) => left.path.localeCompare(right.path));
  return `sha256:${createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex')}`;
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
    typeof candidate.artifact_digest === 'string' &&
    DIGEST.test(candidate.artifact_digest)
  );
}

export function readBuildIdentity(
  path = resolve(process.cwd(), 'dist/hx-build-identity.json'),
  artifactRoot = dirname(path),
): BuildIdentity {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isBuildIdentity(parsed)) {
      const measuredDigest = compiledArtifactDigest(artifactRoot);
      return {
        ...parsed,
        artifact_verified:
          artifactEntries(artifactRoot).length > 0
          && measuredDigest === parsed.artifact_digest,
      };
    }
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
    artifact_digest: 'unattributed',
    artifact_verified: false,
  };
}

export function isTrustedBuildIdentity(identity: BuildIdentity): boolean {
  return (
    REVISION.test(identity.revision)
    && identity.clean_source
    && DIGEST.test(identity.artifact_digest)
    && identity.artifact_verified
  );
}

export const buildIdentity = readBuildIdentity();
