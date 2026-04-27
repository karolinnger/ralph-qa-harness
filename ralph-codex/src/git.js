'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function toGitPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/gu, '/');
}

function runGit(repoRoot, args, options = {}) {
  const result = spawnSync('git', ['-c', `safe.directory=${repoRoot.replace(/\\/gu, '/')}`, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: options.input || undefined,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return result;
}

function requireGitRepo(repoRoot) {
  const result = runGit(repoRoot, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }
  return result.stdout.trim();
}

function parsePorcelainZ(output) {
  return output.split('\0').filter(Boolean).map((entry) => {
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    return { status, path: filePath };
  });
}

function isRalphPath(filePath) {
  return filePath === '.ralph' || filePath.startsWith('.ralph/');
}

function getStatusEntries(repoRoot) {
  const result = runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all', '-z']);
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr || result.stdout}`);
  }
  return parsePorcelainZ(result.stdout);
}

function getChangedFiles(repoRoot) {
  return Array.from(new Set(getStatusEntries(repoRoot)
    .map((entry) => entry.path)
    .filter((filePath) => filePath && !isRalphPath(filePath))))
    .sort();
}

function readTextIfSmall(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return '';
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 1024 * 1024) {
    return '';
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    return '';
  }
  return buffer.toString('utf8');
}

function normalizeChangedFiles(changedFiles) {
  if (!Array.isArray(changedFiles)) {
    return null;
  }
  return new Set(changedFiles
    .filter((filePath) => typeof filePath === 'string' && filePath && !isRalphPath(filePath))
    .map((filePath) => filePath.replace(/\\/gu, '/')));
}

function captureDiff(repoRoot, options = {}) {
  const scopedFiles = normalizeChangedFiles(options.changedFiles);
  if (scopedFiles && scopedFiles.size === 0) {
    return '';
  }
  const diffArgs = scopedFiles
    ? ['diff', '--binary', '--', ...Array.from(scopedFiles)]
    : ['diff', '--binary', '--', '.', ':(exclude).ralph'];
  const result = runGit(repoRoot, diffArgs);
  let diff = result.stdout || '';
  const untracked = getStatusEntries(repoRoot).filter((entry) => (
    entry.status === '??'
    && !isRalphPath(entry.path)
    && (!scopedFiles || scopedFiles.has(entry.path))
  ));
  for (const entry of untracked) {
    const absolutePath = path.join(repoRoot, entry.path);
    const content = readTextIfSmall(absolutePath);
    if (!content) {
      continue;
    }
    diff += [
      diff.endsWith('\n') || diff === '' ? '' : '\n',
      `diff --ralph-untracked a/${entry.path} b/${entry.path}\n`,
      `--- /dev/null\n`,
      `+++ b/${entry.path}\n`,
      '@@\n',
      ...content.split(/\r?\n/u).filter((line, index, array) => line || index < array.length - 1).map((line) => `+${line}\n`),
    ].join('');
  }
  return diff;
}

function getBaselineDirtyFiles(repoRoot) {
  return new Set(getChangedFiles(repoRoot));
}

function commitIterationChanges({ repoRoot, enabled, iteration, changedFiles, baselineDirtyFiles }) {
  if (!enabled) {
    return { status: 'skipped', reason: 'auto-commit disabled' };
  }
  const files = Array.from(new Set((changedFiles || []).filter((filePath) => filePath && !isRalphPath(filePath))));
  if (files.length === 0) {
    return { status: 'skipped', reason: 'no changed files' };
  }
  const baseline = baselineDirtyFiles instanceof Set ? baselineDirtyFiles : new Set(baselineDirtyFiles || []);
  const overlap = files.filter((filePath) => baseline.has(filePath));
  if (overlap.length > 0) {
    return { status: 'blocked', reason: `Refusing to auto-commit pre-existing dirty files: ${overlap.join(', ')}` };
  }
  const addResult = runGit(repoRoot, ['add', '--', ...files]);
  if (addResult.status !== 0) {
    return { status: 'fail', reason: addResult.stderr || addResult.stdout };
  }
  const message = `ralph-codex: iteration ${String(iteration).padStart(3, '0')} pass`;
  const commitResult = runGit(repoRoot, ['commit', '-m', message]);
  if (commitResult.status !== 0) {
    return { status: 'fail', reason: commitResult.stderr || commitResult.stdout };
  }
  return { status: 'pass', message };
}

module.exports = {
  requireGitRepo,
  getStatusEntries,
  getChangedFiles,
  captureDiff,
  getBaselineDirtyFiles,
  commitIterationChanges,
  toGitPath,
};
