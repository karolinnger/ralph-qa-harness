'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCommandLineForDisplay,
  requiresCmdShim,
  runProcess,
} = require('../../src/process');

test('buildCommandLineForDisplay quotes arguments with whitespace', () => {
  assert.equal(
    buildCommandLineForDisplay({ command: 'codex', args: ['exec', '--cd', 'C:\\Target Repo', '-'] }),
    'codex exec --cd "C:\\Target Repo" -',
  );
});

test('requiresCmdShim only detects cmd and bat files on Windows', () => {
  assert.equal(requiresCmdShim('npm.cmd', 'win32'), true);
  assert.equal(requiresCmdShim('script.bat', 'win32'), true);
  assert.equal(requiresCmdShim('npm.cmd', 'linux'), false);
  assert.equal(requiresCmdShim('node', 'win32'), false);
});

test('runProcess captures stdout stderr exit code and stdin', () => {
  const result = runProcess({
    command: process.execPath,
    args: ['-e', "const fs=require('fs'); process.stdout.write(fs.readFileSync(0,'utf8')); process.stderr.write('err');"],
    input: 'hello',
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.durationMs, 'number');
});

test('runProcess marks timeouts', () => {
  const result = runProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000);'],
    timeoutMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('runProcess executes Windows cmd shims without shell quoting breakage', { skip: process.platform !== 'win32' }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-codex-cmd-'));
  const cmdPath = path.join(tempDir, 'echo-args.cmd');
  fs.writeFileSync(cmdPath, '@echo off\r\necho cmd:%~1:%~2\r\n', 'utf8');

  const result = runProcess({
    command: cmdPath,
    args: ['hello', 'two words'],
    cwd: tempDir,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /cmd:hello:two words/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('runProcess executes bare Windows cmd shims from PATH with correct script directory', { skip: process.platform !== 'win32' }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-codex-path-cmd-'));
  const cmdPath = path.join(tempDir, 'path-shim.cmd');
  const targetPath = path.join(tempDir, 'shim-target.js');
  fs.writeFileSync(targetPath, "process.stdout.write('target:' + process.argv[2]);\n", 'utf8');
  fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0shim-target.js" %*\r\n', 'utf8');

  const result = runProcess({
    command: 'path-shim.cmd',
    args: ['ok'],
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      PATH: `${tempDir};${process.env.PATH || ''}`,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'target:ok');
  fs.rmSync(tempDir, { recursive: true, force: true });
});
