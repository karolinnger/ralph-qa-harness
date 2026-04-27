'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  allTasksComplete,
  importPlan,
  parsePlanCheckboxes,
  selectNextTask,
} = require('../../src/plan');
const { createTempRepo, writeFile } = require('../helpers/temp-repo');

test('parsePlanCheckboxes returns line ids, checked state, text, and nearest heading', () => {
  const markdown = [
    '# Plan',
    '',
    '### Task 1: Config',
    '',
    '- [x] Step 1: Write the failing test',
    '  - note',
    '  - [ ] Step 2: Run test to verify it fails',
  ].join('\n');

  assert.deepEqual(parsePlanCheckboxes(markdown), [
    {
      id: 'L5',
      line: 5,
      checked: true,
      text: 'Step 1: Write the failing test',
      heading: 'Task 1: Config',
    },
    {
      id: 'L7',
      line: 7,
      checked: false,
      text: 'Step 2: Run test to verify it fails',
      heading: 'Task 1: Config',
    },
  ]);
});

test('selectNextTask returns the first unchecked task in document order', () => {
  const markdown = '- [x] done\n- [ ] first\n- [ ] second\n';

  assert.equal(selectNextTask(markdown).text, 'first');
});

test('allTasksComplete requires at least one checkbox and all checked', () => {
  assert.equal(allTasksComplete('no tasks'), false);
  assert.equal(allTasksComplete('- [x] done\n- [X] done too'), true);
  assert.equal(allTasksComplete('- [x] done\n- [ ] not done'), false);
});

test('importPlan copies source markdown into .ralph implementation plan', (t) => {
  const repoRoot = createTempRepo(t);
  const sourcePath = path.join(repoRoot, 'docs', 'plan.md');
  const targetPath = path.join(repoRoot, '.ralph', 'IMPLEMENTATION_PLAN.md');
  writeFile(sourcePath, '# Imported\n\n- [ ] task\n');
  writeFile(path.join(repoRoot, '.ralph', 'config.json'), '{}');

  const result = importPlan({ repoRoot, sourcePath });

  assert.equal(result.targetPath, targetPath);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), '# Imported\n\n- [ ] task\n');
});
