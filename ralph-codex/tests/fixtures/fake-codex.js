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

function appendRoleLog(repoRoot, role) {
  fs.appendFileSync(path.join(repoRoot, 'role-log.txt'), `${role}\n`, 'utf8');
}

function appendWorkFile(repoRoot) {
  const targetPath = path.join(repoRoot, 'ralph-output.txt');
  fs.appendFileSync(targetPath, `fake codex pass ${new Date(0).toISOString()}\n`, 'utf8');
}

function parseRole(prompt) {
  const match = String(prompt || '').match(/^RALPH_ROLE:\s*(\S+)\s*$/imu);
  return match ? match[1].trim().toLowerCase() : 'worker';
}

function parseSelectedTaskId(prompt) {
  const match = String(prompt || '').match(/^Selected task:\s*(\S+)\s*$/imu);
  return match && match[1] !== '(none)' ? match[1].trim() : 'P-001';
}

function replaceSelectedProgressStatus(repoRoot, selectedId, status, checked = false) {
  const progressPath = path.join(repoRoot, '.ralph', 'progress.md');
  if (!fs.existsSync(progressPath)) {
    return;
  }
  const lines = fs.readFileSync(progressPath, 'utf8').split(/\r?\n/u);
  let insideSelected = false;
  let statusReplaced = false;
  const nextLines = [];
  for (const line of lines) {
    const itemMatch = line.match(/^(\s*)-\s+\[[ xX]\]\s+`([^`]+)`\s+(.+)$/u);
    if (itemMatch) {
      insideSelected = itemMatch[2] === selectedId;
      nextLines.push(
        insideSelected
          ? `${itemMatch[1]}- [${checked ? 'x' : ' '}] \`${itemMatch[2]}\` ${itemMatch[3]}`
          : line,
      );
      continue;
    }
    if (insideSelected && /^\s+-\s+Status:/iu.test(line)) {
      nextLines.push(`  - Status: \`${status}\``);
      statusReplaced = true;
      insideSelected = false;
      continue;
    }
    nextLines.push(line);
  }
  if (!statusReplaced) {
    nextLines.push(`  - Status: \`${status}\``);
  }
  fs.writeFileSync(progressPath, nextLines.join('\n'), 'utf8');
}

function runMultiRole(repoRoot, prompt) {
  const role = parseRole(prompt);
  const selectedId = parseSelectedTaskId(prompt);
  appendRoleLog(repoRoot, role);

  if (role === 'planner') {
    fs.writeFileSync(path.join(repoRoot, '.ralph', 'PRD.md'), '# PRD\n\nPlanned by fake Codex.\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, '.ralph', 'PROMPT.md'), '# Prompt\n\nExecute the fake plan.\n', 'utf8');
    fs.writeFileSync(
      path.join(repoRoot, '.ralph', 'progress.md'),
      '# Progress\n\n- [ ] `P-001` Implement the planned slice\n  - Status: `todo`\n',
      'utf8',
    );
    process.stdout.write('RALPH_STATUS: pass\nRALPH_SUMMARY: Planner created run artifacts.\nRALPH_VALIDATION: not run\nRALPH_NEXT: execute P-001\n');
    return;
  }

  if (role === 'executor' || role === 'healer') {
    appendWorkFile(repoRoot);
    replaceSelectedProgressStatus(repoRoot, selectedId, 'needs-verification', false);
    process.stdout.write(`RALPH_STATUS: pass\nRALPH_SUMMARY: ${role} prepared ${selectedId} for verification.\nRALPH_VALIDATION: fake validation\nRALPH_NEXT: verifier\n`);
    return;
  }

  if (role === 'verifier') {
    replaceSelectedProgressStatus(repoRoot, selectedId, 'pass', true);
    process.stdout.write(`RALPH_STATUS: pass\nRALPH_SUMMARY: Verifier accepted ${selectedId}.\nRALPH_VALIDATION: fake validation\nRALPH_NEXT: none\n`);
    return;
  }

  appendWorkFile(repoRoot);
  process.stdout.write('RALPH_STATUS: pass\nRALPH_SUMMARY: Completed one task.\nRALPH_VALIDATION: fake validation\nRALPH_NEXT: none\n');
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
  if (mode === 'multi-role') {
    runMultiRole(repoRoot, prompt);
    return;
  }

  appendWorkFile(repoRoot);
  markFirstUncheckedPlanItem(repoRoot);
  process.stdout.write('RALPH_STATUS: pass\nRALPH_SUMMARY: Completed one task.\nRALPH_VALIDATION: fake validation\nRALPH_NEXT: none\n');
}

main();
