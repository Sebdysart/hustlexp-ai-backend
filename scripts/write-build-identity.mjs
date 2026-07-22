import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REVISION = /^[0-9a-f]{40}$/u;
const TRUSTED_CLEAN_SOURCES = new Set(['RAILWAY_GIT_COMMIT_SHA', 'GITHUB_SHA', 'SOURCE_VERSION']);

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

export function resolveBuildIdentity({
  env = process.env,
  now = () => new Date(),
  git = defaultGit,
} = {}) {
  const environment = env.HX_BUILD_ENVIRONMENT || env.NODE_ENV || 'development';
  const candidates = [
    ['HX_BUILD_REVISION', env.HX_BUILD_REVISION],
    ['RAILWAY_GIT_COMMIT_SHA', env.RAILWAY_GIT_COMMIT_SHA],
    ['GITHUB_SHA', env.GITHUB_SHA],
    ['SOURCE_VERSION', env.SOURCE_VERSION],
  ];
  let [source, revision] =
    candidates.find(([, value]) =>
      /^[0-9a-f]{40}$/u.test(
        String(value || '')
          .trim()
          .toLowerCase()
      )
    ) ?? [];
  if (!revision) {
    const gitRevision = git(['rev-parse', 'HEAD']).toLowerCase();
    if (REVISION.test(gitRevision)) {
      source = 'git';
      revision = gitRevision;
    }
  }

  let cleanSource = false;
  if (source && TRUSTED_CLEAN_SOURCES.has(source)) cleanSource = true;
  else if (source === 'HX_BUILD_REVISION') cleanSource = env.HX_BUILD_SOURCE_CLEAN === 'true';
  else if (source === 'git') cleanSource = git(['status', '--porcelain=v1']).length === 0;

  if (environment === 'production' && (!revision || !cleanSource)) {
    throw new Error('Production build requires a clean, immutable 40-character Git revision.');
  }
  const timestamp = env.HX_BUILD_TIMESTAMP || now().toISOString();
  if (Number.isNaN(Date.parse(timestamp)))
    throw new Error('Build timestamp must be a valid ISO-8601 value.');
  return {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision: revision || 'unattributed',
    built_at: timestamp,
    environment,
    clean_source: cleanSource,
    source: source || 'none',
  };
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
