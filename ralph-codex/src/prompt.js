'use strict';

const { buildCommandLineForDisplay } = require('./process');

const REQUIRED_FOOTER = [
  'RALPH_STATUS: pass|blocked|fail',
  'RALPH_SUMMARY: <one concise paragraph>',
  'RALPH_VALIDATION: <commands run, or why not run>',
  'RALPH_NEXT: <next recommended action, or none>',
].join('\n');

function formatValidationCommands(commands) {
  if (!commands || commands.length === 0) {
    return 'No deterministic validation commands configured.';
  }
  return commands.map((command) => `- ${command.name}: ${buildCommandLineForDisplay(command)}`).join('\n');
}

const ROLE_INSTRUCTIONS = Object.freeze({
  planner: [
    'Create or refine PRD.md, progress.md, and PROMPT.md.',
    'Split work into atomic progress items that can be completed and verified independently.',
    'Do not implement product changes while planning.',
  ],
  executor: [
    'Complete exactly one selected progress item.',
    'Do not mark the item final-pass. Leave final acceptance to the verifier.',
    'When implementation is ready for review, record Status: `needs-verification` for the selected item.',
  ],
  healer: [
    'Fix exactly one failed or blocked selected progress item.',
    'Do not broaden scope beyond the selected item.',
    'When the fix is ready for review, record Status: `needs-verification` for the selected item.',
  ],
  verifier: [
    'Review only the selected item, validation evidence, and changed files.',
    'Only the verifier may mark an item final-pass.',
    'If proof is insufficient, mark the selected item fail or blocked with a concise reason.',
  ],
  explorer: [
    'Investigate one bounded gap or risk area.',
    'Record findings as progress items or concise notes.',
    'Do not implement product changes while exploring.',
  ],
  worker: [
    'Work on exactly one selected task. Do not continue to the next unchecked task.',
    'Keep durable progress in files. Do not rely on chat context.',
  ],
});

function formatSelectedTask(selectedTask) {
  if (!selectedTask) {
    return [
      'Selected task: (none)',
      'Heading: (none)',
      'Line: 0',
      'Text: (none)',
    ].join('\n');
  }

  return [
    `Selected task: ${selectedTask.id}`,
    `Heading: ${selectedTask.heading || '(none)'}`,
    `Line: ${selectedTask.line}`,
    `Text: ${selectedTask.text}`,
  ].join('\n');
}

function buildRolePrompt({
  role = 'worker',
  standingPrompt,
  prd,
  implementationPlan,
  progress,
  selectedTask,
  validationCommands,
}) {
  const normalizedRole = ROLE_INSTRUCTIONS[role] ? role : 'worker';
  return [
    `# Ralph Codex ${normalizedRole} Prompt`,
    '',
    `RALPH_ROLE: ${normalizedRole}`,
    '',
    '## Standing Instructions',
    standingPrompt || '',
    '',
    '## PRD',
    prd || '',
    '',
    '## Implementation Plan',
    implementationPlan || '',
    '',
    '## Progress Log',
    progress || '',
    '',
    '## Selected Task',
    formatSelectedTask(selectedTask),
    '',
    '## Role Instructions',
    ROLE_INSTRUCTIONS[normalizedRole].map((instruction) => `- ${instruction}`).join('\n'),
    '',
    '## Validation Commands',
    'Ralph supervisor runs these commands after the worker exits.',
    'Do not run these commands yourself unless you are explicitly diagnosing validation behavior.',
    'If you do not run them, set RALPH_VALIDATION to "not run; supervisor validates after this turn".',
    '',
    formatValidationCommands(validationCommands),
    '',
    '## Required Final Footer',
    REQUIRED_FOOTER,
    '',
  ].join('\n');
}

function buildWorkerPrompt(options) {
  return buildRolePrompt({ ...options, role: options.role || 'worker' });
}

function buildVerifierPrompt({ implementationPlan, progress, diff, validationLog }) {
  return [
    '# Ralph Codex Verifier Prompt',
    '',
    'You are running in read-only mode. Review the evidence and do not modify files.',
    '',
    '## Implementation Plan',
    implementationPlan || '',
    '',
    '## Progress Log',
    progress || '',
    '',
    '## Diff',
    diff || '',
    '',
    '## Validation Log',
    validationLog || '',
    '',
    '## Required Final Footer',
    REQUIRED_FOOTER,
    '',
  ].join('\n');
}

function readFooterLine(text, key) {
  const match = String(text || '').match(new RegExp(`^${key}:\\s*(.+)$`, 'imu'));
  return match ? match[1].trim() : '';
}

function parseRalphFooter(text) {
  const status = readFooterLine(text, 'RALPH_STATUS').toLowerCase();
  return {
    status: ['pass', 'blocked', 'fail'].includes(status) ? status : '',
    summary: readFooterLine(text, 'RALPH_SUMMARY'),
    validation: readFooterLine(text, 'RALPH_VALIDATION'),
    next: readFooterLine(text, 'RALPH_NEXT'),
  };
}

module.exports = {
  REQUIRED_FOOTER,
  buildRolePrompt,
  buildWorkerPrompt,
  buildVerifierPrompt,
  parseRalphFooter,
};
