'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { runCli } = require('../scripts/qa-harness');
const { createTempTargetProject } = require('./helpers/target-project');

test('bin entrypoints keep the standalone CLI prefix and route into the extracted harness', () => {
  const binContent = fs.readFileSync(path.resolve(__dirname, '..', 'bin', 'ralph-qa-harness.js'), 'utf8');

  assert.match(binContent, /QA_HARNESS_COMMAND_PREFIX/);
  assert.match(binContent, /npx ralph-qa-harness/);
  assert.match(binContent, /require\('\.\.\/scripts\/qa-harness'\)/);
});

test('package bin entrypoint exists and passes arguments into runCli', () => {
  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const binPath = path.resolve(path.dirname(packageJsonPath), pkg.bin['ralph-qa-harness']);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalLoad = Module._load;
  const calls = [];

  assert.equal(pkg.bin['ralph-qa-harness'], './bin/ralph-qa-harness.js');
  assert.equal(fs.existsSync(binPath), true);

  Module._load = function load(request, parent, isMain) {
    if (parent?.filename === binPath && request === '../scripts/qa-harness') {
      return {
        runCli(args) {
          calls.push(args);
          return 7;
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[binPath];
    process.argv = [process.execPath, binPath, 'status'];
    process.exitCode = undefined;

    require(binPath);

    assert.deepEqual(calls, [['status']]);
    assert.equal(process.exitCode, 7);
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    delete require.cache[binPath];
  }
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
    commandRunner(command, args, cwd) {
      assert.equal(cwd, repoRoot);
      if (args.join(' ') === '--version' || args.join(' ') === '--help') {
        return {
          status: 0,
          stdout: `${command} ok\n`,
          stderr: '',
        };
      }

      return {
        status: 1,
        stdout: '',
        stderr: `unexpected command: ${command} ${args.join(' ')}\n`,
      };
    },
    stdout: { write: (value) => { doctorStdout += value; } },
    stderr: { write: (value) => { doctorStderr += value; } },
  });

  assert.equal(helpExitCode, 0);
  assert.match(helpStdout, /npx ralph-qa-harness doctor/);
  assert.match(helpStdout, /npx ralph-qa-harness prepare --from <feature-path>/);
  assert.match(helpStdout, /npx ralph-qa-harness prepare --request <text> \[--constraint <value>\]/);
  assert.match(helpStdout, /npx ralph-qa-harness run \[--max-iterations <positive-integer>\]/);
  assert.match(helpStdout, /npx ralph-qa-harness status/);
  assert.match(helpStdout, /npx ralph-qa-harness verify/);
  assert.match(helpStdout, /Four-agent product loop: qa-orchestrator routes qa-planner, qa-executor, and qa-verifier/);
  assert.match(helpStdout, /Default run budget: 40 iterations/);
  assert.match(helpStdout, /fresh Copilot worker context and durable \.qa-harness\/ memory/);
  assert.match(helpStdout, /Playwright CLI first, MCP fallback second/);
  assert.match(helpStdout, /full Playwright execution before pass/);
  assert.match(helpStdout, /Jira API integration is out of scope/);
  assert.doesNotMatch(helpStdout, /create-run|prepare-run|verify-run|execute-run|advance-run|iterate-run|loop-run|preflight/);
  assert.equal(helpStderr, '');

  assert.equal(doctorExitCode, 0);
  assert.match(doctorStdout, /Doctor passed/);
  assert.match(doctorStdout, /PASS target-layout/);
  assert.equal(doctorStderr, '');
});
