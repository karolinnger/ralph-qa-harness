'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyInteractiveBlock,
  classifyIteration,
} = require('../../src/loop');

function base(overrides = {}) {
  return {
    codexResult: { exitCode: 0, timedOut: false, stdout: '', stderr: '', footer: { status: 'pass' } },
    validationResult: { status: 'pass' },
    allTasksComplete: false,
    noMeaningfulChanges: false,
    stallCount: 0,
    stalledNoChangeLimit: 2,
    iteration: 1,
    maxIterations: 5,
    ...overrides,
  };
}

test('classifyIteration returns fail for timeout nonzero exit and validation failure', () => {
  assert.equal(classifyIteration(base({ codexResult: { exitCode: 0, timedOut: true, stdout: '', stderr: '', footer: {} } })).classification, 'fail');
  assert.equal(classifyIteration(base({ codexResult: { exitCode: 2, timedOut: false, stdout: '', stderr: '', footer: {} } })).classification, 'fail');
  assert.equal(classifyIteration(base({ codexResult: { exitCode: 0, timedOut: false, stdout: '', stderr: '', footer: { status: 'fail' } } })).classification, 'fail');
  assert.equal(classifyIteration(base({ validationResult: { status: 'fail' } })).classification, 'fail');
});

test('classifyIteration returns blocked for footer or interactive block signals', () => {
  assert.equal(classifyIteration(base({ codexResult: { exitCode: 0, timedOut: false, stdout: '', stderr: '', footer: { status: 'blocked' } } })).classification, 'blocked');
  assert.equal(classifyIteration(base({ codexResult: { exitCode: 0, timedOut: false, stdout: 'please confirm', stderr: '', footer: { status: 'pass' } } })).classification, 'blocked');
});

test('classifyIteration returns completed stalled budget-exhausted or continue', () => {
  assert.equal(classifyIteration(base({ allTasksComplete: true })).classification, 'completed');
  assert.equal(classifyIteration(base({ noMeaningfulChanges: true, stallCount: 2 })).classification, 'stalled');
  assert.equal(classifyIteration(base({ iteration: 5, maxIterations: 5 })).classification, 'budget-exhausted');
  assert.equal(classifyIteration(base()).classification, 'continue');
});

test('footer pass does not override failed validation', () => {
  const result = classifyIteration(base({
    codexResult: { exitCode: 0, timedOut: false, stdout: 'RALPH_STATUS: pass', stderr: '', footer: { status: 'pass' } },
    validationResult: { status: 'fail' },
  }));

  assert.equal(result.classification, 'fail');
});

test('classifyInteractiveBlock detects blocking operator prompts', () => {
  for (const text of [
    'approval required',
    'requires user approval',
    'permission denied',
    'missing credential',
    'ambiguous requirement',
    'please confirm',
    'need your input',
  ]) {
    assert.equal(classifyInteractiveBlock(text), true, text);
  }
});
