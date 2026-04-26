'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
