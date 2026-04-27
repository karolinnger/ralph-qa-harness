'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REQUIRED_FOOTER,
  buildRolePrompt,
  buildVerifierPrompt,
  buildWorkerPrompt,
  parseRalphFooter,
} = require('../../src/prompt');
const {
  buildCodexExecArgs,
  runCodexVerifier,
  runCodexWorker,
  sanitizeCodexLog,
} = require('../../src/codex');
const { createTempRepo } = require('../helpers/temp-repo');

test('buildWorkerPrompt includes durable memory, selected task, validation, boundary, and footer', () => {
  const prompt = buildWorkerPrompt({
    standingPrompt: 'Standing instructions',
    prd: '# PRD\nShip the thing',
    implementationPlan: '# Plan\n- [ ] Task A',
    progress: '# Progress\nNone',
    selectedTask: { id: 'L2', line: 2, text: 'Task A', heading: 'Plan' },
    validationCommands: [{ name: 'test', command: 'npm', args: ['test'] }],
  });

  assert.match(prompt, /Standing instructions/);
  assert.match(prompt, /Ship the thing/);
  assert.match(prompt, /# Plan/);
  assert.match(prompt, /# Progress/);
  assert.match(prompt, /Selected task: L2/);
  assert.match(prompt, /Task A/);
  assert.match(prompt, /Work on exactly one selected task\. Do not continue to the next unchecked task\./);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Ralph supervisor runs these commands after the worker exits/);
  assert.match(prompt, /Do not run these commands yourself/);
  assert.match(prompt, /RALPH_STATUS: pass\|blocked\|fail/);
});

test('buildRolePrompt includes role-specific instructions for lightweight multi-agent dispatch', () => {
  const executorPrompt = buildRolePrompt({
    role: 'executor',
    standingPrompt: 'Keep changes focused.',
    prd: '# PRD\n',
    progress: '- [ ] `P-001` implement\n',
    selectedTask: { id: 'P-001', heading: '', line: 1, text: 'implement' },
    validationCommands: [],
  });
  const verifierPrompt = buildRolePrompt({
    role: 'verifier',
    standingPrompt: 'Keep changes focused.',
    prd: '# PRD\n',
    progress: 'Pending verifier: P-001\n',
    selectedTask: { id: 'P-001', heading: '', line: 1, text: 'implement' },
    validationCommands: [],
  });

  assert.match(executorPrompt, /RALPH_ROLE: executor/);
  assert.match(executorPrompt, /Do not mark the item final-pass/);
  assert.match(verifierPrompt, /RALPH_ROLE: verifier/);
  assert.match(verifierPrompt, /Only the verifier may mark an item final-pass/);
});

test('buildVerifierPrompt is read-only and includes review evidence', () => {
  const prompt = buildVerifierPrompt({
    implementationPlan: '# Plan',
    progress: '# Progress',
    diff: 'diff --git a/a b/a',
    validationLog: '{"status":"pass"}',
  });

  assert.match(prompt, /read-only/);
  assert.match(prompt, /# Plan/);
  assert.match(prompt, /# Progress/);
  assert.match(prompt, /diff --git/);
  assert.match(prompt, /"status":"pass"/);
  assert.match(prompt, new RegExp(REQUIRED_FOOTER.split('\n')[0].replace('|', '\\|')));
});

test('parseRalphFooter extracts status summary validation and next fields', () => {
  const footer = parseRalphFooter([
    'noise',
    'RALPH_STATUS: pass',
    'RALPH_SUMMARY: Done',
    'RALPH_VALIDATION: npm test',
    'RALPH_NEXT: none',
  ].join('\n'));

  assert.deepEqual(footer, {
    status: 'pass',
    summary: 'Done',
    validation: 'npm test',
    next: 'none',
  });
});

test('buildCodexExecArgs appends noninteractive exec arguments', () => {
  const args = buildCodexExecArgs({
    config: {
      codex: {
        args: ['--profile', 'default'],
        model: 'gpt-test',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-failure',
      },
    },
    repoRoot: 'C:\\repo',
  });

  assert.deepEqual(args, [
    '--profile',
    'default',
    '--ask-for-approval',
    'on-failure',
    'exec',
    '--cd',
    'C:\\repo',
    '--sandbox',
    'workspace-write',
    '--color',
    'never',
    '--model',
    'gpt-test',
    '-',
  ]);
});

test('sanitizeCodexLog collapses known Codex remote warning HTML payloads', () => {
  const log = [
    '2026-04-27T00:00:00Z  WARN codex_core::plugins::manager: failed to warm featured plugin ids cache error=remote plugin sync request to https://chatgpt.com/backend-api/plugins/featured failed with status 403 Forbidden: <html>',
    '<body>large cloudflare challenge</body>',
    '</html>',
    'important stderr line',
  ].join('\n');

  const sanitized = sanitizeCodexLog(log);

  assert.match(sanitized, /suppressed HTML response/);
  assert.match(sanitized, /important stderr line/);
  assert.doesNotMatch(sanitized, /large cloudflare challenge/);
});

test('runCodexWorker uses a fresh process and sends prompt on stdin', (t) => {
  const repoRoot = createTempRepo(t);
  const counterPath = path.join(repoRoot, 'counter.txt');
  const promptPath = path.join(repoRoot, 'prompt.txt');
  const fakeCodexPath = path.resolve(__dirname, '..', 'fixtures', 'fake-codex.js');
  const config = {
    codex: {
      command: process.execPath,
      args: [fakeCodexPath],
      model: '',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-failure',
      timeoutMs: 5000,
    },
  };

  const first = runCodexWorker({ repoRoot, config, prompt: 'first prompt', env: {
    ...process.env,
    RALPH_FAKE_CODEX_COUNTER_PATH: counterPath,
    RALPH_FAKE_CODEX_PROMPT_PATH: promptPath,
  } });
  const second = runCodexWorker({ repoRoot, config, prompt: 'second prompt', env: {
    ...process.env,
    RALPH_FAKE_CODEX_COUNTER_PATH: counterPath,
    RALPH_FAKE_CODEX_PROMPT_PATH: promptPath,
  } });

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  assert.equal(fs.readFileSync(promptPath, 'utf8'), 'second prompt');
});

test('runCodexWorker reports timeout and verifier forces read-only sandbox', (t) => {
  const repoRoot = createTempRepo(t);
  const fakeCodexPath = path.resolve(__dirname, '..', 'fixtures', 'fake-codex.js');
  const argvPath = path.join(repoRoot, 'argv.json');
  const config = {
    codex: {
      command: process.execPath,
      args: [fakeCodexPath],
      model: '',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-failure',
      timeoutMs: 50,
    },
  };
  const verifierConfig = {
    codex: {
      ...config.codex,
      timeoutMs: 5000,
    },
  };

  const timeout = runCodexWorker({ repoRoot, config, prompt: 'prompt', env: {
    ...process.env,
    RALPH_FAKE_CODEX_MODE: 'timeout',
  } });
  const verifier = runCodexVerifier({ repoRoot, config: verifierConfig, prompt: 'verify', env: {
    ...process.env,
    RALPH_FAKE_CODEX_ARGV_PATH: argvPath,
  } });
  const argv = JSON.parse(fs.readFileSync(argvPath, 'utf8'));

  assert.equal(timeout.timedOut, true);
  assert.equal(verifier.exitCode, 0);
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(argv[argv.indexOf('--ask-for-approval') + 1], 'never');
});
