'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli } = require('../../src/cli');
const { readConfig } = require('../../src/config');
const { createTempRepo, runGit, writeFile } = require('../helpers/temp-repo');

const fakeCodexPath = path.resolve(__dirname, '..', 'fixtures', 'fake-codex.js');
const fakeValidationPath = path.resolve(__dirname, '..', 'fixtures', 'fake-validation.js');

function setupRun(t, options = {}) {
  const repoRoot = createTempRepo(t);
  const planPath = path.join(repoRoot, 'plan.md');
  writeFile(planPath, options.plan || '# Plan\n\n- [ ] one\n');
  runCli(['init'], { repoRoot, stdout: { write: () => {} }, stderr: { write: () => {} } });
  runCli(['plan', '--from', planPath, '--force', 'true'], { repoRoot, stdout: { write: () => {} }, stderr: { write: () => {} } });

  const configPath = path.join(repoRoot, '.ralph', 'config.json');
  const config = readConfig(configPath);
  config.codex.command = process.execPath;
  config.codex.args = [fakeCodexPath];
  config.codex.timeoutMs = options.timeoutMs || 5000;
  config.validationCommands = options.validationCommands || [];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return repoRoot;
}

function readLatestResult(repoRoot) {
  const state = JSON.parse(fs.readFileSync(path.join(repoRoot, '.ralph', 'state.json'), 'utf8'));
  return JSON.parse(fs.readFileSync(path.join(repoRoot, '.ralph', 'runs', state.latestRunId, 'result.json'), 'utf8'));
}

test('run completes with fake Codex pass and writes iteration artifacts', (t) => {
  const repoRoot = setupRun(t);
  let stdout = '';

  const exitCode = runCli(['run', '--max-iterations', '3'], {
    repoRoot,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'pass' },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: () => {} },
  });
  const result = readLatestResult(repoRoot);
  const iterationDir = path.join(repoRoot, '.ralph', 'runs', result.runId, 'iterations', '001');

  assert.equal(exitCode, 0);
  assert.equal(result.status, 'completed');
  assert.match(stdout, /Stop reason: completed/);
  for (const fileName of ['worker-prompt.md', 'stdout.log', 'stderr.log', 'summary.json', 'validation.json', 'diff.patch']) {
    assert.equal(fs.existsSync(path.join(iterationDir, fileName)), true, fileName);
  }
  assert.equal(fs.existsSync(path.join(repoRoot, '.ralph', 'runs', result.runId, 'loop-report.md')), true);
  assert.match(fs.readFileSync(path.join(repoRoot, '.ralph', 'progress.md'), 'utf8'), /Completed one task/);
});

test('run stops for blocked fail stalled validation failure and budget exhaustion', (t) => {
  const blockedRepo = setupRun(t);
  runCli(['run', '--max-iterations', '1'], {
    repoRoot: blockedRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'blocked' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(readLatestResult(blockedRepo).status, 'blocked');

  const failRepo = setupRun(t);
  runCli(['run', '--max-iterations', '1'], {
    repoRoot: failRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'fail' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(readLatestResult(failRepo).status, 'fail');

  const stalledRepo = setupRun(t);
  const stalledConfigPath = path.join(stalledRepo, '.ralph', 'config.json');
  const stalledConfig = readConfig(stalledConfigPath);
  stalledConfig.loop.stalledNoChangeLimit = 1;
  fs.writeFileSync(stalledConfigPath, JSON.stringify(stalledConfig, null, 2), 'utf8');
  runCli(['run', '--max-iterations', '2'], {
    repoRoot: stalledRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'no-change' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(readLatestResult(stalledRepo).status, 'stalled');

  const validationRepo = setupRun(t, {
    validationCommands: [{ name: 'validation', command: process.execPath, args: [fakeValidationPath, 'fail'] }],
  });
  runCli(['run', '--max-iterations', '1'], {
    repoRoot: validationRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'pass' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(readLatestResult(validationRepo).status, 'fail');

  const budgetRepo = setupRun(t, { plan: '# Plan\n\n- [ ] one\n- [ ] two\n' });
  runCli(['run', '--max-iterations', '1'], {
    repoRoot: budgetRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'pass' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(readLatestResult(budgetRepo).status, 'budget-exhausted');
});

test('auto-commit is disabled by default, enabled explicitly, and blocks dirty overlap', (t) => {
  const defaultRepo = setupRun(t);
  const beforeDefault = runGit(defaultRepo, ['rev-list', '--count', 'HEAD']).stdout.trim();
  runCli(['run', '--max-iterations', '1'], {
    repoRoot: defaultRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'pass' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(runGit(defaultRepo, ['rev-list', '--count', 'HEAD']).stdout.trim(), beforeDefault);

  const commitRepo = setupRun(t);
  const beforeCommit = Number(runGit(commitRepo, ['rev-list', '--count', 'HEAD']).stdout.trim());
  runCli(['run', '--max-iterations', '1', '--commit-each-iteration', 'true'], {
    repoRoot: commitRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'pass' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(Number(runGit(commitRepo, ['rev-list', '--count', 'HEAD']).stdout.trim()), beforeCommit + 1);

  const dirtyRepo = setupRun(t);
  fs.writeFileSync(path.join(dirtyRepo, 'ralph-output.txt'), 'preexisting\n', 'utf8');
  runCli(['run', '--max-iterations', '1', '--commit-each-iteration', 'true'], {
    repoRoot: dirtyRepo,
    env: { ...process.env, RALPH_FAKE_CODEX_MODE: 'pass' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(readLatestResult(dirtyRepo).status, 'blocked');
});
