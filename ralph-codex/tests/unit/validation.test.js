'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  formatValidationSummary,
  runValidationCommands,
} = require('../../src/validation');
const { createTempRepo } = require('../helpers/temp-repo');

test('runValidationCommands skips empty validation command lists explicitly', (t) => {
  const repoRoot = createTempRepo(t);
  const result = runValidationCommands({ repoRoot, validationCommands: [] });

  assert.equal(result.status, 'skipped');
  assert.equal(formatValidationSummary(result), 'No deterministic validation commands configured.');
});

test('runValidationCommands reports passing and failing commands', (t) => {
  const repoRoot = createTempRepo(t);
  const fakeValidationPath = path.resolve(__dirname, '..', 'fixtures', 'fake-validation.js');

  const passing = runValidationCommands({
    repoRoot,
    validationCommands: [{ name: 'pass', command: process.execPath, args: [fakeValidationPath, 'pass'] }],
  });
  const failing = runValidationCommands({
    repoRoot,
    validationCommands: [{ name: 'fail', command: process.execPath, args: [fakeValidationPath, 'fail'] }],
  });

  assert.equal(passing.status, 'pass');
  assert.equal(passing.results[0].exitCode, 0);
  assert.equal(failing.status, 'fail');
  assert.match(failing.results[0].stderr, /fake validation failed/);
});

test('runValidationCommands reports timeouts', (t) => {
  const repoRoot = createTempRepo(t);
  const fakeValidationPath = path.resolve(__dirname, '..', 'fixtures', 'fake-validation.js');
  const result = runValidationCommands({
    repoRoot,
    timeoutMs: 50,
    validationCommands: [{ name: 'timeout', command: process.execPath, args: [fakeValidationPath, 'timeout'] }],
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.results[0].timedOut, true);
});
