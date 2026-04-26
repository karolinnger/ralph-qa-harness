'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function parseRepoRoot(argv) {
  const index = argv.indexOf('--cd');
  return index >= 0 && argv[index + 1] ? argv[index + 1] : process.cwd();
}

function incrementCounter(counterPath) {
  if (!counterPath) {
    return;
  }
  const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });
  fs.writeFileSync(counterPath, String(current + 1), 'utf8');
}

function markFirstUncheckedPlanItem(repoRoot) {
  const planPath = path.join(repoRoot, '.ralph', 'IMPLEMENTATION_PLAN.md');
  if (!fs.existsSync(planPath)) {
    return;
  }
  const plan = fs.readFileSync(planPath, 'utf8');
  fs.writeFileSync(planPath, plan.replace('- [ ]', '- [x]'), 'utf8');
}

function appendWorkFile(repoRoot) {
  const targetPath = path.join(repoRoot, 'ralph-output.txt');
  fs.appendFileSync(targetPath, `fake codex pass ${new Date(0).toISOString()}\n`, 'utf8');
}

function main() {
  if (process.argv.includes('--version')) {
    process.stdout.write('fake-codex 1.0.0\n');
    return;
  }

  const argv = process.argv.slice(2);
  const repoRoot = parseRepoRoot(argv);
  const prompt = readStdin();
  if (process.env.RALPH_FAKE_CODEX_PROMPT_PATH) {
    fs.mkdirSync(path.dirname(process.env.RALPH_FAKE_CODEX_PROMPT_PATH), { recursive: true });
    fs.writeFileSync(process.env.RALPH_FAKE_CODEX_PROMPT_PATH, prompt, 'utf8');
  }
  if (process.env.RALPH_FAKE_CODEX_ARGV_PATH) {
    fs.mkdirSync(path.dirname(process.env.RALPH_FAKE_CODEX_ARGV_PATH), { recursive: true });
    fs.writeFileSync(process.env.RALPH_FAKE_CODEX_ARGV_PATH, JSON.stringify(argv), 'utf8');
  }
  incrementCounter(process.env.RALPH_FAKE_CODEX_COUNTER_PATH);

  const mode = process.env.RALPH_FAKE_CODEX_MODE || 'pass';
  if (mode === 'timeout') {
    setTimeout(() => {}, 60_000);
    return;
  }
  if (mode === 'blocked') {
    process.stdout.write('Need your input before continuing.\n');
    process.stdout.write('RALPH_STATUS: blocked\nRALPH_SUMMARY: Missing decision.\nRALPH_VALIDATION: not run\nRALPH_NEXT: ask operator\n');
    return;
  }
  if (mode === 'fail') {
    process.stderr.write('fake codex failed\n');
    process.stdout.write('RALPH_STATUS: fail\nRALPH_SUMMARY: Failed deliberately.\nRALPH_VALIDATION: not run\nRALPH_NEXT: inspect failure\n');
    process.exitCode = 2;
    return;
  }
  if (mode === 'no-change') {
    process.stdout.write('RALPH_STATUS: pass\nRALPH_SUMMARY: Reported success without changes.\nRALPH_VALIDATION: not run\nRALPH_NEXT: retry\n');
    return;
  }

  appendWorkFile(repoRoot);
  markFirstUncheckedPlanItem(repoRoot);
  process.stdout.write('RALPH_STATUS: pass\nRALPH_SUMMARY: Completed one task.\nRALPH_VALIDATION: fake validation\nRALPH_NEXT: none\n');
}

main();
