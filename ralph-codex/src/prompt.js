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

function buildWorkerPrompt({ standingPrompt, implementationPlan, progress, selectedTask, validationCommands }) {
  return [
    '# Ralph Codex Worker Prompt',
    '',
    '## Standing Instructions',
    standingPrompt || '',
    '',
    '## Implementation Plan',
    implementationPlan || '',
    '',
    '## Progress Log',
    progress || '',
    '',
    '## Selected Task',
    `Selected task: ${selectedTask.id}`,
    `Heading: ${selectedTask.heading || '(none)'}`,
    `Line: ${selectedTask.line}`,
    `Text: ${selectedTask.text}`,
    '',
    '## Write Boundary',
    'Work on exactly one selected task. Do not continue to the next unchecked task.',
    'Keep durable progress in files. Do not rely on chat context.',
    '',
    '## Validation Commands',
    formatValidationCommands(validationCommands),
    '',
    '## Required Final Footer',
    REQUIRED_FOOTER,
    '',
  ].join('\n');
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
  buildWorkerPrompt,
  buildVerifierPrompt,
  parseRalphFooter,
};
