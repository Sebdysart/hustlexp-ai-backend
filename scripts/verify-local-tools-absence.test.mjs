import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  LocalToolsAbsenceError,
  isForbiddenPath,
  splitNul,
  verifyLocalToolsAbsence,
} from './verify-local-tools-absence.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function nul(entries) {
  return Buffer.from(entries.length === 0 ? '' : `${entries.join('\0')}\0`, 'utf8');
}

function gitFixture({ revision = SHA, tree = [], index = [], fail = false } = {}) {
  return (args) => {
    if (fail) throw new Error('git unavailable');
    if (args[0] === 'rev-parse') return Buffer.from(`${revision}\n`, 'utf8');
    if (args[0] === 'ls-tree') return nul(tree);
    if (args[0] === 'ls-files') return nul(index);
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
}

function verifyFixture({ env = {}, tree = [], index = [], filesystem = [], git } = {}) {
  return verifyLocalToolsAbsence({
    root: 'fixture-root',
    env,
    git: git || gitFixture({ tree, index }),
    readFilesystemEntries: () => filesystem,
  });
}

test('clean exact candidate returns a zero-entry receipt bound to its revision', () => {
  assert.deepEqual(
    verifyFixture({ env: { HX_EXACT_CANDIDATE_SHA: SHA } }),
    {
      ok: true,
      revision: SHA,
      git_tree_entries: 0,
      git_index_entries: 0,
      filesystem_entries: 0,
    }
  );
});

test('Git tree inspection is recursive and index inspection covers every cached path', () => {
  const calls = [];
  verifyFixture({
    git: (args) => {
      calls.push(args);
      return gitFixture()(args);
    },
  });
  assert.deepEqual(calls[1], ['ls-tree', '-r', '-z', '--name-only', SHA, '--']);
  assert.deepEqual(calls[2], ['ls-files', '--cached', '-z']);
});

test('Git tree contamination fails even when index and filesystem are clean', () => {
  assert.throws(
    () => verifyFixture({ tree: ['.local-tools'] }),
    (error) =>
      error instanceof LocalToolsAbsenceError &&
      error.code === 'HX_LOCAL_TOOLS_PRESENT' &&
      error.details.counts.git_tree === 1 &&
      error.details.counts.git_index === 0 &&
      error.details.counts.filesystem === 0
  );
});

test('Git index contamination catches case variants and Windows separators', () => {
  assert.throws(
    () => verifyFixture({ index: ['.LOCAL-TOOLS\\bin\\node'] }),
    (error) =>
      error instanceof LocalToolsAbsenceError &&
      error.code === 'HX_LOCAL_TOOLS_PRESENT' &&
      error.details.counts.git_index === 1
  );
});

test('filesystem inspection catches nested entries and case variants', () => {
  assert.throws(
    () => verifyFixture({ filesystem: ['docs/.Local-Tools/bin/node'] }),
    (error) =>
      error instanceof LocalToolsAbsenceError &&
      error.code === 'HX_LOCAL_TOOLS_PRESENT' &&
      error.details.counts.filesystem === 1
  );
});

test('expected revision input is exact and mismatches fail closed', () => {
  assert.throws(
    () => verifyFixture({ env: { HX_EXACT_CANDIDATE_SHA: 'not-a-sha' } }),
    (error) => error.code === 'HX_LOCAL_TOOLS_EXPECTED_SHA_INVALID'
  );
  assert.throws(
    () =>
      verifyFixture({
        env: { HX_EXACT_CANDIDATE_SHA: 'fedcba9876543210fedcba9876543210fedcba98' },
      }),
    (error) => error.code === 'HX_LOCAL_TOOLS_CANDIDATE_SHA_MISMATCH'
  );
});

test('Git and filesystem inspection errors are not treated as empty evidence', () => {
  assert.throws(
    () => verifyFixture({ git: gitFixture({ fail: true }) }),
    (error) => error.code === 'HX_LOCAL_TOOLS_GIT_INSPECTION_FAILED'
  );
  assert.throws(
    () =>
      verifyLocalToolsAbsence({
        root: 'fixture-root',
        env: {},
        git: gitFixture(),
        readFilesystemEntries: () => {
          throw new Error('filesystem unavailable');
        },
      }),
    (error) => error.code === 'HX_LOCAL_TOOLS_FILESYSTEM_INSPECTION_FAILED'
  );
});

test('NUL parsing is newline-safe and every exact path component is forbidden', () => {
  assert.deepEqual(splitNul(nul(['line\nbreak', 'space name'])), ['line\nbreak', 'space name']);
  for (const path of ['.local-tools-backup', 'docs/local-tools', 'local-tools']) {
    assert.equal(isForbiddenPath(path), false, path);
  }
  for (const path of [
    '.local-tools',
    '.LOCAL-TOOLS/bin/npm',
    '.Local-Tools\\bin\\node',
    'docs/.local-tools/bin/npm',
  ]) {
    assert.equal(isForbiddenPath(path), true, path);
  }
});

test('ignore contracts keep local tooling out of Git and both Docker contexts', async () => {
  const [gitignore, dockerignore, convergenceDockerignore] = await Promise.all([
    readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
    readFile(new URL('../.dockerignore', import.meta.url), 'utf8'),
    readFile(new URL('../Dockerfile.convergence-test.dockerignore', import.meta.url), 'utf8'),
  ]);
  assert.match(gitignore, /^\/\.local-tools\/\r?$/mu);
  assert.match(dockerignore, /^\.local-tools\r?$/mu);
  assert.match(convergenceDockerignore, /^\.local-tools\r?$/mu);
});
