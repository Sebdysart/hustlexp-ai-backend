import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REVISION = /^[0-9a-f]{40}$/u;
const FORBIDDEN_PATH_COMPONENT = '.local-tools';
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const PRUNED_FILESYSTEM_ROOTS = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'reports',
]);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class LocalToolsAbsenceError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'LocalToolsAbsenceError';
    this.code = code;
    this.details = details;
  }
}

export function splitNul(buffer) {
  return Buffer.from(buffer)
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
}

export function isForbiddenPath(path) {
  return String(path)
    .replaceAll('\\', '/')
    .split('/')
    .some((component) => component.toLowerCase() === FORBIDDEN_PATH_COMPONENT);
}

export function filesystemEntries(root, directory = root, prefix = '') {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    paths.push(path);
    if (
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && !(prefix === '' && PRUNED_FILESYSTEM_ROOTS.has(entry.name.toLowerCase()))
    ) {
      paths.push(...filesystemEntries(root, resolve(directory, entry.name), path));
    }
  }
  return paths;
}

function defaultGit(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function decodedGitLine(buffer) {
  return Buffer.from(buffer).toString('utf8').trim().toLowerCase();
}

export function verifyLocalToolsAbsence({
  root = projectRoot,
  env = process.env,
  git = defaultGit,
  readFilesystemEntries = filesystemEntries,
} = {}) {
  const expectedRevision = String(env.HX_EXACT_CANDIDATE_SHA || '')
    .trim()
    .toLowerCase();
  if (expectedRevision && !REVISION.test(expectedRevision)) {
    throw new LocalToolsAbsenceError('HX_LOCAL_TOOLS_EXPECTED_SHA_INVALID');
  }

  let revision;
  let treeEntries;
  let indexEntries;
  try {
    revision = decodedGitLine(git(['rev-parse', '--verify', 'HEAD^{commit}'], root));
    if (!REVISION.test(revision)) {
      throw new LocalToolsAbsenceError('HX_LOCAL_TOOLS_HEAD_SHA_INVALID');
    }
    if (expectedRevision && revision !== expectedRevision) {
      throw new LocalToolsAbsenceError('HX_LOCAL_TOOLS_CANDIDATE_SHA_MISMATCH', {
        expected_revision: expectedRevision,
        actual_revision: revision,
      });
    }
    treeEntries = splitNul(git(['ls-tree', '-r', '-z', '--name-only', revision, '--'], root));
    indexEntries = splitNul(git(['ls-files', '--cached', '-z'], root));
  } catch (cause) {
    if (cause instanceof LocalToolsAbsenceError) throw cause;
    throw new LocalToolsAbsenceError('HX_LOCAL_TOOLS_GIT_INSPECTION_FAILED', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let filesystemEntries;
  try {
    filesystemEntries = readFilesystemEntries(root).map((entry) =>
      typeof entry === 'string' ? entry : entry.name
    );
  } catch (cause) {
    throw new LocalToolsAbsenceError('HX_LOCAL_TOOLS_FILESYSTEM_INSPECTION_FAILED', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const offenders = {
    git_tree: treeEntries.filter(isForbiddenPath),
    git_index: indexEntries.filter(isForbiddenPath),
    filesystem: filesystemEntries.filter(isForbiddenPath),
  };
  if (Object.values(offenders).some((entries) => entries.length > 0)) {
    throw new LocalToolsAbsenceError('HX_LOCAL_TOOLS_PRESENT', {
      revision,
      counts: Object.fromEntries(
        Object.entries(offenders).map(([scope, entries]) => [scope, entries.length])
      ),
      samples: Object.fromEntries(
        Object.entries(offenders).map(([scope, entries]) => [scope, entries.slice(0, 10)])
      ),
    });
  }

  return Object.freeze({
    ok: true,
    revision,
    git_tree_entries: 0,
    git_index_entries: 0,
    filesystem_entries: 0,
  });
}

export function isDirectExecution(
  moduleUrl,
  invokedPath = process.argv[1],
  platform = process.platform,
  canonicalizePath = realpathSync.native
) {
  if (!invokedPath) return false;
  const modulePath = resolve(canonicalizePath(resolve(fileURLToPath(moduleUrl))));
  const entryPath = resolve(canonicalizePath(resolve(invokedPath)));
  return platform === 'win32'
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const receipt = verifyLocalToolsAbsence();
    process.stdout.write(`HXOS_LOCAL_TOOLS_ABSENT ${JSON.stringify(receipt)}\n`);
  } catch (cause) {
    const error =
      cause instanceof LocalToolsAbsenceError
        ? { code: cause.code, details: cause.details }
        : { code: 'HX_LOCAL_TOOLS_VERIFIER_FAILED' };
    process.stderr.write(`${JSON.stringify({ ok: false, ...error })}\n`);
    process.exitCode = 1;
  }
}
