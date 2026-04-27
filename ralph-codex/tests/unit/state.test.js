'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  acquireLock,
  appendProgressEntry,
  createRunDirectories,
  createRunId,
  readState,
  releaseLock,
  resolveRalphPaths,
  writeState,
} = require('../../src/state');
const { createTempRepo, writeFile } = require('../helpers/temp-repo');

test('resolveRalphPaths maps the expected .ralph files and directories', (t) => {
  const repoRoot = createTempRepo(t);
  const paths = resolveRalphPaths(repoRoot);

  assert.equal(paths.rootDir, path.join(repoRoot, '.ralph'));
  assert.equal(paths.promptPath, path.join(repoRoot, '.ralph', 'PROMPT.md'));
  assert.equal(paths.planPath, path.join(repoRoot, '.ralph', 'IMPLEMENTATION_PLAN.md'));
  assert.equal(paths.progressPath, path.join(repoRoot, '.ralph', 'progress.md'));
  assert.equal(paths.configPath, path.join(repoRoot, '.ralph', 'config.json'));
  assert.equal(paths.statePath, path.join(repoRoot, '.ralph', 'state.json'));
  assert.equal(paths.runsDir, path.join(repoRoot, '.ralph', 'runs'));
});

test('createRunId formats UTC timestamp run ids', () => {
  assert.equal(createRunId(new Date('2026-04-26T12:34:56Z')), '20260426T123456Z-ralph');
});

test('acquireLock refuses existing locks unless forced and release clears matching lock', (t) => {
  const repoRoot = createTempRepo(t);
  const paths = resolveRalphPaths(repoRoot);
  fs.mkdirSync(paths.rootDir, { recursive: true });
  writeState(paths.statePath, { schemaVersion: 1, activeRunId: '', latestRunId: '', lastStopReason: '', lock: null });

  const first = acquireLock({ repoRoot, runId: 'run-1', command: 'run' });
  const second = acquireLock({ repoRoot, runId: 'run-2', command: 'run' });
  const forced = acquireLock({ repoRoot, runId: 'run-2', command: 'run', force: true });
  releaseLock({ repoRoot, runId: 'run-1' });
  const stillLocked = readState(paths.statePath);
  releaseLock({ repoRoot, runId: 'run-2' });
  const released = readState(paths.statePath);

  assert.equal(first.status, 'pass');
  assert.equal(second.status, 'fail');
  assert.equal(forced.status, 'pass');
  assert.equal(stillLocked.lock.runId, 'run-2');
  assert.equal(released.lock, null);
});

test('createRunDirectories and appendProgressEntry create durable run artifacts', (t) => {
  const repoRoot = createTempRepo(t);
  const runPaths = createRunDirectories({ repoRoot, runId: 'run-1' });
  const progressPath = resolveRalphPaths(repoRoot).progressPath;
  writeFile(progressPath, '# Progress\n');

  appendProgressEntry({ repoRoot, text: 'First entry' });
  appendProgressEntry({ repoRoot, text: 'Second entry' });

  assert.equal(fs.existsSync(runPaths.resultPath), false);
  assert.match(fs.readFileSync(progressPath, 'utf8'), /First entry[\s\S]*Second entry/);
});
