'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli } = require('../scripts/qa-harness');
const { createTempTargetProject } = require('./helpers/target-project');

test('bin entrypoints keep the standalone CLI prefix and route into the extracted harness', () => {
  const binContent = fs.readFileSync(path.resolve(__dirname, '..', 'bin', 'ralph-qa-harness.js'), 'utf8');
  const orchestratorContent = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'qa-orchestrator.js'), 'utf8');

  assert.match(binContent, /QA_HARNESS_COMMAND_PREFIX/);
  assert.match(binContent, /npx ralph-qa-harness/);
  assert.match(binContent, /require\('\.\.\/scripts\/qa-harness'\)/);

  assert.match(orchestratorContent, /QA_HARNESS_COMMAND_PREFIX/);
  assert.match(orchestratorContent, /npx ralph-qa-harness/);
  assert.match(orchestratorContent, /require\('\.\/qa-harness'\)/);
});

test('CLI help and doctor output work with the standalone prefix from a target-project root', (t) => {
  const repoRoot = createTempTargetProject(t);
  const originalPrefix = process.env.QA_HARNESS_COMMAND_PREFIX;
  let helpStdout = '';
  let helpStderr = '';
  let doctorStdout = '';
  let doctorStderr = '';

  process.env.QA_HARNESS_COMMAND_PREFIX = 'npx ralph-qa-harness';
  t.after(() => {
    if (originalPrefix == null) {
      delete process.env.QA_HARNESS_COMMAND_PREFIX;
      return;
    }

    process.env.QA_HARNESS_COMMAND_PREFIX = originalPrefix;
  });

  const helpExitCode = runCli(['--help'], {
    repoRoot,
    stdout: { write: (value) => { helpStdout += value; } },
    stderr: { write: (value) => { helpStderr += value; } },
  });
  const doctorExitCode = runCli(['doctor'], {
    repoRoot,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
    stdout: { write: (value) => { doctorStdout += value; } },
    stderr: { write: (value) => { doctorStderr += value; } },
  });

  assert.equal(helpExitCode, 0);
  assert.match(helpStdout, /npx ralph-qa-harness prepare-run/);
  assert.equal(helpStderr, '');

  assert.equal(doctorExitCode, 0);
  assert.match(doctorStdout, /Doctor passed/);
  assert.match(doctorStdout, /PASS target-layout/);
  assert.equal(doctorStderr, '');
});
