'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli } = require('../../src/cli');
const { createTempRepo, writeFile } = require('../helpers/temp-repo');

test('init creates .ralph workspace and excludes it from local git info', (t) => {
  const repoRoot = createTempRepo(t);
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['init'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  for (const fileName of ['PROMPT.md', 'IMPLEMENTATION_PLAN.md', 'progress.md', 'config.json', 'state.json']) {
    assert.equal(fs.existsSync(path.join(repoRoot, '.ralph', fileName)), true, fileName);
  }
  assert.equal(exitCode, 0);
  assert.match(stdout, /Initialized Ralph workspace/);
  assert.equal(stderr, '');
  assert.match(fs.readFileSync(path.join(repoRoot, '.git', 'info', 'exclude'), 'utf8'), /\.ralph\//);
});

test('plan imports markdown after init and refuses missing workspace', (t) => {
  const repoRoot = createTempRepo(t);
  const sourcePath = path.join(repoRoot, 'docs', 'implementation.md');
  writeFile(sourcePath, '# Plan\n\n- [ ] one\n');
  let stdout = '';
  let stderr = '';

  const missingExit = runCli(['plan', '--from', sourcePath], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  assert.equal(missingExit, 1);
  assert.match(stderr, /Run `ralph-codex init` first/);

  stdout = '';
  stderr = '';
  assert.equal(runCli(['init'], {
    repoRoot,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  }), 0);
  const importedExit = runCli(['plan', '--from', sourcePath], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(importedExit, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Imported implementation plan/);
  assert.equal(fs.readFileSync(path.join(repoRoot, '.ralph', 'IMPLEMENTATION_PLAN.md'), 'utf8'), '# Plan\n\n- [ ] one\n');
});

test('status reports no run before any run is available', (t) => {
  const repoRoot = createTempRepo(t);
  let stderr = '';
  runCli(['init'], { repoRoot, stdout: { write: () => {} }, stderr: { write: () => {} } });

  const exitCode = runCli(['status'], {
    repoRoot,
    stdout: { write: () => {} },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /No Ralph run is available/);
});
