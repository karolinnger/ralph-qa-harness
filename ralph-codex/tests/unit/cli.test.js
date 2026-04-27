'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCliArgs, runCli } = require('../../src/cli');

test('CLI help lists the supported standalone commands', () => {
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['--help'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout, /ralph-codex init/);
  assert.match(stdout, /ralph-codex plan/);
  assert.match(stdout, /ralph-codex run/);
  assert.match(stdout, /ralph-codex status/);
  assert.match(stdout, /ralph-codex verify/);
  assert.match(stdout, /ralph-codex doctor/);
  assert.equal(stderr, '');
});

test('parseCliArgs supports space and equals option forms', () => {
  assert.deepEqual(parseCliArgs(['run', '--max-iterations', '3', '--resume=true']), {
    command: 'run',
    options: {
      'max-iterations': '3',
      resume: 'true',
    },
  });
});
