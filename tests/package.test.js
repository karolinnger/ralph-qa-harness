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
    .filter((line) => /^ralph-qa-harness (?:doctor|prepare --from <feature-path>|prepare --request <text> \[--constraint <value>\]|run \[--max-iterations <positive-integer>\]|status|verify)$/.test(line));
  assert.equal(commands.length, 6, 'expected exactly six ralph-qa-harness command usage lines');
  return commands;
}

function assertFourAgentPublicContract(content, label) {
  assert.match(content, /exactly four (?:agents|roles)/i, `${label} must state the exact four-agent product loop`);
  assert.match(content, /qa-orchestrator/i, `${label} must name qa-orchestrator`);
  assert.match(content, /qa-planner/i, `${label} must name qa-planner`);
  assert.match(content, /qa-executor/i, `${label} must name qa-executor`);
  assert.match(content, /qa-verifier/i, `${label} must name qa-verifier`);
  assert.match(content, /orchestrator owns|orchestrator-owned/i, `${label} must state the orchestrator-owned loop`);
  assert.match(content, /default (?:budget|iteration budget) of 40|defaults? to (?:a budget of )?40/i, `${label} must document the default run budget`);
  assert.match(content, /fresh (?:Copilot CLI |Copilot )?(?:worker )?context|fresh Copilot process/i, `${label} must document fresh worker context per iteration`);
  assert.match(content, /\.qa-harness\/.*durable|durable .*\.qa-harness\//is, `${label} must document .qa-harness durable memory`);
  assert.match(content, /Playwright CLI (?:seed evidence )?first/i, `${label} must document Playwright CLI first`);
  assert.match(content, /MCP fallback (?:is allowed |is |as )?(?:second|second-choice)/i, `${label} must document MCP fallback second`);
  assert.match(content, /Jira API integration is (?:out of scope|outside)/i, `${label} must document Jira API out of scope`);
  assert.match(content, /full (?:`?playwright test`?|Playwright execution).*before (?:coverage )?pass|full Playwright execution.*required before coverage pass/is, `${label} must document full Playwright execution before pass`);
  assert.doesNotMatch(content, /runs list-time Playwright BDD validation|does not run full browser execution|It does not run full browser execution/i, `${label} must not claim verification is list-only`);
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
    /adapter|external worker|explorer|healer|planner handoff|scenario addition|scenario-addition/i,
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
  assertFourAgentPublicContract(combinedExamples, 'examples');
  assert.doesNotMatch(pkg.files.join('\n'), /qa-runtime-demo-agent/);
});

test('static four-agent role templates ship with role-scoped responsibilities', () => {
  const packageRoot = path.resolve(__dirname, '..');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const roles = [
    {
      role: 'qa-orchestrator',
      dir: 'main-orchestrator',
      required: [/RALPH_AGENT: qa-orchestrator/, /owns the product QA loop/i, /validates intake/i, /routes exactly one role/i, /does not implement test code/i],
      forbidden: [/promote seed logic/i, /final verification proof/i],
    },
    {
      role: 'qa-planner',
      dir: 'planner',
      required: [/RALPH_AGENT: qa-planner/, /creates and refines `.qa-harness\/PRD\.md`/i, /splits work into bounded progress items/i, /does not run browser discovery/i],
      forbidden: [/seed\.spec\.ts/i, /final verification proof/i],
    },
    {
      role: 'qa-executor',
      dir: 'executor',
      required: [/RALPH_AGENT: qa-executor/, /completes exactly one selected task/i, /seed\.spec\.ts/i, /Playwright CLI first/i, /MCP fallback/i, /reason and evidence/i, /promotes proven logic/i],
      forbidden: [/owns the product QA loop/i, /final pass/i, /acceptance decision/i],
    },
    {
      role: 'qa-verifier',
      dir: 'verifier',
      required: [/RALPH_AGENT: qa-verifier/, /reviews proof/i, /bddgen export/i, /bddgen test/i, /playwright test --list/i, /full `playwright test`/i],
      forbidden: [/browser discovery/i, /promotes proven logic/i, /splits work into bounded progress items/i],
    },
  ];

  assert.ok(pkg.files.includes('templates'));

  for (const { role, dir, required, forbidden } of roles) {
    for (const fileName of ['agent.md', 'skills.md']) {
      const templatePath = path.join(packageRoot, 'templates', 'qa-agents', dir, fileName);
      assert.equal(fs.existsSync(templatePath), true, `${role} ${fileName} must exist`);
      const content = fs.readFileSync(templatePath, 'utf8');

      assert.match(content, new RegExp(role), `${role} ${fileName} must name the role`);
      for (const pattern of required) {
        assert.match(content, pattern, `${role} ${fileName} must include ${pattern}`);
      }
      for (const pattern of forbidden) {
        assert.doesNotMatch(content, pattern, `${role} ${fileName} must avoid ${pattern}`);
      }
    }
  }
});

test('package metadata, docs, and CLI help stay aligned with the lean Copilot-first product', () => {
  const packageRoot = path.resolve(__dirname, '..');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  const design = fs.readFileSync(path.join(packageRoot, 'docs', 'copilot-first-qa-ralph-harness.md'), 'utf8');
  const example = fs.readFileSync(path.join(packageRoot, 'examples', 'use-from-another-project.md'), 'utf8');
  const packagingNotes = fs.readFileSync(path.join(packageRoot, 'docs', 'packaging-notes.md'), 'utf8');
  let helpOutput = '';

  const exitCode = runCli(['--help'], {
    stdout: { write: (value) => { helpOutput += value; } },
    stderr: { write: () => {} },
  });

  const expectedCommands = [
    'ralph-qa-harness doctor',
    'ralph-qa-harness prepare --from <feature-path>',
    'ralph-qa-harness prepare --request <text> [--constraint <value>]',
    'ralph-qa-harness run [--max-iterations <positive-integer>]',
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
  assertFourAgentPublicContract(readme, 'README');
  assertFourAgentPublicContract(design, 'design doc');
  assertFourAgentPublicContract(example, 'example');
  assert.match(helpOutput, /Four-agent product loop: qa-orchestrator routes qa-planner, qa-executor, and qa-verifier/);
  assert.match(helpOutput, /Default run budget: 40 iterations/);
  assert.match(helpOutput, /fresh Copilot worker context and durable \.qa-harness\/ memory/);
  assert.match(helpOutput, /Playwright CLI first, MCP fallback second/);
  assert.match(helpOutput, /full Playwright execution before pass/);
  assert.match(helpOutput, /Jira API integration is out of scope/);
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
