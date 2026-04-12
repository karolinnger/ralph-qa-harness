'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { doctor, formatDoctorOutput, runCli } = require('../scripts/qa-harness');
const { createTempTargetProject } = require('./helpers/target-project');

test('doctor passes for the expected target-project layout with the bundled worker', (t) => {
  const repoRoot = createTempTargetProject(t);
  const result = doctor({
    repoRoot,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
  });

  assert.equal(result.status, 'pass');
  assert.match(formatDoctorOutput(result), /Doctor passed/);
  assert.ok(result.checks.some((check) => check.label === 'target-layout' && check.status === 'pass'));
  assert.ok(result.checks.some((check) => check.label === 'playwright' && check.status === 'pass'));
  assert.ok(result.checks.some((check) => check.label === 'runtime' && check.status === 'pass'));
});

test('doctor fails when bridge validation is requested without bridge env vars', (t) => {
  const repoRoot = createTempTargetProject(t);
  const result = doctor({
    repoRoot,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
    requireBridge: true,
  });

  assert.equal(result.status, 'fail');
  assert.ok(result.checks.some((check) => check.label === 'bridge' && check.status === 'fail'));
  assert.match(formatDoctorOutput(result), /Doctor failed/);
});

test('runCli supports the preflight alias and routes pass/fail output to the correct stream', () => {
  let stdout = '';
  let stderr = '';

  const successExitCode = runCli(['preflight'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    doctorFn: () => ({
      repoRoot: 'C:/target-project',
      checks: [],
      failureCount: 0,
      warningCount: 0,
      status: 'pass',
    }),
  });

  assert.equal(successExitCode, 0);
  assert.match(stdout, /Doctor passed/);
  assert.equal(stderr, '');

  stdout = '';
  stderr = '';

  const failureExitCode = runCli(['doctor'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    doctorFn: () => ({
      repoRoot: 'C:/target-project',
      checks: [],
      failureCount: 1,
      warningCount: 0,
      status: 'fail',
    }),
  });

  assert.equal(failureExitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Doctor failed with 1 blocking issue/);
});
