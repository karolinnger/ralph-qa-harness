'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  captureDiff,
  commitIterationChanges,
  getBaselineDirtyFiles,
  getChangedFiles,
  getStatusEntries,
} = require('../../src/git');
const { createTempRepo, runGit, writeFile } = require('../helpers/temp-repo');

test('getChangedFiles reports modified tracked files and excludes .ralph state', (t) => {
  const repoRoot = createTempRepo(t);
  fs.appendFileSync(path.join(repoRoot, 'README.md'), 'change\n', 'utf8');
  writeFile(path.join(repoRoot, '.ralph', 'progress.md'), 'state\n');

  assert.ok(getStatusEntries(repoRoot).some((entry) => entry.path === 'README.md'));
  assert.deepEqual(getChangedFiles(repoRoot), ['README.md']);
});

test('captureDiff includes tracked diffs and synthetic untracked text diffs', (t) => {
  const repoRoot = createTempRepo(t);
  fs.appendFileSync(path.join(repoRoot, 'README.md'), 'change\n', 'utf8');
  writeFile(path.join(repoRoot, 'src', 'new-file.txt'), 'new file\n');

  const diff = captureDiff(repoRoot);

  assert.match(diff, /diff --git a\/README\.md b\/README\.md/);
  assert.match(diff, /diff --ralph-untracked a\/src\/new-file\.txt b\/src\/new-file\.txt/);
  assert.match(diff, /new file/);
});

test('captureDiff can be restricted to iteration changed files', (t) => {
  const repoRoot = createTempRepo(t);
  fs.appendFileSync(path.join(repoRoot, 'README.md'), 'preexisting dirty change\n', 'utf8');
  writeFile(path.join(repoRoot, 'src', 'iteration-file.txt'), 'iteration change\n');

  const diff = captureDiff(repoRoot, { changedFiles: ['src/iteration-file.txt'] });

  assert.doesNotMatch(diff, /README\.md/);
  assert.match(diff, /diff --ralph-untracked a\/src\/iteration-file\.txt b\/src\/iteration-file\.txt/);
  assert.match(diff, /iteration change/);
});

test('commitIterationChanges does nothing unless enabled and blocks dirty baseline overlap', (t) => {
  const repoRoot = createTempRepo(t);
  fs.appendFileSync(path.join(repoRoot, 'README.md'), 'preexisting\n', 'utf8');
  const baselineDirtyFiles = getBaselineDirtyFiles(repoRoot);

  const skipped = commitIterationChanges({
    repoRoot,
    enabled: false,
    iteration: 1,
    changedFiles: ['README.md'],
    baselineDirtyFiles,
  });
  const blocked = commitIterationChanges({
    repoRoot,
    enabled: true,
    iteration: 1,
    changedFiles: ['README.md'],
    baselineDirtyFiles,
  });

  assert.equal(skipped.status, 'skipped');
  assert.equal(blocked.status, 'blocked');
});

test('commitIterationChanges commits clean iteration files when enabled', (t) => {
  const repoRoot = createTempRepo(t);
  writeFile(path.join(repoRoot, 'created.txt'), 'created\n');

  const result = commitIterationChanges({
    repoRoot,
    enabled: true,
    iteration: 1,
    changedFiles: ['created.txt'],
    baselineDirtyFiles: new Set(),
  });
  const log = runGit(repoRoot, ['log', '--oneline', '-1']).stdout;

  assert.equal(result.status, 'pass');
  assert.match(log, /ralph-codex: iteration 001 pass/);
});
