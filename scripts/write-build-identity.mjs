import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TRUSTED_CLEAN_SOURCES = new Set(['RAILWAY_GIT_COMMIT_SHA', 'GITHUB_SHA', 'SOURCE_VERSION']);
const RELEASE_PROVENANCE_PATH = '.hx-release-provenance.json';

function defaultGit(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function parseReleaseProvenance(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Release provenance must be valid JSON.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    value.schema_version !== 1 ||
    value.source !== 'git-archive' ||
    value.clean_source !== true ||
    !REVISION.test(String(value.revision || '').toLowerCase()) ||
    !REVISION.test(String(value.source_tree || '').toLowerCase()) ||
    !SHA256.test(String(value.source_archive_sha256 || '').toLowerCase()) ||
    !SHA256.test(String(value.migration_artifact_sha256 || '').toLowerCase()) ||
    typeof value.built_at !== 'string' ||
    Number.isNaN(Date.parse(value.built_at))
  ) {
    throw new Error('Release provenance is malformed or incomplete.');
  }
  return {
    schema_version: 1,
    source: 'git-archive',
    revision: value.revision.toLowerCase(),
    source_tree: value.source_tree.toLowerCase(),
    source_archive_sha256: value.source_archive_sha256.toLowerCase(),
    migration_artifact_sha256: value.migration_artifact_sha256.toLowerCase(),
    built_at: new Date(value.built_at).toISOString(),
    clean_source: true,
    provenance_sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
  };
}

function defaultReleaseProvenance() {
  const path = resolve(process.cwd(), RELEASE_PROVENANCE_PATH);
  try {
    return parseReleaseProvenance(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function resolveBuildIdentity({
  env = process.env,
  now = () => new Date(),
  git = defaultGit,
  releaseProvenance = defaultReleaseProvenance(),
} = {}) {
  const environment = env.HX_BUILD_ENVIRONMENT || env.NODE_ENV || 'development';
  const candidates = [
    ['release-provenance', releaseProvenance?.revision],
    ['HX_BUILD_REVISION', env.HX_BUILD_REVISION],
    ['RAILWAY_GIT_COMMIT_SHA', env.RAILWAY_GIT_COMMIT_SHA],
    ['GITHUB_SHA', env.GITHUB_SHA],
    ['SOURCE_VERSION', env.SOURCE_VERSION],
  ];
  const populatedCandidates = candidates
    .map(([source, value]) => [
      source,
      String(value || '')
        .trim()
        .toLowerCase(),
    ])
    .filter(([, value]) => value.length > 0);
  if (
    environment === 'production' &&
    populatedCandidates.some(([, value]) => !REVISION.test(value))
  ) {
    throw new Error('Production build contains an invalid revision source.');
  }
  const validCandidates = populatedCandidates.filter(([, value]) => REVISION.test(value));
  const distinctRevisions = new Set(validCandidates.map(([, value]) => value));
  if (distinctRevisions.size > 1) {
    throw new Error('Conflicting build revision sources are forbidden.');
  }
  let [source, revision] = validCandidates[0] ?? [];
  if (!revision) {
    const gitRevision = git(['rev-parse', 'HEAD']).toLowerCase();
    if (REVISION.test(gitRevision)) {
      source = 'git';
      revision = gitRevision;
    }
  }

  let cleanSource = false;
  if (source === 'release-provenance') cleanSource = true;
  else if (source && TRUSTED_CLEAN_SOURCES.has(source)) cleanSource = true;
  else if (source === 'HX_BUILD_REVISION') cleanSource = env.HX_BUILD_SOURCE_CLEAN === 'true';
  else if (source === 'git') cleanSource = git(['status', '--porcelain=v1']).length === 0;

  if (environment === 'production' && (!revision || !cleanSource)) {
    throw new Error('Production build requires a clean, immutable 40-character Git revision.');
  }
  if (releaseProvenance?.built_at && env.HX_BUILD_TIMESTAMP) {
    const explicitTimestamp = new Date(env.HX_BUILD_TIMESTAMP);
    if (
      Number.isNaN(explicitTimestamp.getTime()) ||
      explicitTimestamp.toISOString() !== releaseProvenance.built_at
    ) {
      throw new Error('Conflicting build timestamps are forbidden.');
    }
  }
  const timestamp = releaseProvenance?.built_at || env.HX_BUILD_TIMESTAMP || now().toISOString();
  if (Number.isNaN(Date.parse(timestamp)))
    throw new Error('Build timestamp must be a valid ISO-8601 value.');
  const identity = {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision: revision || 'unattributed',
    built_at: timestamp,
    environment,
    clean_source: cleanSource,
    source: source || 'none',
  };
  if (releaseProvenance) {
    Object.assign(identity, {
      source_tree: releaseProvenance.source_tree,
      source_archive_sha256: releaseProvenance.source_archive_sha256,
      migration_artifact_sha256: releaseProvenance.migration_artifact_sha256,
      provenance_sha256: releaseProvenance.provenance_sha256,
    });
  }
  return identity;
}

export function writeBuildIdentity({
  output = resolve(process.cwd(), 'dist/hx-build-identity.json'),
  ...options
} = {}) {
  const identity = resolveBuildIdentity(options);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  return identity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const identity = writeBuildIdentity();
  console.log(`HustleXP engine build identity: ${identity.revision}`);
}
