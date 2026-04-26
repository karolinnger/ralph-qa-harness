'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli } = require('../../src/cli');
const { readConfig } = require('../../src/config');
const { doctor, formatDoctorOutput } = require('../../src/doctor');
const { createTempRepo } = require('../helpers/temp-repo');

const fakeCodexPath = path.resolve(__dirname, '..', 'fixtures', 'fake-codex.js');
const fakeValidationPath = path.resolve(__dirname, '..', 'fixtures', 'fake-validation.js');

function initFakeRepo(t) {
  const repoRoot = createTempRepo(t);
  runCli(['init'], { repoRoot, stdout: { write: () => {} }, stderr: { write: () => {} } });
  const configPath = path.join(repoRoot, '.ralph', 'config.json');
  const config = readConfig(configPath);
  config.codex.command = process.execPath;
  config.codex.args = [fakeCodexPath];
  config.validationCommands = [{ name: 'validation', command: process.execPath, args: [fakeValidationPath, 'pass'] }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return repoRoot;
}

test('doctor passes with fake Codex and warns for danger-full-access', (t) => {
  const repoRoot = initFakeRepo(t);
  const configPath = path.join(repoRoot, '.ralph', 'config.json');
  const config = readConfig(configPath);
  config.codex.sandbox = 'danger-full-access';
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const result = doctor({ repoRoot, env: process.env });
  const output = formatDoctorOutput(result);

  assert.equal(result.status, 'pass');
  assert.match(output, /WARN codex-sandbox/);
  assert.match(output, /danger-full-access/);
});

test('doctor fails for non-repo invalid config missing Codex and blocked PowerShell shim guidance', (t) => {
  const nonRepo = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ralph-codex-nonrepo-'));
  t.after(() => fs.rmSync(nonRepo, { recursive: true, force: true }));
  const nonRepoResult = doctor({ repoRoot: nonRepo, env: process.env });
  assert.equal(nonRepoResult.status, 'fail');

  const invalidRepo = initFakeRepo(t);
  fs.writeFileSync(path.join(invalidRepo, '.ralph', 'config.json'), '{"codex":{"command":""}}', 'utf8');
  assert.equal(doctor({ repoRoot: invalidRepo, env: process.env }).status, 'fail');

  const missingRepo = initFakeRepo(t);
  const missingConfigPath = path.join(missingRepo, '.ralph', 'config.json');
  const missingConfig = readConfig(missingConfigPath);
  missingConfig.codex.command = 'definitely-missing-ralph-codex-command';
  missingConfig.codex.args = [];
  fs.writeFileSync(missingConfigPath, JSON.stringify(missingConfig, null, 2), 'utf8');
  assert.equal(doctor({ repoRoot: missingRepo, env: process.env }).status, 'fail');

  const shimRepo = initFakeRepo(t);
  const shimResult = doctor({
    repoRoot: shimRepo,
    env: process.env,
    runProcessFn: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'codex.ps1 cannot be loaded because running scripts is disabled on this system.',
      timedOut: false,
      durationMs: 1,
    }),
  });
  assert.match(formatDoctorOutput(shimResult), /codex\.cmd/);
  assert.match(formatDoctorOutput(shimResult), /codex\.exe/);
});

test('doctor accepts BOM-prefixed config files written by Windows PowerShell', (t) => {
  const repoRoot = initFakeRepo(t);
  const configPath = path.join(repoRoot, '.ralph', 'config.json');
  const config = readConfig(configPath);
  fs.writeFileSync(configPath, `\uFEFF${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const result = doctor({ repoRoot, env: process.env });

  assert.equal(result.status, 'pass');
  assert.match(formatDoctorOutput(result), /PASS config/);
});

test('verify reruns deterministic validation and optional fresh Codex review', (t) => {
  const repoRoot = initFakeRepo(t);
  let stdout = '';
  let stderr = '';
  const passExit = runCli(['verify'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(passExit, 0);
  assert.match(stdout, /Verification passed/);
  assert.equal(stderr, '');

  const argvPath = path.join(repoRoot, 'verifier-argv.json');
  stdout = '';
  const reviewExit = runCli(['verify', '--codex-review', 'true'], {
    repoRoot,
    env: { ...process.env, RALPH_FAKE_CODEX_ARGV_PATH: argvPath },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: () => {} },
  });

  assert.equal(reviewExit, 0);
  assert.match(stdout, /Codex review: pass/);
  assert.equal(JSON.parse(fs.readFileSync(argvPath, 'utf8')).includes('read-only'), true);

  const configPath = path.join(repoRoot, '.ralph', 'config.json');
  const config = readConfig(configPath);
  config.validationCommands = [{ name: 'validation', command: process.execPath, args: [fakeValidationPath, 'fail'] }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  stderr = '';
  const failExit = runCli(['verify'], {
    repoRoot,
    stdout: { write: () => {} },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(failExit, 1);
  assert.match(stderr, /Verification failed/);
});
