'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  allProgressItemsComplete,
  allWorkComplete,
  parseProgressItems,
  selectNextAction,
} = require('../../src/progress');

test('parseProgressItems returns atomic progress items with normalized statuses', () => {
  const progress = [
    '# Progress',
    '',
    '## Executor',
    '',
    '- [ ] `P-001` implement the first slice',
    '  - Status: `todo`',
    '- [x] `P-002` already verified',
    '  - Status: `pass`',
    '- [ ] heal flaky proof',
    '  - Status: `fail`',
  ].join('\n');

  assert.deepEqual(parseProgressItems(progress), [
    {
      id: 'P-001',
      line: 5,
      checked: false,
      text: 'implement the first slice',
      heading: 'Executor',
      status: 'todo',
    },
    {
      id: 'P-002',
      line: 7,
      checked: true,
      text: 'already verified',
      heading: 'Executor',
      status: 'pass',
    },
    {
      id: 'L9',
      line: 9,
      checked: false,
      text: 'heal flaky proof',
      heading: 'Executor',
      status: 'fail',
    },
  ]);
});

test('selectNextAction chooses planner executor healer and verifier from durable artifacts', () => {
  assert.deepEqual(
    selectNextAction({
      prd: '',
      prompt: '# Prompt\n',
      progress: '# Progress\n',
      implementationPlan: '',
    }),
    {
      role: 'planner',
      reason: 'missing or empty PRD/progress artifacts',
      task: null,
    },
  );

  assert.deepEqual(
    selectNextAction({
      prd: '# PRD\n',
      prompt: '# Prompt\n',
      progress: '- [ ] `P-001` implement one slice\n  - Status: `todo`\n',
      implementationPlan: '',
    }),
    {
      role: 'executor',
      reason: 'next actionable progress item',
      task: {
        id: 'P-001',
        line: 1,
        checked: false,
        text: 'implement one slice',
        heading: '',
        status: 'todo',
      },
    },
  );

  assert.equal(
    selectNextAction({
      prd: '# PRD\n',
      prompt: '# Prompt\n',
      progress: '- [ ] `P-001` fix failed proof\n  - Status: `fail`\n',
      implementationPlan: '',
    }).role,
    'healer',
  );

  assert.deepEqual(
    selectNextAction({
      prd: '# PRD\n',
      prompt: '# Prompt\n',
      progress: [
        '- [ ] `P-001` implement one slice',
        '  - Status: `needs-verification`',
        '',
        '## 2026-04-26T00:00:00.000Z',
        '',
        'Pending verifier: P-001',
      ].join('\n'),
      implementationPlan: '',
    }),
    {
      role: 'verifier',
      reason: 'pending verifier review',
      task: {
        id: 'P-001',
        line: 1,
        checked: false,
        text: 'implement one slice',
        heading: '',
        status: 'needs-verification',
      },
    },
  );
});

test('selectNextAction does not keep selecting verifier after a rejection closes pending review', () => {
  assert.deepEqual(
    selectNextAction({
      prd: '# PRD\n',
      prompt: '# Prompt\n',
      progress: [
        '- [ ] `P-001` fix failed proof',
        '  - Status: `fail`',
        '',
        'Pending verifier: P-001',
        '',
        'Verifier rejected: P-001',
      ].join('\n'),
      implementationPlan: '',
    }),
    {
      role: 'healer',
      reason: 'failed or blocked progress item',
      task: {
        id: 'P-001',
        line: 1,
        checked: false,
        text: 'fix failed proof',
        heading: '',
        status: 'fail',
      },
    },
  );

  assert.equal(
    selectNextAction({
      prd: '# PRD\n',
      prompt: '# Prompt\n',
      progress: [
        '- [ ] `P-001` fix failed proof',
        '  - Status: `needs-verification`',
        '',
        'Pending verifier: P-001',
        '',
        'Verifier rejected: P-001',
        '',
        'Pending verifier: P-001',
      ].join('\n'),
      implementationPlan: '',
    }).role,
    'verifier',
  );
});

test('allProgressItemsComplete requires verifier acceptance for unchecked items', () => {
  assert.equal(
    allProgressItemsComplete('- [ ] `P-001` implement\n  - Status: `needs-verification`\n'),
    false,
  );
  assert.equal(
    allProgressItemsComplete([
      '- [ ] `P-001` implement',
      '  - Status: `needs-verification`',
      '',
      'Verifier accepted: P-001',
    ].join('\n')),
    true,
  );
});

test('accepted implementation plan items do not complete or reselect the whole plan while unchecked items remain', () => {
  const implementationPlan = [
    '# Implementation Plan',
    '',
    '- [ ] first plan item',
    '- [ ] second plan item',
    '',
  ].join('\n');
  const progress = [
    '# Progress',
    '',
    '- [x] `L3` first plan item',
    '  - Status: `final-pass`',
    '',
    'Verifier accepted: L3',
    '',
  ].join('\n');

  assert.equal(allWorkComplete({ progress, implementationPlan }), false);
  assert.deepEqual(
    selectNextAction({
      prd: '# PRD\n',
      prompt: '# Prompt\n',
      progress,
      implementationPlan,
    }),
    {
      role: 'executor',
      reason: 'legacy implementation plan item',
      task: {
        id: 'L4',
        line: 4,
        checked: false,
        text: 'second plan item',
        heading: 'Implementation Plan',
        status: 'todo',
      },
    },
  );
});
