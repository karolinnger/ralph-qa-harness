'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { doctor, formatDoctorOutput, runCli } = require('../scripts/qa-harness');
const { createTempTargetProject } = require('./helpers/target-project');

function createPassingCommandRunner(assertions = []) {
  return (command, args, cwd) => {
    assertions.push({ command, args, cwd });

    if (args[0] === '--version' || args[0] === '--help') {
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
  };
}

function prependPath(env, binDir) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  return {
    ...env,
    [pathKey]: `${binDir}${path.delimiter}${env[pathKey] || ''}`,
  };
}

function writeFakeCopilotCommand(t) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-qa-harness-copilot-bin-'));
  const commandName = 'copilot';
  const commandPath = path.join(binDir, commandName);

  t.after(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    commandPath,
    [
      '#!/usr/bin/env node',
      "if (process.argv[2] === '--help') {",
      "  process.stdout.write('fake Copilot help from PATH\\n');",
      '  process.exit(0);',
      '}',
      "process.stderr.write('unexpected fake Copilot args: ' + process.argv.slice(2).join(' ') + '\\n');",
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(commandPath, 0o755);

  return {
    binDir,
    commandName,
    platform: 'linux',
  };
}

function runFakeCommandFromPath(command, args, cwd, env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const commandPath = (env[pathKey] || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.join(entry, command))
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());

  if (!commandPath) {
    throw new Error(`${command} was not found on PATH`);
  }

  const stdout = [];
  const stderr = [];
  const exitSignal = {};
  let status = 0;
  const commandSource = fs.readFileSync(commandPath, 'utf8').replace(/^#!.*(?:\r?\n|$)/, '');
  const fakeProcess = {
    argv: [process.execPath, commandPath, ...args],
    env,
    cwd: () => cwd,
    stdout: { write: (value) => stdout.push(String(value)) },
    stderr: { write: (value) => stderr.push(String(value)) },
    exit(code = 0) {
      status = code;
      throw exitSignal;
    },
  };

  try {
    vm.runInNewContext(commandSource, { process: fakeProcess }, { filename: commandPath });
  } catch (error) {
    if (error !== exitSignal) {
      throw error;
    }
  }

  return {
    status,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

test('doctor selects Windows npm and Copilot cmd commands', (t) => {
  const repoRoot = createTempTargetProject(t);
  const commandCalls = [];

  const result = doctor({
    repoRoot,
    platform: 'win32',
    commandRunner(command, args, cwd) {
      commandCalls.push({ command, args, cwd });
      return {
        status: 0,
        stdout: `${command} shim ${args.join(' ')}\n`,
        stderr: '',
      };
    },
  });

  assert.equal(result.status, 'pass');
  assert.ok(result.checks.some((check) => check.label === 'npm' && check.summary.includes('npm.cmd shim --version')));
  assert.ok(result.checks.some((check) => check.label === 'copilot' && check.summary.includes('copilot.cmd shim --help')));
  assert.ok(commandCalls.some((call) => call.command === 'npm.cmd' && call.args.join(' ') === '--version'));
  assert.ok(commandCalls.some((call) => call.command === 'copilot.cmd' && call.args.join(' ') === '--help'));
  assert.deepEqual(
    commandCalls.filter((call) => call.command.toLowerCase().includes('copilot')).map((call) => call.command),
    ['copilot.cmd'],
  );
  assert.ok(commandCalls.every((call) => call.command !== 'copilot' && call.command !== 'copilot.ps1'));
});

test('doctor selects generic Copilot command on non-Windows platforms', (t) => {
  const repoRoot = createTempTargetProject(t);
  const commandCalls = [];

  const result = doctor({
    repoRoot,
    platform: 'linux',
    commandRunner(command, args, cwd) {
      commandCalls.push({ command, args, cwd });
      return {
        status: 0,
        stdout: `${command} shim ${args.join(' ')}\n`,
        stderr: '',
      };
    },
  });

  assert.equal(result.status, 'pass');
  assert.ok(result.checks.some((check) => check.label === 'copilot' && check.summary.includes('copilot shim --help')));
  assert.deepEqual(
    commandCalls.filter((call) => call.command.toLowerCase().includes('copilot')).map((call) => call.command),
    ['copilot'],
  );
  assert.ok(commandCalls.every((call) => call.command !== 'copilot.cmd' && call.command !== 'copilot.ps1'));
});

test('doctor honors configured Copilot command override', (t) => {
  const repoRoot = createTempTargetProject(t);
  const harnessDir = path.join(repoRoot, '.qa-harness');
  const commandCalls = [];

  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, copilot: { command: 'custom-copilot' } }, null, 2)}\n`,
  );

  const result = doctor({
    repoRoot,
    platform: 'win32',
    commandRunner(command, args, cwd) {
      commandCalls.push({ command, args, cwd });
      return {
        status: 0,
        stdout: `${command} shim ${args.join(' ')}\n`,
        stderr: '',
      };
    },
  });

  assert.equal(result.status, 'pass');
  assert.ok(result.checks.some((check) => check.label === 'copilot' && check.summary.includes('custom-copilot shim --help')));
  assert.deepEqual(
    commandCalls.filter((call) => call.command.toLowerCase().includes('copilot')).map((call) => call.command),
    ['custom-copilot'],
  );
});

test('doctor passes Copilot check with a fake Copilot executable on PATH', (t) => {
  const repoRoot = createTempTargetProject(t);
  const fakeCopilot = writeFakeCopilotCommand(t);
  const env = prependPath(process.env, fakeCopilot.binDir);
  const commandCalls = [];

  const result = doctor({
    repoRoot,
    platform: fakeCopilot.platform,
    env,
    commandRunner(command, args, cwd, options = {}) {
      commandCalls.push({ command, args, cwd });

      if (command === fakeCopilot.commandName) {
        return runFakeCommandFromPath(command, args, cwd, options.env);
      }

      return createPassingCommandRunner()(command, args, cwd);
    },
  });

  const copilotCheck = result.checks.find((check) => check.label === 'copilot');

  assert.equal(result.status, 'pass');
  assert.equal(copilotCheck.status, 'pass');
  assert.match(copilotCheck.summary, /fake Copilot help from PATH/);
  assert.deepEqual(
    commandCalls.filter((call) => call.command.toLowerCase().includes('copilot')).map((call) => call.command),
    [fakeCopilot.commandName],
  );
});

test('doctor fails clearly when the Copilot CLI is missing from PATH', (t) => {
  const repoRoot = createTempTargetProject(t);
  const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-qa-harness-empty-bin-'));
  const env = { PATH: emptyBinDir };
  const commandCalls = [];
  let stdout = '';
  let stderr = '';

  t.after(() => {
    fs.rmSync(emptyBinDir, { recursive: true, force: true });
  });

  const exitCode = runCli(['doctor'], {
    repoRoot,
    env,
    platform: 'linux',
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner(command, args, cwd, options = {}) {
      commandCalls.push({ command, args, cwd, env: options.env });

      if (command === 'copilot') {
        assert.equal(options.env.PATH, emptyBinDir);
        throw new Error('spawn copilot ENOENT');
      }

      return createPassingCommandRunner()(command, args, cwd);
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /FAIL copilot:/);
  assert.match(stderr, /Install Copilot CLI/i);
  assert.match(stderr, /\.qa-harness\/config\.json/);
  assert.match(stderr, /copilot\.command/);
  assert.match(stderr, /Doctor failed with 1 blocking issue/);
  assert.deepEqual(
    commandCalls.filter((call) => call.command.toLowerCase().includes('copilot')).map((call) => call.command),
    ['copilot'],
  );
});

test('doctor fails clearly when the Playwright BDD layout is missing', (t) => {
  const repoRoot = createTempTargetProject(t, {
    mutate: (targetRoot) => {
      fs.rmSync(path.join(targetRoot, 'Features', 'steps'), { recursive: true, force: true });
      fs.rmSync(path.join(targetRoot, 'node_modules', 'playwright-bdd'), { recursive: true, force: true });
    },
  });
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['doctor'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: createPassingCommandRunner(),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /FAIL target-layout: missing Features\/steps\/ directory, Features\/steps\/\*\*\/\*\.ts step definitions/);
  assert.match(
    stderr,
    /FAIL playwright-bdd: missing playwright-bdd package metadata, playwright-bdd CLI at node_modules\/playwright-bdd\/dist\/cli\/index\.js/,
  );
  assert.match(stderr, /Doctor failed with 2 blocking issues/);
});

test('doctor reports the lean prerequisite checks with pass or fail statuses', (t) => {
  const repoRoot = createTempTargetProject(t);
  const commandCalls = [];
  const result = doctor({
    repoRoot,
    commandRunner: createPassingCommandRunner(commandCalls),
  });

  assert.equal(result.status, 'pass');
  assert.deepEqual(
    result.checks.map((check) => check.label),
    ['node', 'npm', 'git', 'target-layout', 'playwright', 'playwright-bdd', 'copilot'],
  );
  assert.ok(result.checks.every((check) => check.status === 'pass' || check.status === 'fail'));
  assert.ok(result.checks.some((check) => check.label === 'node' && check.summary.includes(process.version)));
  assert.ok(commandCalls.some((call) => call.command === 'git' && call.args.join(' ') === '--version'));
  assert.ok(commandCalls.some((call) => call.command.includes('npm') && call.args.join(' ') === '--version'));
  assert.ok(commandCalls.some((call) => call.command.includes('copilot') && call.args.join(' ') === '--help'));
  assert.match(formatDoctorOutput(result), /Doctor passed/);
  assert.doesNotMatch(formatDoctorOutput(result), /browsers|bridge|runtime/i);
});

test('doctor fails each missing lean prerequisite separately', (t) => {
  const repoRoot = createTempTargetProject(t, {
    mutate: (targetRoot) => {
      fs.rmSync(path.join(targetRoot, 'Features', 'steps'), { recursive: true, force: true });
      fs.rmSync(path.join(targetRoot, 'node_modules', 'playwright-bdd', 'dist', 'cli', 'index.js'), {
        force: true,
      });
    },
  });

  const result = doctor({
    repoRoot,
    commandRunner: (command, args, cwd) => {
      if (command === 'git') {
        return { status: 1, stdout: '', stderr: 'git missing\n' };
      }

      if (command.includes('copilot')) {
        return { status: 1, stdout: '', stderr: 'copilot missing\n' };
      }

      return createPassingCommandRunner()(command, args, cwd);
    },
  });

  assert.equal(result.status, 'fail');
  assert.ok(result.checks.some((check) => check.label === 'git' && check.status === 'fail'));
  assert.ok(result.checks.some((check) => check.label === 'target-layout' && check.status === 'fail'));
  assert.ok(result.checks.some((check) => check.label === 'playwright-bdd' && check.status === 'fail'));
  assert.ok(result.checks.some((check) => check.label === 'copilot' && check.status === 'fail'));
  assert.match(formatDoctorOutput(result), /Doctor failed/);
});

test('runCli routes doctor output and rejects the deleted preflight alias', () => {
  let stdout = '';
  let stderr = '';

  const successExitCode = runCli(['doctor'], {
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

  const preflightExitCode = runCli(['preflight'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(preflightExitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Unknown command "preflight"/);

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
