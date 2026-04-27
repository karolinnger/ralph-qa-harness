'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.QA_HARNESS_COMMAND_PREFIX = 'npx ralph-qa-harness';

const {
  QA_AGENT_ROLES,
  createRunId,
  findGeneratedSpecsForRun,
  findNextActionableProgressItem,
  getTemplatePlaceholders,
  parseProgressItems,
  prepare,
  run,
  resolveQaAgentTemplatePaths,
  resolveHarnessPaths,
  resolveProjectCliInvocation,
  runCli,
  selectQaOrchestratorRoute,
  verify,
} = require('../../scripts/qa-harness');
const { createTempTargetProject } = require('../helpers/target-project');

const realTemplatesDir = path.resolve(__dirname, '../../templates/qa-run');

function createTempRepo(t) {
  return createTempTargetProject(t);
}

function writeFeature(repoRoot, relativePath, content) {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

function writeGeneratedSpec(repoRoot, runId) {
  const generatedSpecPath = path.join(
    repoRoot,
    '.features-gen',
    '.qa-harness',
    'runs',
    runId,
    'normalized.feature.spec.js',
  );
  fs.mkdirSync(path.dirname(generatedSpecPath), { recursive: true });
  fs.writeFileSync(generatedSpecPath, '// generated spec\n', 'utf8');
  return generatedSpecPath;
}

function writeCoverageVerificationState(repoRoot, runId, options = {}) {
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId: runId,
      activeRunId: null,
      terminalStatus: null,
      intake: {
        kind: 'coverage-request',
        target: { type: 'url', value: 'http://localhost:3000' },
        sourceContext: { type: 'requirements', value: 'REQ-123' },
      },
    }, null, 2)}\n`,
  );
  writeTextFile(
    harnessPaths.prdPath,
    [
      '# QA Harness PRD',
      '',
      '## Accepted Coverage Request',
      '',
      'Status: accepted',
      'Target: url: http://localhost:3000',
      'Source context: requirements: REQ-123',
      '',
    ].join('\n'),
  );
  writeTextFile(
    harnessPaths.progressPath,
    [
      '# QA Harness Progress',
      '',
      '## Active Items',
      '',
      '- [ ] `VERIFY-001` Goal: verify one completed coverage item.',
      '  - Input: `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and run proof artifacts',
      '  - Output: verifier acceptance for complete coverage proof',
      '  - Verify: `ralph-qa-harness verify` with seed proof and full Playwright execution',
      '  - Owner: `qa-verifier`',
      '  - Agent: `qa-verifier`',
      '  - Mode: `verification`',
      '  - Status: `needs-verification`',
      '  - Retry budget: `1`',
      '  - Result: ``',
      `  - Evidence: \`${options.evidence || ''}\``,
      `  - Fallback reason: \`${options.fallbackReason || ''}\``,
      '',
    ].join('\n'),
  );
  return { harnessPaths, runPaths: resolveHarnessPaths(repoRoot, { runId }) };
}

function writeCoverageSeedSpec(repoRoot, runId) {
  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  writeTextFile(
    runPaths.seedSpecPath,
    [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('coverage seed proof', async ({ page }) => {",
      "  await page.goto('http://localhost:3000');",
      "  await expect(page.locator('body')).toBeVisible();",
      '});',
      '',
    ].join('\n'),
  );
  return runPaths.seedSpecPath;
}

function writeCoverageSeedEvidence(repoRoot, runId, overrides = {}) {
  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  const evidenceDir = path.join(runPaths.iterationsDir, '001', 'evidence');
  const seedDisplayPath = `.qa-harness/runs/${runId}/seed.spec.ts`;
  const record = {
    type: 'playwright-cli-seed',
    RALPH_AGENT: 'qa-executor',
    runId,
    iteration: 1,
    seedSpecPath: seedDisplayPath,
    command: 'npx.cmd',
    args: ['playwright', 'test', seedDisplayPath],
    commandDisplay: `npx.cmd playwright test ${seedDisplayPath}`,
    exitCode: 0,
    stdout: '1 passed (0.1s)\n',
    stderr: '',
    startedAt: '2026-04-27T10:00:00.000Z',
    finishedAt: '2026-04-27T10:00:01.000Z',
    durationMs: 1000,
    ...overrides,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  writeTextFile(
    path.join(evidenceDir, 'playwright-cli-seed.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

function createCoverageVerifyCommandRunner(runId, options = {}) {
  const calls = [];
  const runner = (command, args, cwd, commandOptions) => {
    calls.push({ command, args, cwd, commandOptions });

    if (args[0] === 'bddgen' && args[1] === 'export') {
      return options.exportResult || { status: 0, stdout: 'List of all steps (4)\n', stderr: '' };
    }

    if (args[0] === 'bddgen' && args[1] === 'test') {
      if (options.writeGeneratedSpecOnTest !== false) {
        writeGeneratedSpec(cwd, runId);
      }
      return options.testResult || { status: 0, stdout: 'generated specs\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
      return options.listResult || { status: 0, stdout: 'Total: 1 test\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test') {
      return options.executeResult || { status: 0, stdout: '1 passed (0.1s)\n', stderr: '' };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  return { calls, runner };
}

function installStubProjectCli(repoRoot) {
  writeTextFile(
    path.join(repoRoot, 'node_modules', 'playwright-bdd', 'dist', 'cli', 'index.js'),
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const command = process.argv[2] || '';",
      "const runRoot = path.join(process.cwd(), '.qa-harness', 'runs');",
      "const runIds = fs.existsSync(runRoot)",
      "  ? fs.readdirSync(runRoot).filter((entry) => fs.statSync(path.join(runRoot, entry)).isDirectory()).sort()",
      "  : [];",
      "const runId = runIds[0] || 'stub-run';",
      "if (command === 'export') {",
      "  const status = Number(process.env.QA_HARNESS_STUB_BDDGEN_EXPORT_STATUS || '0');",
      "  if (process.env.QA_HARNESS_STUB_BDDGEN_EXPORT_STDERR) {",
      "    process.stderr.write(process.env.QA_HARNESS_STUB_BDDGEN_EXPORT_STDERR);",
      "  }",
      "  process.stdout.write(process.env.QA_HARNESS_STUB_BDDGEN_EXPORT_STDOUT || 'List of all steps (9)\\n');",
      "  process.exit(status);",
      "}",
      "if (command === 'test') {",
      "  const status = Number(process.env.QA_HARNESS_STUB_BDDGEN_TEST_STATUS || '0');",
      "  const specPath = path.join(process.cwd(), '.features-gen', '.qa-harness', 'runs', runId, 'normalized.feature.spec.js');",
      "  fs.mkdirSync(path.dirname(specPath), { recursive: true });",
      "  fs.writeFileSync(specPath, '// generated spec\\n', 'utf8');",
      "  if (process.env.QA_HARNESS_STUB_BDDGEN_TEST_STDERR) {",
      "    process.stderr.write(process.env.QA_HARNESS_STUB_BDDGEN_TEST_STDERR);",
      "  }",
      "  process.stdout.write(process.env.QA_HARNESS_STUB_BDDGEN_TEST_STDOUT || 'generated\\n');",
      "  process.exit(status);",
      "}",
      "process.stderr.write(`Unsupported bddgen stub command ${command}\\n`);",
      "process.exit(1);",
      '',
    ].join('\n'),
  );
  writeTextFile(
    path.join(repoRoot, 'node_modules', 'playwright', 'cli.js'),
    [
      "'use strict';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'test' && args[1] === '--list') {",
      "  const status = Number(process.env.QA_HARNESS_STUB_PLAYWRIGHT_LIST_STATUS || '0');",
      "  if (process.env.QA_HARNESS_STUB_PLAYWRIGHT_LIST_STDERR) {",
      "    process.stderr.write(process.env.QA_HARNESS_STUB_PLAYWRIGHT_LIST_STDERR);",
      "  }",
      "  process.stdout.write(process.env.QA_HARNESS_STUB_PLAYWRIGHT_LIST_STDOUT || 'Total: 1 test\\n');",
      "  process.exit(status);",
      "}",
      "if (args[0] === 'test') {",
      "  const status = Number(process.env.QA_HARNESS_STUB_PLAYWRIGHT_EXEC_STATUS || '0');",
      "  if (process.env.QA_HARNESS_STUB_PLAYWRIGHT_EXEC_STDERR) {",
      "    process.stderr.write(process.env.QA_HARNESS_STUB_PLAYWRIGHT_EXEC_STDERR);",
      "  }",
      "  process.stdout.write(",
      "    process.env.QA_HARNESS_STUB_PLAYWRIGHT_EXEC_STDOUT || (status === 0 ? '1 passed (0.1s)\\n' : '1 failed\\n'),",
      "  );",
      "  process.exit(status);",
      "}",
      "process.stderr.write(`Unsupported playwright stub args ${args.join(' ')}\\n`);",
      "process.exit(1);",
      '',
    ].join('\n'),
  );
}

function createMockCommandRunner(options = {}) {
  const calls = [];
  const runner = (command, args, cwd, commandOptions) => {
    calls.push({ command, args, cwd, commandOptions });

    if (args[0] === 'bddgen' && args[1] === 'export') {
      return options.exportResult || { status: 0, stdout: 'List of all steps (9)\n', stderr: '' };
    }

    if (args[0] === 'bddgen' && args[1] === 'test') {
      return options.generateResult || { status: 0, stdout: 'generated\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test' && args.includes('--list')) {
      return options.listResult || { status: 0, stdout: 'Total: 1 test\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test') {
      return options.executeResult || { status: 0, stdout: '\u001b[1A\u001b[2K  1 passed (1.2s)\n', stderr: '' };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  return { calls, runner };
}

function runVerifyCliWithInjectedRunner(t, options = {}) {
  const repoRoot = createTempRepo(t);
  const runId = options.runId || '20260427T071800Z-cli-verify';
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId: runId,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );

  const calls = [];
  const commandRunner = (command, args, cwd, commandOptions) => {
    calls.push({ command, args, cwd, commandOptions });

    if (args[0] === 'bddgen' && args[1] === 'export') {
      return options.exportResult || { status: 0, stdout: 'List of all steps (6)\n', stderr: '' };
    }

    if (args[0] === 'bddgen' && args[1] === 'test') {
      if (options.writeGeneratedSpecOnTest !== false) {
        writeGeneratedSpec(cwd, runId);
      }
      return options.testResult || { status: 0, stdout: 'generated specs\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
      return options.listResult || { status: 0, stdout: 'Total: 2 tests\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test') {
      return options.executeResult || { status: 0, stdout: '2 passed (0.2s)\n', stderr: '' };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  let stdout = '';
  let stderr = '';
  const exitCode = runCli(['verify'], {
    repoRoot,
    commandRunner,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    verifyFn: (verifyOptions) => {
      assert.equal(verifyOptions.commandRunner, commandRunner);
      return verify(verifyOptions);
    },
  });

  return { repoRoot, runId, calls, stdout, stderr, exitCode };
}

function createPreparedLeanRun(t, options = {}) {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/x.feature', [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n'));
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  prepare({
    repoRoot,
    from: 'Features/x.feature',
    platform: 'linux',
    now: options.prepareNow || new Date('2026-04-27T08:08:00.000Z'),
  });

  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      copilot: {
        command: 'fake-copilot',
      },
    }, null, 2)}\n`,
  );

  if (options.progressContent) {
    writeTextFile(harnessPaths.progressPath, options.progressContent);
  }

  return { repoRoot, harnessPaths };
}

function buildLeanProgressDocument(items) {
  return [
    '# Test Progress',
    '',
    '## Active Items',
    '',
    ...items.flatMap((item) => {
      const status = item.status || 'todo';
      const checkbox = item.checkbox || (status === 'pass' ? 'x' : ' ');
      const lines = [
        `- [${checkbox}] \`${item.id}\` Goal: ${item.goal}`,
        '  - Input: `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`',
        `  - Output: ${item.output || '`iteration evidence`'}`,
        '  - Verify: `ralph-qa-harness verify`',
      ];

      if (item.owner !== null) {
        lines.push(`  - Owner: \`${item.owner || 'qa-executor'}\``);
      }

      lines.push(
        `  - Agent: \`${item.agent || item.owner || 'qa-executor'}\``,
        `  - Mode: \`${item.mode || 'implementation'}\``,
        `  - Status: \`${status}\``,
        `  - Retry budget: \`${item.retryBudget || '1'}\``,
        `  - Result: \`${item.result || ''}\``,
        `  - Evidence: \`${item.evidence || ''}\``,
        '',
      );

      return lines;
    }),
  ].join('\n');
}

function createLeanRunCommandRunner(options = {}) {
  const calls = [];
  const runner = (command, args, cwd, commandOptions) => {
    calls.push({ command, args, cwd, commandOptions });

    if (command === 'fake-copilot' && args.length === 0) {
      if (typeof options.onWorkerCall === 'function') {
        options.onWorkerCall({ command, args, cwd, commandOptions, callNumber: calls.length });
      }
      return typeof options.workerResult === 'function' ? options.workerResult(calls.length) : options.workerResult || {
        status: 0,
        stdout: [
          'fake Copilot worker output',
          'RALPH_STATUS: pass',
          'RALPH_SUMMARY: worker completed selected item',
          'RALPH_VALIDATION: worker deferred to supervisor verify',
          'RALPH_NEXT: none',
          '',
        ].join('\n'),
        stderr: '',
      };
    }

    if (args[0] === 'bddgen' && args[1] === 'export') {
      return options.exportResult || { status: 0, stdout: 'List of all steps (6)\n', stderr: '' };
    }

    if (args[0] === 'bddgen' && args[1] === 'test') {
      if (options.writeGeneratedSpecOnTest !== false) {
        const harnessPaths = resolveHarnessPaths(cwd);
        const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
        writeGeneratedSpec(cwd, state.activeRunId || state.latestRunId);
      }
      return options.testResult || { status: 0, stdout: 'generated specs\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
      return options.listResult || { status: 0, stdout: 'Total: 1 test\n', stderr: '' };
    }

    if (args[0] === 'playwright' && args[1] === 'test') {
      if (/[/\\]seed\.spec\.ts$/i.test(args[2] || '')) {
        return options.seedExecuteResult
          || options.executeResult
          || { status: 0, stdout: '1 passed (0.1s)\n', stderr: '' };
      }

      return options.fullExecutionResult || { status: 0, stdout: '1 passed (0.1s)\n', stderr: '' };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  return { calls, runner };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('createRunId uses UTC timestamp and slugified feature name', () => {
  const runId = createRunId(new Date('2026-04-09T12:34:56.000Z'), 'plan', 'Features/Home Page.feature');
  assert.equal(runId, '20260409T123456Z-plan-home-page');
});

test('shipped templates describe only lean Copilot artifacts and footer contract', () => {
  const templateNames = ['PRD.md', 'progress.md', 'PROMPT.md', 'normalized.feature'];
  const templateEntries = templateNames.map((templateName) => [
    templateName,
    fs.readFileSync(path.join(realTemplatesDir, templateName), 'utf8'),
  ]);
  const templates = Object.fromEntries(templateEntries);
  const combinedTemplates = templateEntries.map(([, content]) => content).join('\n');
  const allowedArtifactRefs = [
    '.qa-harness/PRD.md',
    '.qa-harness/progress.md',
    '.qa-harness/PROMPT.md',
    '.qa-harness/normalized.feature',
  ];

  for (const artifactRef of allowedArtifactRefs) {
    assert.match(combinedTemplates, new RegExp(escapeRegExp(artifactRef)));
  }

  for (const [templateName, templateContent] of templateEntries) {
    const contentWithoutAllowedArtifacts = allowedArtifactRefs.reduce(
      (content, artifactRef) => content.replaceAll(artifactRef, ''),
      templateContent,
    );

    assert.doesNotMatch(
      contentWithoutAllowedArtifacts,
      /\b(?:PRD\.md|progress\.md|PROMPT\.md|normalized\.feature)\b/,
      `${templateName} must use only .qa-harness artifact paths`,
    );
  }

  for (const forbiddenPattern of [
    /\bJira\b/i,
    /\bMCP\b/i,
    /runtime adapter/i,
    /\bqa-(?:verifier|executor|explorer|healer|agent|template)\b/i,
    /\b(?:verify-run|execute-run|advance-run|iterate-run|prepare-run|loop-run|create-run|preflight)\b/i,
    /\b(?:logs|outputs)\//i,
    /planner handoff|promotion|scenario addition|scenario-addition/i,
  ]) {
    assert.doesNotMatch(combinedTemplates, forbiddenPattern);
  }

  assert.match(templates['PROMPT.md'], /RALPH_STATUS: pass\|blocked\|fail/);
  assert.match(templates['PROMPT.md'], /RALPH_SUMMARY: <one concise paragraph>/);
  assert.match(templates['PROMPT.md'], /RALPH_VALIDATION: <commands run, or why not run>/);
  assert.match(templates['PROMPT.md'], /RALPH_NEXT: <next recommended action, or none>/);
});

test('resolveHarnessPaths defines lean artifacts under the target project .qa-harness directory', () => {
  const repoRoot = path.resolve('C:/target-project-under-test');
  const packageRoot = path.resolve(__dirname, '..', '..');
  const paths = resolveHarnessPaths(repoRoot, { runId: '20260409T123456Z-run' });

  assert.equal(paths.harnessDir, path.join(repoRoot, '.qa-harness'));
  assert.equal(paths.configPath, path.join(paths.harnessDir, 'config.json'));
  assert.equal(paths.prdPath, path.join(paths.harnessDir, 'PRD.md'));
  assert.equal(paths.progressPath, path.join(paths.harnessDir, 'progress.md'));
  assert.equal(paths.promptPath, path.join(paths.harnessDir, 'PROMPT.md'));
  assert.equal(paths.normalizedFeaturePath, path.join(paths.harnessDir, 'normalized.feature'));
  assert.equal(paths.statePath, path.join(paths.harnessDir, 'state.json'));
  assert.equal(paths.runsDir, path.join(paths.harnessDir, 'runs'));
  assert.equal(paths.runDir, path.join(paths.runsDir, '20260409T123456Z-run'));
  assert.equal(paths.seedSpecPath, path.join(paths.runDir, 'seed.spec.ts'));
  assert.equal(paths.playwrightConfigPath, path.join(paths.runDir, 'playwright.config.ts'));
  assert.equal(paths.agentsDir, path.join(paths.runDir, 'agents'));
  assert.equal(paths.resolvedPromptsDir, path.join(paths.agentsDir, 'resolved-prompts'));

  for (const expectedPath of [
    paths.configPath,
    paths.prdPath,
    paths.progressPath,
    paths.promptPath,
    paths.normalizedFeaturePath,
    paths.statePath,
    paths.runsDir,
    paths.runDir,
    paths.seedSpecPath,
    paths.playwrightConfigPath,
    paths.agentsDir,
    paths.resolvedPromptsDir,
  ]) {
    assert.equal(expectedPath.startsWith(paths.harnessDir), true);
    assert.equal(expectedPath.startsWith(packageRoot), false);
  }

  for (const expectedPath of [paths.seedSpecPath, paths.playwrightConfigPath, paths.agentsDir, paths.resolvedPromptsDir]) {
    assert.equal(path.relative(paths.runDir, expectedPath).startsWith('..'), false);
    assert.equal(path.relative(paths.runsDir, expectedPath).startsWith('..'), false);
  }
});

test('findGeneratedSpecsForRun reads only generated Playwright BDD specs under .features-gen/.qa-harness', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260409T123456Z-run';
  const generatedHarnessSpec = path.join(
    repoRoot,
    '.features-gen',
    '.qa-harness',
    'runs',
    runId,
    'normalized.feature.spec.js',
  );
  const generatedOtherSpec = path.join(
    repoRoot,
    '.features-gen',
    'other-output',
    runId,
    'stray.spec.js',
  );
  const durableStateSpec = path.join(
    repoRoot,
    '.qa-harness',
    'runs',
    runId,
    'summary.spec.js',
  );

  writeTextFile(generatedHarnessSpec, '// generated harness spec\n');
  writeTextFile(generatedOtherSpec, '// generated elsewhere\n');
  writeTextFile(durableStateSpec, '// durable state, not generated output\n');

  assert.deepEqual(findGeneratedSpecsForRun(repoRoot, runId), [generatedHarnessSpec]);
});

test('resolveHarnessPaths rejects run ids that would escape the harness runs directory', () => {
  const repoRoot = path.resolve('C:/target-project-under-test');

  for (const runId of ['../outside', '..\\outside', '/absolute-run', 'nested/run']) {
    assert.throws(
      () => resolveHarnessPaths(repoRoot, { runId }),
      /Run id must be a single path segment under \.qa-harness\/runs\./,
    );
  }
});

test('resolveQaAgentTemplatePaths defines exact four-agent role template paths', () => {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const expectedRoles = [
    'qa-orchestrator',
    'qa-planner',
    'qa-executor',
    'qa-verifier',
  ];
  const expectedTemplateDirs = new Map([
    ['qa-orchestrator', 'main-orchestrator'],
    ['qa-planner', 'planner'],
    ['qa-executor', 'executor'],
    ['qa-verifier', 'verifier'],
  ]);

  assert.deepEqual(QA_AGENT_ROLES, expectedRoles);

  for (const role of expectedRoles) {
    const paths = resolveQaAgentTemplatePaths(role);
    const expectedTemplateDir = path.join(
      packageRoot,
      'templates',
      'qa-agents',
      expectedTemplateDirs.get(role),
    );

    assert.equal(paths.role, role);
    assert.equal(paths.templateDir, expectedTemplateDir);
    assert.equal(paths.agentPath, path.join(expectedTemplateDir, 'agent.md'));
    assert.equal(paths.skillsPath, path.join(expectedTemplateDir, 'skills.md'));
  }

  assert.throws(
    () => resolveQaAgentTemplatePaths('qa-explorer'),
    /Invalid QA agent role "qa-explorer"\. Valid roles: qa-orchestrator, qa-planner, qa-executor, qa-verifier\./,
  );
});

test('selectQaOrchestratorRoute routes missing planning artifacts to qa-planner', (t) => {
  const repoRoot = createTempRepo(t);
  const harnessPaths = resolveHarnessPaths(repoRoot);

  const route = selectQaOrchestratorRoute(harnessPaths);

  assert.equal(route.role, 'qa-planner');
  assert.equal(route.mode, 'planning');
  assert.equal(route.stopReason, null);
  assert.equal(route.item.id, 'PLAN-ARTIFACTS');
  assert.equal(route.item.owner, 'qa-planner');
  assert.match(route.reason, /Missing planning artifacts/);
  assert.deepEqual(route.missingArtifacts, [
    '.qa-harness/PRD.md',
    '.qa-harness/progress.md',
    '.qa-harness/PROMPT.md',
  ]);
});

test('selectQaOrchestratorRoute routes four-agent lifecycle states', (t) => {
  const cases = [
    {
      name: 'todo implementation item',
      progressItems: [
        {
          id: 'P-EXECUTE',
          goal: 'execute one coverage task.',
          owner: 'qa-executor',
          agent: 'qa-executor',
          mode: 'implementation',
          status: 'todo',
          retryBudget: '1',
        },
      ],
      expectedRole: 'qa-executor',
      expectedMode: 'implementation',
      expectedItemId: 'P-EXECUTE',
    },
    {
      name: 'needs-verification item',
      progressItems: [
        {
          id: 'P-VERIFY',
          goal: 'review executor evidence.',
          owner: 'qa-executor',
          agent: 'qa-executor',
          mode: 'implementation',
          status: 'needs-verification',
          retryBudget: '1',
        },
      ],
      expectedRole: 'qa-verifier',
      expectedMode: 'verification',
      expectedItemId: 'P-VERIFY',
    },
    {
      name: 'verifier fail with retry budget',
      progressItems: [
        {
          id: 'P-HEAL',
          goal: 'heal failed verification.',
          owner: 'qa-verifier',
          agent: 'qa-verifier',
          mode: 'verification',
          status: 'fail',
          retryBudget: '1',
        },
      ],
      expectedRole: 'qa-executor',
      expectedMode: 'healing',
      expectedItemId: 'P-HEAL',
    },
    {
      name: 'blocked item',
      progressItems: [
        {
          id: 'P-BLOCKED',
          goal: 'wait for operator input.',
          owner: 'qa-orchestrator',
          agent: 'qa-orchestrator',
          mode: 'intake',
          status: 'blocked',
          retryBudget: '0',
        },
      ],
      expectedRole: 'qa-orchestrator',
      expectedMode: 'routing',
      expectedItemId: 'P-BLOCKED',
      expectedStatus: 'blocked',
      expectedStopReason: 'blocked',
    },
    {
      name: 'all pass',
      progressItems: [
        {
          id: 'P-PASS',
          goal: 'accepted by verifier.',
          owner: 'qa-verifier',
          agent: 'qa-verifier',
          mode: 'verification',
          status: 'pass',
          retryBudget: '0',
          checkbox: 'x',
        },
      ],
      expectedRole: 'qa-orchestrator',
      expectedMode: 'routing',
      expectedStatus: 'completed',
      expectedStopReason: 'all-progress-passed',
    },
  ];

  for (const testCase of cases) {
    const repoRoot = createTempRepo(t);
    const harnessPaths = resolveHarnessPaths(repoRoot);
    writeTextFile(harnessPaths.prdPath, '# Test PRD\n');
    writeTextFile(harnessPaths.promptPath, '# Test Prompt\n');
    writeTextFile(
      harnessPaths.progressPath,
      buildLeanProgressDocument(testCase.progressItems),
    );

    const route = selectQaOrchestratorRoute(harnessPaths);

    assert.equal(route.role, testCase.expectedRole, testCase.name);
    assert.equal(route.mode, testCase.expectedMode, testCase.name);
    assert.equal(route.status, testCase.expectedStatus || 'run', testCase.name);
    assert.equal(route.stopReason, testCase.expectedStopReason || null, testCase.name);
    if (testCase.expectedItemId) {
      assert.equal(route.item.id, testCase.expectedItemId, testCase.name);
    }
  }
});

test('selectQaOrchestratorRoute reroutes incomplete planner-authored progress to qa-planner', (t) => {
  const repoRoot = createTempRepo(t);
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(harnessPaths.prdPath, '# Test PRD\n');
  writeTextFile(harnessPaths.promptPath, '# Test Prompt\n');
  writeTextFile(
    harnessPaths.progressPath,
    [
      '# Test Progress',
      '',
      '## Active Items',
      '',
      '- [ ] `COVER-001` Goal: cover the public billing flow.',
      '  - Input: `.qa-harness/PRD.md`',
      '  - Output: `iteration evidence`',
      '  - Owner: `qa-executor`',
      '  - Agent: `qa-executor`',
      '  - Mode: `implementation`',
      '  - Status: `todo`',
      '  - Retry budget: `1`',
      '  - Result: ``',
      '',
    ].join('\n'),
  );

  const route = selectQaOrchestratorRoute(harnessPaths);

  assert.equal(route.role, 'qa-planner');
  assert.equal(route.mode, 'planning');
  assert.equal(route.item.id, 'PLAN-PROGRESS-CONTRACT');
  assert.match(route.reason, /COVER-001/);
  assert.match(route.reason, /Verify/);
  assert.match(route.reason, /Evidence/);
});

test('selectQaOrchestratorRoute fails unknown progress lifecycle statuses', (t) => {
  const repoRoot = createTempRepo(t);
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(harnessPaths.prdPath, '# Test PRD\n');
  writeTextFile(harnessPaths.promptPath, '# Test Prompt\n');
  writeTextFile(
    harnessPaths.progressPath,
    buildLeanProgressDocument([
      {
        id: 'P-WAITING',
        goal: 'wait using an unsupported lifecycle status.',
        owner: 'qa-executor',
        agent: 'qa-executor',
        mode: 'implementation',
        status: 'waiting',
        retryBudget: '1',
      },
    ]),
  );

  const route = selectQaOrchestratorRoute(harnessPaths);

  assert.equal(route.status, 'failed');
  assert.equal(route.stopReason, 'invalid-progress-status');
  assert.equal(route.role, 'qa-orchestrator');
  assert.equal(route.mode, 'routing');
  assert.equal(route.item.id, 'P-WAITING');
  assert.match(route.reason, /Unsupported progress status "waiting"/);
});

test('resolveProjectCliInvocation maps bddgen npx invocations onto the local Node CLI entrypoint', (t) => {
  const repoRoot = createTempRepo(t);
  writeTextFile(path.join(repoRoot, 'node_modules', 'playwright-bdd', 'dist', 'cli', 'index.js'), '// stub\n');
  const invocation = resolveProjectCliInvocation('npx.cmd', ['bddgen', 'export'], repoRoot);

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    path.join(repoRoot, 'node_modules', 'playwright-bdd', 'dist', 'cli', 'index.js'),
    'export',
  ]);
});

test('resolveProjectCliInvocation maps playwright npx invocations onto the local Node CLI entrypoint', (t) => {
  const repoRoot = createTempRepo(t);
  writeTextFile(path.join(repoRoot, 'node_modules', 'playwright', 'cli.js'), '// stub\n');
  const invocation = resolveProjectCliInvocation('npx.cmd', ['playwright', 'test', '--list'], repoRoot);

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    path.join(repoRoot, 'node_modules', 'playwright', 'cli.js'),
    'test',
    '--list',
  ]);
});

test('resolveProjectCliInvocation leaves non-npx commands unchanged', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  const invocation = resolveProjectCliInvocation('node', ['scripts/demo.js'], repoRoot);

  assert.equal(invocation.command, 'node');
  assert.deepEqual(invocation.args, ['scripts/demo.js']);
});

test('runCli help lists exactly the lean operator commands', (t) => {
  const originalPrefix = process.env.QA_HARNESS_COMMAND_PREFIX;
  const expectedPrefix = 'npx ralph-qa-harness';
  let stdout = '';
  let stderr = '';

  process.env.QA_HARNESS_COMMAND_PREFIX = expectedPrefix;
  t.after(() => {
    if (originalPrefix == null) {
      delete process.env.QA_HARNESS_COMMAND_PREFIX;
      return;
    }

    process.env.QA_HARNESS_COMMAND_PREFIX = originalPrefix;
  });

  const exitCode = runCli(['--help'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  const commandLines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('  '));

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.deepEqual(commandLines, [
    `  ${expectedPrefix} doctor`,
    `  ${expectedPrefix} prepare --from <feature-path>`,
    `  ${expectedPrefix} prepare --request <text> [--constraint <value>]`,
    `  ${expectedPrefix} run [--max-iterations <positive-integer>]`,
    `  ${expectedPrefix} status`,
    `  ${expectedPrefix} verify`,
  ]);
  assert.ok(commandLines.every((line) => line.startsWith(`  ${expectedPrefix} `)));
  assert.doesNotMatch(stdout, /npm run qa:orchestrator/);
  assert.doesNotMatch(
    stdout,
    /create-run|prepare-run|verify-run|execute-run|advance-run|iterate-run|loop-run|preflight/,
  );
});

test('runCli help uses a configured command prefix consistently', (t) => {
  const originalPrefix = process.env.QA_HARNESS_COMMAND_PREFIX;
  const configuredPrefix = 'custom qa-harness';
  let stdout = '';
  let stderr = '';

  process.env.QA_HARNESS_COMMAND_PREFIX = configuredPrefix;
  t.after(() => {
    if (originalPrefix == null) {
      delete process.env.QA_HARNESS_COMMAND_PREFIX;
      return;
    }

    process.env.QA_HARNESS_COMMAND_PREFIX = originalPrefix;
  });

  const exitCode = runCli(['--help'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  const commandLines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('  '));

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.deepEqual(commandLines, [
    `  ${configuredPrefix} doctor`,
    `  ${configuredPrefix} prepare --from <feature-path>`,
    `  ${configuredPrefix} prepare --request <text> [--constraint <value>]`,
    `  ${configuredPrefix} run [--max-iterations <positive-integer>]`,
    `  ${configuredPrefix} status`,
    `  ${configuredPrefix} verify`,
  ]);
  assert.doesNotMatch(stdout, /npx ralph-qa-harness|npm run qa:orchestrator/);
});

test('runCli dispatches only doctor, prepare, run, status, and verify handlers with lean parsing', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';
  const calls = [];
  const commonOptions = {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    doctorFn: (options) => {
      calls.push({ command: 'doctor', options });
      return {
        repoRoot: options.repoRoot,
        checks: [],
        failureCount: 0,
        warningCount: 0,
        status: 'pass',
      };
    },
    prepareFn: (options) => {
      calls.push({ command: 'prepare', options });
      return { output: 'prepared\n' };
    },
    runFn: (options) => {
      calls.push({ command: 'run', options });
      return { output: 'ran\n' };
    },
    statusFn: (options) => {
      calls.push({ command: 'status', options });
      return { output: 'status ok\n' };
    },
    verifyFn: (options) => {
      calls.push({ command: 'verify', options });
      return { output: 'verified\n' };
    },
  };

  const exitCodes = [
    runCli(['doctor'], commonOptions),
    runCli(['prepare', '--from', 'Features/homepage.feature'], commonOptions),
    runCli(['run'], commonOptions),
    runCli(['run', '--max-iterations', '3'], commonOptions),
    runCli(['status'], commonOptions),
    runCli(['verify'], commonOptions),
  ];

  assert.deepEqual(exitCodes, [0, 0, 0, 0, 0, 0]);
  assert.equal(stderr, '');
  assert.match(stdout, /Doctor passed/);
  assert.match(stdout, /prepared/);
  assert.match(stdout, /ran/);
  assert.match(stdout, /status ok/);
  assert.match(stdout, /verified/);
  assert.deepEqual(calls.map((call) => call.command), ['doctor', 'prepare', 'run', 'run', 'status', 'verify']);
  assert.ok(calls.every((call) => call.options.repoRoot === repoRoot));
  assert.ok(calls.slice(1).every((call) => call.options.harnessPaths.repoRoot === repoRoot));
  assert.ok(calls.slice(1).every((call) => call.options.harnessPaths.harnessDir === path.join(repoRoot, '.qa-harness')));
  assert.ok(calls.slice(1).every((call) => call.options.harnessPaths.normalizedFeaturePath === path.join(repoRoot, '.qa-harness', 'normalized.feature')));
  assert.equal(calls[1].options.from, 'Features/homepage.feature');
  assert.equal(calls[2].options.maxIterations, 40);
  assert.equal(calls[3].options.maxIterations, 3);
  assert.deepEqual(Object.keys(calls[4].options).sort(), ['harnessPaths', 'repoRoot']);
  assert.deepEqual(Object.keys(calls[5].options).sort(), ['harnessPaths', 'repoRoot']);
});

test('runCli parses prepare --request coverage intake with target URL, Jira context, acceptance criteria, and constraints', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  const requestText = [
    'Target URL: http://localhost:3000/billing',
    'Jira: http://localhost:8080/browse/QA-123',
    'Requirements: Cover the public billing status page for anonymous visitors.',
    'Acceptance criteria:',
    '- visitor sees the current invoice summary',
    '- visitor can open invoice details',
  ].join('\n');
  let capturedOptions;
  let stdout = '';
  let stderr = '';

  const exitCode = runCli([
    'prepare',
    '--request',
    requestText,
    '--constraint',
    'Use desktop Chrome',
    '--constraint',
    'Do not mutate billing records',
  ], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    prepareFn: (options) => {
      capturedOptions = options;
      return { output: 'prepared request\n' };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /prepared request/);
  assert.equal(capturedOptions.from, undefined);
  assert.equal(capturedOptions.request.kind, 'coverage-request');
  assert.deepEqual(capturedOptions.request.target, {
    type: 'url',
    value: 'http://localhost:3000/billing',
  });
  assert.deepEqual(capturedOptions.request.sourceContext, {
    type: 'jira',
    value: 'http://localhost:8080/browse/QA-123',
  });
  assert.match(capturedOptions.request.requirements, /public billing status page/);
  assert.deepEqual(capturedOptions.request.acceptanceCriteria, [
    'visitor sees the current invoice summary',
    'visitor can open invoice details',
  ]);
  assert.deepEqual(capturedOptions.request.constraints, [
    'Use desktop Chrome',
    'Do not mutate billing records',
  ]);
});

test('runCli parses prepare --request coverage intake with app scope and pasted requirements', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  const requestText = [
    'App scope: Admin teammate invitations',
    'Requirements:',
    'As an admin, I can invite a teammate and see the pending invite.',
    'Acceptance criteria:',
    '1. Admin submits a valid teammate email',
    '2. Pending invite appears in the invitations table',
  ].join('\n');
  let capturedOptions;
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['prepare', '--request', requestText], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    prepareFn: (options) => {
      capturedOptions = options;
      return { output: 'prepared request\n' };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /prepared request/);
  assert.equal(capturedOptions.request.kind, 'coverage-request');
  assert.deepEqual(capturedOptions.request.target, {
    type: 'app-scope',
    value: 'Admin teammate invitations',
  });
  assert.deepEqual(capturedOptions.request.sourceContext, {
    type: 'requirements',
    value: 'As an admin, I can invite a teammate and see the pending invite.',
  });
  assert.equal(capturedOptions.request.requirements, 'As an admin, I can invite a teammate and see the pending invite.');
  assert.deepEqual(capturedOptions.request.acceptanceCriteria, [
    'Admin submits a valid teammate email',
    'Pending invite appears in the invitations table',
  ]);
  assert.deepEqual(capturedOptions.request.constraints, []);
});

test('prepare --request records blocked intake state for incomplete coverage requests', (t) => {
  const repoRoot = createTempRepo(t);
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });
  const requestText = 'Target URL: http://localhost:3000/billing';
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['prepare', '--request', requestText], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  const harnessDir = path.join(repoRoot, '.qa-harness');
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Coverage request intake is blocked/);
  assert.match(stderr, /Jira ticket link\/text or pasted requirements/);
  assert.match(stderr, /acceptance criteria/);

  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  assert.equal(state.terminalStatus, 'blocked');
  assert.equal(state.latestRunId, null);
  assert.equal(state.activeRunId, null);
  assert.equal(state.intake.kind, 'coverage-request');
  assert.equal(state.intake.status, 'blocked');
  assert.equal(state.intake.requestText, requestText);
  assert.deepEqual(state.intake.target, {
    type: 'url',
    value: 'http://localhost:3000/billing',
  });
  assert.deepEqual(state.intake.missingFields, ['sourceContext', 'acceptanceCriteria']);
  assert.equal(state.intake.followUpQuestions.length, 2);
  assert.match(state.intake.followUpQuestions[0], /Jira ticket link\/text or pasted requirements/);
  assert.match(state.intake.followUpQuestions[1], /acceptance criteria/);

  const prdContent = fs.readFileSync(path.join(harnessDir, 'PRD.md'), 'utf8');
  assert.match(prdContent, /^## Blocked Coverage Intake$/m);
  assert.match(prdContent, /Missing fields:/);
  assert.match(prdContent, /Jira ticket link\/text or pasted requirements/);
  assert.match(prdContent, /Acceptance criteria/);
  assert.match(prdContent, /Follow-up questions:/);
  assert.match(prdContent, /No feature or BDD artifacts are generated until intake is complete/);

  const progressContent = fs.readFileSync(path.join(harnessDir, 'progress.md'), 'utf8');
  const progressItems = parseProgressItems(progressContent);
  assert.equal(progressItems.length, 1);
  assert.equal(progressItems[0].id, 'INTAKE-001');
  assert.equal(progressItems[0].owner, 'qa-orchestrator');
  assert.equal(progressItems[0].agent, 'qa-orchestrator');
  assert.equal(progressItems[0].mode, 'intake');
  assert.equal(progressItems[0].status, 'blocked');
  assert.match(progressItems[0].blockReason, /sourceContext/);
  assert.match(progressItems[0].blockReason, /acceptanceCriteria/);
  assert.doesNotMatch(progressContent, /Owner: `qa-planner`/);
  assert.doesNotMatch(progressContent, /Owner: `qa-executor`/);

  assert.equal(fs.existsSync(path.join(harnessDir, 'normalized.feature')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, '.features-gen', '.qa-harness')), false);

  let workerCalls = 0;
  let runStdout = '';
  let runStderr = '';
  const runExitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    stdout: { write: (value) => { runStdout += value; } },
    stderr: { write: (value) => { runStderr += value; } },
    commandRunner: () => {
      workerCalls += 1;
      return {
        exitCode: 0,
        stdout: [
          'RALPH_STATUS: pass',
          'RALPH_SUMMARY: should not run',
          'RALPH_VALIDATION: not run',
          'RALPH_NEXT: none',
        ].join('\n'),
        stderr: '',
      };
    },
  });

  assert.equal(runExitCode, 1);
  assert.equal(runStdout, '');
  assert.match(runStderr, /blocked/);
  assert.equal(workerCalls, 0);
});

test('prepare --request updates existing blocked intake state and removes stale normalized feature truth', (t) => {
  const repoRoot = createTempRepo(t);
  const harnessDir = path.join(repoRoot, '.qa-harness');
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });
  writeTextFile(path.join(harnessDir, 'normalized.feature'), 'Feature: stale\n');
  writeTextFile(
    path.join(harnessDir, 'state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      intake: {
        kind: 'coverage-request',
        status: 'blocked',
        requestText: 'old request',
        missingFields: ['target'],
        followUpQuestions: ['old question'],
      },
      preparedAt: '2026-04-27T00:00:00.000Z',
      latestRunId: 'old-run',
      activeRunId: 'old-run',
      terminalStatus: 'blocked',
    }, null, 2)}\n`,
  );
  let stderr = '';

  const exitCode = runCli(['prepare', '--request', [
    'Requirements: Cover public search for anonymous visitors.',
    'Acceptance criteria:',
    '- Visitor can submit a search',
  ].join('\n')], {
    repoRoot,
    stdout: { write: () => {} },
    stderr: { write: (value) => { stderr += value; } },
  });

  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  assert.equal(exitCode, 1);
  assert.match(stderr, /target URL or app scope/);
  assert.equal(state.intake.requestText, [
    'Requirements: Cover public search for anonymous visitors.',
    'Acceptance criteria:',
    '- Visitor can submit a search',
  ].join('\n'));
  assert.deepEqual(state.intake.missingFields, ['target']);
  assert.equal(state.latestRunId, null);
  assert.equal(state.activeRunId, null);
  assert.equal(fs.existsSync(path.join(harnessDir, 'normalized.feature')), false);
});

test('prepare --request creates accepted coverage artifacts routed first to qa-planner', (t) => {
  const repoRoot = createTempRepo(t);
  const harnessPaths = resolveHarnessPaths(repoRoot);
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });
  const requestText = [
    'Target URL: http://localhost:3000/billing',
    'Jira: http://localhost:8080/browse/QA-288',
    'Requirements:',
    'Anonymous visitors can review their public billing status without signing in.',
    'Acceptance criteria:',
    '- Visitor sees the current invoice summary',
    '- Visitor can open invoice details',
  ].join('\n');
  let stdout = '';
  let stderr = '';

  const exitCode = runCli([
    'prepare',
    '--request',
    requestText,
    '--constraint',
    'Use desktop Chrome',
    '--constraint',
    'Do not mutate billing records',
  ], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Accepted coverage request for http:\/\/localhost:3000\/billing/);

  for (const artifactPath of [
    harnessPaths.configPath,
    harnessPaths.prdPath,
    harnessPaths.progressPath,
    harnessPaths.promptPath,
    harnessPaths.statePath,
  ]) {
    assert.ok(fs.statSync(artifactPath).isFile(), `${path.basename(artifactPath)} should exist`);
  }

  assert.equal(fs.existsSync(harnessPaths.normalizedFeaturePath), false);
  assert.equal(fs.existsSync(path.join(repoRoot, '.features-gen', '.qa-harness')), false);

  const prdContent = fs.readFileSync(harnessPaths.prdPath, 'utf8');
  assert.match(prdContent, /^## Accepted Coverage Request$/m);
  assert.match(prdContent, /Target: url: http:\/\/localhost:3000\/billing/);
  assert.match(prdContent, /Source context: jira: http:\/\/localhost:8080\/browse\/QA-288/);
  assert.match(prdContent, /Anonymous visitors can review their public billing status/);
  assert.match(prdContent, /Visitor sees the current invoice summary/);
  assert.match(prdContent, /Visitor can open invoice details/);
  assert.match(prdContent, /Use desktop Chrome/);
  assert.match(prdContent, /Do not mutate billing records/);

  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
  const progressItems = parseProgressItems(progressContent);
  assert.equal(progressItems.length, 1);
  assert.equal(progressItems[0].id, 'PLAN-001');
  assert.equal(progressItems[0].owner, 'qa-planner');
  assert.equal(progressItems[0].agent, 'qa-planner');
  assert.equal(progressItems[0].mode, 'planning');
  assert.equal(progressItems[0].status, 'todo');
  assert.match(progressItems[0].input, /\.qa-harness\/PRD\.md/);
  assert.match(progressItems[0].output, /\.qa-harness\/progress\.md/);
  assert.match(progressItems[0].verify, /id, goal, input, output, verify/i);
  assert.match(progressItems[0].verify, /owner, status, retry budget, result, and evidence/i);
  assert.match(progressItems[0].verify, /seed proof/i);
  assert.match(progressItems[0].verify, /full Playwright execution/i);
  assert.match(progressItems[0].verify, /one worker iteration/i);

  const promptContent = fs.readFileSync(harnessPaths.promptPath, 'utf8');
  assert.match(promptContent, /Use `.qa-harness\/PRD.md` as the durable objective/);
  assert.match(promptContent, /Use `.qa-harness\/progress.md` as durable progress/);
  assert.match(promptContent, /Use `.qa-harness\/PROMPT.md` as durable worker rules/);
  assert.match(promptContent, /Use `.qa-harness\/` files as durable memory/);
  assert.match(promptContent, /Planner output contract/i);
  assert.match(promptContent, /id, goal, input, output, verify command or proof requirement, owner, status, retry budget, result, and evidence/i);
  assert.match(promptContent, /seed proof/i);
  assert.match(promptContent, /full Playwright execution/i);
  assert.match(promptContent, /one worker iteration/i);

  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  assert.equal(state.intake.kind, 'coverage-request');
  assert.equal(state.intake.status, 'accepted');
  assert.deepEqual(state.intake.target, {
    type: 'url',
    value: 'http://localhost:3000/billing',
  });
  assert.deepEqual(state.intake.sourceContext, {
    type: 'jira',
    value: 'http://localhost:8080/browse/QA-288',
  });
  assert.deepEqual(state.intake.acceptanceCriteria, [
    'Visitor sees the current invoice summary',
    'Visitor can open invoice details',
  ]);
  assert.deepEqual(state.intake.constraints, [
    'Use desktop Chrome',
    'Do not mutate billing records',
  ]);
  assert.equal(state.latestRunId, null);
  assert.equal(state.activeRunId, null);
  assert.equal(state.terminalStatus, null);

  const route = selectQaOrchestratorRoute(harnessPaths);
  assert.equal(route.role, 'qa-planner');
  assert.equal(route.mode, 'planning');
  assert.equal(route.item.id, 'PLAN-001');
});

test('runCli reads configured loop default when --max-iterations is omitted', (t) => {
  const repoRoot = createTempRepo(t);
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      loop: {
        defaultMaxIterations: 7,
      },
      copilot: {
        command: 'fake-copilot',
      },
    }, null, 2)}\n`,
  );

  let capturedOptions;
  let stdout = '';
  let stderr = '';
  const exitCode = runCli(['run'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    runFn: (options) => {
      capturedOptions = options;
      return { status: 'budget-exhausted', exitCode: 0, output: 'ran\n' };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /ran/);
  assert.equal(capturedOptions.maxIterations, 7);
});

test('runCli keeps prepare state paths under .qa-harness for traversal-like feature inputs', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let capturedOptions;
  const exitCode = runCli(['prepare', '--from', '../outside.feature'], {
    repoRoot,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    prepareFn: (options) => {
      capturedOptions = options;
      return { output: 'prepared\n' };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(capturedOptions.from, '../outside.feature');
  assert.equal(capturedOptions.harnessPaths.harnessDir, path.join(repoRoot, '.qa-harness'));
  assert.equal(
    capturedOptions.harnessPaths.normalizedFeaturePath,
    path.join(repoRoot, '.qa-harness', 'normalized.feature'),
  );
  assert.equal(
    path.relative(capturedOptions.harnessPaths.harnessDir, capturedOptions.harnessPaths.normalizedFeaturePath),
    'normalized.feature',
  );
});

test('prepare --from creates lean harness artifacts for the selected feature', (t) => {
  const repoRoot = createTempRepo(t);
  const featureContent = [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n');
  writeFeature(repoRoot, 'Features/x.feature', featureContent);
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  let stdout = '';
  let stderr = '';
  const exitCode = runCli(['prepare', '--from', 'Features/x.feature'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  const harnessDir = path.join(repoRoot, '.qa-harness');
  const expectedArtifacts = [
    'config.json',
    'PRD.md',
    'progress.md',
    'PROMPT.md',
    'normalized.feature',
    'state.json',
  ];

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Prepared Features\/x\.feature/);

  for (const artifactName of expectedArtifacts) {
    assert.ok(
      fs.statSync(path.join(harnessDir, artifactName)).isFile(),
      `${artifactName} should exist under .qa-harness`,
    );
  }

  assert.equal(fs.readFileSync(path.join(harnessDir, 'normalized.feature'), 'utf8'), featureContent);

  const prdContent = fs.readFileSync(path.join(harnessDir, 'PRD.md'), 'utf8');
  assert.match(prdContent, /^# QA Harness PRD$/m);
  assert.match(prdContent, /^Source feature path: `Features\/x\.feature`$/m);
  assert.match(prdContent, /^Feature title: Checkout$/m);
  assert.match(prdContent, /^Scenario count: 1 scenario$/m);
  assert.match(
    prdContent,
    /Execute or improve the selected feature through Copilot-supervised Playwright BDD\./,
  );
  assert.match(prdContent, /`normalized\.feature` is the execution truth/);
  assert.match(prdContent, /Playwright is required for browser\/test execution/);
  assert.match(prdContent, /`playwright-bdd` is required for executable feature generation/);
  assert.doesNotMatch(
    prdContent,
    /RequestEnvelope|RuntimeAdapter|ToolPolicy|MCP|plugins|Jira|explorer|healer|planner handoff|promotion|scenario addition|scenario-addition/,
  );

  const progressContent = fs.readFileSync(path.join(harnessDir, 'progress.md'), 'utf8');
  const uncheckedItems = progressContent.match(/^- \[ \] /gm) || [];
  assert.equal(uncheckedItems.length, 1);
  assert.match(progressContent, /Features\/x\.feature/);
  assert.doesNotMatch(progressContent, /autonomous exploration/i);

  const progressItems = parseProgressItems(progressContent);
  assert.equal(progressItems.length, 1);
  assert.equal(progressItems[0].checkboxChecked, false);
  assert.equal(progressItems[0].id, 'P-001');
  assert.match(progressItems[0].goal, /Features\/x\.feature/);
  assert.match(progressItems[0].input, /Features\/x\.feature/);
  assert.match(progressItems[0].input, /\.qa-harness\/normalized\.feature/);
  assert.match(progressItems[0].output, /evidence/i);
  assert.match(progressItems[0].verify, /ralph-qa-harness verify/);
  assert.equal(progressItems[0].owner, 'qa-executor');
  assert.equal(progressItems[0].status, 'todo');
  assert.equal(progressItems[0].retryBudget, '1');

  const promptContent = fs.readFileSync(path.join(harnessDir, 'PROMPT.md'), 'utf8');
  assert.match(promptContent, /^# Copilot Worker Rules$/m);
  assert.match(promptContent, /Complete exactly one selected unchecked item from `.qa-harness\/progress.md`/);
  assert.match(promptContent, /Use `.qa-harness\/PRD.md` as the durable objective/);
  assert.match(promptContent, /Use `.qa-harness\/progress.md` as durable progress/);
  assert.match(promptContent, /Use `.qa-harness\/PROMPT.md` as durable worker rules/);
  assert.match(promptContent, /Use `.qa-harness\/normalized.feature` as execution truth/);
  assert.match(promptContent, /Use `.qa-harness\/` files as durable memory/);
  assert.match(promptContent, /Do not stage, commit, push, or create a pull request/);
  assert.match(promptContent, /The supervisor will run `ralph-qa-harness verify` after worker exit/);
  assert.match(promptContent, /Every response must end with this exact four-line Ralph footer:/);
  assert.match(promptContent, /^RALPH_STATUS: pass\|blocked\|fail$/m);
  assert.match(promptContent, /^RALPH_SUMMARY: <one concise paragraph>$/m);
  assert.match(promptContent, /^RALPH_VALIDATION: <commands run, or why not run>$/m);
  assert.match(promptContent, /^RALPH_NEXT: <next recommended action, or none>$/m);

  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  assert.equal(state.sourceFeaturePath, 'Features/x.feature');
  assert.equal(state.normalizedFeaturePath, '.qa-harness/normalized.feature');
  assert.equal(state.latestRunId, null);

  const config = JSON.parse(fs.readFileSync(path.join(harnessDir, 'config.json'), 'utf8'));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.loop.defaultMaxIterations, 40);
  assert.equal(config.copilot.command, process.platform === 'win32' ? 'copilot.cmd' : 'copilot');

  const excludeContent = fs.readFileSync(path.join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
  assert.match(excludeContent, /^\.qa-harness\/$/m);
  assert.match(excludeContent, /^\.features-gen\/\.qa-harness\/$/m);
});

test('run reads the configured loop default when maxIterations is omitted', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/x.feature', [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n'));
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  prepare({
    repoRoot,
    from: 'Features/x.feature',
    platform: 'linux',
    now: new Date('2026-04-27T08:01:00.000Z'),
  });

  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      loop: {
        defaultMaxIterations: 2,
      },
      copilot: {
        command: 'fake-copilot',
      },
    }, null, 2)}\n`,
  );
  writeTextFile(
    harnessPaths.progressPath,
    buildLeanProgressDocument([
      { id: 'P-001', goal: 'run first configured-budget iteration.' },
      { id: 'P-002', goal: 'run second configured-budget iteration.' },
      { id: 'P-003', goal: 'remain pending after configured budget is exhausted.' },
    ]),
  );

  const { calls, runner } = createLeanRunCommandRunner();
  const result = run({
    repoRoot,
    commandRunner: runner,
    verifyFn: () => ({ status: 'pass', exitCode: 0, output: 'verified\n' }),
    now: new Date('2026-04-27T08:02:00.000Z'),
  });
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.iterationCount, 2);
  assert.equal(result.stopReason, 'budget-exhausted');
  assert.equal(workerCalls.length, 2);
});

test('status reads latest prepared state from .qa-harness state.json', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/x.feature', [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n'));
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  prepare({
    repoRoot,
    from: 'Features/x.feature',
    now: new Date('2026-04-27T06:18:00.000Z'),
  });

  const state = JSON.parse(fs.readFileSync(path.join(repoRoot, '.qa-harness', 'state.json'), 'utf8'));
  assert.equal(state.sourceFeaturePath, 'Features/x.feature');
  assert.equal(state.normalizedFeaturePath, '.qa-harness/normalized.feature');
  assert.equal(state.preparedAt, '2026-04-27T06:18:00.000Z');
  assert.equal(state.latestRunId, null);
  assert.equal(state.activeRunId, null);
  assert.equal(state.terminalStatus, null);

  let stdout = '';
  let stderr = '';
  const exitCode = runCli(['status'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Prepared feature: Features\/x\.feature/);
  assert.match(stdout, /Normalized feature: \.qa-harness\/normalized\.feature/);
  assert.match(stdout, /Prepared at: 2026-04-27T06:18:00\.000Z/);
  assert.match(stdout, /Latest run: none/);
  assert.match(stdout, /Active run: none/);
  assert.match(stdout, /Terminal status: not run/);
  assert.match(stdout, /Next: npx ralph-qa-harness run --max-iterations <positive-integer>/);
});

test('status reports no-run before prepare', (t) => {
  const repoRoot = createTempRepo(t);
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['status'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Status: no-run/);
  assert.match(stdout, /No prepared QA harness state found at \.qa-harness\/state\.json\./);
  assert.match(stdout, /Next: npx ralph-qa-harness prepare --from <feature-path>/);
});

test('status reports active run id and current or last iteration', (t) => {
  const repoRoot = createTempRepo(t);
  const harnessPaths = resolveHarnessPaths(repoRoot);
  const runId = '20260427T082600Z-run-x';
  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  fs.mkdirSync(path.join(runPaths.iterationsDir, '001'), { recursive: true });
  fs.mkdirSync(path.join(runPaths.iterationsDir, '002'), { recursive: true });
  writeTextFile(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      sourceFeaturePath: 'Features/x.feature',
      normalizedFeaturePath: '.qa-harness/normalized.feature',
      preparedAt: '2026-04-27T08:25:00.000Z',
      latestRunId: runId,
      activeRunId: runId,
      terminalStatus: null,
    }, null, 2)}\n`,
  );

  let stdout = '';
  let stderr = '';
  const exitCode = runCli(['status'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Prepared feature: Features\/x\.feature/);
  assert.match(stdout, /Latest run: 20260427T082600Z-run-x/);
  assert.match(stdout, /Active run: 20260427T082600Z-run-x/);
  assert.match(stdout, /Run status: active/);
  assert.match(stdout, /Current\/last iteration: 002/);
});

test('status reports terminal run state, stop reason, and validation state', (t) => {
  const cases = [
    {
      name: 'completed',
      terminalStatus: 'completed',
      stopReason: 'no-actionable-items',
      validationStatus: 'pass',
    },
    {
      name: 'blocked',
      terminalStatus: 'blocked',
      stopReason: 'blocked',
      validationStatus: null,
    },
    {
      name: 'failed',
      terminalStatus: 'failed',
      stopReason: 'validation-failed',
      validationStatus: 'fail',
    },
    {
      name: 'stalled',
      terminalStatus: 'stalled',
      stopReason: 'selected-item-not-completed',
      validationStatus: 'pass',
    },
    {
      name: 'budget-exhausted',
      terminalStatus: 'budget-exhausted',
      stopReason: 'budget-exhausted',
      validationStatus: 'pass',
    },
  ];

  for (const testCase of cases) {
    const repoRoot = createTempRepo(t);
    const harnessPaths = resolveHarnessPaths(repoRoot);
    const runId = `20260427T0827${String(cases.indexOf(testCase)).padStart(2, '0')}Z-run-x`;
    const runPaths = resolveHarnessPaths(repoRoot, { runId });
    fs.mkdirSync(path.join(runPaths.iterationsDir, '001'), { recursive: true });
    writeTextFile(
      harnessPaths.statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        sourceFeaturePath: 'Features/x.feature',
        normalizedFeaturePath: '.qa-harness/normalized.feature',
        preparedAt: '2026-04-27T08:25:00.000Z',
        latestRunId: runId,
        activeRunId: null,
        terminalStatus: testCase.terminalStatus,
      }, null, 2)}\n`,
    );
    writeTextFile(
      runPaths.resultPath,
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        status: testCase.terminalStatus,
        stopReason: testCase.stopReason,
        exitCode: ['failed', 'blocked', 'stalled'].includes(testCase.terminalStatus) ? 1 : 0,
        iterationCount: 1,
        iterations: [],
        finishedAt: '2026-04-27T08:28:00.000Z',
      }, null, 2)}\n`,
    );
    if (testCase.validationStatus) {
      writeTextFile(
        runPaths.validationPath,
        `${JSON.stringify({
          schemaVersion: 1,
          runId,
          status: testCase.validationStatus,
          summary: `${testCase.validationStatus} validation evidence`,
        }, null, 2)}\n`,
      );
    }

    let stdout = '';
    let stderr = '';
    const exitCode = runCli(['status'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });

    assert.equal(exitCode, 0, testCase.name);
    assert.equal(stderr, '', testCase.name);
    assert.match(stdout, new RegExp(`Terminal status: ${testCase.terminalStatus}`), testCase.name);
    assert.match(stdout, new RegExp(`Run status: ${testCase.terminalStatus}`), testCase.name);
    assert.match(stdout, new RegExp(`Stop reason: ${testCase.stopReason}`), testCase.name);
    assert.match(
      stdout,
      new RegExp(`Validation status: ${testCase.validationStatus || 'not recorded'}`),
      testCase.name,
    );
    assert.match(stdout, /Current\/last iteration: 001/, testCase.name);
  }
});

test('run CLI launches one fresh fake Copilot process per requested iteration', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T06:30:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-001', goal: 'run first fake Copilot iteration.' },
      { id: 'P-002', goal: 'run second fake Copilot iteration.' },
      { id: 'P-003', goal: 'run third fake Copilot iteration.' },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    workerResult: (callNumber) => ({
      status: 0,
      stdout: [
        `fake Copilot invocation ${callNumber}`,
        'RALPH_STATUS: pass',
        `RALPH_SUMMARY: fake iteration ${callNumber}`,
        'RALPH_VALIDATION: fake validation command',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    }),
  });
  let stdout = '';
  let stderr = '';
  const exitCode = runCli(['run', '--max-iterations', '3'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: runner,
  });

  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Run .* stopped after 3 iterations: budget-exhausted/);
  assert.match(stderr, /stop reason: budget-exhausted/);
  assert.deepEqual(workerCalls.map((call) => call.command), ['fake-copilot', 'fake-copilot', 'fake-copilot']);
  assert.deepEqual(workerCalls.map((call) => call.args), [[], [], []]);
  assert.ok(workerCalls.every((call) => call.cwd === repoRoot));
  assert.match(state.latestRunId, /^\d{8}T\d{6}Z-run-x$/);
  assert.equal(state.activeRunId, null);
  assert.equal(state.terminalStatus, 'budget-exhausted');
});

test('run CLI writes each worker prompt from durable docs and the selected unchecked item', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/x.feature', [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n'));
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  prepare({
    repoRoot,
    from: 'Features/x.feature',
    platform: 'linux',
    now: new Date('2026-04-27T07:34:00.000Z'),
  });

  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      copilot: {
        command: 'fake-copilot',
      },
    }, null, 2)}\n`,
  );
  writeTextFile(harnessPaths.prdPath, '# Test PRD\n\nUnique PRD objective for prompt construction.\n');
  writeTextFile(
    harnessPaths.promptPath,
    [
      '# Test Worker Rules',
      '',
      'Unique durable worker rule for prompt construction.',
      '',
      'RALPH_STATUS: pass|blocked|fail',
      'RALPH_SUMMARY: <one concise paragraph>',
      'RALPH_VALIDATION: <commands run, or why not run>',
      'RALPH_NEXT: <next recommended action, or none>',
      '',
    ].join('\n'),
  );
  writeTextFile(
    harnessPaths.progressPath,
    [
      '# Test Progress',
      '',
      '## Active Items',
      '',
      '- [x] `P-001` Goal: already completed prompt item.',
      '  - Input: `done input`',
      '  - Output: `done output`',
      '  - Verify: `done verify`',
      '  - Owner: `qa-executor`',
      '  - Status: `pass`',
      '  - Retry budget: `0`',
      '  - Result: `done`',
      '  - Evidence: `done evidence`',
      '',
      '- [ ] `P-002` Goal: build the selected worker prompt.',
      '  - Input: `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`',
      '  - Output: `.qa-harness/runs/<run-id>/iterations/001/worker-prompt.md`',
      '  - Verify: `inspect worker-prompt.md`',
      '  - Owner: `qa-executor`',
      '  - Status: `todo`',
      '  - Retry budget: `1`',
      '  - Result: ``',
      '  - Evidence: ``',
      '',
    ].join('\n'),
  );

  const { runner } = createLeanRunCommandRunner({
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot invocation',
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: prompt artifact written',
        'RALPH_VALIDATION: fake validation command',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });
  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T07:35:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const workerPromptPath = path.join(runPaths.iterationsDir, '001', 'worker-prompt.md');
  const workerPrompt = fs.readFileSync(workerPromptPath, 'utf8');

  assert.equal(exitCode, 0);
  assert.match(workerPrompt, /## Durable PRD: `.qa-harness\/PRD.md`/);
  assert.match(workerPrompt, /Unique PRD objective for prompt construction/);
  assert.match(workerPrompt, /## Durable Progress: `.qa-harness\/progress.md`/);
  assert.match(workerPrompt, /already completed prompt item/);
  assert.match(workerPrompt, /build the selected worker prompt/);
  assert.match(workerPrompt, /## Durable Worker Rules: `.qa-harness\/PROMPT.md`/);
  assert.match(workerPrompt, /Unique durable worker rule for prompt construction/);
  assert.match(workerPrompt, /^RALPH_STATUS: pass\|blocked\|fail$/m);
  assert.match(workerPrompt, /^RALPH_SUMMARY: <one concise paragraph>$/m);
  assert.match(workerPrompt, /^RALPH_VALIDATION: <commands run, or why not run>$/m);
  assert.match(workerPrompt, /^RALPH_NEXT: <next recommended action, or none>$/m);

  const selectedSection = workerPrompt.match(/## Selected Progress Item\n\n```markdown\n([\s\S]*?)\n```/);
  assert.ok(selectedSection, 'worker prompt should include a selected progress item section');
  const selectedItemBlock = selectedSection[1];
  assert.match(selectedItemBlock, /^- \[ \] `P-002` Goal: build the selected worker prompt\.$/m);
  assert.doesNotMatch(selectedItemBlock, /P-001|already completed prompt item|- \[x\]/);
  assert.equal((selectedItemBlock.match(/^- \[[ x]\] /gm) || []).length, 1);
});

test('run CLI executor prompts provide run-local seed workflow artifact paths', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:14:00.000Z'),
  });
  const { runner } = createLeanRunCommandRunner({
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot invocation',
        'RALPH_STATUS: blocked',
        'RALPH_SUMMARY: seed workflow prompt inspected',
        'RALPH_VALIDATION: not run',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T09:15:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const workerPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'worker-prompt.md'), 'utf8');
  const seedDisplayPath = `.qa-harness/runs/${state.latestRunId}/seed.spec.ts`;
  const playwrightConfigDisplayPath = `.qa-harness/runs/${state.latestRunId}/playwright.config.ts`;

  assert.equal(exitCode, 1);
  assert.equal(runPaths.seedSpecPath, path.join(runPaths.runDir, 'seed.spec.ts'));
  assert.equal(runPaths.playwrightConfigPath, path.join(runPaths.runDir, 'playwright.config.ts'));
  assert.equal(path.relative(runPaths.runDir, runPaths.seedSpecPath).startsWith('..'), false);
  assert.equal(path.relative(runPaths.runsDir, runPaths.seedSpecPath).startsWith('..'), false);
  assert.equal(path.relative(runPaths.runDir, runPaths.playwrightConfigPath).startsWith('..'), false);
  assert.equal(path.relative(runPaths.runsDir, runPaths.playwrightConfigPath).startsWith('..'), false);
  assert.match(workerPrompt, /^RALPH_AGENT: qa-executor$/m);
  assert.match(workerPrompt, /## Run-Local Coverage Artifacts/);
  assert.match(workerPrompt, new RegExp(`Seed spec: \`${escapeRegExp(seedDisplayPath)}\``));
  assert.match(workerPrompt, new RegExp(`Optional Playwright config: \`${escapeRegExp(playwrightConfigDisplayPath)}\``));
  assert.match(workerPrompt, /first executable coverage proof/);
  assert.match(workerPrompt, /imports Playwright test APIs from the target project dependencies/);
  assert.match(workerPrompt, /working navigation, interactions, waits, assertions, and locators/);
  assert.match(workerPrompt, /seed is evidence, not final BDD output/);
  assert.doesNotMatch(workerPrompt, /\.qa-harness\/runs\/<run-id>\/seed\.spec\.ts/);
});

test('run CLI records Playwright CLI seed evidence before supervisor verification for coverage executor work', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:16:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-SEED', goal: 'prove one coverage flow with seed evidence.' },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
      const runPaths = resolveHarnessPaths(repoRoot, { runId: state.activeRunId });
      writeTextFile(
        runPaths.seedSpecPath,
        [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('seed proof', async ({ page }) => {",
          "  await page.goto('http://localhost:3000');",
          "  await expect(page.locator('body')).toBeVisible();",
          '});',
          '',
        ].join('\n'),
      );
    },
    executeResult: {
      status: 0,
      stdout: 'seed passed\n',
      stderr: 'seed stderr note\n',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T09:17:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');
  const evidencePath = path.join(iterationDir, 'evidence', 'playwright-cli-seed.json');
  const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const workerCallIndex = calls.findIndex((call) => call.command === 'fake-copilot');
  const seedCallIndex = calls.findIndex((call) =>
    call.args[0] === 'playwright'
    && call.args[1] === 'test'
    && call.args[2] === `.qa-harness/runs/${state.latestRunId}/seed.spec.ts`);
  const verifyCallIndex = calls.findIndex((call) => call.args[0] === 'bddgen' && call.args[1] === 'export');

  assert.equal(exitCode, 1);
  assert.ok(workerCallIndex >= 0);
  assert.ok(seedCallIndex > workerCallIndex, 'seed Playwright CLI evidence should run after worker writes seed');
  assert.ok(verifyCallIndex > seedCallIndex, 'seed Playwright CLI evidence should run before supervisor verify');
  assert.match(evidence.command, /^npx(?:\.cmd)?$/);
  assert.deepEqual(evidence.args, ['playwright', 'test', `.qa-harness/runs/${state.latestRunId}/seed.spec.ts`]);
  assert.match(evidence.commandDisplay, new RegExp(`playwright test ${escapeRegExp(`.qa-harness/runs/${state.latestRunId}/seed.spec.ts`)}`));
  assert.equal(evidence.stdout, 'seed passed\n');
  assert.equal(evidence.stderr, 'seed stderr note\n');
  assert.equal(evidence.exitCode, 0);
  assert.equal(Number.isInteger(evidence.durationMs), true);
  assert.equal(evidence.RALPH_AGENT, 'qa-executor');
  assert.equal(evidence.runId, state.latestRunId);
  assert.equal(evidence.iteration, 1);
  assert.equal(summary.coverageEvidence.path, `.qa-harness/runs/${state.latestRunId}/iterations/001/evidence/playwright-cli-seed.json`);
  assert.equal(summary.coverageEvidence.exitCode, 0);
});

test('run CLI rejects MCP fallback before Playwright CLI seed evidence exists', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:18:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-MCP', goal: 'attempt coverage fallback too early.' },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
      writeTextFile(
        harnessPaths.progressPath,
        progressContent.replace(
          '  - Evidence: ``',
          [
            '  - Evidence: `MCP accessibility snapshot`',
            '  - Fallback reason: `MCP fallback used before Playwright CLI seed evidence`',
          ].join('\n'),
        ),
      );
    },
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot worker output',
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: worker tried MCP fallback before CLI evidence',
        'RALPH_VALIDATION: not run',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T09:19:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
  const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));

  assert.equal(exitCode, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'coverage-cli-evidence-required');
  assert.match(summary.coverageEvidenceError, /Playwright CLI seed evidence is required before MCP fallback/);
  assert.match(iterationValidation.reason, /Playwright CLI seed evidence is required before MCP fallback/);
  assert.equal(fs.existsSync(path.join(iterationDir, 'evidence', 'playwright-cli-seed.json')), false);
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [['fake-copilot', []]]);
});

test('run CLI accepts MCP fallback only after Playwright CLI seed discovery cannot proceed', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:20:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-MCP-AFTER-CLI', goal: 'use MCP fallback after CLI discovery cannot proceed.' },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
      const runPaths = resolveHarnessPaths(repoRoot, { runId: state.activeRunId });
      writeTextFile(
        runPaths.seedSpecPath,
        [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('seed proof', async ({ page }) => {",
          "  await page.goto('http://localhost:3000');",
          "  await expect(page.locator('body')).toBeVisible();",
          '});',
          '',
        ].join('\n'),
      );
      const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
      writeTextFile(
        harnessPaths.progressPath,
        progressContent.replace(
          '  - Evidence: ``',
          [
            '  - Evidence: `MCP accessibility snapshot observed button "Continue"`',
            '  - Fallback reason: `Playwright CLI seed discovery could not proceed because the local browser launch failed`',
          ].join('\n'),
        ),
      );
    },
    executeResult: {
      status: 1,
      stdout: '',
      stderr: 'browser launch failed before discovery\n',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T09:21:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
  const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
  const seedCallIndex = calls.findIndex((call) =>
    call.args[0] === 'playwright'
    && call.args[1] === 'test'
    && call.args[2] === `.qa-harness/runs/${state.latestRunId}/seed.spec.ts`);
  const verifyCallIndex = calls.findIndex((call) => call.args[0] === 'bddgen' && call.args[1] === 'export');

  assert.equal(exitCode, 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.stopReason, 'all-progress-passed');
  assert.ok(seedCallIndex >= 0);
  assert.ok(verifyCallIndex > seedCallIndex);
  assert.equal(summary.coverageEvidence.exitCode, 1);
  assert.equal(summary.coverageEvidenceError, null);
  assert.equal(iterationValidation.status, 'pass');
  assert.deepEqual(result.iterations.map((iteration) => iteration.RALPH_AGENT), ['qa-executor', 'qa-verifier']);
  assert.match(progressContent, /Status: `pass`/);
  assert.match(progressContent, /Evidence: `MCP accessibility snapshot observed button "Continue"`/);
  assert.match(progressContent, /Fallback reason: `Playwright CLI seed discovery could not proceed/);
});

test('run CLI rejects MCP fallback when Playwright CLI seed discovery succeeds', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:22:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-MCP-SUCCESS', goal: 'try fallback despite successful CLI discovery.' },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
      const runPaths = resolveHarnessPaths(repoRoot, { runId: state.activeRunId });
      writeTextFile(
        runPaths.seedSpecPath,
        [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('seed proof', async ({ page }) => {",
          "  await page.goto('http://localhost:3000');",
          "  await expect(page.locator('body')).toBeVisible();",
          '});',
          '',
        ].join('\n'),
      );
      const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
      writeTextFile(
        harnessPaths.progressPath,
        progressContent.replace(
          '  - Evidence: ``',
          [
            '  - Evidence: `MCP accessibility snapshot despite successful seed`',
            '  - Fallback reason: `MCP fallback used after successful Playwright CLI seed discovery`',
          ].join('\n'),
        ),
      );
    },
    executeResult: {
      status: 0,
      stdout: 'seed discovery passed\n',
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T09:23:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
  const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));

  assert.equal(exitCode, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'coverage-mcp-fallback-requires-failed-cli');
  assert.equal(summary.coverageEvidence.exitCode, 0);
  assert.match(summary.coverageEvidenceError, /MCP fallback requires Playwright CLI seed evidence that could not proceed/);
  assert.match(iterationValidation.reason, /MCP fallback requires Playwright CLI seed evidence that could not proceed/);
  assert.equal(calls.some((call) => call.args[0] === 'bddgen'), false);
});

test('run CLI fails MCP fallback verification without fallback reason or MCP evidence', (t) => {
  const cases = [
    {
      name: 'missing fallback reason',
      itemId: 'P-MCP-NO-REASON',
      progressReplacement: '  - Evidence: `MCP accessibility snapshot observed button "Continue"`',
      expectedStopReason: 'coverage-mcp-fallback-reason-required',
      expectedReason: /MCP fallback requires a fallback reason/,
    },
    {
      name: 'missing MCP evidence',
      itemId: 'P-MCP-NO-EVIDENCE',
      progressReplacement: [
        '  - Evidence: ``',
        '  - Fallback reason: `MCP fallback used after Playwright CLI seed discovery failed`',
      ].join('\n'),
      expectedStopReason: 'coverage-mcp-fallback-evidence-required',
      expectedReason: /MCP fallback requires MCP evidence/,
    },
  ];

  for (const testCase of cases) {
    const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
      prepareNow: new Date('2026-04-27T09:24:00.000Z'),
      progressContent: buildLeanProgressDocument([
        { id: testCase.itemId, goal: `${testCase.name} coverage fallback.` },
      ]),
    });
    const { calls, runner } = createLeanRunCommandRunner({
      onWorkerCall: () => {
        const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
        const runPaths = resolveHarnessPaths(repoRoot, { runId: state.activeRunId });
        writeTextFile(
          runPaths.seedSpecPath,
          [
            "import { test, expect } from '@playwright/test';",
            '',
            "test('seed proof', async ({ page }) => {",
            "  await page.goto('http://localhost:3000');",
            "  await expect(page.locator('body')).toBeVisible();",
            '});',
            '',
          ].join('\n'),
        );
        const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
        writeTextFile(
          harnessPaths.progressPath,
          progressContent.replace('  - Evidence: ``', testCase.progressReplacement),
        );
      },
      executeResult: {
        status: 1,
        stdout: '',
        stderr: 'seed discovery could not proceed\n',
      },
    });

    const exitCode = runCli(['run', '--max-iterations', '1'], {
      repoRoot,
      now: new Date('2026-04-27T09:25:00.000Z'),
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      commandRunner: runner,
    });
    const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
    const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
    const iterationDir = path.join(runPaths.iterationsDir, '001');
    const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
    const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
    const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));

    assert.equal(exitCode, 1, testCase.name);
    assert.equal(result.status, 'failed', testCase.name);
    assert.equal(result.stopReason, testCase.expectedStopReason, testCase.name);
    assert.match(summary.coverageEvidenceError, testCase.expectedReason, testCase.name);
    assert.match(iterationValidation.reason, testCase.expectedReason, testCase.name);
    assert.equal(calls.some((call) => call.args[0] === 'bddgen'), false, testCase.name);
  }
});

test('run CLI executor prompt requires seed proof before promotion into BDD or framework files', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:26:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-PROMPT-PROMOTE', goal: 'promote proven seed logic into BDD steps.' },
    ]),
  });
  const { runner } = createLeanRunCommandRunner();

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T09:27:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const workerPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'worker-prompt.md'), 'utf8');

  assert.equal(exitCode, 1);
  assert.match(workerPrompt, /Do not promote seed logic into BDD or framework files until Playwright CLI seed proof exists/);
  assert.match(workerPrompt, /Promotion explanation/);
  assert.match(workerPrompt, /materially differs from seed proof/);
});

test('run CLI rejects promoted BDD code that materially differs from seed proof without explanation', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:28:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-PROMOTION-DIFF', goal: 'promote a proven checkout seed into BDD steps.' },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
      const runPaths = resolveHarnessPaths(repoRoot, { runId: state.activeRunId });
      writeTextFile(
        runPaths.seedSpecPath,
        [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('seed proof', async ({ page }) => {",
          "  await page.goto('http://localhost:3000/checkout');",
          "  await page.getByRole('button', { name: 'Pay now' }).click();",
          "  await expect(page.getByText('Receipt')).toBeVisible();",
          '});',
          '',
        ].join('\n'),
      );
      writeFeature(
        repoRoot,
        'Features/steps/promotion-generated.ts',
        [
          "import { Given } from 'playwright-bdd/decorators';",
          '',
          "Given('the customer pays with the shortcut flow', async ({ page }) => {",
          "  await page.goto('http://localhost:3000/checkout?shortcut=true');",
          "  await page.locator('[data-testid=\"fast-pay\"]').click();",
          "  await page.waitForURL('**/done');",
          '});',
          '',
        ].join('\n'),
      );
      const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
      writeTextFile(
        harnessPaths.progressPath,
        progressContent.replace(
          '  - Evidence: ``',
          '  - Evidence: `Promoted BDD step code into Features/steps/promotion-generated.ts; material difference from seed proof.`',
        ),
      );
    },
    executeResult: {
      status: 0,
      stdout: 'seed proof passed\n',
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T09:29:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
  const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));

  assert.equal(exitCode, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'coverage-promotion-explanation-required');
  assert.match(summary.coverageEvidenceError, /Promotion explanation is required/);
  assert.match(iterationValidation.reason, /Promotion explanation is required/);
  assert.equal(calls.some((call) => call.args[0] === 'bddgen'), false);
});

test('run CLI builds a planner-scoped worker prompt with only planner role templates', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/x.feature', [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n'));
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  prepare({
    repoRoot,
    from: 'Features/x.feature',
    platform: 'linux',
    now: new Date('2026-04-27T08:24:00.000Z'),
  });

  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      copilot: {
        command: 'fake-copilot',
      },
    }, null, 2)}\n`,
  );
  writeTextFile(harnessPaths.prdPath, '# Planner PRD\n\nPlanner-scoped durable objective.\n');
  writeTextFile(
    harnessPaths.promptPath,
    [
      '# Planner Worker Rules',
      '',
      'Planner-scoped durable worker rule.',
      '',
      'RALPH_STATUS: pass|blocked|fail',
      'RALPH_SUMMARY: <one concise paragraph>',
      'RALPH_VALIDATION: <commands run, or why not run>',
      'RALPH_NEXT: <next recommended action, or none>',
      '',
    ].join('\n'),
  );
  writeTextFile(
    harnessPaths.progressPath,
    [
      '# Planner Progress',
      '',
      '## Active Items',
      '',
      '- [ ] `PLAN-001` Goal: refine the durable planning artifacts.',
      '  - Input: `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`',
      '  - Output: `bounded planner-authored progress items`',
      '  - Verify: `inspect planner artifacts`',
      '  - Owner: `qa-planner`',
      '  - Status: `todo`',
      '  - Retry budget: `1`',
      '  - Result: ``',
      '  - Evidence: ``',
      '',
    ].join('\n'),
  );

  const { runner } = createLeanRunCommandRunner({
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot invocation',
        'RALPH_STATUS: blocked',
        'RALPH_SUMMARY: prompt inspected',
        'RALPH_VALIDATION: not run',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });
  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T08:25:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const workerPromptPath = path.join(runPaths.iterationsDir, '001', 'worker-prompt.md');
  const workerPrompt = fs.readFileSync(workerPromptPath, 'utf8');
  const plannerTemplates = resolveQaAgentTemplatePaths('qa-planner');
  const plannerAgent = fs.readFileSync(plannerTemplates.agentPath, 'utf8').trimEnd();
  const plannerSkills = fs.readFileSync(plannerTemplates.skillsPath, 'utf8').trimEnd();

  assert.equal(exitCode, 1);
  assert.match(workerPrompt, /^RALPH_AGENT: qa-planner$/m);
  assert.match(workerPrompt, /## Role Agent Template: `templates\/qa-agents\/planner\/agent.md`/);
  assert.match(workerPrompt, /## Role Skills Template: `templates\/qa-agents\/planner\/skills.md`/);
  assert.match(workerPrompt, new RegExp(escapeRegExp(plannerAgent)));
  assert.match(workerPrompt, new RegExp(escapeRegExp(plannerSkills)));
  assert.match(workerPrompt, /## Durable PRD: `.qa-harness\/PRD.md`/);
  assert.match(workerPrompt, /Planner-scoped durable objective/);
  assert.match(workerPrompt, /## Durable Progress: `.qa-harness\/progress.md`/);
  assert.match(workerPrompt, /## Durable Worker Rules: `.qa-harness\/PROMPT.md`/);
  assert.match(workerPrompt, /Planner-scoped durable worker rule/);
  assert.match(workerPrompt, /## Selected Progress Item/);
  assert.match(workerPrompt, /PLAN-001` Goal: refine the durable planning artifacts/);
  assert.doesNotMatch(workerPrompt, /## Role Agent Template: `templates\/qa-agents\/executor\/agent.md`/);
  assert.doesNotMatch(workerPrompt, /## Role Skills Template: `templates\/qa-agents\/verifier\/skills.md`/);
  assert.doesNotMatch(workerPrompt, /Use run-local `\.qa-harness\/runs\/<run-id>\/seed\.spec\.ts`/);
  assert.doesNotMatch(workerPrompt, /Require full `playwright test` for affected specs/);
});

test('run CLI passes the worker prompt to fake Copilot on stdin', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/x.feature', [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n'));
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  prepare({
    repoRoot,
    from: 'Features/x.feature',
    platform: 'linux',
    now: new Date('2026-04-27T07:40:00.000Z'),
  });

  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      copilot: {
        command: 'fake-copilot',
      },
    }, null, 2)}\n`,
  );
  writeTextFile(harnessPaths.prdPath, '# Test PRD\n\nUnique stdin PRD objective.\n');
  writeTextFile(
    harnessPaths.promptPath,
    [
      '# Test Worker Rules',
      '',
      'Unique stdin worker rule.',
      '',
      'RALPH_STATUS: pass|blocked|fail',
      'RALPH_SUMMARY: <one concise paragraph>',
      'RALPH_VALIDATION: <commands run, or why not run>',
      'RALPH_NEXT: <next recommended action, or none>',
      '',
    ].join('\n'),
  );
  writeTextFile(
    harnessPaths.progressPath,
    [
      '# Test Progress',
      '',
      '## Active Items',
      '',
      '- [ ] `P-003` Goal: prove stdin prompt delivery.',
      '  - Input: `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`',
      '  - Output: `fake Copilot captured stdin`',
      '  - Verify: `inspect captured stdin`',
      '  - Owner: `qa-executor`',
      '  - Status: `todo`',
      '  - Retry budget: `1`',
      '  - Result: ``',
      '  - Evidence: ``',
      '',
    ].join('\n'),
  );

  const capturedStdinPath = path.join(repoRoot, 'fake-copilot-stdin.txt');
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: ({ commandOptions }) => {
      writeTextFile(capturedStdinPath, commandOptions.input || '');
    },
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot received stdin',
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: stdin prompt captured',
        'RALPH_VALIDATION: fake validation command',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });
  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T07:41:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const workerPromptPath = path.join(runPaths.iterationsDir, '001', 'worker-prompt.md');
  const workerPrompt = fs.readFileSync(workerPromptPath, 'utf8');
  const capturedStdin = fs.readFileSync(capturedStdinPath, 'utf8');
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(exitCode, 1);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].command, 'fake-copilot');
  assert.deepEqual(workerCalls[0].args, []);
  assert.equal(capturedStdin, workerPrompt);
  assert.match(capturedStdin, /Unique stdin PRD objective/);
  assert.match(capturedStdin, /Unique stdin worker rule/);
  assert.match(capturedStdin, /prove stdin prompt delivery/);
  assert.match(capturedStdin, /^RALPH_STATUS: pass\|blocked\|fail$/m);
  assert.equal(workerCalls[0].args.join(' ').includes('Unique stdin PRD objective'), false);
  assert.equal(workerCalls[0].args.join(' ').includes('prove stdin prompt delivery'), false);
});

test('run CLI creates fresh prompts when the orchestrator routes executor work to verifier', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T08:36:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-001', goal: 'implement coverage and hand it to verifier.' },
    ]),
  });
  const workerPrompts = [];
  let workerInvocation = 0;
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: ({ commandOptions }) => {
      workerInvocation += 1;
      workerPrompts.push(commandOptions.input);

      if (workerInvocation === 1) {
        const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
        writeCoverageSeedSpec(repoRoot, state.activeRunId);
        const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
        writeTextFile(
          harnessPaths.progressPath,
          progressContent
            .replace('  - Status: `todo`', '  - Status: `needs-verification`')
            .replace('  - Result: ``', '  - Result: `executor produced verifier-ready evidence`')
            .replace('  - Evidence: ``', '  - Evidence: `.qa-harness/runs/<run-id>/iterations/001/summary.json`'),
        );
      }
    },
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot worker output',
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: worker completed selected role work',
        'RALPH_VALIDATION: worker deferred to supervisor verify',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T08:37:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const firstPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'worker-prompt.md'), 'utf8');
  const secondPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '002', 'worker-prompt.md'), 'utf8');
  const firstSummary = JSON.parse(
    fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'summary.json'), 'utf8'),
  );
  const secondSummary = JSON.parse(
    fs.readFileSync(path.join(runPaths.iterationsDir, '002', 'summary.json'), 'utf8'),
  );
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(exitCode, 0);
  assert.equal(workerCalls.length, 2);
  assert.deepEqual(workerCalls.map((call) => call.args), [[], []]);
  assert.equal(workerPrompts.length, 2);
  assert.equal(workerPrompts[0], firstPrompt);
  assert.equal(workerPrompts[1], secondPrompt);
  assert.notEqual(workerPrompts[0], workerPrompts[1]);
  assert.match(firstPrompt, /^RALPH_AGENT: qa-executor$/m);
  assert.match(firstPrompt, /## Role Agent Template: `templates\/qa-agents\/executor\/agent.md`/);
  assert.doesNotMatch(firstPrompt, /## Role Agent Template: `templates\/qa-agents\/verifier\/agent.md`/);
  assert.match(secondPrompt, /^RALPH_AGENT: qa-verifier$/m);
  assert.match(secondPrompt, /## Role Agent Template: `templates\/qa-agents\/verifier\/agent.md`/);
  assert.doesNotMatch(secondPrompt, /## Role Agent Template: `templates\/qa-agents\/executor\/agent.md`/);
  assert.match(secondPrompt, /Status: `needs-verification`/);
  assert.equal(firstSummary.RALPH_AGENT, 'qa-executor');
  assert.equal(secondSummary.RALPH_AGENT, 'qa-verifier');
  assert.equal(result.iterationCount, 2);
  assert.deepEqual(result.iterations.map((iteration) => iteration.RALPH_AGENT), ['qa-executor', 'qa-verifier']);
  assert.match(progressContent, /- \[x\] `P-001` Goal: implement coverage and hand it to verifier\./);
  assert.match(progressContent, /Status: `pass`/);
});

test('run CLI routes executor pass through verifier before final completion', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T11:50:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-001', goal: 'implement coverage and require verifier acceptance.' },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
      writeCoverageSeedSpec(repoRoot, state.activeRunId);
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T11:51:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const firstPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'worker-prompt.md'), 'utf8');
  const secondPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '002', 'worker-prompt.md'), 'utf8');
  const firstValidation = JSON.parse(
    fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'validation.json'), 'utf8'),
  );
  const secondValidation = JSON.parse(
    fs.readFileSync(path.join(runPaths.iterationsDir, '002', 'validation.json'), 'utf8'),
  );
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(exitCode, 0);
  assert.equal(workerCalls.length, 2);
  assert.match(firstPrompt, /^RALPH_AGENT: qa-executor$/m);
  assert.match(secondPrompt, /^RALPH_AGENT: qa-verifier$/m);
  assert.match(secondPrompt, /Status: `needs-verification`/);
  assert.deepEqual(result.iterations.map((iteration) => iteration.RALPH_AGENT), ['qa-executor', 'qa-verifier']);
  assert.equal(firstValidation.RALPH_AGENT, 'qa-executor');
  assert.equal(secondValidation.RALPH_AGENT, 'qa-verifier');
  assert.equal(result.status, 'completed');
  assert.equal(result.stopReason, 'all-progress-passed');
  assert.match(progressContent, /- \[x\] `P-001` Goal: implement coverage and require verifier acceptance\./);
  assert.match(progressContent, /Status: `pass`/);
  assert.match(progressContent, /Result: `pass: worker completed selected item; supervisor verify passed`/);
});

test('run CLI writes role-named resolved prompt audit copies under the run directory', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T09:10:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-001', goal: 'implement coverage and hand it to verifier.' },
    ]),
  });
  let workerInvocation = 0;
  const { runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      workerInvocation += 1;

      if (workerInvocation === 1) {
        const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
        writeCoverageSeedSpec(repoRoot, state.activeRunId);
        const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
        writeTextFile(
          harnessPaths.progressPath,
          progressContent
            .replace('  - Status: `todo`', '  - Status: `needs-verification`')
            .replace('  - Result: ``', '  - Result: `executor produced verifier-ready evidence`')
            .replace('  - Evidence: ``', '  - Evidence: `.qa-harness/runs/<run-id>/iterations/001/summary.json`'),
        );
      }
    },
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot worker output',
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: worker completed selected role work',
        'RALPH_VALIDATION: worker deferred to supervisor verify',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T09:11:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const resolvedPromptsDir = path.join(runPaths.runDir, 'agents', 'resolved-prompts');
  const firstPromptPath = path.join(runPaths.iterationsDir, '001', 'worker-prompt.md');
  const secondPromptPath = path.join(runPaths.iterationsDir, '002', 'worker-prompt.md');
  const firstAuditPath = path.join(resolvedPromptsDir, '001-qa-executor.md');
  const secondAuditPath = path.join(resolvedPromptsDir, '002-qa-verifier.md');

  assert.equal(exitCode, 0);
  assert.equal(path.relative(runPaths.runDir, resolvedPromptsDir).startsWith('..'), false);
  assert.equal(path.relative(runPaths.runsDir, resolvedPromptsDir).startsWith('..'), false);
  assert.equal(fs.existsSync(firstAuditPath), true);
  assert.equal(fs.existsSync(secondAuditPath), true);
  assert.equal(fs.readFileSync(firstAuditPath, 'utf8'), fs.readFileSync(firstPromptPath, 'utf8'));
  assert.equal(fs.readFileSync(secondAuditPath, 'utf8'), fs.readFileSync(secondPromptPath, 'utf8'));
  assert.match(fs.readFileSync(firstAuditPath, 'utf8'), /^RALPH_AGENT: qa-executor$/m);
  assert.match(fs.readFileSync(secondAuditPath, 'utf8'), /^RALPH_AGENT: qa-verifier$/m);
});

test('run CLI routes retryable verifier failure to a fresh executor healing prompt', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T08:38:00.000Z'),
    progressContent: buildLeanProgressDocument([
      {
        id: 'P-RETRY',
        goal: 'heal a verifier-rejected coverage item.',
        owner: 'qa-verifier',
        agent: 'qa-verifier',
        mode: 'verification',
        status: 'fail',
        retryBudget: '1',
        result: 'verifier rejected prior proof',
        evidence: '.qa-harness/runs/<run-id>/iterations/001/validation.json',
      },
    ]),
  });
  const workerPrompts = [];
  const { calls, runner } = createLeanRunCommandRunner({
    onWorkerCall: ({ commandOptions }) => {
      workerPrompts.push(commandOptions.input);
    },
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot healing worker output',
        'RALPH_STATUS: blocked',
        'RALPH_SUMMARY: healing prompt inspected',
        'RALPH_VALIDATION: not run',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T08:39:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const workerPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'worker-prompt.md'), 'utf8');
  const summary = JSON.parse(fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'summary.json'), 'utf8'));
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(exitCode, 1);
  assert.equal(workerCalls.length, 1);
  assert.deepEqual(workerCalls[0].args, []);
  assert.equal(workerPrompts[0], workerPrompt);
  assert.match(workerPrompt, /^RALPH_AGENT: qa-executor$/m);
  assert.match(workerPrompt, /- Mode: `healing`/);
  assert.match(workerPrompt, /failed verification with retry budget remaining/);
  assert.match(workerPrompt, /P-RETRY` Goal: heal a verifier-rejected coverage item/);
  assert.match(workerPrompt, /Status: `fail`/);
  assert.match(workerPrompt, /verifier rejected prior proof/);
  assert.equal(summary.RALPH_AGENT, 'qa-executor');
});

test('run CLI routes verifier fail to healing while retry budget remains', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T11:52:00.000Z'),
    progressContent: buildLeanProgressDocument([
      {
        id: 'P-VERIFY-FAIL',
        goal: 'repair verifier-rejected evidence.',
        owner: 'qa-verifier',
        agent: 'qa-verifier',
        mode: 'verification',
        status: 'needs-verification',
        retryBudget: '1',
        result: 'executor evidence is ready',
        evidence: '.qa-harness/runs/<run-id>/iterations/001/summary.json',
      },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    workerResult: (callNumber) => {
      if (callNumber === 1) {
        return {
          status: 0,
          stdout: [
            'fake verifier rejection',
            'RALPH_STATUS: fail',
            'RALPH_SUMMARY: verifier rejected incomplete proof',
            'RALPH_VALIDATION: inspected submitted evidence',
            'RALPH_NEXT: heal and retry',
            '',
          ].join('\n'),
          stderr: '',
        };
      }

      return {
        status: 0,
        stdout: [
          'fake healing worker block',
          'RALPH_STATUS: blocked',
          'RALPH_SUMMARY: healing needs updated fixture data',
          'RALPH_VALIDATION: not run',
          'RALPH_NEXT: provide fixture data',
          '',
        ].join('\n'),
        stderr: '',
      };
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T11:53:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const firstValidation = JSON.parse(
    fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'validation.json'), 'utf8'),
  );
  const secondPrompt = fs.readFileSync(path.join(runPaths.iterationsDir, '002', 'worker-prompt.md'), 'utf8');
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(exitCode, 1);
  assert.equal(workerCalls.length, 2);
  assert.equal(firstValidation.RALPH_AGENT, 'qa-verifier');
  assert.equal(firstValidation.status, 'skipped');
  assert.match(firstValidation.reason, /Worker reported RALPH_STATUS: fail/);
  assert.match(secondPrompt, /^RALPH_AGENT: qa-executor$/m);
  assert.match(secondPrompt, /- Mode: `healing`/);
  assert.match(secondPrompt, /failed verification with retry budget remaining/);
  assert.deepEqual(result.iterations.map((iteration) => iteration.RALPH_AGENT), ['qa-verifier', 'qa-executor']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.stopReason, 'blocked');
});

test('run CLI stops verifier fail when retry budget is exhausted', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T11:54:00.000Z'),
    progressContent: buildLeanProgressDocument([
      {
        id: 'P-VERIFY-EXHAUSTED',
        goal: 'stop after verifier rejection with no retries.',
        owner: 'qa-verifier',
        agent: 'qa-verifier',
        mode: 'verification',
        status: 'needs-verification',
        retryBudget: '0',
        result: 'executor evidence is ready',
        evidence: '.qa-harness/runs/<run-id>/iterations/001/summary.json',
      },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner({
    workerResult: {
      status: 0,
      stdout: [
        'fake verifier rejection',
        'RALPH_STATUS: fail',
        'RALPH_SUMMARY: verifier rejected exhausted proof',
        'RALPH_VALIDATION: inspected submitted evidence',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    },
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T11:55:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const iterationValidation = JSON.parse(
    fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'validation.json'), 'utf8'),
  );
  const loopReport = fs.readFileSync(runPaths.loopReportPath, 'utf8');
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
  const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

  assert.equal(exitCode, 1);
  assert.equal(workerCalls.length, 1);
  assert.equal(state.terminalStatus, 'failed');
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'retry-budget-exhausted');
  assert.equal(iterationValidation.status, 'skipped');
  assert.equal(iterationValidation.RALPH_AGENT, 'qa-verifier');
  assert.match(iterationValidation.reason, /Worker reported RALPH_STATUS: fail/);
  assert.match(loopReport, /retry budget remaining/i);
  assert.match(progressContent, /Status: `fail`/);
  assert.match(progressContent, /Result: `fail: verifier rejected exhausted proof`/);
});

test('run CLI captures per-iteration worker output, summary, changed files, and diff patch', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/x.feature', [
    'Feature: Checkout',
    '',
    '  Scenario: Complete purchase',
    '    Given the browser session is open',
  ].join('\n'));
  fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

  prepare({
    repoRoot,
    from: 'Features/x.feature',
    platform: 'linux',
    now: new Date('2026-04-27T07:48:00.000Z'),
  });

  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      copilot: {
        command: 'fake-copilot',
      },
    }, null, 2)}\n`,
  );
  writeTextFile(path.join(repoRoot, 'pre-existing-dirty.txt'), 'already dirty before run\n');
  writeTextFile(path.join(repoRoot, 'worker-target.txt'), 'before worker\n');

  const { runner } = createLeanRunCommandRunner({
    onWorkerCall: ({ cwd }) => {
      writeTextFile(path.join(cwd, 'worker-target.txt'), 'after worker\n');
      writeTextFile(path.join(cwd, 'worker-created.txt'), 'created by worker\n');
      writeTextFile(path.join(cwd, 'worker-large.txt'), `${'x'.repeat(70 * 1024)}\n`);
      fs.writeFileSync(path.join(cwd, 'worker-binary.bin'), Buffer.from([0, 1, 2, 3, 255]));
    },
    workerResult: {
      status: 0,
      stdout: [
        'fake Copilot stdout line',
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: captured iteration evidence',
        'RALPH_VALIDATION: fake validation command',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: 'fake Copilot stderr line\n',
    },
  });
  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T07:49:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });

  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');
  const stdoutLog = fs.readFileSync(path.join(iterationDir, 'stdout.log'), 'utf8');
  const stderrLog = fs.readFileSync(path.join(iterationDir, 'stderr.log'), 'utf8');
  const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
  const diffPatch = fs.readFileSync(path.join(iterationDir, 'diff.patch'), 'utf8');

  assert.equal(exitCode, 1);
  assert.match(stdoutLog, /fake Copilot stdout line/);
  assert.match(stderrLog, /fake Copilot stderr line/);
  assert.equal(summary.iteration, 1);
  assert.equal(summary.command, 'fake-copilot');
  assert.equal(summary.exitCode, 0);
  assert.equal(typeof summary.durationMs, 'number');
  assert.ok(summary.durationMs >= 0);
  assert.deepEqual(summary.footer, {
    status: 'pass',
    summary: 'captured iteration evidence',
    validation: 'fake validation command',
    next: 'none',
  });
  assert.equal(summary.footerError, null);
  assert.deepEqual(
    summary.changedFiles.map((entry) => entry.path).sort(),
    ['worker-binary.bin', 'worker-created.txt', 'worker-large.txt', 'worker-target.txt'],
  );
  assert.equal(summary.changedFiles.some((entry) => entry.path === 'pre-existing-dirty.txt'), false);
  assert.match(diffPatch, /diff --git a\/worker-target\.txt b\/worker-target\.txt/);
  assert.match(diffPatch, /-before worker/);
  assert.match(diffPatch, /\+after worker/);
  assert.match(diffPatch, /diff --git a\/worker-created\.txt b\/worker-created\.txt/);
  assert.match(diffPatch, /\+created by worker/);
  assert.match(diffPatch, /worker-binary\.bin/);
  assert.match(diffPatch, /\[binary file omitted\]/);
  assert.match(diffPatch, /worker-large\.txt/);
  assert.match(diffPatch, /\[diff omitted: file exceeds/);
  assert.doesNotMatch(diffPatch, /pre-existing-dirty\.txt/);
});

test('run CLI diffs only include files changed by the current iteration', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T08:44:00.000Z'),
    progressContent: buildLeanProgressDocument([
      { id: 'P-001', goal: 'change one existing dirty file and create one new file.' },
      { id: 'P-002', goal: 'run without touching the previous iteration files.' },
    ]),
  });
  writeTextFile(path.join(repoRoot, 'pre-existing-dirty.txt'), 'dirty before run\n');
  let workerCallCount = 0;
  const { runner } = createLeanRunCommandRunner({
    onWorkerCall: ({ cwd }) => {
      workerCallCount += 1;
      if (workerCallCount === 1) {
        writeTextFile(path.join(cwd, 'pre-existing-dirty.txt'), 'dirty changed by iteration one\n');
        writeTextFile(path.join(cwd, 'iteration-one-created.txt'), 'created by iteration one\n');
      }
    },
    workerResult: (callNumber) => ({
      status: 0,
      stdout: [
        `fake Copilot iteration ${callNumber}`,
        'RALPH_STATUS: pass',
        `RALPH_SUMMARY: completed item ${callNumber}`,
        'RALPH_VALIDATION: supervisor verify',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      stderr: '',
    }),
  });

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T08:45:00.000Z'),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commandRunner: runner,
  });

  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const firstIterationDir = path.join(runPaths.iterationsDir, '001');
  const secondIterationDir = path.join(runPaths.iterationsDir, '002');
  const firstSummary = JSON.parse(fs.readFileSync(path.join(firstIterationDir, 'summary.json'), 'utf8'));
  const secondSummary = JSON.parse(fs.readFileSync(path.join(secondIterationDir, 'summary.json'), 'utf8'));
  const firstDiffPatch = fs.readFileSync(path.join(firstIterationDir, 'diff.patch'), 'utf8');
  const secondDiffPatch = fs.readFileSync(path.join(secondIterationDir, 'diff.patch'), 'utf8');

  assert.equal(exitCode, 1);
  assert.deepEqual(
    firstSummary.changedFiles.map((entry) => entry.path).sort(),
    ['iteration-one-created.txt', 'pre-existing-dirty.txt'],
  );
  assert.match(firstDiffPatch, /diff --git a\/pre-existing-dirty\.txt b\/pre-existing-dirty\.txt/);
  assert.match(firstDiffPatch, /-dirty before run/);
  assert.match(firstDiffPatch, /\+dirty changed by iteration one/);
  assert.match(firstDiffPatch, /diff --git a\/iteration-one-created\.txt b\/iteration-one-created\.txt/);
  assert.deepEqual(secondSummary.changedFiles, []);
  assert.match(secondDiffPatch, /No worker file changes detected for this iteration\./);
  assert.doesNotMatch(secondDiffPatch, /pre-existing-dirty\.txt/);
  assert.doesNotMatch(secondDiffPatch, /iteration-one-created\.txt/);
});

test('run CLI fails an iteration when the required worker footer is missing or invalid', (t) => {
  const cases = [
    {
      name: 'missing footer',
      stdout: 'fake Copilot output without footer\n',
      errorPattern: /Missing required footer field RALPH_STATUS\./,
    },
    {
      name: 'missing summary',
      stdout: [
        'RALPH_STATUS: pass',
        'RALPH_VALIDATION: fake validation command',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      errorPattern: /Missing required footer field RALPH_SUMMARY\./,
    },
    {
      name: 'missing validation',
      stdout: [
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: missing validation case',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      errorPattern: /Missing required footer field RALPH_VALIDATION\./,
    },
    {
      name: 'missing next action',
      stdout: [
        'RALPH_STATUS: pass',
        'RALPH_SUMMARY: missing next case',
        'RALPH_VALIDATION: fake validation command',
        '',
      ].join('\n'),
      errorPattern: /Missing required footer field RALPH_NEXT\./,
    },
    {
      name: 'invalid status',
      stdout: [
        'RALPH_STATUS: maybe',
        'RALPH_SUMMARY: invalid status case',
        'RALPH_VALIDATION: fake validation command',
        'RALPH_NEXT: none',
        '',
      ].join('\n'),
      errorPattern: /Invalid RALPH_STATUS "maybe"; expected pass, blocked, or fail\./,
    },
  ];

  for (const testCase of cases) {
    const repoRoot = createTempRepo(t);
    writeFeature(repoRoot, 'Features/x.feature', [
      'Feature: Checkout',
      '',
      '  Scenario: Complete purchase',
      '    Given the browser session is open',
    ].join('\n'));
    fs.mkdirSync(path.join(repoRoot, '.git', 'info'), { recursive: true });

    prepare({
      repoRoot,
      from: 'Features/x.feature',
      platform: 'linux',
      now: new Date('2026-04-27T07:58:00.000Z'),
    });

    const harnessPaths = resolveHarnessPaths(repoRoot);
    writeTextFile(
      harnessPaths.configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        copilot: {
          command: 'fake-copilot',
        },
      }, null, 2)}\n`,
    );

    let stdout = '';
    let stderr = '';
    const exitCode = runCli(['run', '--max-iterations', '1'], {
      repoRoot,
      now: new Date('2026-04-27T07:59:00.000Z'),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      commandRunner: () => ({
        status: 0,
        stdout: testCase.stdout,
        stderr: '',
      }),
    });
    const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
    const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
    const summary = JSON.parse(
      fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'summary.json'), 'utf8'),
    );

    assert.equal(exitCode, 1, testCase.name);
    assert.equal(stdout, '', testCase.name);
    assert.match(stderr, /Run .* stopped after 1 iterations: failed/, testCase.name);
    assert.equal(state.activeRunId, null, testCase.name);
    assert.equal(state.terminalStatus, 'failed', testCase.name);
    assert.equal(summary.exitCode, 0, testCase.name);
    assert.match(summary.footerError, testCase.errorPattern, testCase.name);
  }
});

test('run CLI marks the selected item complete only after Copilot pass and supervisor verify pass', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    progressContent: buildLeanProgressDocument([
      {
        id: 'P-VERIFY',
        goal: 'accept verifier-reviewed feature evidence.',
        owner: 'qa-verifier',
        agent: 'qa-verifier',
        mode: 'verification',
        status: 'needs-verification',
        retryBudget: '1',
        result: 'executor submitted evidence',
        evidence: '.qa-harness/runs/<run-id>/iterations/001/summary.json',
      },
    ]),
  });
  const { calls, runner } = createLeanRunCommandRunner();
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T08:10:00.000Z'),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: runner,
  });
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Run .* stopped after 1 iterations: completed/);
  assert.match(stdout, /stop reason: all-progress-passed/);
  assert.deepEqual(calls.map((call) => call.args), [
    [],
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list', '.features-gen/.qa-harness/runs/20260427T081000Z-run-x/normalized.feature.spec.js'],
    ['playwright', 'test', '.features-gen/.qa-harness/runs/20260427T081000Z-run-x/normalized.feature.spec.js'],
  ]);
  assert.match(progressContent, /- \[x\] `P-VERIFY` Goal: accept verifier-reviewed feature evidence\./);
  assert.match(progressContent, /Status: `pass`/);
  assert.match(progressContent, /Result: `pass: worker completed selected item; supervisor verify passed`/);
});

test('run CLI leaves the selected item unchecked when Copilot passes but supervisor verify fails', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t);
  const { calls, runner } = createLeanRunCommandRunner({
    exportResult: { status: 1, stdout: '', stderr: 'bddgen export failed\n' },
  });
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T08:12:00.000Z'),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Run .* stopped after 1 iterations: failed/);
  assert.deepEqual(calls.map((call) => call.args), [[], ['bddgen', 'export']]);
  assert.equal(state.activeRunId, null);
  assert.equal(state.terminalStatus, 'failed');
  assert.match(progressContent, /- \[ \] `P-001` Goal: execute `Features\/x\.feature`/);
  assert.match(progressContent, /Status: `fail`/);
  assert.match(progressContent, /Result: `fail: worker completed selected item; supervisor verify failed`/);
});

test('run CLI leaves the selected item unchecked and stops when Copilot reports fail or blocked', (t) => {
  const cases = [
    {
      name: 'fail',
      footerStatus: 'fail',
      summary: 'worker found a product failure',
      expectedTerminalStatus: 'failed',
      expectedExitCode: 1,
      stderrPattern: /Run .* stopped after 1 iterations: failed/,
    },
    {
      name: 'blocked',
      footerStatus: 'blocked',
      summary: 'worker needs manual setup',
      expectedTerminalStatus: 'blocked',
      expectedExitCode: 1,
      stderrPattern: /Run .* stopped after 1 iterations: blocked/,
    },
  ];

  for (const testCase of cases) {
    const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
      prepareNow: new Date('2026-04-27T08:14:00.000Z'),
    });
    const { calls, runner } = createLeanRunCommandRunner({
      workerResult: {
        status: 0,
        stdout: [
          'fake Copilot worker output',
          `RALPH_STATUS: ${testCase.footerStatus}`,
          `RALPH_SUMMARY: ${testCase.summary}`,
          'RALPH_VALIDATION: worker validation evidence',
          'RALPH_NEXT: none',
          '',
        ].join('\n'),
        stderr: '',
      },
    });
    let stdout = '';
    let stderr = '';

    const exitCode = runCli(['run', '--max-iterations', '1'], {
      repoRoot,
      now: new Date('2026-04-27T08:15:00.000Z'),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      commandRunner: runner,
    });
    const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
    const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');

    assert.equal(exitCode, testCase.expectedExitCode, testCase.name);
    assert.equal(stdout, '', testCase.name);
    assert.match(stderr, testCase.stderrPattern, testCase.name);
    assert.deepEqual(calls.map((call) => call.args), [[]], testCase.name);
    assert.equal(state.activeRunId, null, testCase.name);
    assert.equal(state.terminalStatus, testCase.expectedTerminalStatus, testCase.name);
    assert.match(progressContent, /- \[ \] `P-001` Goal: execute `Features\/x\.feature`/, testCase.name);
    assert.match(progressContent, new RegExp(`Status: \`${testCase.footerStatus}\``), testCase.name);
    assert.match(
      progressContent,
      new RegExp(`Result: \`${testCase.footerStatus}: ${testCase.summary}\``),
      testCase.name,
    );
  }
});

test('run CLI records result and loop report for terminal stop reasons', (t) => {
  const cases = [
    {
      name: 'missing footer',
      workerResult: {
        status: 0,
        stdout: 'fake Copilot output without footer\n',
        stderr: '',
      },
      expectedTerminalStatus: 'failed',
      expectedStopReason: 'missing-footer',
      expectedExitCode: 1,
      expectedStream: 'stderr',
      expectedIterationValidationStatus: 'skipped',
    },
    {
      name: 'worker fail footer',
      workerResult: {
        status: 0,
        stdout: [
          'fake Copilot worker output',
          'RALPH_STATUS: fail',
          'RALPH_SUMMARY: worker found a product failure',
          'RALPH_VALIDATION: worker validation evidence',
          'RALPH_NEXT: none',
          '',
        ].join('\n'),
        stderr: '',
      },
      expectedTerminalStatus: 'failed',
      expectedStopReason: 'worker-failed',
      expectedExitCode: 1,
      expectedStream: 'stderr',
      expectedIterationValidationStatus: 'skipped',
    },
    {
      name: 'validation fail',
      exportResult: { status: 1, stdout: '', stderr: 'bddgen export failed\n' },
      expectedTerminalStatus: 'failed',
      expectedStopReason: 'validation-failed',
      expectedExitCode: 1,
      expectedStream: 'stderr',
      expectedIterationValidationStatus: 'fail',
    },
    {
      name: 'blocked footer',
      workerResult: {
        status: 0,
        stdout: [
          'fake Copilot worker output',
          'RALPH_STATUS: blocked',
          'RALPH_SUMMARY: worker needs manual setup',
          'RALPH_VALIDATION: worker validation evidence',
          'RALPH_NEXT: install missing dependency',
          '',
        ].join('\n'),
        stderr: '',
      },
      expectedTerminalStatus: 'blocked',
      expectedStopReason: 'blocked',
      expectedExitCode: 1,
      expectedStream: 'stderr',
      expectedIterationValidationStatus: 'skipped',
    },
    {
      name: 'budget exhausted',
      maxIterations: '1',
      progressContent: buildLeanProgressDocument([
        { id: 'P-001', goal: 'run the first budgeted item.' },
        { id: 'P-002', goal: 'remain after the budget is exhausted.' },
      ]),
      expectedTerminalStatus: 'budget-exhausted',
      expectedStopReason: 'budget-exhausted',
      expectedExitCode: 1,
      expectedStream: 'stderr',
      expectedIterationValidationStatus: 'pass',
    },
  ];

  for (const testCase of cases) {
    const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
      prepareNow: new Date('2026-04-27T08:18:00.000Z'),
      progressContent: testCase.progressContent,
    });
    const { runner } = createLeanRunCommandRunner({
      workerResult: testCase.workerResult,
      exportResult: testCase.exportResult,
    });
    let stdout = '';
    let stderr = '';

    const exitCode = runCli(['run', '--max-iterations', testCase.maxIterations || '1'], {
      repoRoot,
      now: new Date('2026-04-27T08:19:00.000Z'),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      commandRunner: runner,
    });
    const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
    const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
    const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
    const loopReport = fs.readFileSync(runPaths.loopReportPath, 'utf8');
    const iterationValidation = JSON.parse(
      fs.readFileSync(path.join(runPaths.iterationsDir, '001', 'validation.json'), 'utf8'),
    );
    const operatorOutput = testCase.expectedStream === 'stdout' ? stdout : stderr;

    assert.equal(exitCode, testCase.expectedExitCode, testCase.name);
    assert.equal(state.activeRunId, null, testCase.name);
    assert.equal(state.terminalStatus, testCase.expectedTerminalStatus, testCase.name);
    assert.equal(result.status, testCase.expectedTerminalStatus, testCase.name);
    assert.equal(result.stopReason, testCase.expectedStopReason, testCase.name);
    assert.equal(result.exitCode, testCase.expectedExitCode, testCase.name);
    assert.equal(result.iterationCount, 1, testCase.name);
    assert.equal(iterationValidation.status, testCase.expectedIterationValidationStatus, testCase.name);
    assert.equal(iterationValidation.runId, state.latestRunId, testCase.name);
    assert.equal(iterationValidation.iteration, 1, testCase.name);
    assert.match(
      operatorOutput,
      new RegExp(`Run .* stopped after 1 iterations: ${testCase.expectedTerminalStatus}`),
      testCase.name,
    );
    assert.match(operatorOutput, new RegExp(`stop reason: ${testCase.expectedStopReason}`), testCase.name);
    assert.match(loopReport, new RegExp(`Final status: ${testCase.expectedTerminalStatus}`), testCase.name);
    assert.match(loopReport, new RegExp(`Stop reason: ${testCase.expectedStopReason}`), testCase.name);
    assert.match(loopReport, /Operator summary:/, testCase.name);
    if (testCase.expectedTerminalStatus === 'budget-exhausted') {
      assert.notEqual(result.status, 'completed', testCase.name);
      assert.match(loopReport, /Budget was exhausted before all progress items completed\./, testCase.name);
    }
  }
});

test('run CLI writes the complete lean run artifact set with zero-padded iteration directories', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T08:24:00.000Z'),
    progressContent: buildLeanProgressDocument([
      {
        id: 'P-VERIFY',
        goal: 'accept verifier-reviewed artifact evidence.',
        owner: 'qa-verifier',
        agent: 'qa-verifier',
        mode: 'verification',
        status: 'needs-verification',
        retryBudget: '1',
        result: 'executor submitted evidence',
        evidence: '.qa-harness/runs/<run-id>/iterations/001/summary.json',
      },
    ]),
  });
  const { runner } = createLeanRunCommandRunner();
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T08:25:00.000Z'),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Run .* stopped after 1 iterations: completed/);
  assert.match(stdout, /stop reason: all-progress-passed/);
  assert.equal(fs.existsSync(path.join(runPaths.runsDir, '1')), false);
  assert.equal(fs.existsSync(path.join(runPaths.runsDir, '01')), false);
  assert.equal(fs.existsSync(runPaths.resultPath), true);
  assert.equal(fs.existsSync(runPaths.loopReportPath), true);
  assert.equal(fs.existsSync(runPaths.validationPath), true);
  assert.equal(fs.existsSync(iterationDir), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'worker-prompt.md')), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'summary.json')), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'validation.json')), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'diff.patch')), true);

  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const runValidation = JSON.parse(fs.readFileSync(runPaths.validationPath, 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
  const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));
  const loopReport = fs.readFileSync(runPaths.loopReportPath, 'utf8');
  const workerPrompt = fs.readFileSync(path.join(iterationDir, 'worker-prompt.md'), 'utf8');
  const diffPatch = fs.readFileSync(path.join(iterationDir, 'diff.patch'), 'utf8');

  assert.equal(result.runId, state.latestRunId);
  assert.equal(result.status, 'completed');
  assert.equal(result.stopReason, 'all-progress-passed');
  assert.equal(result.iterationCount, 1);
  assert.equal(result.iterations[0].RALPH_AGENT, 'qa-verifier');
  assert.equal(runValidation.status, 'pass');
  assert.equal(runValidation.runId, state.latestRunId);
  assert.equal(summary.iteration, 1);
  assert.equal(summary.RALPH_AGENT, 'qa-verifier');
  assert.equal(summary.footer.status, 'pass');
  assert.equal(iterationValidation.status, 'pass');
  assert.equal(iterationValidation.runId, state.latestRunId);
  assert.equal(iterationValidation.iteration, 1);
  assert.equal(iterationValidation.RALPH_AGENT, 'qa-verifier');
  assert.equal(Array.isArray(iterationValidation.commands), true);
  assert.match(loopReport, /# QA Harness Loop Report/);
  assert.match(loopReport, /Run id:/);
  assert.match(loopReport, /Final status: completed/);
  assert.match(loopReport, /Stop reason: all-progress-passed/);
  assert.match(loopReport, /- Iteration 1: RALPH_AGENT qa-verifier/);
  assert.match(workerPrompt, /# Copilot Worker Prompt/);
  assert.match(workerPrompt, /## Selected Progress Item/);
  assert.match(diffPatch, /No worker file changes detected for this iteration\.|diff --git/);
});

test('run CLI writes the complete four-agent run artifact model', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T12:02:00.000Z'),
    progressContent: buildLeanProgressDocument([
      {
        id: 'P-ARTIFACTS',
        goal: 'produce and verify the complete four-agent artifact layout.',
        owner: 'qa-executor',
        agent: 'qa-executor',
        mode: 'implementation',
        status: 'todo',
        retryBudget: '1',
        output: 'run-root seed proof, iteration evidence, prompt audit, validation, and diff artifacts',
      },
    ]),
  });
  const { runner } = createLeanRunCommandRunner({
    onWorkerCall({ cwd, callNumber }) {
      if (callNumber !== 1) {
        return;
      }

      const state = JSON.parse(fs.readFileSync(resolveHarnessPaths(cwd).statePath, 'utf8'));
      writeCoverageSeedSpec(cwd, state.activeRunId);
      writeTextFile(path.join(cwd, 'worker-proof.txt'), 'proof from executor iteration\n');
    },
  });
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T12:03:00.000Z'),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const firstIterationDir = path.join(runPaths.iterationsDir, '001');
  const secondIterationDir = path.join(runPaths.iterationsDir, '002');
  const firstResolvedPromptPath = path.join(runPaths.resolvedPromptsDir, '001-qa-executor.md');
  const secondResolvedPromptPath = path.join(runPaths.resolvedPromptsDir, '002-qa-verifier.md');
  const seedEvidencePath = path.join(firstIterationDir, 'evidence', 'playwright-cli-seed.json');

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Run .* stopped after 2 iterations: completed/);
  assert.equal(fs.existsSync(runPaths.resultPath), true);
  assert.equal(fs.existsSync(runPaths.loopReportPath), true);
  assert.equal(fs.existsSync(runPaths.validationPath), true);
  assert.equal(fs.existsSync(runPaths.diffPatchPath), true);
  assert.equal(fs.existsSync(runPaths.seedSpecPath), true);
  assert.equal(fs.existsSync(runPaths.resolvedPromptsDir), true);
  assert.equal(fs.existsSync(firstResolvedPromptPath), true);
  assert.equal(fs.existsSync(secondResolvedPromptPath), true);
  assert.equal(fs.existsSync(firstIterationDir), true);
  assert.equal(fs.existsSync(secondIterationDir), true);

  for (const iterationDir of [firstIterationDir, secondIterationDir]) {
    assert.equal(fs.existsSync(path.join(iterationDir, 'worker-prompt.md')), true);
    assert.equal(fs.existsSync(path.join(iterationDir, 'stdout.log')), true);
    assert.equal(fs.existsSync(path.join(iterationDir, 'stderr.log')), true);
    assert.equal(fs.existsSync(path.join(iterationDir, 'summary.json')), true);
    assert.equal(fs.existsSync(path.join(iterationDir, 'validation.json')), true);
    assert.equal(fs.existsSync(path.join(iterationDir, 'diff.patch')), true);
    assert.equal(fs.existsSync(path.join(iterationDir, 'evidence')), true);
  }

  assert.equal(fs.existsSync(seedEvidencePath), true);
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const runValidation = JSON.parse(fs.readFileSync(runPaths.validationPath, 'utf8'));
  const firstSummary = JSON.parse(fs.readFileSync(path.join(firstIterationDir, 'summary.json'), 'utf8'));
  const secondSummary = JSON.parse(fs.readFileSync(path.join(secondIterationDir, 'summary.json'), 'utf8'));
  const seedEvidence = JSON.parse(fs.readFileSync(seedEvidencePath, 'utf8'));
  const runDiffPatch = fs.readFileSync(runPaths.diffPatchPath, 'utf8');
  const firstResolvedPrompt = fs.readFileSync(firstResolvedPromptPath, 'utf8');
  const secondResolvedPrompt = fs.readFileSync(secondResolvedPromptPath, 'utf8');

  assert.equal(result.status, 'completed');
  assert.equal(result.stopReason, 'all-progress-passed');
  assert.equal(result.iterationCount, 2);
  assert.deepEqual(result.iterations.map((entry) => entry.RALPH_AGENT), ['qa-executor', 'qa-verifier']);
  assert.equal(runValidation.status, 'pass');
  assert.equal(runValidation.runId, state.latestRunId);
  assert.equal(firstSummary.RALPH_AGENT, 'qa-executor');
  assert.equal(secondSummary.RALPH_AGENT, 'qa-verifier');
  assert.equal(seedEvidence.RALPH_AGENT, 'qa-executor');
  assert.equal(seedEvidence.seedSpecPath, `.qa-harness/runs/${state.latestRunId}/seed.spec.ts`);
  assert.match(firstResolvedPrompt, /RALPH_AGENT: qa-executor/);
  assert.match(secondResolvedPrompt, /RALPH_AGENT: qa-verifier/);
  assert.match(runDiffPatch, /# Iteration 1: RALPH_AGENT qa-executor/);
  assert.match(runDiffPatch, /worker-proof\.txt/);
});

test('run CLI fails before worker execution when the selected item has no valid QA agent role', (t) => {
  const cases = [
    {
      name: 'invalid owner',
      owner: 'qa-explorer',
      errorPattern: /Invalid QA agent role "qa-explorer"/,
    },
    {
      name: 'missing owner',
      owner: null,
      errorPattern: /Selected progress item P-001 is missing a QA agent Owner field/,
    },
  ];

  for (const testCase of cases) {
    const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
      prepareNow: new Date('2026-04-27T08:28:00.000Z'),
      progressContent: buildLeanProgressDocument([
        { id: 'P-001', goal: `stop before worker execution for ${testCase.name}.`, owner: testCase.owner },
      ]),
    });
    const { calls, runner } = createLeanRunCommandRunner();
    let stdout = '';
    let stderr = '';

    const exitCode = runCli(['run', '--max-iterations', '1'], {
      repoRoot,
      now: new Date('2026-04-27T08:29:00.000Z'),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      commandRunner: runner,
    });
    const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
    const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
    const iterationDir = path.join(runPaths.iterationsDir, '001');
    const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
    const summary = JSON.parse(fs.readFileSync(path.join(iterationDir, 'summary.json'), 'utf8'));
    const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));
    const loopReport = fs.readFileSync(runPaths.loopReportPath, 'utf8');
    const workerCalls = calls.filter((call) => call.command === 'fake-copilot');

    assert.equal(exitCode, 1, testCase.name);
    assert.equal(stdout, '', testCase.name);
    assert.match(stderr, /stop reason: invalid-agent-role/, testCase.name);
    assert.equal(workerCalls.length, 0, testCase.name);
    assert.equal(fs.existsSync(path.join(iterationDir, 'worker-prompt.md')), false, testCase.name);
    assert.equal(state.terminalStatus, 'failed', testCase.name);
    assert.equal(result.status, 'failed', testCase.name);
    assert.equal(result.stopReason, 'invalid-agent-role', testCase.name);
    assert.equal(result.iterations[0].RALPH_AGENT, 'qa-orchestrator', testCase.name);
    assert.match(result.iterations[0].roleError, testCase.errorPattern, testCase.name);
    assert.equal(summary.RALPH_AGENT, 'qa-orchestrator', testCase.name);
    assert.equal(summary.footerError, null, testCase.name);
    assert.match(summary.roleError, testCase.errorPattern, testCase.name);
    assert.equal(iterationValidation.RALPH_AGENT, 'qa-orchestrator', testCase.name);
    assert.equal(iterationValidation.status, 'skipped', testCase.name);
    assert.match(iterationValidation.reason, testCase.errorPattern, testCase.name);
    assert.match(loopReport, /- Iteration 1: RALPH_AGENT qa-orchestrator/, testCase.name);
    assert.match(loopReport, testCase.errorPattern, testCase.name);
  }
});

test('status and report artifacts stay linked to a run created through the CLI', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T08:32:00.000Z'),
    progressContent: buildLeanProgressDocument([
      {
        id: 'P-VERIFY',
        goal: 'accept verifier-reviewed report evidence.',
        owner: 'qa-verifier',
        agent: 'qa-verifier',
        mode: 'verification',
        status: 'needs-verification',
        retryBudget: '1',
        result: 'executor submitted evidence',
        evidence: '.qa-harness/runs/<run-id>/iterations/001/summary.json',
      },
    ]),
  });
  const { runner } = createLeanRunCommandRunner();
  let runStdout = '';
  let runStderr = '';

  const runExitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T08:33:00.000Z'),
    stdout: { write: (value) => { runStdout += value; } },
    stderr: { write: (value) => { runStderr += value; } },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runId = state.latestRunId;
  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  const iterationDir = path.join(runPaths.iterationsDir, '001');

  let statusStdout = '';
  let statusStderr = '';
  const statusExitCode = runCli(['status'], {
    repoRoot,
    stdout: { write: (value) => { statusStdout += value; } },
    stderr: { write: (value) => { statusStderr += value; } },
  });

  assert.equal(runExitCode, 0);
  assert.equal(runStderr, '');
  assert.match(runStdout, new RegExp(`Run ${runId} stopped after 1 iterations: completed`));
  assert.match(runStdout, /stop reason: all-progress-passed/);
  assert.equal(statusExitCode, 0);
  assert.equal(statusStderr, '');
  assert.match(statusStdout, new RegExp(`Run id: ${runId}`));
  assert.match(statusStdout, /Run status: completed/);
  assert.match(statusStdout, /Stop reason: all-progress-passed/);
  assert.match(statusStdout, /Validation status: pass/);
  assert.match(statusStdout, new RegExp(`Validation artifact: \\.qa-harness/runs/${runId}/validation\\.json`));

  assert.equal(fs.existsSync(runPaths.resultPath), true);
  assert.equal(fs.existsSync(runPaths.loopReportPath), true);
  assert.equal(fs.existsSync(runPaths.validationPath), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'summary.json')), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'validation.json')), true);

  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const runValidation = JSON.parse(fs.readFileSync(runPaths.validationPath, 'utf8'));
  const iterationValidation = JSON.parse(fs.readFileSync(path.join(iterationDir, 'validation.json'), 'utf8'));
  const loopReport = fs.readFileSync(runPaths.loopReportPath, 'utf8');

  assert.equal(result.runId, runId);
  assert.equal(runValidation.runId, runId);
  assert.equal(iterationValidation.runId, runId);
  assert.match(loopReport, new RegExp(`Run id: ${runId}`));
});

test('run CLI stops as stalled when a pass leaves the selected item actionable', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t);
  const { runner } = createLeanRunCommandRunner({
    onWorkerCall: () => {
      const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');
      writeTextFile(harnessPaths.progressPath, progressContent.replace(/`P-001`/g, '`P-999`'));
    },
  });
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['run', '--max-iterations', '1'], {
    repoRoot,
    now: new Date('2026-04-27T08:21:00.000Z'),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: runner,
  });
  const state = JSON.parse(fs.readFileSync(harnessPaths.statePath, 'utf8'));
  const runPaths = resolveHarnessPaths(repoRoot, { runId: state.latestRunId });
  const result = JSON.parse(fs.readFileSync(runPaths.resultPath, 'utf8'));
  const loopReport = fs.readFileSync(runPaths.loopReportPath, 'utf8');
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Run .* stopped after 1 iterations: stalled/);
  assert.match(stderr, /stop reason: selected-item-not-completed/);
  assert.equal(state.activeRunId, null);
  assert.equal(state.terminalStatus, 'stalled');
  assert.equal(result.status, 'stalled');
  assert.equal(result.stopReason, 'selected-item-not-completed');
  assert.equal(result.exitCode, 1);
  assert.match(loopReport, /Final status: stalled/);
  assert.match(loopReport, /Stop reason: selected-item-not-completed/);
  assert.match(loopReport, /The selected progress item was not completed after a pass footer and supervisor verify pass\./);
  assert.match(progressContent, /- \[ \] `P-999` Goal: execute `Features\/x\.feature`/);
});

test('verify runs bddgen export and captures command output', (t) => {
  const repoRoot = createTempRepo(t);
  const calls = [];
  const result = verify({
    repoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      calls.push({ command, args, cwd, commandOptions });
      return {
        status: 0,
        stdout: 'List of all steps (7)\n',
        stderr: 'export warning\n',
      };
    },
  });

  assert.equal(result.status, 'pass');
  assert.equal(result.exportedStepCount, 7);
  assert.equal(result.commands.length, 2);
  assert.deepEqual(calls.map((call) => call.args), [['bddgen', 'export'], ['bddgen', 'test']]);
  assert.ok(calls.every((call) => call.cwd === repoRoot));
  assert.match(result.commands[0].commandDisplay, /^npx(?:\.cmd)? bddgen export$/);
  assert.equal(result.commands[0].exitCode, 0);
  assert.equal(result.commands[0].stdout, 'List of all steps (7)\n');
  assert.equal(result.commands[0].stderr, 'export warning\n');
  assert.equal(typeof result.commands[0].durationMs, 'number');
  assert.ok(result.commands[0].durationMs >= 0);
  assert.match(result.output, /bddgen export registered 7 steps/);
});

test('verify runs bddgen test after export passes and discovers generated specs', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T063600Z-verify';
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId: runId,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );

  const calls = [];
  const generatedSpecPath = path.join(
    repoRoot,
    '.features-gen',
    '.qa-harness',
    'runs',
    runId,
    'normalized.feature.spec.js',
  );
  const result = verify({
    repoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      calls.push({ command, args, cwd, commandOptions });

      if (args[0] === 'bddgen' && args[1] === 'export') {
        return {
          status: 0,
          stdout: 'List of all steps (7)\n',
          stderr: 'export warning\n',
        };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        writeGeneratedSpec(cwd, runId);
        return {
          status: 0,
          stdout: 'generated specs\n',
          stderr: 'test warning\n',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
        return {
          status: 0,
          stdout: 'Total: 2 tests\n',
          stderr: 'list warning\n',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test') {
        return {
          status: 0,
          stdout: '2 passed (0.2s)\n',
          stderr: 'execution warning\n',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });
  const relativeGeneratedSpecPath = path.relative(repoRoot, generatedSpecPath).replace(/\\/g, '/');

  assert.equal(result.status, 'pass');
  assert.equal(result.runId, runId);
  assert.equal(result.listedTestCount, 2);
  assert.equal(result.executedTestCount, 2);
  assert.deepEqual(result.commands.map((commandResult) => commandResult.exitCode), [0, 0, 0, 0]);
  assert.deepEqual(calls.map((call) => call.args), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list', relativeGeneratedSpecPath],
    ['playwright', 'test', relativeGeneratedSpecPath],
  ]);
  assert.ok(calls.every((call) => call.cwd === repoRoot));
  assert.match(result.commands[1].commandDisplay, /^npx(?:\.cmd)? bddgen test$/);
  assert.equal(result.commands[1].stdout, 'generated specs\n');
  assert.equal(result.commands[1].stderr, 'test warning\n');
  assert.equal(typeof result.commands[1].durationMs, 'number');
  assert.ok(result.commands[1].durationMs >= 0);
  assert.match(result.commands[2].commandDisplay, /^npx(?:\.cmd)? playwright test --list \.features-gen\/\.qa-harness\/runs\/20260427T063600Z-verify\/normalized\.feature\.spec\.js$/);
  assert.equal(result.commands[2].stdout, 'Total: 2 tests\n');
  assert.equal(result.commands[2].stderr, 'list warning\n');
  assert.equal(typeof result.commands[2].durationMs, 'number');
  assert.ok(result.commands[2].durationMs >= 0);
  assert.match(result.commands[3].commandDisplay, /^npx(?:\.cmd)? playwright test \.features-gen\/\.qa-harness\/runs\/20260427T063600Z-verify\/normalized\.feature\.spec\.js$/);
  assert.equal(result.commands[3].stdout, '2 passed (0.2s)\n');
  assert.equal(result.commands[3].stderr, 'execution warning\n');
  assert.equal(typeof result.commands[3].durationMs, 'number');
  assert.ok(result.commands[3].durationMs >= 0);
  assert.deepEqual(result.generatedSpecs, [generatedSpecPath]);
  assert.match(result.output, /bddgen test generated 1 spec/);
  assert.match(result.output, /playwright test --list found 2 tests/);
  assert.match(result.output, /playwright test executed 2 tests/);
});

test('verify records validation output for the active run when a run exists', (t) => {
  const repoRoot = createTempRepo(t);
  const latestRunId = '20260427T065100Z-latest';
  const activeRunId = '20260427T065200Z-active';
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId,
      activeRunId,
      terminalStatus: null,
    }, null, 2)}\n`,
  );

  const result = verify({
    repoRoot,
    commandRunner: (command, args, cwd) => {
      if (args[0] === 'bddgen' && args[1] === 'export') {
        return {
          status: 0,
          stdout: 'List of all steps (5)\n',
          stderr: 'export warning\n',
        };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        writeGeneratedSpec(cwd, activeRunId);
        return {
          status: 0,
          stdout: 'generated specs\n',
          stderr: 'test warning\n',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
        return {
          status: 0,
          stdout: 'Total: 1 test\n',
          stderr: 'list warning\n',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test') {
        return {
          status: 0,
          stdout: '1 passed (0.1s)\n',
          stderr: 'execution warning\n',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  const activeRunPaths = resolveHarnessPaths(repoRoot, { runId: activeRunId });
  const latestRunPaths = resolveHarnessPaths(repoRoot, { runId: latestRunId });
  const validation = JSON.parse(fs.readFileSync(activeRunPaths.validationPath, 'utf8'));

  assert.equal(result.status, 'pass');
  assert.equal(result.runId, activeRunId);
  assert.equal(fs.existsSync(latestRunPaths.validationPath), false);
  assert.equal(validation.status, 'pass');
  assert.equal(validation.runId, activeRunId);
  assert.equal(validation.exportedStepCount, 5);
  assert.equal(validation.listedTestCount, 1);
  assert.equal(validation.executedTestCount, 1);
  assert.equal(validation.commands.length, 4);
  assert.match(validation.commands[0].commandDisplay, /^npx(?:\.cmd)? bddgen export$/);
  assert.match(validation.commands[1].commandDisplay, /^npx(?:\.cmd)? bddgen test$/);
  assert.match(validation.commands[2].commandDisplay, /^npx(?:\.cmd)? playwright test --list /);
  assert.match(validation.commands[3].commandDisplay, /^npx(?:\.cmd)? playwright test /);
  assert.doesNotMatch(validation.commands[3].commandDisplay, /--list/);
  assert.equal(validation.commands[0].stdout, 'List of all steps (5)\n');
  assert.equal(validation.commands[1].stdout, 'generated specs\n');
  assert.equal(validation.commands[2].stdout, 'Total: 1 test\n');
  assert.equal(validation.commands[3].stdout, '1 passed (0.1s)\n');
  for (const commandResult of validation.commands) {
    assert.match(commandResult.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(commandResult.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof commandResult.durationMs, 'number');
  }
});

test('coverage verifier rejects runs without seed proof before BDD verification', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T110000Z-coverage-no-seed';
  writeCoverageVerificationState(repoRoot, runId);
  const calls = [];

  const result = verify({
    repoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      calls.push({ command, args, cwd, commandOptions });
      return { status: 0, stdout: 'List of all steps (4)\n', stderr: '' };
    },
  });
  const validation = JSON.parse(fs.readFileSync(resolveHarnessPaths(repoRoot, { runId }).validationPath, 'utf8'));

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(result.commands, []);
  assert.match(result.output, /Playwright CLI seed proof is required for coverage verification/);
  assert.equal(validation.status, 'fail');
  assert.match(validation.coverageProofError, /Playwright CLI seed proof is required/);
});

test('coverage verifier rejects seed proof not executed by Playwright CLI', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T110100Z-coverage-manual-seed';
  writeCoverageVerificationState(repoRoot, runId);
  writeCoverageSeedSpec(repoRoot, runId);
  writeCoverageSeedEvidence(repoRoot, runId, {
    type: 'manual-seed-proof',
    command: 'node',
    args: [`.qa-harness/runs/${runId}/seed.spec.ts`],
    commandDisplay: `node .qa-harness/runs/${runId}/seed.spec.ts`,
  });
  const { calls, runner } = createCoverageVerifyCommandRunner(runId);

  const result = verify({ repoRoot, commandRunner: runner });

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, []);
  assert.match(result.output, /seed proof must be executed by Playwright CLI/);
});

test('coverage verifier rejects failed seed proof without MCP fallback evidence', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T110150Z-coverage-failed-seed-no-fallback';
  writeCoverageVerificationState(repoRoot, runId);
  writeCoverageSeedSpec(repoRoot, runId);
  writeCoverageSeedEvidence(repoRoot, runId, {
    exitCode: 1,
    stdout: '',
    stderr: 'browser launch failed before discovery\n',
  });
  const { calls, runner } = createCoverageVerifyCommandRunner(runId);

  const result = verify({ repoRoot, commandRunner: runner });
  const validation = JSON.parse(fs.readFileSync(resolveHarnessPaths(repoRoot, { runId }).validationPath, 'utf8'));

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, []);
  assert.match(result.output, /Playwright CLI seed proof failed before coverage verification/);
  assert.equal(validation.status, 'fail');
  assert.equal(validation.coverageProof.seedProofStatus, 'failed');
  assert.match(validation.coverageProofError, /Playwright CLI seed proof failed/);
});

test('coverage verifier rejects MCP fallback without fallback reason or MCP evidence', (t) => {
  const cases = [
    {
      name: 'missing fallback reason',
      runId: '20260427T110200Z-coverage-mcp-no-reason',
      evidence: 'MCP accessibility snapshot observed button "Continue"',
      fallbackReason: '',
      expected: /MCP fallback requires a fallback reason/,
    },
    {
      name: 'missing MCP evidence',
      runId: '20260427T110300Z-coverage-mcp-no-evidence',
      evidence: '',
      fallbackReason: 'MCP fallback used after Playwright CLI seed discovery failed',
      expected: /MCP fallback requires MCP evidence/,
    },
  ];

  for (const testCase of cases) {
    const repoRoot = createTempRepo(t);
    writeCoverageVerificationState(repoRoot, testCase.runId, {
      evidence: testCase.evidence,
      fallbackReason: testCase.fallbackReason,
    });
    writeCoverageSeedSpec(repoRoot, testCase.runId);
    writeCoverageSeedEvidence(repoRoot, testCase.runId, {
      exitCode: 1,
      stdout: '',
      stderr: 'browser launch failed before discovery\n',
    });
    const { calls, runner } = createCoverageVerifyCommandRunner(testCase.runId);

    const result = verify({ repoRoot, commandRunner: runner });

    assert.equal(result.status, 'fail', testCase.name);
    assert.equal(result.exitCode, 1, testCase.name);
    assert.deepEqual(calls, [], testCase.name);
    assert.match(result.output, testCase.expected, testCase.name);
  }
});

test('coverage verifier rejects list-only proof without full Playwright execution evidence', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T110400Z-coverage-list-only';
  writeCoverageVerificationState(repoRoot, runId);
  writeCoverageSeedSpec(repoRoot, runId);
  writeCoverageSeedEvidence(repoRoot, runId);
  const { calls, runner } = createCoverageVerifyCommandRunner(runId, {
    executeResult: { status: 0, stdout: 'browser launched but no tests reported\n', stderr: '' },
  });

  const result = verify({ repoRoot, commandRunner: runner });

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.equal(result.listedTestCount, 1);
  assert.equal(result.executedTestCount, 0);
  assert.equal(result.commands.length, 4);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list'],
    ['playwright', 'test', '.features-gen/.qa-harness/runs/20260427T110400Z-coverage-list-only/normalized.feature.spec.js'],
  ]);
  assert.match(result.output, /playwright test execution did not report executed tests/);
});

test('coverage verifier rejects failed runtime execution even with seed and list proof', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T110500Z-coverage-runtime-fail';
  writeCoverageVerificationState(repoRoot, runId);
  writeCoverageSeedSpec(repoRoot, runId);
  writeCoverageSeedEvidence(repoRoot, runId);
  const { calls, runner } = createCoverageVerifyCommandRunner(runId, {
    executeResult: { status: 7, stdout: '1 failed\n', stderr: 'runtime failure\n' },
  });

  const result = verify({ repoRoot, commandRunner: runner });

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.equal(result.commands.length, 4);
  assert.equal(result.commands[3].exitCode, 7);
  assert.equal(calls.some((call) => call.args[0] === 'playwright' && call.args[1] === 'test' && call.args[2] !== '--list'), true);
  assert.match(result.output, /playwright test failed with exit code 7/);
});

test('coverage verifier accepts only complete seed, CLI-first, fallback, and runtime proof', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T110600Z-coverage-complete-proof';
  writeCoverageVerificationState(repoRoot, runId);
  writeCoverageSeedSpec(repoRoot, runId);
  writeCoverageSeedEvidence(repoRoot, runId);
  const { calls, runner } = createCoverageVerifyCommandRunner(runId, {
    listResult: { status: 0, stdout: 'Total: 2 tests\n', stderr: '' },
    executeResult: { status: 0, stdout: '2 passed (0.2s)\n', stderr: '' },
  });

  const result = verify({ repoRoot, commandRunner: runner });
  const validation = JSON.parse(fs.readFileSync(resolveHarnessPaths(repoRoot, { runId }).validationPath, 'utf8'));

  assert.equal(result.status, 'pass');
  assert.equal(result.exitCode, undefined);
  assert.equal(result.listedTestCount, 2);
  assert.equal(result.executedTestCount, 2);
  assert.equal(result.commands.length, 4);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list'],
    ['playwright', 'test', '.features-gen/.qa-harness/runs/20260427T110600Z-coverage-complete-proof/normalized.feature.spec.js'],
  ]);
  assert.match(result.output, /Verification passed/);
  assert.equal(validation.status, 'pass');
  assert.equal(validation.coverageProof.seedProofStatus, 'pass');
  assert.equal(validation.coverageProof.fullExecutionStatus, 'pass');
});

test('verify CLI passes with an injected command runner and clear operator output', (t) => {
  const result = runVerifyCliWithInjectedRunner(t);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls.map((call) => call.args.slice(0, 3)), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list'],
    ['playwright', 'test', '.features-gen/.qa-harness/runs/20260427T071800Z-cli-verify/normalized.feature.spec.js'],
  ]);
  assert.ok(result.calls.every((call) => call.cwd === result.repoRoot));
  assert.match(result.stdout, /Verification passed: bddgen export registered 6 steps/);
  assert.match(result.stdout, /bddgen test generated 1 spec/);
  assert.match(result.stdout, /playwright test --list found 2 tests/);
  assert.match(result.stdout, /playwright test executed 2 tests/);
  assert.match(result.stdout, /Command: npx(?:\.cmd)? bddgen export/);
  assert.match(result.stdout, /Command: npx(?:\.cmd)? bddgen test/);
  assert.match(result.stdout, /Command: npx(?:\.cmd)? playwright test --list/);
  assert.match(result.stdout, /Command: npx(?:\.cmd)? playwright test \.features-gen\/\.qa-harness\/runs\/20260427T071800Z-cli-verify\/normalized\.feature\.spec\.js/);
});

test('verify CLI stops on bddgen failure with clear operator output', (t) => {
  const result = runVerifyCliWithInjectedRunner(t, {
    testResult: {
      status: 4,
      stdout: 'partial generation\n',
      stderr: 'bddgen test failed\n',
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.calls.map((call) => call.args), [['bddgen', 'export'], ['bddgen', 'test']]);
  assert.match(result.stderr, /Verification failed: bddgen test failed with exit code 4/);
  assert.match(result.stderr, /Stdout: partial generation/);
  assert.match(result.stderr, /Stderr: bddgen test failed/);
  assert.doesNotMatch(result.stderr, /playwright test --list/);
});

test('verify CLI fails when generated specs are missing with clear operator output', (t) => {
  const result = runVerifyCliWithInjectedRunner(t, {
    runId: '20260427T071900Z-cli-nospec',
    writeGeneratedSpecOnTest: false,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.calls.map((call) => call.args), [['bddgen', 'export'], ['bddgen', 'test']]);
  assert.match(
    result.stderr,
    /Verification failed: No generated Playwright specs were found for run 20260427T071900Z-cli-nospec/,
  );
  assert.match(result.stderr, /Command: npx(?:\.cmd)? bddgen export/);
  assert.match(result.stderr, /Command: npx(?:\.cmd)? bddgen test/);
  assert.doesNotMatch(result.stderr, /playwright test --list/);
});

test('verify fails when bddgen export fails or reports zero steps', (t) => {
  const failingRepoRoot = createTempRepo(t);
  const failedExportCalls = [];
  const failedExport = verify({
    repoRoot: failingRepoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      failedExportCalls.push({ command, args, cwd, commandOptions });
      return {
        status: 2,
        stdout: 'partial output\n',
        stderr: 'export failed\n',
      };
    },
  });

  assert.equal(failedExport.status, 'fail');
  assert.equal(failedExport.exitCode, 1);
  assert.deepEqual(failedExportCalls.map((call) => call.args), [['bddgen', 'export']]);
  assert.equal(failedExport.commands[0].exitCode, 2);
  assert.equal(failedExport.commands[0].stdout, 'partial output\n');
  assert.equal(failedExport.commands[0].stderr, 'export failed\n');
  assert.match(failedExport.output, /bddgen export failed with exit code 2/);
  assert.match(failedExport.output, /export failed/);

  const zeroStepRepoRoot = createTempRepo(t);
  const zeroStepExport = verify({
    repoRoot: zeroStepRepoRoot,
    commandRunner: () => ({
      status: 0,
      stdout: 'List of all steps (0)\n',
      stderr: '',
    }),
  });

  assert.equal(zeroStepExport.status, 'fail');
  assert.equal(zeroStepExport.exitCode, 1);
  assert.equal(zeroStepExport.exportedStepCount, 0);
  assert.match(zeroStepExport.output, /bddgen export returned zero registered steps/);
});

test('verify fails when bddgen test fails', (t) => {
  const repoRoot = createTempRepo(t);
  const calls = [];
  const result = verify({
    repoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      calls.push({ command, args, cwd, commandOptions });

      if (args[0] === 'bddgen' && args[1] === 'export') {
        return {
          status: 0,
          stdout: 'List of all steps (3)\n',
          stderr: '',
        };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        return {
          status: 4,
          stdout: 'partial generation\n',
          stderr: 'test failed\n',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls.map((call) => call.args), [['bddgen', 'export'], ['bddgen', 'test']]);
  assert.equal(result.commands[1].exitCode, 4);
  assert.equal(result.commands[1].stdout, 'partial generation\n');
  assert.equal(result.commands[1].stderr, 'test failed\n');
  assert.match(result.output, /bddgen test failed with exit code 4/);
  assert.match(result.output, /test failed/);
});

test('verify fails when no generated run-backed specs are found', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T064400Z-nospec';
  const harnessPaths = resolveHarnessPaths(repoRoot);
  writeTextFile(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId: runId,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );

  const calls = [];
  const result = verify({
    repoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      calls.push({ command, args, cwd, commandOptions });

      if (args[0] === 'bddgen' && args[1] === 'export') {
        return {
          status: 0,
          stdout: 'List of all steps (3)\n',
          stderr: '',
        };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        return {
          status: 0,
          stdout: 'generated nothing\n',
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.generatedSpecs, []);
  assert.deepEqual(calls.map((call) => call.args), [['bddgen', 'export'], ['bddgen', 'test']]);
  assert.match(result.output, /No generated Playwright specs were found for run 20260427T064400Z-nospec/);
});

test('verify fails when playwright test --list fails or reports zero tests', (t) => {
  const failingRepoRoot = createTempRepo(t);
  const failingRunId = '20260427T064400Z-listfail';
  writeTextFile(
    resolveHarnessPaths(failingRepoRoot).statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId: failingRunId,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );
  const failingCalls = [];
  const failingList = verify({
    repoRoot: failingRepoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      failingCalls.push({ command, args, cwd, commandOptions });

      if (args[0] === 'bddgen' && args[1] === 'export') {
        return {
          status: 0,
          stdout: 'List of all steps (3)\n',
          stderr: '',
        };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        writeGeneratedSpec(cwd, failingRunId);
        return {
          status: 0,
          stdout: 'generated specs\n',
          stderr: '',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
        return {
          status: 5,
          stdout: 'partial list\n',
          stderr: 'list failed\n',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(failingList.status, 'fail');
  assert.equal(failingList.exitCode, 1);
  assert.deepEqual(failingCalls.map((call) => call.args.slice(0, 3)), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list'],
  ]);
  assert.equal(failingList.commands[2].exitCode, 5);
  assert.equal(failingList.commands[2].stdout, 'partial list\n');
  assert.equal(failingList.commands[2].stderr, 'list failed\n');
  assert.match(failingList.output, /playwright test --list failed with exit code 5/);
  assert.match(failingList.output, /list failed/);

  const zeroTestRepoRoot = createTempRepo(t);
  const zeroTestRunId = '20260427T064400Z-zerotests';
  writeTextFile(
    resolveHarnessPaths(zeroTestRepoRoot).statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId: zeroTestRunId,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );
  const zeroTestList = verify({
    repoRoot: zeroTestRepoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      if (args[0] === 'bddgen' && args[1] === 'export') {
        return {
          status: 0,
          stdout: 'List of all steps (3)\n',
          stderr: '',
        };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        writeGeneratedSpec(cwd, zeroTestRunId);
        return {
          status: 0,
          stdout: 'generated specs\n',
          stderr: '',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
        return {
          status: 0,
          stdout: 'Total: 0 tests\n',
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(zeroTestList.status, 'fail');
  assert.equal(zeroTestList.exitCode, 1);
  assert.equal(zeroTestList.listedTestCount, 0);
  assert.equal(zeroTestList.commands[2].exitCode, 0);
  assert.match(zeroTestList.output, /playwright test --list did not find generated tests for run 20260427T064400Z-zerotests/);
});

test('verify fails when full playwright execution fails for generated specs', (t) => {
  const repoRoot = createTempRepo(t);
  const runId = '20260427T064400Z-execfail';
  writeTextFile(
    resolveHarnessPaths(repoRoot).statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      latestRunId: runId,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );
  const calls = [];
  const result = verify({
    repoRoot,
    commandRunner: (command, args, cwd, commandOptions) => {
      calls.push({ command, args, cwd, commandOptions });

      if (args[0] === 'bddgen' && args[1] === 'export') {
        return {
          status: 0,
          stdout: 'List of all steps (3)\n',
          stderr: '',
        };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        writeGeneratedSpec(cwd, runId);
        return {
          status: 0,
          stdout: 'generated specs\n',
          stderr: '',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test' && args[2] === '--list') {
        return {
          status: 0,
          stdout: 'Total: 1 test\n',
          stderr: '',
        };
      }

      if (args[0] === 'playwright' && args[1] === 'test') {
        return {
          status: 7,
          stdout: '1 failed\n',
          stderr: 'runtime failure\n',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.equal(result.listedTestCount, 1);
  assert.equal(result.commands.length, 4);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list'],
    ['playwright', 'test', '.features-gen/.qa-harness/runs/20260427T064400Z-execfail/normalized.feature.spec.js'],
  ]);
  assert.equal(result.commands[3].exitCode, 7);
  assert.equal(result.commands[3].stdout, '1 failed\n');
  assert.equal(result.commands[3].stderr, 'runtime failure\n');
  assert.match(result.output, /playwright test failed with exit code 7/);
  assert.match(result.output, /runtime failure/);
});

test('prepare --from fails clearly for missing sources and non-feature paths', (t) => {
  const repoRoot = createTempRepo(t);
  writeTextFile(path.join(repoRoot, 'Features', 'notes.txt'), 'not a feature\n');

  const missingFeature = { stdout: '', stderr: '' };
  const missingExitCode = runCli(['prepare', '--from', 'Features/missing.feature'], {
    repoRoot,
    stdout: { write: (value) => { missingFeature.stdout += value; } },
    stderr: { write: (value) => { missingFeature.stderr += value; } },
  });

  assert.equal(missingExitCode, 1);
  assert.equal(missingFeature.stdout, '');
  assert.match(missingFeature.stderr, /Feature file not found: Features\/missing\.feature/);

  const nonFeature = { stdout: '', stderr: '' };
  const nonFeatureExitCode = runCli(['prepare', '--from', 'Features/notes.txt'], {
    repoRoot,
    stdout: { write: (value) => { nonFeature.stdout += value; } },
    stderr: { write: (value) => { nonFeature.stderr += value; } },
  });

  assert.equal(nonFeatureExitCode, 1);
  assert.equal(nonFeature.stdout, '');
  assert.match(nonFeature.stderr, /prepare --from requires a \.feature file: Features\/notes\.txt/);

  const absentNonFeature = { stdout: '', stderr: '' };
  const absentNonFeatureExitCode = runCli(['prepare', '--from', 'Features/notes.md'], {
    repoRoot,
    stdout: { write: (value) => { absentNonFeature.stdout += value; } },
    stderr: { write: (value) => { absentNonFeature.stderr += value; } },
  });

  assert.equal(absentNonFeatureExitCode, 1);
  assert.equal(absentNonFeature.stdout, '');
  assert.match(absentNonFeature.stderr, /prepare --from requires a \.feature file: Features\/notes\.md/);
  assert.equal(fs.existsSync(path.join(repoRoot, '.qa-harness')), false);
});

test('runCli rejects missing and invalid lean command options before dispatch', () => {
  const rejectedInvocations = [
    { argv: ['prepare'], pattern: /Missing required option --from or --request/ },
    { argv: ['prepare', '--from'], pattern: /Missing value for option --from/ },
    { argv: ['prepare', '--request'], pattern: /Missing value for option --request/ },
    {
      argv: ['prepare', '--from', 'Features/homepage.feature', '--request', 'Target URL: http://localhost:3000'],
      pattern: /prepare accepts either --from or --request, but not both/,
    },
    { argv: ['run', '--max-iterations'], pattern: /Missing value for option --max-iterations/ },
    { argv: ['run', '--max-iterations', '0'], pattern: /--max-iterations must be a positive integer/ },
    { argv: ['run', '--max-iterations', '-1'], pattern: /--max-iterations must be a positive integer/ },
    { argv: ['run', '--max-iterations', 'abc'], pattern: /--max-iterations must be a positive integer/ },
    { argv: ['status', '--from', 'Features/homepage.feature'], pattern: /status does not accept --from/ },
    { argv: ['verify', '--max-iterations', '3'], pattern: /verify does not accept --max-iterations/ },
  ];

  for (const { argv, pattern } of rejectedInvocations) {
    let stdout = '';
    let stderr = '';
    const exitCode = runCli(argv, {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareFn: () => {
        throw new Error('prepare should be unreachable.');
      },
      runFn: () => {
        throw new Error('run should be unreachable.');
      },
      statusFn: () => {
        throw new Error('status should be unreachable.');
      },
      verifyFn: () => {
        throw new Error('verify should be unreachable.');
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, pattern);
  }
});

test('runCli rejects deleted command names as unknown commands', () => {
  const deletedCommands = [
    'create-run',
    'prepare-run',
    'verify-run',
    'execute-run',
    'advance-run',
    'iterate-run',
    'loop-run',
    'preflight',
  ];

  for (const command of deletedCommands) {
    let stdout = '';
    let stderr = '';
    const exitCode = runCli([command], {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`Unknown command "${command}"`));
  }
});

test('parseProgressItems skips the template section and findNextActionableProgressItem preserves file order', () => {
  const progressContent = [
    '# QA Harness Progress',
    '',
    '## Item Template',
    '',
    '- [ ] `P-TEMPLATE` Goal: template item',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: `iteration evidence`',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `copilot`',
    '  - Status: `todo`',
    '  - Retry budget: `1`',
    '',
    '## Active Items',
    '',
    '- [x] `P-001` Goal: already done',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: `iteration evidence`',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `copilot`',
    '  - Status: `pass`',
    '  - Retry budget: `1`',
    '  - Result: ``',
    '',
    '- [ ] `P-002` Goal: terminal block',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: `iteration evidence`',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `copilot`',
    '  - Status: `blocked`',
    '  - Retry budget: `1`',
    '  - Result: ``',
    '',
    '- [ ] `P-003` Goal: retry this failed item first',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: `iteration evidence`',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `copilot`',
    '  - Status: `fail`',
    '  - Retry budget: `1`',
    '',
    '- [ ] `P-004` Goal: later todo item',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: `iteration evidence`',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `copilot`',
    '  - Status: `todo`',
    '  - Retry budget: `1`',
    '  - Result: ``',
    '',
  ].join('\n');

  const items = parseProgressItems(progressContent);
  const nextItem = findNextActionableProgressItem(progressContent);

  assert.deepEqual(items.map((item) => item.id), ['P-001', 'P-002', 'P-003', 'P-004']);
  assert.equal(items.some((item) => item.id === 'P-TEMPLATE'), false);
  assert.equal(items.find((item) => item.id === 'P-003').result, '');
  assert.equal(nextItem.id, 'P-003');
});

test('parseProgressItems reads four-agent lifecycle statuses and metadata fields', () => {
  const progressContent = [
    '# QA Harness Progress',
    '',
    '## Active Items',
    '',
    '- [x] `P-001` Goal: completed item',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: verifier proof',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `qa-verifier`',
    '  - Agent: `qa-verifier`',
    '  - Mode: `verification`',
    '  - Status: `pass`',
    '  - Retry budget: `0`',
    '  - Result: `accepted`',
    '  - Evidence: `full playwright pass`',
    '',
    '- [ ] `P-002` Goal: blocked item',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: blocked proof',
    '  - Verify: `operator unblocks`',
    '  - Owner: `qa-orchestrator`',
    '  - Agent: `qa-orchestrator`',
    '  - Mode: `intake`',
    '  - Status: `blocked`',
    '  - Retry budget: `0`',
    '  - Result: `manual input needed`',
    '  - Evidence: `blocked intake`',
    '  - Block reason: `missing app scope`',
    '',
    '- [ ] `P-003` Goal: verifier should review executor evidence first',
    '  - Input: `.qa-harness/runs/run-1/iterations/001/evidence`',
    '  - Output: verifier decision',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `qa-verifier`',
    '  - Agent: `qa-executor`',
    '  - Mode: `verification`',
    '  - Status: `needs-verification`',
    '  - Retry budget: `1`',
    '  - Result: `executor ready`',
    '  - Evidence: `seed.spec.ts and validation.json`',
    '  - Fallback reason: `CLI blocked by auth gate`',
    '',
    '- [ ] `P-004` Goal: failed item can heal later',
    '  - Input: `.qa-harness/normalized.feature`',
    '  - Output: retry proof',
    '  - Verify: `ralph-qa-harness verify`',
    '  - Owner: `qa-executor`',
    '  - Agent: `qa-verifier`',
    '  - Mode: `healing`',
    '  - Status: `fail`',
    '  - Retry budget: `1`',
    '  - Result: `runtime failed`',
    '  - Evidence: `failing playwright run`',
    '',
    '- [ ] `P-005` Goal: new planner item',
    '  - Input: requirements',
    '  - Output: plan',
    '  - Verify: review',
    '  - Owner: `qa-planner`',
    '  - Agent: `qa-planner`',
    '  - Mode: `planning`',
    '  - Status: `todo`',
    '  - Retry budget: `1`',
    '  - Result: ``',
    '  - Evidence: ``',
    '',
    '- [ ] `P-006` Goal: orchestrator marked work active',
    '  - Input: progress',
    '  - Output: route',
    '  - Verify: selected role',
    '  - Owner: `qa-orchestrator`',
    '  - Agent: `qa-orchestrator`',
    '  - Mode: `routing`',
    '  - Status: `doing`',
    '  - Retry budget: `1`',
    '  - Result: `selected`',
    '  - Evidence: `route decision`',
    '',
  ].join('\n');

  const items = parseProgressItems(progressContent);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const nextItem = findNextActionableProgressItem(progressContent);

  assert.deepEqual(items.map((item) => item.status), [
    'pass',
    'blocked',
    'needs-verification',
    'fail',
    'todo',
    'doing',
  ]);
  assert.equal(itemById.get('P-003').owner, 'qa-verifier');
  assert.equal(itemById.get('P-003').agent, 'qa-executor');
  assert.equal(itemById.get('P-003').mode, 'verification');
  assert.equal(itemById.get('P-003').evidence, 'seed.spec.ts and validation.json');
  assert.equal(itemById.get('P-003').fallbackReason, 'CLI blocked by auth gate');
  assert.equal(itemById.get('P-002').blockReason, 'missing app scope');
  assert.equal(nextItem.id, 'P-003');
});

test('run CLI progress updates preserve four-agent metadata and user-authored fields', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T08:36:00.000Z'),
    progressContent: [
      '# QA Harness Progress',
      '',
      '## Active Items',
      '',
      '- [ ] `P-001` Goal: preserve progress metadata while completing work',
      '  - Input: `.qa-harness/normalized.feature`',
      '  - Output: `iteration evidence`',
      '  - Verify: `ralph-qa-harness verify`',
      '  - Owner: `qa-executor`',
      '  - Agent: `qa-executor`',
      '  - Mode: `implementation`',
      '  - Status: `todo`',
      '  - Retry budget: `1`',
      '  - Result: `pending`',
      '  - Evidence: `existing iteration evidence`',
      '  - Fallback reason: `existing fallback note`',
      '  - Block reason: `existing block note`',
      '  - Reviewer note: keep this user-authored line',
      '',
    ].join('\n'),
  });
  const { runner } = createLeanRunCommandRunner();
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['run', '--max-iterations', '2'], {
    repoRoot,
    now: new Date('2026-04-27T08:37:00.000Z'),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    commandRunner: runner,
  });
  const progressContent = fs.readFileSync(harnessPaths.progressPath, 'utf8');

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Run .* stopped after 2 iterations: completed/);
  assert.match(stdout, /stop reason: all-progress-passed/);
  assert.match(progressContent, /- \[x\] `P-001` Goal: preserve progress metadata/);
  assert.match(progressContent, /  - Status: `pass`/);
  assert.match(progressContent, /  - Result: `pass: worker completed selected item; supervisor verify passed`/);
  assert.match(progressContent, /  - Agent: `qa-executor`/);
  assert.match(progressContent, /  - Mode: `implementation`/);
  assert.match(progressContent, /  - Evidence: `existing iteration evidence`/);
  assert.match(progressContent, /  - Fallback reason: `existing fallback note`/);
  assert.match(progressContent, /  - Block reason: `existing block note`/);
  assert.match(progressContent, /  - Reviewer note: keep this user-authored line/);
});

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
