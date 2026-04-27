'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli } = require('../scripts/qa-harness');

function extractCommandBlockCommands(content, marker) {
  const markerIndex = content.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected command marker: ${marker}`);
  const fencedBlock = content.slice(markerIndex).match(/```[^\r\n]*\r?\n([\s\S]*?)```/);
  assert.ok(fencedBlock, 'expected a fenced command block');
  const commands = fencedBlock[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^ralph-qa-harness (?:doctor|prepare --from <feature-path>|run --max-iterations <positive-integer>|status|verify)$/.test(line));
  assert.equal(commands.length, 5, 'expected exactly five ralph-qa-harness command lines');
  return commands;
}

test('package metadata exposes the standalone CLI package shape', () => {
  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  assert.equal(pkg.name, 'ralph-qa-harness');
  assert.equal(pkg.main, './scripts/qa-harness.js');
  assert.equal(pkg.bin['ralph-qa-harness'], './bin/ralph-qa-harness.js');
  assert.equal(fs.existsSync(path.resolve(path.dirname(packageJsonPath), pkg.bin['ralph-qa-harness'])), true);
  assert.match(pkg.scripts.test, /node --test/);
  assert.ok(pkg.files.includes('bin'));
  assert.ok(pkg.files.includes('scripts'));
  assert.ok(pkg.files.includes('templates'));
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ['@playwright/test', 'playwright-bdd']);
});

test('package no longer ships legacy runtime adapter surfaces', () => {
  const packageRoot = path.resolve(__dirname, '..');
  const harness = require('../scripts/qa-harness');
  const harnessSource = fs.readFileSync(path.join(packageRoot, 'scripts', 'qa-harness.js'), 'utf8');
  const harnessTests = fs.readFileSync(path.join(packageRoot, 'tests', 'harness', 'qa-harness.test.js'), 'utf8');
  const packagingNotes = fs.readFileSync(path.join(packageRoot, 'docs', 'packaging-notes.md'), 'utf8');

  assert.equal(fs.existsSync(path.join(packageRoot, 'scripts', 'qa-runtime-external-worker.js')), false);
  assert.equal(fs.existsSync(path.join(packageRoot, 'scripts', 'qa-runtime-mock-adapter.js')), false);
  assert.equal(Object.prototype.hasOwnProperty.call(harness, 'iterateRun'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(harness, 'advanceRun'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(harness, 'loopRun'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(harness, 'executeRun'), false);
  assert.doesNotMatch(
    harnessSource,
    /qa-runtime-(?:external-worker|mock-adapter)|Runtime adapter|runtime adapter|buildRuntimeAdapter|parseRuntimeAdapter|normalizeRuntimeAdapter|RUNTIME_ADAPTER_NAMES/,
  );
  assert.doesNotMatch(
    harnessTests,
    /qa-runtime-(?:external-worker|mock-adapter)|--adapter|\badapter:\s*['"](?:external|mock)['"]|external adapter|mock adapter|executeExternalWorker/i,
  );
  assert.doesNotMatch(packagingNotes, /qa-runtime|runtime adapter|external worker|mock adapter/i);
});

test('harness tests no longer preserve deleted command or backend behavior', () => {
  const packageRoot = path.resolve(__dirname, '..');
  const harnessTests = fs.readFileSync(path.join(packageRoot, 'tests', 'harness', 'qa-harness.test.js'), 'utf8');

  assert.doesNotMatch(harnessTests, /\btest\.skip\(/);
  assert.doesNotMatch(
    harnessTests,
    /test\('(?:parseCliArgs parses prepare-run|parseCliArgs keeps .*exploratory|clarifyPrepareRunRequest|prepareRun|planPreparedRunArtifacts|verifyRun|executeRun|runCli prepare-run|runCli verify-run|runCli create-run)/,
  );
});

test('tests stay focused on lean CLI, validation, artifact, and Copilot loop contracts', () => {
  const packageRoot = path.resolve(__dirname, '..');
  const harnessTests = fs.readFileSync(path.join(packageRoot, 'tests', 'harness', 'qa-harness.test.js'), 'utf8');
  const doctorTests = fs.readFileSync(path.join(packageRoot, 'tests', 'doctor.test.js'), 'utf8');
  const binTests = fs.readFileSync(path.join(packageRoot, 'tests', 'bin.test.js'), 'utf8');
  const targetProjectHelper = fs.readFileSync(path.join(packageRoot, 'tests', 'helpers', 'target-project.js'), 'utf8');
  const combinedTests = [harnessTests, doctorTests, binTests, targetProjectHelper].join('\n');

  assert.match(harnessTests, /createTempTargetProject/);
  assert.doesNotMatch(harnessTests, /path\.join\(repoRoot, 'Features', 'steps'/);
  assert.doesNotMatch(harnessTests, /design doc|copilot-first-qa-ralph-harness\.md/i);
  assert.doesNotMatch(combinedTests, /https?:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])/i);
  assert.doesNotMatch(combinedTests, /\b(?:fetch|XMLHttpRequest|http\.request|https\.request)\b/);
  assert.doesNotMatch(combinedTests, /\b(?:spawn|spawnSync|execFile|execFileSync)\([^)]*copilot/i);
  assert.match(doctorTests, /writeFakeCopilotCommand/);
  assert.match(harnessTests, /fake-copilot/);
  assert.match(harnessTests, /verify runs bddgen export/);
  assert.match(harnessTests, /verify CLI passes/);
  assert.match(harnessTests, /run CLI writes the complete lean run artifact set/);
  assert.match(binTests, /package bin entrypoint/);
});

test('examples show only the lean command flow', () => {
  const packageRoot = path.resolve(__dirname, '..');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const examplesDir = path.join(packageRoot, 'examples');
  const exampleFiles = fs
    .readdirSync(examplesDir)
    .filter((entry) => fs.statSync(path.join(examplesDir, entry)).isFile())
    .sort();
  const combinedExamples = exampleFiles
    .map((entry) => fs.readFileSync(path.join(examplesDir, entry), 'utf8'))
    .join('\n');

  assert.deepEqual(exampleFiles, ['use-from-another-project.md']);
  assert.equal(fs.existsSync(path.join(examplesDir, 'qa-runtime-demo-agent.js')), false);
  assert.doesNotMatch(
    combinedExamples,
    /adapter|external worker|MCP|Jira|explorer|healer|planner handoff|promotion|scenario addition|scenario-addition/i,
  );
  assert.doesNotMatch(
    combinedExamples,
    /\b(?:create-run|prepare-run|verify-run|execute-run|advance-run|iterate-run|loop-run|preflight)\b/,
  );
  assert.match(combinedExamples, /npx ralph-qa-harness doctor/);
  assert.match(combinedExamples, /npx ralph-qa-harness prepare --from Features\/homepage\.feature/);
  assert.match(combinedExamples, /npx ralph-qa-harness run --max-iterations 2/);
  assert.match(combinedExamples, /npx ralph-qa-harness status/);
  assert.match(combinedExamples, /npx ralph-qa-harness verify/);
  assert.doesNotMatch(pkg.files.join('\n'), /qa-runtime-demo-agent/);
});

test('package metadata, docs, and CLI help stay aligned with the lean Copilot-first product', () => {
  const packageRoot = path.resolve(__dirname, '..');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  const design = fs.readFileSync(path.join(packageRoot, 'docs', 'copilot-first-qa-ralph-harness.md'), 'utf8');
  const packagingNotes = fs.readFileSync(path.join(packageRoot, 'docs', 'packaging-notes.md'), 'utf8');
  let helpOutput = '';

  const exitCode = runCli(['--help'], {
    stdout: { write: (value) => { helpOutput += value; } },
    stderr: { write: () => {} },
  });

  const expectedCommands = [
    'ralph-qa-harness doctor',
    'ralph-qa-harness prepare --from <feature-path>',
    'ralph-qa-harness run --max-iterations <positive-integer>',
    'ralph-qa-harness status',
    'ralph-qa-harness verify',
  ];

  assert.equal(exitCode, 0);
  assert.match(pkg.description, /Copilot-first/i);
  assert.match(pkg.description, /Playwright BDD/i);
  assert.match(pkg.description, /lean/i);
  assert.ok(pkg.keywords.includes('copilot'));
  assert.ok(pkg.keywords.includes('copilot-first'));
  assert.ok(pkg.keywords.includes('playwright-bdd'));
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.scripts, 'qa:orchestrator'), false);
  assert.equal(fs.existsSync(path.join(packageRoot, 'scripts', 'qa-orchestrator.js')), false);
  assert.doesNotMatch(packagingNotes, /qa-orchestrator|orchestrator/i);
  assert.deepEqual(extractCommandBlockCommands(readme, 'The operator-facing command surface is intentionally small:'), expectedCommands);
  assert.deepEqual(extractCommandBlockCommands(design, 'The final CLI exposes only these commands:'), expectedCommands);
  assert.deepEqual(
    helpOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(?:npx )?ralph-qa-harness /.test(line))
      .map((line) => line.replace(/^npx /, '')),
    expectedCommands,
  );
});

test('publishable repo placeholders are present', () => {
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'README.md')), true);
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', '.gitignore')), true);
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'LICENSE')), true);
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', '.env.example')), true);
});
