'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QA_HARNESS_COMMAND_PREFIX = 'npm run qa:orchestrator --';

const {
  advanceRun,
  clarifyPrepareRunRequest,
  createRun,
  createRunId,
  executeRun,
  findNextActionableProgressItem,
  getTemplatePlaceholders,
  iterateRun,
  loopRun,
  parseCliArgs,
  parseProgressItems,
  planPreparedRunArtifacts,
  prepareRun,
  resolveProjectCliInvocation,
  resolveRunPaths,
  runCli,
  validateRequestEnvelope,
  verifyRun,
} = require('../../scripts/qa-harness');
const { executeExternalWorker } = require('../../scripts/qa-runtime-external-worker');

const realTemplatesDir = path.resolve(__dirname, '../../templates/qa-run');

function createTempRepo(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-harness-'));
  t.after(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(repoRoot, 'Features', 'steps'), { recursive: true });
  writeTextFile(
    path.join(repoRoot, 'Features', 'steps', 'fixtures.ts'),
    fs.readFileSync(path.resolve(__dirname, '../fixtures/target-project/Features/steps/fixtures.ts'), 'utf8'),
  );
  writeTextFile(
    path.join(repoRoot, 'Features', 'steps', 'index.ts'),
    fs.readFileSync(path.resolve(__dirname, '../fixtures/target-project/Features/steps/index.ts'), 'utf8'),
  );
  return repoRoot;
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

function formatToolInvocationDisplay(command, args) {
  return [command, ...args].join(' ');
}

function createExternalWorkerToolRunner(runId, options = {}) {
  return (command, args, cwd) => {
    const invocation = resolveProjectCliInvocation(command, args, cwd);
    const mappedArgs = invocation.args;
    const commandDisplay = formatToolInvocationDisplay(invocation.command, mappedArgs);

    if (
      invocation.command === process.execPath &&
      /playwright-bdd[\\/]dist[\\/]cli[\\/]index\.js$/i.test(mappedArgs[0] || '')
    ) {
      const subcommand = mappedArgs[1];
      if (subcommand === 'export') {
        return {
          status: options.bddgenExportStatus || 0,
          stdout: options.bddgenExportStdout || 'List of all steps (9)\n',
          stderr: options.bddgenExportStderr || '',
          commandDisplay,
        };
      }

      if (subcommand === 'test') {
        writeGeneratedSpec(cwd, runId);
        return {
          status: options.bddgenTestStatus || 0,
          stdout: options.bddgenTestStdout || 'generated\n',
          stderr: options.bddgenTestStderr || '',
          commandDisplay,
        };
      }
    }

    if (
      invocation.command === process.execPath &&
      /playwright[\\/]cli\.js$/i.test(mappedArgs[0] || '')
    ) {
      if (mappedArgs[1] === 'test' && mappedArgs[2] === '--list') {
        return {
          status: options.playwrightListStatus || 0,
          stdout: options.playwrightListStdout || 'Total: 1 test\n',
          stderr: options.playwrightListStderr || '',
          commandDisplay,
        };
      }

      if (mappedArgs[1] === 'test') {
        return {
          status: options.playwrightExecStatus || 0,
          stdout: options.playwrightExecStdout || '1 passed (0.1s)\n',
          stderr: options.playwrightExecStderr || '',
          commandDisplay,
        };
      }
    }

    throw new Error(`Unexpected worker tool invocation: ${commandDisplay}`);
  };
}

function parseAdapterArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      continue;
    }

    options[token.slice(2)] = args[index + 1];
    index += 1;
  }

  return options;
}

function createExternalWorkerProcessRunner(runId, options = {}) {
  const toolRunner = createExternalWorkerToolRunner(runId, options);

  return (command, args, cwd) => {
    if (command !== process.execPath || !/qa-runtime-external-worker\.js$/i.test(args[0] || '')) {
      throw new Error(`Unexpected external worker invocation: ${command} ${args.join(' ')}`);
    }

    const runtimeOptions = parseAdapterArgs(args.slice(1));
    const result = executeExternalWorker(runtimeOptions, {
      runTool: toolRunner,
    });

    return {
      status: 0,
      stdout: JSON.stringify(result),
      stderr: '',
    };
  };
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

function createFeatureRun(t, options = {}) {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    options.featureContent || [
      '@smoke',
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: options.intent || 'plan',
      sourceType: 'feature',
      sourceRef: featurePath,
    },
  });

  if (options.progressContent) {
    writeTextFile(result.runPaths.progressPath, options.progressContent);
  }

  return { repoRoot, featurePath, result };
}

function prepareGuidedCoverageRun(t, options = {}) {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    options.featureContent || [
      '@coverage',
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
      '',
      '  Scenario: Close the docs drawer',
      '    Given the browser session is open',
    ].join('\n'),
  );
  const { runner } = createMockCommandRunner(options.commandRunnerOptions);
  const result = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'coverage',
      sourceType: 'feature',
      sourceRef: featurePath,
      mode: 'guided-exploratory',
      scope: options.scope || 'single-feature',
      constraints: options.constraints || [
        'feature: docs navigation',
        'scenario: Open the docs',
        'risk area: collapsed menu',
        'iteration budget: 2',
      ],
    },
    commandRunner: runner,
    createRunFn: (prepareOptions) => {
      const createdRun = createRun(prepareOptions);
      writeGeneratedSpec(repoRoot, createdRun.runId);
      return createdRun;
    },
  });

  return { repoRoot, featurePath, result, runner };
}

function prepareAutonomousCoverageRun(t, options = {}) {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    options.featureContent || [
      '@coverage',
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
      '',
      '  Scenario: Close the docs drawer',
      '    Given the browser session is open',
    ].join('\n'),
  );
  const { runner } = createMockCommandRunner(options.commandRunnerOptions);
  const result = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'coverage',
      sourceType: 'feature',
      sourceRef: featurePath,
      mode: 'autonomous-exploratory',
      scope: options.scope || 'single-feature',
      constraints: options.constraints || [],
    },
    commandRunner: runner,
    createRunFn: (prepareOptions) => {
      const createdRun = createRun(prepareOptions);
      writeGeneratedSpec(repoRoot, createdRun.runId);
      return createdRun;
    },
  });

  return { repoRoot, featurePath, result, runner };
}

function createProgressBlock(options = {}) {
  const lines = [
    `- [${options.checked ? 'x' : ' '}] \`${options.id}\` Goal: ${options.goal}`,
    `  - Input: ${options.input || '`normalized.feature`'}`,
    `  - Output: ${options.output || '`logs/runtime.log`'}`,
    `  - Verify: ${options.verify || '`manual verify`'}`,
    `  - Owner: \`${options.owner || 'qa-agent'}\``,
    `  - Status: \`${options.status || 'todo'}\``,
    `  - Retry budget: \`${options.retryBudget || '1'}\``,
  ];

  if (options.includeResult !== false) {
    lines.push(`  - Result: \`${options.result || ''}\``);
  }

  if (options.includeFallbackReason !== false) {
    lines.push(`  - Fallback reason: \`${options.fallbackReason || ''}\``);
  }

  if (options.includeBlockReason) {
    lines.push(`  - Block reason: \`${options.blockReason || ''}\``);
  }
  return lines.join('\n');
}

function createProgressDocument(options = {}) {
  const sections = [
    '# QA Run Progress',
    '',
    '## Rules',
    '',
    '- Complete exactly one atomic item per iteration.',
    '',
  ];

  if (options.includeTemplate !== false) {
    sections.push('## Item Template', '');
    sections.push(
      options.templateBlock ||
        createProgressBlock({
          id: 'P-TEMPLATE',
          goal: 'template item',
          owner: 'qa-template',
        }),
    );
    sections.push('');
  }

  sections.push(`## ${options.activeSectionTitle || 'Active Items'}`, '');

  const activeBlocks = options.activeBlocks || [];
  activeBlocks.forEach((block, index) => {
    sections.push(block);
    if (index < activeBlocks.length - 1) {
      sections.push('');
    }
  });

  sections.push('');
  return sections.join('\n');
}

function writeStructuredLogEntry(filePath, status, lines) {
  const block = [`[2026-04-09T12:34:56.000Z] status=${status}`, ...lines].join('\n');
  fs.writeFileSync(filePath, `${block}\n\n`, 'utf8');
}

function appendStructuredLogEntry(filePath, status, lines, timestamp = '2026-04-09T12:34:56.000Z') {
  const block = [`[${timestamp}] status=${status}`, ...lines].join('\n');
  fs.appendFileSync(filePath, `${block}\n\n`, 'utf8');
}

function writeAcceptedPlannerHandoffEntry(runPaths, options = {}) {
  const candidateScenario = options.candidateScenario || 'cover collapsed menu open and close';
  const scope = options.scope || 'docs navigation';
  const itemId = options.itemId || 'P-GAP-001';
  const progressGoal = options.progressGoal || `${candidateScenario} for ${scope}`;
  const progressInput = options.progressInput || `accepted gap candidate 1 in \`outputs/gap-analysis.md\` for \`${scope}\``;
  const progressVerify =
    options.progressVerify || `\`npm run qa:orchestrator -- advance-run --run-id ${runPaths.runId}\``;
  const lines = [
    'Source artifact: outputs/gap-analysis.md',
    `Candidate key: ${options.candidateKey || `[2026-04-09T12:34:56.000Z] ${itemId}`}`,
    'Gap analysis timestamp: 2026-04-09T12:34:56.000Z',
    `Selected item: ${options.selectedItem || 'P-735 - identify bounded coverage gaps around the docs navigation'}`,
    `Scope: ${scope}`,
    `Candidate ordinal: ${options.candidateOrdinal || '1'}`,
    `Candidate gap: ${options.candidateGap || 'missing collapsed menu coverage'}`,
    `Candidate scenario: ${candidateScenario}`,
    ...(options.candidateAdditionTarget
      ? [`Candidate addition target: ${options.candidateAdditionTarget}`]
      : []),
    ...(options.candidateEvidence
      ? [`Candidate evidence: ${options.candidateEvidence}`]
      : []),
    'Decision: accepted',
    `Progress item id: ${itemId}`,
    `Progress goal: ${progressGoal}`,
    `Progress input: ${progressInput}`,
    `Progress output: ${options.progressOutput || 'verifier-backed proof recorded in `logs/verifier.log`'}`,
    `Progress verify: ${progressVerify}`,
    `Progress owner: ${options.progressOwner || 'qa-executor'}`,
    `Progress retry budget: ${options.retryBudget || '1'}`,
    `Summary: ${options.summary || `accepted gap candidate 1 for ${scope}: ${itemId} from ${candidateScenario}`}`,
  ];

  writeStructuredLogEntry(runPaths.plannerHandoffPath, 'accepted', lines);
}

function countOccurrences(content, pattern) {
  const matches = content.match(pattern);
  return matches ? matches.length : 0;
}

function appendScenarioBlock(featurePath, scenarioBlock) {
  const content = fs.readFileSync(featurePath, 'utf8').trimEnd();
  const nextContent = content
    ? `${content}\n\n${scenarioBlock.trim()}\n`
    : `${scenarioBlock.trim()}\n`;
  fs.writeFileSync(featurePath, nextContent, 'utf8');
}

function createScenarioAdditionProcessRunner(options) {
  return () => {
    if (options.scenarioBlock) {
      appendScenarioBlock(options.runPaths.normalizedFeaturePath, options.scenarioBlock);
    }

    return {
      status: 0,
      stdout: JSON.stringify({
        status: options.status || 'pass',
        summary: options.summary || 'appended one bounded scenario to normalized.feature',
        runtimeLayer: options.runtimeLayer || 'playwright-cli',
        addedScenarioOrOutline: options.addedScenarioOrOutline,
        targetArtifactPath: options.runPaths.normalizedFeaturePath,
        evidence: options.evidence || ['normalized.feature', 'logs/runtime.log'],
        fallbackReason: options.fallbackReason,
        escalationReason: options.escalationReason,
        stopReason: options.stopReason,
        blockReason: options.blockReason,
      }),
      stderr: options.stderr || '',
    };
  };
}

function valueAfterFlag(args, flag) {
  const flagIndex = args.indexOf(flag);
  assert.notEqual(flagIndex, -1, `Expected flag ${flag} in ${args.join(' ')}`);
  assert.notEqual(flagIndex, args.length - 1, `Expected value after ${flag}`);
  return args[flagIndex + 1];
}

test('createRunId uses UTC timestamp and slugified feature name', () => {
  const runId = createRunId(new Date('2026-04-09T12:34:56.000Z'), 'plan', 'Features/Home Page.feature');
  assert.equal(runId, '20260409T123456Z-plan-home-page');
});

test('validateRequestEnvelope rejects unsupported source types in this slice', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/sample.feature', 'Feature: Sample\n');

  assert.throws(
    () =>
      validateRequestEnvelope(
        {
          intent: 'plan',
          sourceType: 'jira',
          sourceRef: 'Features/sample.feature',
        },
        { repoRoot },
      ),
    /only supports --source-type feature/i,
  );
});

test('createRun stamps templates and copies normalized feature content', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      '@smoke',
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: featurePath,
      constraints: ['Use Playwright CLI first when execution is added later.'],
    },
  });

  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');
  const normalizedFeature = fs.readFileSync(result.runPaths.normalizedFeaturePath, 'utf8');

  assert.match(prdContent, /Run ID: `20260409T123456Z-plan-homepage`/);
  assert.match(prdContent, /Intent: `plan`/);
  assert.match(prdContent, /Mode: `standard`/);
  assert.match(prdContent, /Source type: `feature`/);
  assert.match(prdContent, /Feature input: `?Features\/homepage\.feature`?/);
  assert.match(prdContent, /Use Playwright CLI first when execution is added later\./);
  assert.match(progressContent, /Input: `?Features\/homepage\.feature`?/);
  assert.match(progressContent, /verify-run --run-id 20260409T123456Z-plan-homepage/);
  assert.match(progressContent, /execute-run --run-id 20260409T123456Z-plan-homepage --project chromium/);
  assert.match(promptContent, /Run ID: `20260409T123456Z-plan-homepage`/);
  assert.match(promptContent, /Source reference: `Features\/homepage\.feature`/);
  assert.equal(normalizedFeature, fs.readFileSync(featurePath, 'utf8'));

  const placeholders = getTemplatePlaceholders(realTemplatesDir);
  for (const placeholder of placeholders) {
    assert.equal(prdContent.includes(placeholder), false, `PRD still contains ${placeholder}`);
    assert.equal(progressContent.includes(placeholder), false, `Progress still contains ${placeholder}`);
    assert.equal(promptContent.includes(placeholder), false, `Prompt still contains ${placeholder}`);
  }
});

test('verifyRun fails when PROMPT.md still contains unresolved template placeholders', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/homepage.feature', 'Feature: Sample\n');

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: 'Features/homepage.feature',
    },
  });

  fs.writeFileSync(result.runPaths.promptPath, '# Prompt\n\n- Run ID: `<run-id>`\n', 'utf8');

  assert.throws(
    () =>
      verifyRun({
        repoRoot,
        templatesDir: realTemplatesDir,
        runId: result.runId,
        commandRunner: () => {
          throw new Error('verifyRun should fail before command execution');
        },
      }),
    /PROMPT\.md.*<run-id>/i,
  );
});

test('verifyRun appends verifier history without duplicating planner-owned active items', (t) => {
  const { repoRoot, result } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();

  writeGeneratedSpec(repoRoot, result.runId);
  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  verifyRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });
  verifyRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');
  const activeItems = parseProgressItems(progressContent);

  assert.equal(activeItems.filter((item) => item.id === 'P-001').length, 1);
  assert.equal(activeItems.filter((item) => item.id === 'P-002').length, 1);
  assert.match(progressContent, /- \[x\] `P-001` Goal: verify planner-refined artifacts and generated BDD specs/);
  assert.equal(countOccurrences(verifierLog, /status=pass/g), 3);
});

test('recorded execution controls stay deduped across verifier reruns and are reused by later iterations', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-101',
        goal: 'reuse recorded controls',
        owner: 'qa-executor',
        verify: '`npm run qa:orchestrator -- execute-run --run-id 20260409T123456Z-plan-homepage --project chromium`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeGeneratedSpec(repoRoot, result.runId);
  const { runner } = createMockCommandRunner();

  verifyRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    project: 'firefox',
    headed: true,
    debug: false,
    baseUrl: 'https://staging.example.test',
    targetEnv: 'staging',
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    env: { ...process.env },
    commandRunner: runner,
  });
  verifyRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    project: 'firefox',
    headed: true,
    debug: false,
    baseUrl: 'https://staging.example.test',
    targetEnv: 'staging',
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    env: { ...process.env },
    commandRunner: runner,
  });

  let capturedInvocation = null;
  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env: {
      ...process.env,
      QA_HARNESS_EXTERNAL_RUNTIME_CMD: 'external-runtime',
    },
    processRunner: (command, args, cwd, spawnOptions) => {
      capturedInvocation = { command, args, cwd, spawnOptions };
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'pass',
          summary: 'recorded controls reused',
          runtimeLayer: 'playwright-cli',
        }),
        stderr: '',
      };
    },
  });

  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(capturedInvocation.command, 'external-runtime');
  assert.equal(capturedInvocation.spawnOptions.env.QA_HARNESS_EXECUTION_PROJECT, 'firefox');
  assert.equal(capturedInvocation.spawnOptions.env.QA_HARNESS_EXECUTION_HEADED, 'true');
  assert.equal(capturedInvocation.spawnOptions.env.QA_HARNESS_EXECUTION_DEBUG, 'false');
  assert.equal(capturedInvocation.spawnOptions.env.QA_HARNESS_EXECUTION_TRACE, 'on');
  assert.equal(capturedInvocation.spawnOptions.env.QA_HARNESS_EXECUTION_VIDEO, 'retain-on-failure');
  assert.equal(capturedInvocation.spawnOptions.env.QA_HARNESS_EXECUTION_SCREENSHOT, 'only-on-failure');
  assert.equal(capturedInvocation.spawnOptions.env.PLAYWRIGHT_BASE_URL, 'https://staging.example.test');
  assert.equal(capturedInvocation.spawnOptions.env.QA_HARNESS_TARGET_ENV, 'staging');
  assert.equal(countOccurrences(prdContent, /^## Execution Controls$/gm), 1);
  assert.equal(countOccurrences(promptContent, /^## Execution Controls Context$/gm), 1);
  assert.equal(countOccurrences(verifierLog, /status=pass/g), 2);
});

test('resolveRunPaths keeps artifacts under .qa-harness/runs/<run-id>', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  const runPaths = resolveRunPaths(repoRoot, '20260409T123456Z-plan-homepage');

  assert.equal(
    runPaths.runDir,
    path.join(repoRoot, '.qa-harness', 'runs', '20260409T123456Z-plan-homepage'),
  );
  assert.equal(runPaths.prdPath, path.join(runPaths.runDir, 'PRD.md'));
  assert.equal(runPaths.verifierLogPath, path.join(runPaths.runDir, 'logs', 'verifier.log'));
  assert.equal(runPaths.promotionReportPath, path.join(runPaths.runDir, 'outputs', 'promotion-report.md'));
  assert.equal(runPaths.scenarioAdditionPath, path.join(runPaths.runDir, 'outputs', 'scenario-addition.md'));
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

test('parseCliArgs parses prepare-run request options and repeated constraints', () => {
  const parsed = parseCliArgs([
    'prepare-run',
    '--intent',
    'plan',
    '--source-type',
    'feature',
    '--source-ref',
    'Features/homepage.feature',
    '--mode',
    'standard',
    '--scope',
    'single-feature',
    '--constraint',
    'Stay feature-backed.',
    '--constraint',
    'Keep one task at a time.',
  ]);

  assert.equal(parsed.command, 'prepare-run');
  assert.deepEqual(parsed.options, {
    intent: 'plan',
    'source-type': 'feature',
    'source-ref': 'Features/homepage.feature',
    mode: 'standard',
    scope: 'single-feature',
    constraint: ['Stay feature-backed.', 'Keep one task at a time.'],
  });
});

test('parseCliArgs keeps guided exploratory coverage preparation on the existing option surface', () => {
  const parsed = parseCliArgs([
    'prepare-run',
    '--intent',
    'coverage',
    '--source-type',
    'feature',
    '--source-ref',
    'Features/homepage.feature',
    '--mode',
    'guided-exploratory',
    '--scope',
    'single-feature',
    '--constraint',
    'feature: docs navigation',
    '--constraint',
    'scenario: Open the docs',
    '--constraint',
    'risk area: collapsed menu',
    '--constraint',
    'iteration budget: 2',
  ]);

  assert.equal(parsed.command, 'prepare-run');
  assert.deepEqual(parsed.options, {
    intent: 'coverage',
    'source-type': 'feature',
    'source-ref': 'Features/homepage.feature',
    mode: 'guided-exploratory',
    scope: 'single-feature',
    constraint: [
      'feature: docs navigation',
      'scenario: Open the docs',
      'risk area: collapsed menu',
      'iteration budget: 2',
    ],
  });
});

test('parseCliArgs keeps autonomous exploratory coverage preparation on the existing option surface', () => {
  const parsed = parseCliArgs([
    'prepare-run',
    '--intent',
    'coverage',
    '--source-type',
    'feature',
    '--source-ref',
    'Features/homepage.feature',
    '--mode',
    'autonomous-exploratory',
    '--scope',
    'single-feature',
  ]);

  assert.equal(parsed.command, 'prepare-run');
  assert.deepEqual(parsed.options, {
    intent: 'coverage',
    'source-type': 'feature',
    'source-ref': 'Features/homepage.feature',
    mode: 'autonomous-exploratory',
    scope: 'single-feature',
    constraint: [],
  });
});

test('parseCliArgs parses prepare-run freeform request options and repeated constraints', () => {
  const parsed = parseCliArgs([
    'prepare-run',
    '--request',
    'Please prepare a run for Features/homepage.feature.',
    '--constraint',
    'Stay feature-backed.',
    '--constraint',
    'Keep one task at a time.',
  ]);

  assert.equal(parsed.command, 'prepare-run');
  assert.deepEqual(parsed.options, {
    constraint: ['Stay feature-backed.', 'Keep one task at a time.'],
    request: 'Please prepare a run for Features/homepage.feature.',
  });
});

test('parseCliArgs parses prepare-run existing-run options and repeated constraints', () => {
  const parsed = parseCliArgs([
    'prepare-run',
    '--run-id',
    'sample-run',
    '--constraint',
    'Keep existing evidence.',
    '--constraint',
    'Stay atomic.',
  ]);

  assert.equal(parsed.command, 'prepare-run');
  assert.deepEqual(parsed.options, {
    constraint: ['Keep existing evidence.', 'Stay atomic.'],
    'run-id': 'sample-run',
  });
});

test('parseCliArgs keeps advance-run request options unchanged after explorer delegation', () => {
  const parsed = parseCliArgs([
    'advance-run',
    '--run-id',
    'sample-run',
    '--adapter',
    'mock',
  ]);

  assert.equal(parsed.command, 'advance-run');
  assert.deepEqual(parsed.options, {
    constraint: [],
    'run-id': 'sample-run',
    adapter: 'mock',
  });
});

test('parseCliArgs keeps iterate-run and loop-run request forms unchanged after planner handoff', () => {
  const iterateParsed = parseCliArgs([
    'iterate-run',
    '--run-id',
    'sample-run',
    '--adapter',
    'mock',
  ]);
  const loopParsed = parseCliArgs([
    'loop-run',
    '--run-id',
    'sample-run',
    '--max-iterations',
    '2',
    '--adapter',
    'mock',
  ]);

  assert.deepEqual(iterateParsed, {
    command: 'iterate-run',
    options: {
      constraint: [],
      'run-id': 'sample-run',
      adapter: 'mock',
    },
  });
  assert.deepEqual(loopParsed, {
    command: 'loop-run',
    options: {
      constraint: [],
      'run-id': 'sample-run',
      'max-iterations': '2',
      adapter: 'mock',
    },
  });
});

test('clarifyPrepareRunRequest normalizes narrow freeform prepare-run requests into the feature-backed envelope', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );

  const clarification = clarifyPrepareRunRequest({
    repoRoot,
    request: {
      request: 'Please prepare a run for Features/homepage.feature.',
      constraints: ['Stay feature-backed.'],
    },
  });

  assert.deepEqual(clarification.request, {
    intent: 'plan',
    sourceType: 'feature',
    sourceRef: featurePath,
    sourceRefDisplay: 'Features/homepage.feature',
    mode: 'standard',
    scope: 'single-feature',
    constraints: ['Stay feature-backed.'],
  });
  assert.equal(
    clarification.summary,
    'normalized feature-backed plan request from Features/homepage.feature; mode=standard; scope=single-feature; 1 constraint',
  );
});

test('prepareRun composes clarifier, createRun, planner, and verifyRun successfully', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );
  const callOrder = [];
  const { runner } = createMockCommandRunner();
  const clarifierSummary = 'normalized feature-backed plan request from Features/homepage.feature; mode=standard; scope=single-feature';

  const result = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: featurePath,
    },
    commandRunner: runner,
    clarifyRequestFn: (options) => {
      callOrder.push('clarifier');
      return {
        request: validateRequestEnvelope(options.request, { repoRoot }),
        summary: clarifierSummary,
      };
    },
    createRunFn: (options) => {
      callOrder.push('create-run');
      const createdRun = createRun(options);
      writeGeneratedSpec(repoRoot, createdRun.runId);
      return createdRun;
    },
    planRunFn: (options) => {
      callOrder.push('planner');
      return planPreparedRunArtifacts(options);
    },
    verifyRunFn: (options) => {
      callOrder.push('verify-run');
      return verifyRun(options);
    },
  });

  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');
  const normalizedFeature = fs.readFileSync(result.runPaths.normalizedFeaturePath, 'utf8');

  assert.deepEqual(callOrder, ['clarifier', 'create-run', 'planner', 'verify-run']);
  assert.equal(result.runId, '20260409T123456Z-plan-homepage');
  assert.equal(result.clarifierSummary, clarifierSummary);
  assert.equal(result.plannerSummary, 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)');
  assert.equal(result.verifierSummary, '9 exported steps, 1 listed tests');
  assert.equal(result.verifyResult.runId, result.runId);
  assert.match(verifierLog, /status=pass/);
  assert.match(progressContent, /Goal: verify planner-refined artifacts and generated BDD specs for Playwright home page/);
  assert.match(progressContent, /Owner: `qa-verifier`/);
  assert.match(progressContent, /Status: `pass`/);
  assert.match(prdContent, /## Request Normalization/);
  assert.match(prdContent, /Clarifier status: `accepted`/);
  assert.match(prdContent, /## Planner Refinement/);
  assert.match(prdContent, /Planner status: `refined`/);
  assert.match(prdContent, /normalized feature-backed plan request from Features\/homepage\.feature; mode=standard; scope=single-feature/);
  assert.match(promptContent, /## Planner Context/);
  assert.match(promptContent, /Planned feature: `Playwright home page`/);
  assert.equal(normalizedFeature, fs.readFileSync(featurePath, 'utf8'));
});

test('prepareRun supports narrow freeform requests that mention a local feature path', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );
  const { runner } = createMockCommandRunner();
  let createdRequest = null;

  const result = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      request: 'Please prepare a run for Features/homepage.feature.',
      constraints: ['Stay feature-backed.'],
    },
    commandRunner: runner,
    createRunFn: (options) => {
      createdRequest = options.request;
      const createdRun = createRun(options);
      writeGeneratedSpec(repoRoot, createdRun.runId);
      return createdRun;
    },
    verifyRunFn: (options) => verifyRun(options),
  });

  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const normalizedFeature = fs.readFileSync(result.runPaths.normalizedFeaturePath, 'utf8');

  assert.deepEqual(createdRequest, {
    intent: 'plan',
    sourceType: 'feature',
    sourceRef: featurePath,
    sourceRefDisplay: 'Features/homepage.feature',
    mode: 'standard',
    scope: 'single-feature',
    constraints: ['Stay feature-backed.'],
  });
  assert.equal(result.clarifierSummary, 'normalized feature-backed plan request from Features/homepage.feature; mode=standard; scope=single-feature; 1 constraint');
  assert.equal(result.plannerSummary, 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)');
  assert.equal(result.verifierSummary, '9 exported steps, 1 listed tests');
  assert.match(prdContent, /Clarifier summary: `normalized feature-backed plan request from Features\/homepage\.feature; mode=standard; scope=single-feature; 1 constraint`/);
  assert.equal(normalizedFeature, fs.readFileSync(featurePath, 'utf8'));
});

test('planPreparedRunArtifacts refines created artifacts without changing normalized.feature', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );
  const createdRun = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: featurePath,
    },
  });
  const originalPrd = fs.readFileSync(createdRun.runPaths.prdPath, 'utf8');
  const originalProgress = fs.readFileSync(createdRun.runPaths.progressPath, 'utf8');
  const originalPrompt = fs.readFileSync(createdRun.runPaths.promptPath, 'utf8');
  const originalFeature = fs.readFileSync(createdRun.runPaths.normalizedFeaturePath, 'utf8');

  const planning = planPreparedRunArtifacts({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: createdRun.runId,
    request: createdRun.request,
    featureMetadata: createdRun.featureMetadata,
  });

  const updatedPrd = fs.readFileSync(createdRun.runPaths.prdPath, 'utf8');
  const updatedProgress = fs.readFileSync(createdRun.runPaths.progressPath, 'utf8');
  const updatedPrompt = fs.readFileSync(createdRun.runPaths.promptPath, 'utf8');
  const updatedFeature = fs.readFileSync(createdRun.runPaths.normalizedFeaturePath, 'utf8');

  assert.equal(planning.summary, 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)');
  assert.notEqual(updatedPrd, originalPrd);
  assert.notEqual(updatedProgress, originalProgress);
  assert.notEqual(updatedPrompt, originalPrompt);
  assert.equal(updatedFeature, originalFeature);
  assert.match(updatedPrd, /## Planner Refinement/);
  assert.match(updatedProgress, /execute the generated feature-backed run for Playwright home page on Chromium/);
  assert.match(updatedPrompt, /first actionable planner-authored item/);
});

test('prepareRun authors guided explorer artifacts for coverage-scoped guided runs with explicit constraints', (t) => {
  const { result } = prepareGuidedCoverageRun(t);
  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  assert.equal(
    result.plannerSummary,
    'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (2 scenarios)',
  );
  assert.match(prdContent, /## Guided Exploration/);
  assert.match(prdContent, /Guided mode: `enabled`/);
  assert.match(prdContent, /Guided scope kind: `single-feature`/);
  assert.match(prdContent, /Guided feature scope: `docs navigation`/);
  assert.match(prdContent, /Guided scenario scope: `Open the docs`/);
  assert.match(prdContent, /Guided risk areas: `collapsed menu`/);
  assert.match(prdContent, /Guided iteration budget: `2`/);
  assert.match(prdContent, /Guided iterations recorded: `0`/);
  assert.match(prdContent, /Guided iterations remaining: `2`/);
  assert.match(
    prdContent,
    /Guided stop conditions: `one bounded discovery outcome per iteration; stay within the selected run artifacts and selected exploration item; scope must remain within the recorded guided feature, scenario, and risk constraints; stop after 2 recorded guided exploration iteration\(s\) in outputs\/gap-analysis\.md`/,
  );
  assert.match(progressContent, /## Guided Exploration/);
  assert.match(progressContent, /Guided explorer artifact: `outputs\/gap-analysis\.md`/);
  assert.match(progressContent, /Goal: identify one bounded guided coverage gap for Open the docs around collapsed menu/);
  assert.match(progressContent, /Owner: `qa-explorer`/);
  assert.match(progressContent, /Output: gap candidates recorded in `outputs\/gap-analysis\.md`/);
  assert.doesNotMatch(progressContent, /execute the generated feature-backed run for Playwright home page on Chromium/);
  assert.doesNotMatch(progressContent, /## Autonomous Exploration/);
  assert.match(promptContent, /## Guided Exploration Context/);
  assert.match(promptContent, /Guided explorer output: `outputs\/gap-analysis\.md`/);
  assert.match(promptContent, /Do not mutate scenarios during guided exploration; planner handoff remains the boundary before scenario addition\./);
  assert.doesNotMatch(prdContent, /## Autonomous Exploration/);
  assert.doesNotMatch(promptContent, /## Autonomous Exploration Context/);
});

test('iterateRun records guided exploration scope, stopping conditions, and budget state in explorer artifacts', (t) => {
  const { repoRoot, result } = prepareGuidedCoverageRun(t);
  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'identified one guided gap',
        runtimeLayer: 'playwright-cli',
        coverageScope: 'docs navigation',
        gapCandidates: [
          {
            gap: 'missing collapsed menu coverage',
            candidateScenario: 'cover collapsed menu open and close',
            evidence: ['evidence/screenshots/menu-collapsed.png'],
          },
        ],
      }),
      stderr: '',
    }),
  });

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');

  assert.equal(iteration.selectedItemId, 'P-002');
  assert.equal(iteration.status, 'pass');
  assert.match(runtimeLog, /Guided exploration: yes/);
  assert.match(runtimeLog, /Guided feature scope: docs navigation/);
  assert.match(runtimeLog, /Guided scenario scope: Open the docs/);
  assert.match(runtimeLog, /Guided risk areas: collapsed menu/);
  assert.match(runtimeLog, /Guided iteration budget: 2/);
  assert.match(runtimeLog, /Guided iterations recorded before run: 0/);
  assert.match(gapAnalysis, /Guided exploration: yes/);
  assert.match(gapAnalysis, /Guided feature scope: docs navigation/);
  assert.match(gapAnalysis, /Guided scenario scope: Open the docs/);
  assert.match(gapAnalysis, /Guided risk areas: collapsed menu/);
  assert.match(gapAnalysis, /Guided iteration budget: 2/);
  assert.match(gapAnalysis, /Guided iterations recorded before run: 0/);
  assert.match(gapAnalysis, /Guided iterations recorded after run: 1/);
  assert.match(gapAnalysis, /Guided iterations remaining before run: 2/);
  assert.match(gapAnalysis, /Guided iterations remaining after run: 1/);
  assert.match(
    gapAnalysis,
    /Guided stop conditions: one bounded discovery outcome per iteration; stay within the selected run artifacts and selected exploration item; scope must remain within the recorded guided feature, scenario, and risk constraints; stop after 2 recorded guided exploration iteration\(s\) in outputs\/gap-analysis\.md/,
  );
});

test('prepareRun existing guided runs reuse recorded exploration constraints and merge new explicit limits deterministically', (t) => {
  const { repoRoot, result } = prepareGuidedCoverageRun(t);

  iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'guided exploration completed without new gaps',
        runtimeLayer: 'playwright-cli',
        coverageScope: 'docs navigation',
        gapCandidates: [],
      }),
      stderr: '',
    }),
  });

  const { runner } = createMockCommandRunner();
  const preparedAgain = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    constraints: ['risk area: offline footer'],
    commandRunner: runner,
  });

  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  assert.equal(
    preparedAgain.plannerSummary,
    'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (2 scenarios)',
  );
  assert.match(prdContent, /Guided risk areas: `collapsed menu, offline footer`/);
  assert.match(prdContent, /Guided iterations recorded: `1`/);
  assert.match(prdContent, /Guided iterations remaining: `1`/);
  assert.match(progressContent, /Guided risk areas: `collapsed menu, offline footer`/);
  assert.match(
    progressContent,
    /- \[x\] `P-002` Goal: identify one bounded guided coverage gap for Open the docs around collapsed menu[\s\S]*?Status: `pass`/,
  );
  assert.match(promptContent, /Guided risk areas: `collapsed menu, offline footer`/);
  assert.match(promptContent, /Guided iterations recorded: `1`/);
  assert.match(promptContent, /Guided iterations remaining: `1`/);
});

test('prepareRun existing guided runs rewrite planner-owned sections deterministically without duplicating guided metadata blocks', (t) => {
  const { repoRoot, result } = prepareGuidedCoverageRun(t);
  const { runner } = createMockCommandRunner();
  const originalPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const originalProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const originalPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  writeTextFile(
    result.runPaths.prdPath,
    originalPrd
      .replace(
        '- User constraint: feature: docs navigation',
        '- User constraint: feature: docs navigation\n- User constraint: feature: docs navigation',
      )
      .replace(/\s*$/, '\n\n## Guided Exploration\n\n- Guided mode: `stale`\n'),
  );
  writeTextFile(
    result.runPaths.progressPath,
    `${originalProgress.trimEnd()}\n\n## Guided Exploration\n\n- Guided mode: \`stale\`\n\n## Planner Copies\n\n${
      createProgressBlock({
        id: 'P-002',
        goal: 'stale guided duplicate',
        owner: 'qa-explorer',
      })
    }\n`,
  );
  writeTextFile(
    result.runPaths.promptPath,
    `${originalPrompt.trimEnd()}\n\n## Guided Exploration Context\n\n- Guided mode: \`stale\`\n`,
  );

  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const firstPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const firstProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const firstPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const secondPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const secondProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const secondPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  assert.equal(firstPrd, secondPrd);
  assert.equal(firstProgress, secondProgress);
  assert.equal(firstPrompt, secondPrompt);
  assert.equal(countOccurrences(firstPrd, /^## Guided Exploration$/gm), 1);
  assert.equal(countOccurrences(firstProgress, /^## Guided Exploration$/gm), 1);
  assert.equal(countOccurrences(firstPrompt, /^## Guided Exploration Context$/gm), 1);
  assert.equal(countOccurrences(firstPrd, /- User constraint: feature: docs navigation/g), 1);
  assert.equal(countOccurrences(firstProgress, /`P-002` Goal:/g), 1);
});

test('prepareRun planner handoff still accepts guided gap-analysis candidates without changing scenario-addition expectations', (t) => {
  const { repoRoot, result } = prepareGuidedCoverageRun(t);

  iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'identified one guided gap candidate',
        runtimeLayer: 'playwright-cli',
        coverageScope: 'docs navigation',
        gapCandidates: [
          {
            gap: 'missing collapsed menu coverage',
            candidateScenario: 'cover collapsed menu open and close',
            evidence: ['evidence/screenshots/menu-collapsed.png'],
          },
        ],
      }),
      stderr: '',
    }),
  });

  const { runner } = createMockCommandRunner();
  const preparedAgain = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const plannerHandoff = fs.readFileSync(result.runPaths.plannerHandoffPath, 'utf8');

  assert.match(
    preparedAgain.plannerSummary,
    /accepted gap candidate 1 for docs navigation: P-GAP-001 from cover collapsed menu open and close/,
  );
  assert.match(progressContent, /- \[ \] `P-GAP-001` Goal: cover collapsed menu open and close for docs navigation/);
  assert.match(progressContent, /Owner: `qa-executor`/);
  assert.match(
    progressContent,
    /- \[x\] `P-002` Goal: identify one bounded guided coverage gap for Open the docs around collapsed menu[\s\S]*?Status: `pass`/,
  );
  assert.match(plannerHandoff, /status=accepted/);
  assert.match(plannerHandoff, /Decision: accepted/);
  assert.match(plannerHandoff, /Progress item id: P-GAP-001/);
  assert.match(plannerHandoff, /Progress owner: qa-executor/);
});

test('prepareRun authors autonomous explorer artifacts for coverage-scoped autonomous runs with deterministic target selection', (t) => {
  const { result } = prepareAutonomousCoverageRun(t);
  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  assert.equal(
    result.plannerSummary,
    'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (2 scenarios)',
  );
  assert.match(prdContent, /## Autonomous Exploration/);
  assert.match(prdContent, /Autonomous mode: `enabled`/);
  assert.match(prdContent, /Autonomous target kind: `scenario`/);
  assert.match(prdContent, /Autonomous target: `Open the docs`/);
  assert.match(prdContent, /Autonomous target source: `normalized\.feature:first-scenario`/);
  assert.match(prdContent, /Autonomous iteration budget: `1`/);
  assert.match(prdContent, /Autonomous iterations recorded: `0`/);
  assert.match(prdContent, /Autonomous iterations remaining: `1`/);
  assert.match(
    prdContent,
    /Autonomous stop frame: `one bounded discovery outcome per iteration; stay within the selected run artifacts and selected exploration item; stay within the recorded autonomous scenario target; stop after 1 recorded autonomous exploration iteration\(s\) in outputs\/gap-analysis\.md; stop and route findings through planner review before scenario addition`/,
  );
  assert.match(progressContent, /## Autonomous Exploration/);
  assert.match(progressContent, /Autonomous explorer artifact: `outputs\/gap-analysis\.md`/);
  assert.match(progressContent, /Goal: identify one bounded autonomous coverage gap for Open the docs/);
  assert.match(progressContent, /Input: `PRD\.md` autonomous exploration target, `progress\.md` autonomous stop frame, and `normalized\.feature`/);
  assert.match(progressContent, /Owner: `qa-explorer`/);
  assert.match(progressContent, /Output: gap candidates recorded in `outputs\/gap-analysis\.md`/);
  assert.doesNotMatch(progressContent, /execute the generated feature-backed run for Playwright home page on Chromium/);
  assert.match(promptContent, /## Autonomous Exploration Context/);
  assert.match(promptContent, /Autonomous explorer output: `outputs\/gap-analysis\.md`/);
  assert.match(promptContent, /Do not mutate scenarios during autonomous exploration; planner handoff remains the boundary before scenario addition\./);
  assert.doesNotMatch(prdContent, /## Guided Exploration/);
  assert.doesNotMatch(progressContent, /## Guided Exploration/);
  assert.doesNotMatch(promptContent, /## Guided Exploration Context/);
});

test('iterateRun records autonomous exploration target, budget, stop frame, and scope fallback in explorer artifacts', (t) => {
  const { repoRoot, result } = prepareAutonomousCoverageRun(t);
  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'identified one autonomous gap',
        runtimeLayer: 'playwright-cli',
        gapCandidates: [
          {
            gap: 'missing collapsed menu coverage',
            candidateScenario: 'cover collapsed menu open and close',
            evidence: ['evidence/screenshots/menu-collapsed.png'],
          },
        ],
      }),
      stderr: '',
    }),
  });

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');

  assert.equal(iteration.selectedItemId, 'P-002');
  assert.equal(iteration.status, 'pass');
  assert.match(runtimeLog, /Autonomous exploration: yes/);
  assert.match(runtimeLog, /Autonomous target kind: scenario/);
  assert.match(runtimeLog, /Autonomous target: Open the docs/);
  assert.match(runtimeLog, /Autonomous target source: normalized\.feature:first-scenario/);
  assert.match(runtimeLog, /Autonomous iteration budget: 1/);
  assert.match(runtimeLog, /Autonomous iterations recorded before run: 0/);
  assert.match(runtimeLog, /Autonomous iterations remaining before run: 1/);
  assert.match(gapAnalysis, /Autonomous exploration: yes/);
  assert.match(gapAnalysis, /Scope: Open the docs/);
  assert.match(gapAnalysis, /Autonomous target: Open the docs/);
  assert.match(gapAnalysis, /Autonomous iteration budget: 1/);
  assert.match(gapAnalysis, /Autonomous iterations recorded before run: 0/);
  assert.match(gapAnalysis, /Autonomous iterations recorded after run: 1/);
  assert.match(gapAnalysis, /Autonomous iterations remaining before run: 1/);
  assert.match(gapAnalysis, /Autonomous iterations remaining after run: 0/);
  assert.match(
    gapAnalysis,
    /Autonomous stop frame: one bounded discovery outcome per iteration; stay within the selected run artifacts and selected exploration item; stay within the recorded autonomous scenario target; stop after 1 recorded autonomous exploration iteration\(s\) in outputs\/gap-analysis\.md; stop and route findings through planner review before scenario addition/,
  );
});

test('prepareRun existing autonomous runs reuse recorded target, budget, and stop frame deterministically', (t) => {
  const { repoRoot, result } = prepareAutonomousCoverageRun(t);

  iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'autonomous exploration completed without new gaps',
        runtimeLayer: 'playwright-cli',
        gapCandidates: [],
      }),
      stderr: '',
    }),
  });

  const { runner } = createMockCommandRunner();
  const preparedAgain = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    constraints: ['Keep existing evidence.'],
    commandRunner: runner,
  });

  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  assert.equal(
    preparedAgain.plannerSummary,
    'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (2 scenarios)',
  );
  assert.match(prdContent, /Autonomous target kind: `scenario`/);
  assert.match(prdContent, /Autonomous target: `Open the docs`/);
  assert.match(prdContent, /Autonomous iteration budget: `1`/);
  assert.match(prdContent, /Autonomous iterations recorded: `1`/);
  assert.match(prdContent, /Autonomous iterations remaining: `0`/);
  assert.match(progressContent, /Autonomous target: `Open the docs`/);
  assert.match(progressContent, /Autonomous iterations recorded: `1`/);
  assert.match(progressContent, /Autonomous iterations remaining: `0`/);
  assert.match(
    progressContent,
    /- \[x\] `P-002` Goal: identify one bounded autonomous coverage gap for Open the docs[\s\S]*?Status: `pass`/,
  );
  assert.match(promptContent, /Autonomous target: `Open the docs`/);
  assert.match(promptContent, /Autonomous iterations recorded: `1`/);
  assert.match(promptContent, /Autonomous iterations remaining: `0`/);
  assert.match(prdContent, /- User constraint: Keep existing evidence\./);
});

test('prepareRun existing autonomous runs rewrite planner-owned sections deterministically without duplicating autonomous metadata blocks', (t) => {
  const { repoRoot, result } = prepareAutonomousCoverageRun(t);
  const { runner } = createMockCommandRunner();
  const originalPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const originalProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const originalPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  writeTextFile(
    result.runPaths.prdPath,
    `${originalPrd.trimEnd()}\n\n## Autonomous Exploration\n\n- Autonomous mode: \`stale\`\n`,
  );
  writeTextFile(
    result.runPaths.progressPath,
    `${originalProgress.trimEnd()}\n\n## Autonomous Exploration\n\n- Autonomous mode: \`stale\`\n\n## Archived Planner Items\n\n${
      createProgressBlock({
        id: 'P-002',
        goal: 'stale autonomous duplicate',
        owner: 'qa-explorer',
      })
    }\n`,
  );
  writeTextFile(
    result.runPaths.promptPath,
    `${originalPrompt.trimEnd()}\n\n## Autonomous Exploration Context\n\n- Autonomous mode: \`stale\`\n`,
  );

  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const firstPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const firstProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const firstPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const secondPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const secondProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const secondPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  assert.equal(firstPrd, secondPrd);
  assert.equal(firstProgress, secondProgress);
  assert.equal(firstPrompt, secondPrompt);
  assert.equal(countOccurrences(firstPrd, /^## Autonomous Exploration$/gm), 1);
  assert.equal(countOccurrences(firstProgress, /^## Autonomous Exploration$/gm), 1);
  assert.equal(countOccurrences(firstPrompt, /^## Autonomous Exploration Context$/gm), 1);
  assert.equal(countOccurrences(firstProgress, /`P-002` Goal:/g), 1);
});

test('prepareRun refines an existing run in place without resetting unrelated artifacts', (t) => {
  const { repoRoot, result: existingRun } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();
  const runtimeLogSentinel = 'runtime proof already recorded\n';
  const fallbackLogSentinel = 'fallback reason already recorded\n';
  const gapAnalysisSentinel = '# Gap Analysis\n\nExisting gap analysis.\n';
  const healReportSentinel = '# Heal Report\n\nExisting heal report.\n';
  const originalFeature = fs.readFileSync(existingRun.runPaths.normalizedFeaturePath, 'utf8');
  let createCalled = false;

  writeGeneratedSpec(repoRoot, existingRun.runId);
  writeTextFile(existingRun.runPaths.runtimeLogPath, runtimeLogSentinel);
  writeTextFile(existingRun.runPaths.fallbackLogPath, fallbackLogSentinel);
  writeTextFile(existingRun.runPaths.gapAnalysisPath, gapAnalysisSentinel);
  writeTextFile(existingRun.runPaths.healReportPath, healReportSentinel);

  const result = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: existingRun.runId,
    constraints: ['Keep existing evidence.'],
    commandRunner: runner,
    createRunFn: () => {
      createCalled = true;
      throw new Error('createRun should not execute for prepare-run --run-id');
    },
  });

  const prdContent = fs.readFileSync(existingRun.runPaths.prdPath, 'utf8');
  const progressContent = fs.readFileSync(existingRun.runPaths.progressPath, 'utf8');
  const promptContent = fs.readFileSync(existingRun.runPaths.promptPath, 'utf8');
  const verifierLog = fs.readFileSync(existingRun.runPaths.verifierLogPath, 'utf8');
  const normalizedFeature = fs.readFileSync(existingRun.runPaths.normalizedFeaturePath, 'utf8');

  assert.equal(createCalled, false);
  assert.equal(result.runId, existingRun.runId);
  assert.equal(
    result.clarifierSummary,
    `reloaded existing run ${existingRun.runId} from .qa-harness/runs/${existingRun.runId} for in-place planner refinement; 1 constraint`,
  );
  assert.equal(result.plannerSummary, 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)');
  assert.equal(result.verifierSummary, '9 exported steps, 1 listed tests');
  assert.match(prdContent, /## Planner Refinement/);
  assert.match(prdContent, /- User constraint: Keep existing evidence\./);
  assert.match(progressContent, /Goal: verify planner-refined artifacts and generated BDD specs for Playwright home page/);
  assert.match(promptContent, /## Planner Context/);
  assert.match(verifierLog, /status=pass/);
  assert.equal(normalizedFeature, originalFeature);
  assert.equal(fs.readFileSync(existingRun.runPaths.runtimeLogPath, 'utf8'), runtimeLogSentinel);
  assert.equal(fs.readFileSync(existingRun.runPaths.fallbackLogPath, 'utf8'), fallbackLogSentinel);
  assert.equal(fs.readFileSync(existingRun.runPaths.gapAnalysisPath, 'utf8'), gapAnalysisSentinel);
  assert.equal(fs.readFileSync(existingRun.runPaths.healReportPath, 'utf8'), healReportSentinel);
});

test('prepareRun existing-run refinement invokes verifier after planner success', (t) => {
  const { repoRoot, result: existingRun } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();
  const callOrder = [];

  writeGeneratedSpec(repoRoot, existingRun.runId);

  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: existingRun.runId,
    commandRunner: runner,
    planRunFn: (options) => {
      callOrder.push('planner');
      return planPreparedRunArtifacts(options);
    },
    verifyRunFn: (options) => {
      callOrder.push('verify-run');
      return verifyRun(options);
    },
  });

  assert.deepEqual(callOrder, ['planner', 'verify-run']);
});

test('prepareRun existing-run refinement consumes one recorded explorer gap proposal into an atomic progress item', (t) => {
  const { repoRoot, result: existingRun } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();

  writeGeneratedSpec(repoRoot, existingRun.runId);
  writeStructuredLogEntry(existingRun.runPaths.gapAnalysisPath, 'pass', [
    'Selected item: P-735 - identify bounded coverage gaps around the docs navigation',
    'Scope: docs navigation',
    'Runtime status: pass',
    'Runtime layer: playwright-cli',
    'Runtime log: logs/runtime.log',
    'Candidate count: 2',
    'Candidate 1 gap: missing collapsed menu coverage',
    'Candidate 1 scenario: cover collapsed menu open and close',
    'Candidate 1 evidence: evidence/screenshots/menu-collapsed.png',
    'Candidate 2 gap: missing docs return-path coverage',
    'Candidate 2 scenario: cover docs return CTA back to the home page',
    'Summary: identified 2 bounded coverage gaps',
  ]);

  const result = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: existingRun.runId,
    commandRunner: runner,
  });

  const progressContent = fs.readFileSync(existingRun.runPaths.progressPath, 'utf8');
  const prdContent = fs.readFileSync(existingRun.runPaths.prdPath, 'utf8');
  const promptContent = fs.readFileSync(existingRun.runPaths.promptPath, 'utf8');
  const plannerHandoff = fs.readFileSync(existingRun.runPaths.plannerHandoffPath, 'utf8');

  assert.match(
    result.plannerSummary,
    /accepted gap candidate 1 for docs navigation: P-GAP-001 from cover collapsed menu open and close/,
  );
  assert.match(prdContent, /## Explorer Gap Handoff/);
  assert.match(prdContent, /Accepted gap items: `1`/);
  assert.match(promptContent, /Explorer handoff source: `outputs\/gap-analysis\.md`/);
  assert.match(promptContent, /Accepted explorer handoff items: `1`/);
  assert.match(
    progressContent,
    new RegExp(
      '- \\[ \\] `P-GAP-001` Goal: cover collapsed menu open and close for docs navigation[\\s\\S]*?'
      + 'Input: accepted gap candidate 1 in `outputs/gap-analysis\\.md` for `docs navigation`[\\s\\S]*?'
      + 'Output: verifier-backed proof recorded in `logs/verifier\\.log`[\\s\\S]*?'
      + 'Verify: `npm run qa:orchestrator -- advance-run --run-id '
      + existingRun.runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '`[\\s\\S]*?Owner: `qa-executor`[\\s\\S]*?Retry budget: `1`',
    ),
  );
  assert.doesNotMatch(progressContent, /cover docs return CTA back to the home page/);
  assert.match(plannerHandoff, /status=accepted/);
  assert.match(plannerHandoff, /Source artifact: outputs\/gap-analysis\.md/);
  assert.match(plannerHandoff, /Candidate ordinal: 1/);
  assert.match(plannerHandoff, /Decision: accepted/);
  assert.match(plannerHandoff, /Progress item id: P-GAP-001/);
  assert.match(plannerHandoff, /Progress goal: cover collapsed menu open and close for docs navigation/);
});

test('planPreparedRunArtifacts rejects vague explorer gap proposals deterministically and records the rejection', (t) => {
  const { repoRoot, result } = createFeatureRun(t);

  writeStructuredLogEntry(result.runPaths.gapAnalysisPath, 'pass', [
    'Selected item: P-736 - identify bounded coverage gaps around the checkout drawer',
    'Scope: checkout drawer',
    'Runtime status: pass',
    'Runtime layer: playwright-cli',
    'Runtime log: logs/runtime.log',
    'Candidate count: 1',
    'Candidate 1 gap: checkout close state remains unverified',
    'Candidate 1 scenario: cover checkout coverage',
    'Summary: identified one vague gap proposal',
  ]);

  const planning = planPreparedRunArtifacts({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    existingRunRefinement: true,
  });

  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const plannerHandoff = fs.readFileSync(result.runPaths.plannerHandoffPath, 'utf8');

  assert.match(
    planning.summary,
    /rejected gap candidate 1 for checkout drawer: candidate scenario must avoid generic coverage wording and name one concrete scenario-sized change\./,
  );
  assert.match(prdContent, /## Explorer Gap Handoff/);
  assert.match(prdContent, /Rejected gap proposals: `1`/);
  assert.doesNotMatch(progressContent, /P-GAP-/);
  assert.match(plannerHandoff, /status=rejected/);
  assert.match(plannerHandoff, /Decision: rejected/);
  assert.match(
    plannerHandoff,
    /Reason: candidate scenario must avoid generic coverage wording and name one concrete scenario-sized change\./,
  );
});

test('planPreparedRunArtifacts still rejects recorded addition targets without a candidate scenario', (t) => {
  const { repoRoot, result } = createFeatureRun(t);

  writeStructuredLogEntry(result.runPaths.gapAnalysisPath, 'blocked', [
    'Selected item: P-736B - inspect footer coverage gaps',
    'Scope: docs footer',
    'Runtime status: blocked',
    'Runtime layer: playwright-test',
    'Runtime log: logs/runtime.log',
    'Observed gap: offline footer return path remains unproven',
    'Candidate addition target: Features/homepage.feature :: Offline footer return path',
    'Supporting evidence: evidence/screenshots/footer-offline.png',
    'Stop reason: bounded discovery stopped after footer navigation diverged',
    'Candidate count: 1',
    'Candidate 1 gap: offline footer return path remains uncovered',
    'Candidate 1 addition target: Features/homepage.feature :: Offline footer return path',
    'Summary: addition target recorded without a concrete scenario',
  ]);

  const planning = planPreparedRunArtifacts({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    existingRunRefinement: true,
  });

  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const plannerHandoff = fs.readFileSync(result.runPaths.plannerHandoffPath, 'utf8');

  assert.match(
    planning.summary,
    /rejected gap candidate 1 for docs footer: missing candidate scenario text in outputs\/gap-analysis\.md\./,
  );
  assert.doesNotMatch(progressContent, /P-GAP-/);
  assert.match(plannerHandoff, /status=rejected/);
  assert.match(plannerHandoff, /Candidate addition target: Features\/homepage\.feature :: Offline footer return path/);
  assert.match(plannerHandoff, /Reason: missing candidate scenario text in outputs\/gap-analysis\.md\./);
});

test('planPreparedRunArtifacts rebuilds accepted planner handoff items from the recorded planner handoff artifact', (t) => {
  const { repoRoot, result } = createFeatureRun(t);
  const originalProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  writeStructuredLogEntry(result.runPaths.gapAnalysisPath, 'pass', [
    'Selected item: P-737 - identify bounded coverage gaps around the docs navigation',
    'Scope: docs navigation',
    'Runtime status: pass',
    'Runtime layer: playwright-cli',
    'Runtime log: logs/runtime.log',
    'Candidate count: 1',
    'Candidate 1 gap: missing collapsed menu coverage',
    'Candidate 1 scenario: cover collapsed menu open and close',
    'Summary: identified 1 bounded coverage gap',
  ]);

  planPreparedRunArtifacts({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    existingRunRefinement: true,
  });

  writeTextFile(result.runPaths.progressPath, originalProgress);

  const secondPlanning = planPreparedRunArtifacts({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    existingRunRefinement: true,
  });

  const rebuiltProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const plannerHandoff = fs.readFileSync(result.runPaths.plannerHandoffPath, 'utf8');

  assert.equal(
    secondPlanning.summary,
    'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
  );
  assert.match(rebuiltProgress, /- \[ \] `P-GAP-001` Goal: cover collapsed menu open and close for docs navigation/);
  assert.equal((plannerHandoff.match(/status=accepted/g) || []).length, 1);
});

test('prepareRun does not duplicate planner-handoff progress items when repeated gap-analysis entries describe the same candidate', (t) => {
  const { repoRoot, result } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();

  writeGeneratedSpec(repoRoot, result.runId);
  writeTextFile(result.runPaths.gapAnalysisPath, '# Gap Analysis\n\n');
  appendStructuredLogEntry(result.runPaths.gapAnalysisPath, 'pass', [
    'Selected item: P-737 - identify bounded coverage gaps around the docs navigation',
    'Scope: docs navigation',
    'Runtime status: pass',
    'Runtime layer: playwright-cli',
    'Runtime log: logs/runtime.log',
    'Candidate count: 1',
    'Candidate 1 gap: missing collapsed menu coverage',
    'Candidate 1 scenario: cover collapsed menu open and close',
    'Summary: identified 1 bounded coverage gap',
  ], '2026-04-09T12:34:56.000Z');
  appendStructuredLogEntry(result.runPaths.gapAnalysisPath, 'pass', [
    'Selected item: P-737 - identify bounded coverage gaps around the docs navigation',
    'Scope: docs navigation',
    'Runtime status: pass',
    'Runtime layer: playwright-cli',
    'Runtime log: logs/runtime.log',
    'Candidate count: 1',
    'Candidate 1 gap: missing collapsed menu coverage',
    'Candidate 1 scenario: cover collapsed menu open and close',
    'Summary: identified 1 bounded coverage gap again',
  ], '2026-04-09T12:35:56.000Z');

  const firstPrepared = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });
  const secondPrepared = prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const plannerHandoff = fs.readFileSync(result.runPaths.plannerHandoffPath, 'utf8');

  assert.match(
    firstPrepared.plannerSummary,
    /accepted gap candidate 1 for docs navigation: P-GAP-001 from cover collapsed menu open and close/,
  );
  assert.equal(
    secondPrepared.plannerSummary,
    'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
  );
  assert.equal(countOccurrences(progressContent, /`P-GAP-001` Goal:/g), 1);
  assert.doesNotMatch(progressContent, /P-GAP-002/);
  assert.equal(countOccurrences(plannerHandoff, /status=accepted/g), 1);
});

test('prepareRun keeps planner-handoff report history readable while deduping active planner-owned projections', (t) => {
  const { repoRoot, result } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();
  const originalProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  writeGeneratedSpec(repoRoot, result.runId);
  writeTextFile(result.runPaths.plannerHandoffPath, '# Planner Handoff\n\n');
  appendStructuredLogEntry(result.runPaths.plannerHandoffPath, 'accepted', [
    'Source artifact: outputs/gap-analysis.md',
    'Candidate key: duplicate-accepted-1',
    'Gap analysis timestamp: 2026-04-09T12:34:56.000Z',
    'Selected item: P-735 - identify bounded coverage gaps around the docs navigation',
    'Scope: docs navigation',
    'Candidate ordinal: 1',
    'Candidate gap: missing collapsed menu coverage',
    'Candidate scenario: cover collapsed menu open and close',
    'Decision: accepted',
    'Progress item id: P-GAP-001',
    'Progress goal: cover collapsed menu open and close for docs navigation',
    'Progress input: accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
    'Progress output: verifier-backed proof recorded in `logs/verifier.log`',
    `Progress verify: \`npm run qa:orchestrator -- advance-run --run-id ${result.runId}\``,
    'Progress owner: qa-executor',
    'Progress retry budget: 1',
    'Summary: accepted gap candidate 1 for docs navigation: P-GAP-001 from cover collapsed menu open and close',
  ], '2026-04-09T12:34:56.000Z');
  appendStructuredLogEntry(result.runPaths.plannerHandoffPath, 'accepted', [
    'Source artifact: outputs/gap-analysis.md',
    'Candidate key: duplicate-accepted-2',
    'Gap analysis timestamp: 2026-04-09T12:35:56.000Z',
    'Selected item: P-735 - identify bounded coverage gaps around the docs navigation',
    'Scope: docs navigation',
    'Candidate ordinal: 1',
    'Candidate gap: missing collapsed menu coverage',
    'Candidate scenario: cover collapsed menu open and close',
    'Decision: accepted',
    'Progress item id: P-GAP-001',
    'Progress goal: cover collapsed menu open and close for docs navigation',
    'Progress input: accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
    'Progress output: verifier-backed proof recorded in `logs/verifier.log`',
    `Progress verify: \`npm run qa:orchestrator -- advance-run --run-id ${result.runId}\``,
    'Progress owner: qa-executor',
    'Progress retry budget: 1',
    'Summary: accepted gap candidate 1 for docs navigation: P-GAP-001 from cover collapsed menu open and close',
  ], '2026-04-09T12:35:56.000Z');
  appendStructuredLogEntry(result.runPaths.plannerHandoffPath, 'rejected', [
    'Source artifact: outputs/gap-analysis.md',
    'Candidate key: rejected-footer-candidate',
    'Gap analysis timestamp: 2026-04-09T12:36:56.000Z',
    'Selected item: P-736 - inspect footer coverage gaps',
    'Scope: docs footer',
    'Candidate ordinal: 1',
    'Candidate gap: footer CTA remains uncovered',
    'Candidate scenario: cover footer return path',
    'Decision: rejected',
    'Reason: candidate scenario must avoid generic coverage wording and name one concrete scenario-sized change.',
    'Summary: rejected gap candidate 1 for docs footer: candidate scenario must avoid generic coverage wording and name one concrete scenario-sized change.',
  ], '2026-04-09T12:36:56.000Z');
  writeTextFile(
    result.runPaths.progressPath,
    `${originalProgress.trimEnd()}\n\n## Active Items\n\n${
      createProgressBlock({
        id: 'P-GAP-001',
        goal: 'cover collapsed menu open and close for docs navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: `\`npm run qa:orchestrator -- advance-run --run-id ${result.runId}\``,
        owner: 'qa-executor',
      })
    }\n\n## Archived Planner Items\n\n${
      createProgressBlock({
        id: 'P-GAP-001',
        goal: 'stale archived planner duplicate',
        owner: 'qa-executor',
      })
    }\n`,
  );

  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const plannerHandoff = fs.readFileSync(result.runPaths.plannerHandoffPath, 'utf8');

  assert.equal(countOccurrences(progressContent, /^## Active Items$/gm), 1);
  assert.equal(countOccurrences(progressContent, /`P-GAP-001` Goal:/g), 1);
  assert.match(prdContent, /Accepted gap items: `1`/);
  assert.match(prdContent, /Rejected gap proposals: `1`/);
  assert.equal(countOccurrences(plannerHandoff, /status=accepted/g), 2);
  assert.equal(countOccurrences(plannerHandoff, /status=rejected/g), 1);
});

test('prepareRun existing-run refinement preserves artifacts when planner fails', (t) => {
  const { repoRoot, result: existingRun } = createFeatureRun(t);
  const originalPrd = fs.readFileSync(existingRun.runPaths.prdPath, 'utf8');
  const originalProgress = fs.readFileSync(existingRun.runPaths.progressPath, 'utf8');
  const originalPrompt = fs.readFileSync(existingRun.runPaths.promptPath, 'utf8');
  const originalFeature = fs.readFileSync(existingRun.runPaths.normalizedFeaturePath, 'utf8');
  let verifyCalled = false;

  assert.throws(
    () =>
      prepareRun({
        repoRoot,
        templatesDir: realTemplatesDir,
        runId: existingRun.runId,
        planRunFn: () => {
          throw new Error('planner could not refine the current run artifacts');
        },
        verifyRunFn: () => {
          verifyCalled = true;
          throw new Error('verifyRun should not execute after planner failure');
        },
      }),
    (error) => {
      assert.equal(error.prepareRunFailure.stage, 'planner');
      assert.equal(error.prepareRunFailure.runId, existingRun.runId);
      assert.match(error.prepareRunFailure.runPathDisplay, new RegExp(`\\.qa-harness/runs/${existingRun.runId}$`));
      assert.match(error.prepareRunFailure.clarifierSummary, /reloaded existing run .* in-place planner refinement/);
      assert.equal(error.prepareRunFailure.plannerSummary, 'planner could not refine the current run artifacts');
      assert.equal(error.prepareRunFailure.retainedArtifactSummary, 'existing artifacts retained.');
      return true;
    },
  );

  assert.equal(verifyCalled, false);
  assert.equal(fs.readFileSync(existingRun.runPaths.prdPath, 'utf8'), originalPrd);
  assert.equal(fs.readFileSync(existingRun.runPaths.progressPath, 'utf8'), originalProgress);
  assert.equal(fs.readFileSync(existingRun.runPaths.promptPath, 'utf8'), originalPrompt);
  assert.equal(fs.readFileSync(existingRun.runPaths.normalizedFeaturePath, 'utf8'), originalFeature);
});

test('prepareRun existing-run refinement preserves artifacts when verifier fails after planner refinement', (t) => {
  const { repoRoot, result: existingRun } = createFeatureRun(t);
  const originalFeature = fs.readFileSync(existingRun.runPaths.normalizedFeaturePath, 'utf8');
  const { runner } = createMockCommandRunner({
    exportResult: {
      status: 1,
      stdout: '',
      stderr: 'export failed',
    },
  });

  assert.throws(
    () =>
      prepareRun({
        repoRoot,
        templatesDir: realTemplatesDir,
        runId: existingRun.runId,
        commandRunner: runner,
      }),
    (error) => {
      assert.equal(error.prepareRunFailure.stage, 'verification');
      assert.equal(error.prepareRunFailure.runId, existingRun.runId);
      assert.match(error.prepareRunFailure.runPathDisplay, new RegExp(`\\.qa-harness/runs/${existingRun.runId}$`));
      assert.match(error.prepareRunFailure.clarifierSummary, /reloaded existing run .* in-place planner refinement/);
      assert.match(
        error.prepareRunFailure.plannerSummary,
        /refined PRD\.md, progress\.md, and PROMPT\.md for Playwright home page \(1 scenario\)/,
      );
      assert.match(error.prepareRunFailure.verifierSummary, /bddgen export failed/i);
      assert.equal(error.prepareRunFailure.retainedArtifactSummary, 'existing artifacts retained.');
      return true;
    },
  );

  assert.match(fs.readFileSync(existingRun.runPaths.prdPath, 'utf8'), /## Planner Refinement/);
  assert.match(fs.readFileSync(existingRun.runPaths.progressPath, 'utf8'), /Owner: `qa-verifier`/);
  assert.match(fs.readFileSync(existingRun.runPaths.progressPath, 'utf8'), /Status: `fail`/);
  assert.match(fs.readFileSync(existingRun.runPaths.verifierLogPath, 'utf8'), /status=fail/);
  assert.equal(fs.readFileSync(existingRun.runPaths.normalizedFeaturePath, 'utf8'), originalFeature);
});

test('prepareRun preserves created artifacts when verification fails after run creation', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );
  const { runner } = createMockCommandRunner({
    exportResult: {
      status: 1,
      stdout: '',
      stderr: 'export failed',
    },
  });
  let createdRun = null;

  assert.throws(
    () =>
      prepareRun({
        repoRoot,
        templatesDir: realTemplatesDir,
        now: new Date('2026-04-09T12:34:56.000Z'),
        request: {
          intent: 'plan',
          sourceType: 'feature',
          sourceRef: featurePath,
        },
        commandRunner: runner,
        createRunFn: (options) => {
          createdRun = createRun(options);
          return createdRun;
        },
      }),
    (error) => {
      assert.equal(error.prepareRunFailure.stage, 'verification');
      assert.equal(error.prepareRunFailure.runId, '20260409T123456Z-plan-homepage');
      assert.match(error.prepareRunFailure.runPathDisplay, /\.qa-harness\/runs\/20260409T123456Z-plan-homepage$/);
      assert.match(error.prepareRunFailure.clarifierSummary, /normalized feature-backed plan request from Features\/homepage\.feature/);
      assert.match(error.prepareRunFailure.plannerSummary, /refined PRD\.md, progress\.md, and PROMPT\.md for Playwright home page \(1 scenario\)/);
      assert.match(error.prepareRunFailure.verifierSummary, /bddgen export failed/i);
      return true;
    },
  );

  assert.ok(createdRun);
  assert.equal(fs.existsSync(createdRun.runPaths.runDir), true);
  assert.equal(fs.existsSync(createdRun.runPaths.normalizedFeaturePath), true);
  assert.match(fs.readFileSync(createdRun.runPaths.verifierLogPath, 'utf8'), /status=fail/);
  assert.match(fs.readFileSync(createdRun.runPaths.progressPath, 'utf8'), /Owner: `qa-verifier`/);
  assert.match(fs.readFileSync(createdRun.runPaths.progressPath, 'utf8'), /Status: `fail`/);
  assert.match(fs.readFileSync(createdRun.runPaths.prdPath, 'utf8'), /## Request Normalization/);
  assert.match(fs.readFileSync(createdRun.runPaths.prdPath, 'utf8'), /## Planner Refinement/);
});

test('prepareRun preserves created artifacts when planner fails after run creation', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );
  let createdRun = null;
  let verifyCalled = false;

  assert.throws(
    () =>
      prepareRun({
        repoRoot,
        templatesDir: realTemplatesDir,
        now: new Date('2026-04-09T12:34:56.000Z'),
        request: {
          intent: 'plan',
          sourceType: 'feature',
          sourceRef: featurePath,
        },
        createRunFn: (options) => {
          createdRun = createRun(options);
          return createdRun;
        },
        planRunFn: () => {
          throw new Error('planner could not refine the just-created artifacts');
        },
        verifyRunFn: () => {
          verifyCalled = true;
          throw new Error('verifyRun should not execute after planner failure');
        },
      }),
    (error) => {
      assert.equal(error.prepareRunFailure.stage, 'planner');
      assert.equal(error.prepareRunFailure.runId, '20260409T123456Z-plan-homepage');
      assert.match(error.prepareRunFailure.runPathDisplay, /\.qa-harness\/runs\/20260409T123456Z-plan-homepage$/);
      assert.match(error.prepareRunFailure.clarifierSummary, /normalized feature-backed plan request from Features\/homepage\.feature/);
      assert.match(error.prepareRunFailure.plannerSummary, /planner could not refine the just-created artifacts/);
      return true;
    },
  );

  assert.ok(createdRun);
  assert.equal(verifyCalled, false);
  assert.equal(fs.existsSync(createdRun.runPaths.runDir), true);
  assert.equal(fs.existsSync(createdRun.runPaths.normalizedFeaturePath), true);
  assert.match(fs.readFileSync(createdRun.runPaths.prdPath, 'utf8'), /## Request Normalization/);
});

test('prepareRun stops on clarifier rejection before run creation', () => {
  let createCalled = false;
  let verifyCalled = false;

  assert.throws(
    () =>
      prepareRun({
        request: {
          intent: 'plan',
          sourceType: 'jira',
          sourceRef: 'QA-123',
        },
        createRunFn: () => {
          createCalled = true;
          throw new Error('createRun should not execute after clarifier rejection');
        },
        verifyRunFn: () => {
          verifyCalled = true;
          throw new Error('verifyRun should not execute after clarifier rejection');
        },
      }),
    (error) => {
      assert.equal(error.prepareRunFailure.stage, 'clarifier');
      assert.match(error.prepareRunFailure.clarifierSummary, /only supports --source-type feature/i);
      return true;
    },
  );

  assert.equal(createCalled, false);
  assert.equal(verifyCalled, false);
});

test('clarifyPrepareRunRequest rejects freeform requests that do not include a usable feature path', (t) => {
  const repoRoot = createTempRepo(t);

  assert.throws(
    () =>
      clarifyPrepareRunRequest({
        repoRoot,
        request: {
          request: 'Please prepare a run for the home page flow.',
        },
      }),
    /must include one concrete local feature path such as Features\/homepage\.feature/i,
  );
});

test('clarifyPrepareRunRequest rejects freeform Jira intake', (t) => {
  const repoRoot = createTempRepo(t);

  assert.throws(
    () =>
      clarifyPrepareRunRequest({
        repoRoot,
        request: {
          request: 'Please prepare a run from Jira QA-123.',
        },
      }),
    /Jira or ticket intake is not supported in this slice/i,
  );
});

test('clarifyPrepareRunRequest rejects freeform non-feature intake', (t) => {
  const repoRoot = createTempRepo(t);

  assert.throws(
    () =>
      clarifyPrepareRunRequest({
        repoRoot,
        request: {
          request: 'Please prepare a run from tests/homepage.spec.ts.',
        },
      }),
    /Non-feature artifact or spec intake is not supported in this slice/i,
  );
});

test('runCli prepare-run routes parsed options to the composed primitive and prints stdout on success', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const exitCode = runCli(
    [
      'prepare-run',
      '--intent',
      'plan',
      '--source-type',
      'feature',
      '--source-ref',
      'Features/homepage.feature',
      '--mode',
      'standard',
      '--scope',
      'single-feature',
      '--constraint',
      'Stay feature-backed.',
    ],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: (options) => {
        capturedOptions = options;
        return {
          runId: 'sample-run',
          runPaths: {
            runDir: path.join(repoRoot, '.qa-harness', 'runs', 'sample-run'),
          },
          clarifierSummary: 'normalized feature-backed plan request from Features/homepage.feature; mode=standard; scope=single-feature',
          plannerSummary: 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
          verifierSummary: '9 exported steps, 1 listed tests',
        };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(capturedOptions.request.intent, 'plan');
  assert.equal(capturedOptions.request.sourceType, 'feature');
  assert.equal(capturedOptions.request.sourceRef, 'Features/homepage.feature');
  assert.equal(capturedOptions.request.mode, 'standard');
  assert.equal(capturedOptions.request.scope, 'single-feature');
  assert.deepEqual(capturedOptions.request.constraints, ['Stay feature-backed.']);
  assert.match(
    stdout,
    /Prepared run sample-run at \.qa-harness\/runs\/sample-run: ready; clarifier=normalized feature-backed plan request from Features\/homepage\.feature; mode=standard; scope=single-feature; planner=refined PRD\.md, progress\.md, and PROMPT\.md for Playwright home page \(1 scenario\); verifier=9 exported steps, 1 listed tests; artifacts=progress\.md, logs\/verifier\.log/,
  );
});

test('runCli prepare-run routes freeform --request intake to the composed primitive and prints stdout on success', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const exitCode = runCli(
    [
      'prepare-run',
      '--request',
      'Please prepare a run for Features/homepage.feature.',
      '--constraint',
      'Stay feature-backed.',
    ],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: (options) => {
        capturedOptions = options;
        return {
          runId: 'sample-run',
          runPaths: resolveRunPaths(repoRoot, 'sample-run'),
          clarifierSummary: 'normalized feature-backed plan request from Features/homepage.feature; mode=standard; scope=single-feature; 1 constraint',
          plannerSummary: 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
          verifierSummary: '9 exported steps, 1 listed tests',
        };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.deepEqual(capturedOptions.request, {
    request: 'Please prepare a run for Features/homepage.feature.',
    constraints: ['Stay feature-backed.'],
  });
  assert.match(
    stdout,
    /Prepared run sample-run at \.qa-harness\/runs\/sample-run: ready; clarifier=normalized feature-backed plan request from Features\/homepage\.feature; mode=standard; scope=single-feature; 1 constraint; planner=refined PRD\.md, progress\.md, and PROMPT\.md for Playwright home page \(1 scenario\); verifier=9 exported steps, 1 listed tests; artifacts=progress\.md, logs\/verifier\.log/,
  );
});

test('runCli prepare-run routes existing-run --run-id refinement to the composed primitive and prints stdout on success', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const exitCode = runCli(
    [
      'prepare-run',
      '--run-id',
      'sample-run',
      '--constraint',
      'Keep existing evidence.',
    ],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: (options) => {
        capturedOptions = options;
        return {
          runId: 'sample-run',
          runPaths: resolveRunPaths(repoRoot, 'sample-run'),
          clarifierSummary: 'reloaded existing run sample-run from .qa-harness/runs/sample-run for in-place planner refinement; 1 constraint',
          plannerSummary: 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
          verifierSummary: '9 exported steps, 1 listed tests',
        };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(capturedOptions.runId, 'sample-run');
  assert.deepEqual(capturedOptions.constraints, ['Keep existing evidence.']);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedOptions, 'request'), false);
  assert.match(
    stdout,
    /Prepared run sample-run at \.qa-harness\/runs\/sample-run: ready; clarifier=reloaded existing run sample-run from \.qa-harness\/runs\/sample-run for in-place planner refinement; 1 constraint; planner=refined PRD\.md, progress\.md, and PROMPT\.md for Playwright home page \(1 scenario\); verifier=9 exported steps, 1 listed tests; artifacts=progress\.md, logs\/verifier\.log/,
  );
});

test('runCli prepare-run prints clarifier rejections to stderr and returns exit code 1', () => {
  let stdout = '';
  let stderr = '';

  const clarifierError = new Error('This bootstrap slice only supports --source-type feature. Received "jira".');
  clarifierError.prepareRunFailure = {
    stage: 'clarifier',
    clarifierSummary: 'This bootstrap slice only supports --source-type feature. Received "jira".',
  };

  const exitCode = runCli(
    [
      'prepare-run',
      '--intent',
      'plan',
      '--source-type',
      'jira',
      '--source-ref',
      'QA-123',
    ],
    {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: () => {
        throw clarifierError;
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Prepare-run clarifier rejected request: This bootstrap slice only supports --source-type feature\. Received "jira"\./,
  );
});

test('runCli prepare-run prints verification failures to stderr and returns exit code 1', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';

  const verificationError = new Error('playwright test --list did not find generated tests for run sample-run.');
  verificationError.prepareRunFailure = {
    stage: 'verification',
    runId: 'sample-run',
    runPaths: {
      runDir: path.join(repoRoot, '.qa-harness', 'runs', 'sample-run'),
    },
    clarifierSummary: 'normalized feature-backed plan request from Features/homepage.feature; mode=standard; scope=single-feature',
    plannerSummary: 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
    verifierSummary: 'playwright test --list did not find generated tests for run sample-run.',
  };

  const exitCode = runCli(
    [
      'prepare-run',
      '--intent',
      'plan',
      '--source-type',
      'feature',
      '--source-ref',
      'Features/homepage.feature',
    ],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: () => {
        throw verificationError;
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Prepare-run verification failed for sample-run at \.qa-harness\/runs\/sample-run: clarifier=normalized feature-backed plan request from Features\/homepage\.feature; mode=standard; scope=single-feature; planner=refined PRD\.md, progress\.md, and PROMPT\.md for Playwright home page \(1 scenario\); verifier=playwright test --list did not find generated tests for run sample-run\.; retained=created artifacts retained\.; artifacts=progress\.md, logs\/verifier\.log/,
  );
});

test('runCli prepare-run prints planner failures to stderr and returns exit code 1', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';

  const plannerError = new Error('planner could not refine the just-created artifacts');
  plannerError.prepareRunFailure = {
    stage: 'planner',
    runId: 'sample-run',
    runPaths: {
      runDir: path.join(repoRoot, '.qa-harness', 'runs', 'sample-run'),
    },
    clarifierSummary: 'normalized feature-backed plan request from Features/homepage.feature; mode=standard; scope=single-feature',
    plannerSummary: 'planner could not refine the just-created artifacts',
  };

  const exitCode = runCli(
    [
      'prepare-run',
      '--intent',
      'plan',
      '--source-type',
      'feature',
      '--source-ref',
      'Features/homepage.feature',
    ],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: () => {
        throw plannerError;
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Prepare-run planner failed for sample-run at \.qa-harness\/runs\/sample-run: clarifier=normalized feature-backed plan request from Features\/homepage\.feature; mode=standard; scope=single-feature; planner=planner could not refine the just-created artifacts; retained=created artifacts retained\.; artifacts=PRD\.md, progress\.md, PROMPT\.md/,
  );
});

test('runCli prepare-run prints existing-run planner failures to stderr and returns exit code 1', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';

  const plannerError = new Error('planner could not refine the current run artifacts');
  plannerError.prepareRunFailure = {
    stage: 'planner',
    runId: 'sample-run',
    runPaths: {
      runDir: path.join(repoRoot, '.qa-harness', 'runs', 'sample-run'),
    },
    clarifierSummary: 'reloaded existing run sample-run from .qa-harness/runs/sample-run for in-place planner refinement',
    plannerSummary: 'planner could not refine the current run artifacts',
    retainedArtifactSummary: 'existing artifacts retained.',
  };

  const exitCode = runCli(
    ['prepare-run', '--run-id', 'sample-run'],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: () => {
        throw plannerError;
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Prepare-run planner failed for sample-run at \.qa-harness\/runs\/sample-run: clarifier=reloaded existing run sample-run from \.qa-harness\/runs\/sample-run for in-place planner refinement; planner=planner could not refine the current run artifacts; retained=existing artifacts retained\.; artifacts=PRD\.md, progress\.md, PROMPT\.md/,
  );
});

test('runCli prepare-run prints existing-run verification failures to stderr and returns exit code 1', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';

  const verificationError = new Error('bddgen export failed: export failed');
  verificationError.prepareRunFailure = {
    stage: 'verification',
    runId: 'sample-run',
    runPaths: {
      runDir: path.join(repoRoot, '.qa-harness', 'runs', 'sample-run'),
    },
    clarifierSummary: 'reloaded existing run sample-run from .qa-harness/runs/sample-run for in-place planner refinement',
    plannerSummary: 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
    verifierSummary: 'bddgen export failed: export failed',
    retainedArtifactSummary: 'existing artifacts retained.',
  };

  const exitCode = runCli(
    ['prepare-run', '--run-id', 'sample-run'],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: () => {
        throw verificationError;
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Prepare-run verification failed for sample-run at \.qa-harness\/runs\/sample-run: clarifier=reloaded existing run sample-run from \.qa-harness\/runs\/sample-run for in-place planner refinement; planner=refined PRD\.md, progress\.md, and PROMPT\.md for Playwright home page \(1 scenario\); verifier=bddgen export failed: export failed; retained=existing artifacts retained\.; artifacts=progress\.md, logs\/verifier\.log/,
  );
});

test('runCli create-run and verify-run remain intact after adding prepare-run', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';
  let createdOptions = null;
  let verifiedOptions = null;

  const createExitCode = runCli(
    ['create-run', '--intent', 'plan', '--source-type', 'feature', '--source-ref', 'Features/homepage.feature'],
    {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      createRunFn: (options) => {
        createdOptions = options;
        return {
          runId: 'sample-run',
          runPaths: {
            runDir: path.join(repoRoot, '.qa-harness', 'runs', 'sample-run'),
          },
        };
      },
    },
  );

  assert.equal(createExitCode, 0);
  assert.equal(stderr, '');
  assert.equal(createdOptions.request.intent, 'plan');
  assert.match(stdout, /Created run sample-run at \.qa-harness\/runs\/sample-run/);

  stdout = '';
  stderr = '';

  const verifyExitCode = runCli(['verify-run', '--run-id', 'sample-run'], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    verifyRunFn: (options) => {
      verifiedOptions = options;
      return {
        runId: 'sample-run',
        exportedStepCount: 3,
        listedTestCount: 2,
      };
    },
  });

  assert.equal(verifyExitCode, 0);
  assert.equal(stderr, '');
  assert.equal(verifiedOptions.runId, 'sample-run');
  assert.match(stdout, /Verified run sample-run: 3 exported steps, 2 listed tests\./);
});

test('runCli verify-run remains compatible with runs created through the legacy createRun path', (t) => {
  const { repoRoot, result } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();
  writeGeneratedSpec(repoRoot, result.runId);
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['verify-run', '--run-id', result.runId], {
    repoRoot,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    verifyRunFn: (options) =>
      verifyRun({
        ...options,
        templatesDir: realTemplatesDir,
        commandRunner: runner,
      }),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(
    stdout,
    new RegExp(`Verified run ${result.runId}: 9 exported steps, 1 listed tests\\.`),
  );
});

test('runCli create-run, prepare-run, verify-run, execute-run, advance-run, iterate-run, and loop-run remain routable after planner handoff', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  let stdout = '';
  let stderr = '';

  assert.equal(
    runCli(['create-run', '--intent', 'plan', '--source-type', 'feature', '--source-ref', 'Features/homepage.feature'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      createRunFn: () => ({ runId: 'create-run-id', runPaths: resolveRunPaths(repoRoot, 'create-run-id') }),
    }),
    0,
  );
  assert.equal(
    runCli(['prepare-run', '--run-id', 'prepare-run-id'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      prepareRunFn: () => ({
        runId: 'prepare-run-id',
        runPaths: resolveRunPaths(repoRoot, 'prepare-run-id'),
        clarifierSummary: 'reloaded existing run prepare-run-id from .qa-harness/runs/prepare-run-id for in-place planner refinement',
        plannerSummary: 'refined PRD.md, progress.md, and PROMPT.md for Playwright home page (1 scenario)',
        verifierSummary: '1 exported steps, 1 listed tests',
      }),
    }),
    0,
  );
  assert.equal(
    runCli(['verify-run', '--run-id', 'verify-run-id'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      verifyRunFn: () => ({ runId: 'verify-run-id', exportedStepCount: 1, listedTestCount: 1 }),
    }),
    0,
  );
  assert.equal(
    runCli(['execute-run', '--run-id', 'execute-run-id'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      executeRunFn: () => ({ runId: 'execute-run-id', project: 'chromium', summary: '1 passed (1.2s)' }),
    }),
    0,
  );
  assert.equal(
    runCli(['advance-run', '--run-id', 'advance-run-id'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      advanceRunFn: () => ({
        runId: 'advance-run-id',
        selectedItemId: 'P-001',
        adapter: 'external',
        status: 'pass',
        executorStatus: 'pass',
        verifierStatus: 'pass',
        executorSummary: 'executor ok',
        verifierSummary: 'verifier ok',
      }),
    }),
    0,
  );
  assert.equal(
    runCli(['iterate-run', '--run-id', 'iterate-run-id'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      iterateRunFn: () => ({
        runId: 'iterate-run-id',
        selectedItemId: 'P-001',
        adapter: 'external',
        status: 'pass',
        summary: 'iteration ok',
      }),
    }),
    0,
  );
  assert.equal(
    runCli(['loop-run', '--run-id', 'loop-run-id', '--max-iterations', '2'], {
      repoRoot,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      loopRunFn: () => ({
        runId: 'loop-run-id',
        adapter: 'external',
        status: 'completed',
        completedIterations: 1,
        maxIterations: 2,
        stopReason: 'no-actionable-items',
      }),
    }),
    0,
  );

  assert.equal(stderr, '');
  assert.match(stdout, /Created run create-run-id/);
  assert.match(stdout, /Prepared run prepare-run-id/);
  assert.match(stdout, /Verified run verify-run-id/);
  assert.match(stdout, /Executed run execute-run-id on chromium/);
  assert.match(stdout, /Advanced run advance-run-id item P-001 with external: pass/);
  assert.match(stdout, /Iterated run iterate-run-id item P-001 with external: pass/);
  assert.match(stdout, /Looped run loop-run-id with external: completed/);
});

test('design doc exists and keeps the extracted command model explicit', () => {
  const designDocPath = path.resolve(__dirname, '../../docs/copilot-first-qa-ralph-harness.md');
  assert.equal(fs.existsSync(designDocPath), true);

  const designDoc = fs.readFileSync(designDocPath, 'utf8');

  assert.match(designDoc, /prepare-run/);
  assert.match(designDoc, /verify-run/);
  assert.match(designDoc, /execute-run/);
  assert.match(designDoc, /advance-run/);
  assert.match(designDoc, /iterate-run/);
  assert.match(designDoc, /loop-run/);
  assert.match(designDoc, /guided-exploratory/i);
  assert.match(designDoc, /autonomous-exploratory/i);
  assert.match(designDoc, /artifact-first/i);
  assert.match(designDoc, /fresh-session/i);
  assert.match(designDoc, /normalized\.feature/);
});

test('design doc still records the verifier boundary and promotion constraints', () => {
  const designDoc = fs.readFileSync(
    path.resolve(__dirname, '../../docs/copilot-first-qa-ralph-harness.md'),
    'utf8',
  );

  assert.match(designDoc, /verifier review before `advance-run` reports `pass`/i);
  assert.match(designDoc, /append-only history/i);
  assert.match(designDoc, /fallback/i);
  assert.match(designDoc, /retry-budget|retry budget/i);
  assert.match(designDoc, /canonical promotion/i);
  assert.match(designDoc, /execution controls/i);
  assert.match(designDoc, /browser project/i);
  assert.match(designDoc, /base URL|target environment/i);
});

test('runCli execute-run validates --run-id and keeps default project behavior when controls are omitted', () => {
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const missingRunIdExitCode = runCli(['execute-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(missingRunIdExitCode, 1);
  assert.match(stderr, /--run-id/);
  assert.equal(stdout, '');

  stdout = '';
  stderr = '';

  const exitCode = runCli(['execute-run', '--run-id', 'sample-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    executeRunFn: (options) => {
      capturedOptions = options;
      return {
        runId: options.runId,
        project: options.project || 'chromium',
        summary: '1 passed (1.2s)',
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(capturedOptions.runId, 'sample-run');
  assert.equal(capturedOptions.project, undefined);
  assert.match(stdout, /Executed run sample-run on chromium: 1 passed \(1\.2s\)/);
});

test('runCli routes additive execution-control flags to the existing command surfaces', () => {
  let stdout = '';
  let stderr = '';
  const captured = [];
  const expectedControls = {
    project: 'firefox',
    headed: true,
    debug: false,
    baseUrl: 'https://staging.example.test',
    targetEnv: 'staging',
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  };

  const writeStdout = { write: (value) => { stdout += value; } };
  const writeStderr = { write: (value) => { stderr += value; } };

  const verifyExitCode = runCli([
    'verify-run',
    '--run-id',
    'sample-run',
    '--project',
    expectedControls.project,
    '--headed',
    'true',
    '--debug',
    'false',
    '--base-url',
    expectedControls.baseUrl,
    '--target-env',
    expectedControls.targetEnv,
    '--trace',
    expectedControls.trace,
    '--video',
    expectedControls.video,
    '--screenshot',
    expectedControls.screenshot,
  ], {
    stdout: writeStdout,
    stderr: writeStderr,
    verifyRunFn: (options) => {
      captured.push({ command: 'verify-run', options });
      return { runId: options.runId, exportedStepCount: 1, listedTestCount: 1 };
    },
  });

  stdout = '';
  stderr = '';
  const executeExitCode = runCli([
    'execute-run',
    '--run-id',
    'sample-run',
    '--project',
    expectedControls.project,
    '--headed',
    'true',
    '--debug',
    'false',
    '--base-url',
    expectedControls.baseUrl,
    '--target-env',
    expectedControls.targetEnv,
    '--trace',
    expectedControls.trace,
    '--video',
    expectedControls.video,
    '--screenshot',
    expectedControls.screenshot,
  ], {
    stdout: writeStdout,
    stderr: writeStderr,
    executeRunFn: (options) => {
      captured.push({ command: 'execute-run', options });
      return { runId: options.runId, project: options.project, summary: '1 passed (0.3s)' };
    },
  });

  stdout = '';
  stderr = '';
  const advanceExitCode = runCli([
    'advance-run',
    '--run-id',
    'sample-run',
    '--adapter',
    'mock',
    '--project',
    expectedControls.project,
    '--headed',
    'true',
    '--debug',
    'false',
    '--base-url',
    expectedControls.baseUrl,
    '--target-env',
    expectedControls.targetEnv,
    '--trace',
    expectedControls.trace,
    '--video',
    expectedControls.video,
    '--screenshot',
    expectedControls.screenshot,
  ], {
    stdout: writeStdout,
    stderr: writeStderr,
    advanceRunFn: (options) => {
      captured.push({ command: 'advance-run', options });
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-900',
        status: 'pass',
        executorStatus: 'pass',
        executorSummary: 'recorded pass from logs/runtime.log: routed controls',
        verifierStatus: 'pass',
        verifierSummary: 'verifier accepted pass from logs/runtime.log: routed controls',
        summary: 'verifier accepted pass from logs/runtime.log: routed controls',
        verifierLogPathDisplay: 'logs/verifier.log',
        runtimeLogPathDisplay: 'logs/runtime.log',
      };
    },
  });

  stdout = '';
  stderr = '';
  const iterateExitCode = runCli([
    'iterate-run',
    '--run-id',
    'sample-run',
    '--adapter',
    'mock',
    '--project',
    expectedControls.project,
    '--headed',
    'true',
    '--debug',
    'false',
    '--base-url',
    expectedControls.baseUrl,
    '--target-env',
    expectedControls.targetEnv,
    '--trace',
    expectedControls.trace,
    '--video',
    expectedControls.video,
    '--screenshot',
    expectedControls.screenshot,
  ], {
    stdout: writeStdout,
    stderr: writeStderr,
    iterateRunFn: (options) => {
      captured.push({ command: 'iterate-run', options });
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-901',
        status: 'pass',
        summary: 'routed controls',
        runtimeLogPathDisplay: 'logs/runtime.log',
      };
    },
  });

  stdout = '';
  stderr = '';
  const loopExitCode = runCli([
    'loop-run',
    '--run-id',
    'sample-run',
    '--max-iterations',
    '2',
    '--adapter',
    'mock',
    '--project',
    expectedControls.project,
    '--headed',
    'true',
    '--debug',
    'false',
    '--base-url',
    expectedControls.baseUrl,
    '--target-env',
    expectedControls.targetEnv,
    '--trace',
    expectedControls.trace,
    '--video',
    expectedControls.video,
    '--screenshot',
    expectedControls.screenshot,
  ], {
    stdout: writeStdout,
    stderr: writeStderr,
    loopRunFn: (options) => {
      captured.push({ command: 'loop-run', options });
      return {
        runId: options.runId,
        adapter: options.adapter,
        maxIterations: options.maxIterations,
        completedIterations: 1,
        stopReason: 'no-actionable-items',
        status: 'completed',
        lastSelectedItemId: 'P-902',
        loopReportPathDisplay: 'outputs/loop-report.md',
      };
    },
  });

  assert.equal(verifyExitCode, 0);
  assert.equal(executeExitCode, 0);
  assert.equal(advanceExitCode, 0);
  assert.equal(iterateExitCode, 0);
  assert.equal(loopExitCode, 0);
  assert.equal(captured.length, 5);

  for (const entry of captured) {
    assert.equal(entry.options.runId, 'sample-run');
    assert.deepEqual({
      project: entry.options.project,
      headed: entry.options.headed,
      debug: entry.options.debug,
      baseUrl: entry.options.baseUrl,
      targetEnv: entry.options.targetEnv,
      trace: entry.options.trace,
      video: entry.options.video,
      screenshot: entry.options.screenshot,
    }, expectedControls);
  }
});

test('executeRun stops when verification preflight fails', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/homepage.feature', 'Feature: Sample\n');

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: 'Features/homepage.feature',
    },
  });

  const { calls, runner } = createMockCommandRunner({
    exportResult: { status: 1, stdout: '', stderr: 'export failed' },
  });

  assert.throws(
    () =>
      executeRun({
        repoRoot,
        templatesDir: realTemplatesDir,
        runId: result.runId,
        commandRunner: runner,
      }),
    /bddgen export failed/i,
  );

  assert.equal(
    calls.some(({ args }) => args[0] === 'playwright' && args[1] === 'test' && !args.includes('--list')),
    false,
  );

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  assert.match(runtimeLog, /status=fail/);
  assert.match(progressContent, /Owner: `qa-executor`/);
  assert.match(progressContent, /Status: `fail`/);
});

test('executeRun records a passing runtime and marks executor progress pass', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/homepage.feature', 'Feature: Sample\n');

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: 'Features/homepage.feature',
    },
  });

  writeGeneratedSpec(repoRoot, result.runId);
  const { runner } = createMockCommandRunner();

  const execution = executeRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(execution.project, 'chromium');
  assert.match(runtimeLog, /status=pass/);
  assert.match(runtimeLog, /Project: chromium/);
  assert.doesNotMatch(runtimeLog, /\u001b\[/);
  assert.match(progressContent, /Owner: `qa-executor`/);
  assert.match(progressContent, /Status: `pass`/);
  assert.match(progressContent, /logs\/runtime\.log/);
});

test('executeRun applies explicit execution controls to Playwright invocation and records them in run artifacts', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/homepage.feature', 'Feature: Sample\n');

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: 'Features/homepage.feature',
    },
  });

  writeGeneratedSpec(repoRoot, result.runId);
  const { calls, runner } = createMockCommandRunner();

  const execution = executeRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    project: 'firefox',
    headed: true,
    debug: true,
    baseUrl: 'https://staging.example.test',
    targetEnv: 'staging',
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    env: { ...process.env },
    commandRunner: runner,
  });

  const playwightListCall = calls.find(({ args }) => args[0] === 'playwright' && args[1] === 'test' && args.includes('--list'));
  const playwightExecuteCall = calls.find(({ args }) => args[0] === 'playwright' && args[1] === 'test' && !args.includes('--list'));
  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const promptContent = fs.readFileSync(result.runPaths.promptPath, 'utf8');

  assert.equal(execution.project, 'firefox');
  assert.ok(playwightListCall);
  assert.ok(playwightExecuteCall);
  assert.ok(playwightListCall.args.includes('--project=firefox'));
  assert.ok(playwightExecuteCall.args.includes('--project=firefox'));
  assert.ok(playwightExecuteCall.args.includes('--headed'));
  assert.ok(playwightExecuteCall.args.includes('--debug'));
  assert.ok(playwightExecuteCall.args.includes('--trace=on'));
  assert.ok(playwightExecuteCall.args.includes('--video=retain-on-failure'));
  assert.ok(playwightExecuteCall.args.includes('--screenshot=only-on-failure'));
  assert.equal(playwightExecuteCall.commandOptions.env.PLAYWRIGHT_BASE_URL, 'https://staging.example.test');
  assert.equal(playwightExecuteCall.commandOptions.env.QA_HARNESS_TARGET_ENV, 'staging');
  assert.match(runtimeLog, /Project: firefox/);
  assert.match(runtimeLog, /Headed execution: enabled/);
  assert.match(runtimeLog, /Debug execution: enabled/);
  assert.match(runtimeLog, /Base URL override: https:\/\/staging\.example\.test/);
  assert.match(runtimeLog, /Trace setting: on/);
  assert.equal(countOccurrences(prdContent, /^## Execution Controls$/gm), 1);
  assert.match(prdContent, /Browser project: `firefox`/);
  assert.match(prdContent, /Target environment: `staging`/);
  assert.equal(countOccurrences(promptContent, /^## Execution Controls Context$/gm), 1);
});

test('executeRun records a failing runtime and marks executor progress fail', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/homepage.feature', 'Feature: Sample\n');

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: 'Features/homepage.feature',
    },
  });

  writeGeneratedSpec(repoRoot, result.runId);
  const { runner } = createMockCommandRunner({
    executeResult: {
      status: 1,
      stdout: '1 failed\n',
      stderr: 'Error: strict mode violation',
    },
  });

  assert.throws(
    () =>
      executeRun({
        repoRoot,
        templatesDir: realTemplatesDir,
        runId: result.runId,
        commandRunner: runner,
      }),
    /Playwright execution failed/i,
  );

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.match(runtimeLog, /status=fail/);
  assert.match(runtimeLog, /strict mode violation/);
  assert.match(progressContent, /Owner: `qa-executor`/);
  assert.match(progressContent, /Status: `fail`/);
  assert.match(progressContent, /strict mode violation/);
});

test('executeRun appends an execution result item for legacy progress files', (t) => {
  const repoRoot = createTempRepo(t);
  writeFeature(repoRoot, 'Features/homepage.feature', 'Feature: Sample\n');

  const result = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: 'Features/homepage.feature',
    },
  });

  writeTextFile(
    result.runPaths.progressPath,
    [
      '# QA Run Progress',
      '',
      '## Active Items',
      '',
      '- [ ] `P-001` Goal: legacy item',
      '  - Input: `normalized.feature`',
      '  - Output: `normalized.feature`',
      '  - Verify: `manual`',
      '  - Owner: `qa-clarifier`',
      '  - Status: `todo`',
      '  - Retry budget: `1`',
      '  - Fallback reason: ``',
      '',
    ].join('\n'),
  );

  writeGeneratedSpec(repoRoot, result.runId);
  const { runner } = createMockCommandRunner();

  executeRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });

  const progressContent = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  assert.match(progressContent, /## Execution Results/);
  assert.match(progressContent, /Owner: `qa-executor`/);
  assert.match(progressContent, /Status: `pass`/);
});

test('advanceRun composes executor review and verifier review around one bounded iterate-run step', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  const templatesDir = path.resolve('C:/repo-under-test/specs/templates/qa-run');
  const env = { QA_HARNESS_EXTERNAL_RUNTIME_CMD: 'npx' };
  const processRunner = () => ({ status: 0, stdout: '', stderr: '' });
  const callOrder = [];
  let capturedSelectionOptions = null;
  let capturedOptions = null;
  let capturedExecutionReviewOptions = null;
  let capturedReviewOptions = null;

  const result = advanceRun({
    repoRoot,
    templatesDir,
    runId: 'sample-run',
    adapter: 'mock',
    env,
    processRunner,
    loadAdvanceRunSelectionFn: (options) => {
      capturedSelectionOptions = options;
      return {
        selectedItemId: 'P-701',
        healingItem: false,
      };
    },
    iterateRunFn: (options) => {
      callOrder.push('iterate');
      capturedOptions = options;
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-701',
        status: 'pass',
        summary: 'one bounded pass',
      };
    },
    reviewAdvanceRunExecutionFn: (options) => {
      callOrder.push('executor-review');
      capturedExecutionReviewOptions = options;
      return {
        status: 'pass',
        summary: 'recorded pass from logs/runtime.log: one bounded pass',
        selectedItemId: options.iterationResult.selectedItemId,
        runtimeLogPathDisplay: 'logs/runtime.log',
        fallbackLogPathDisplay: 'logs/fallback.log',
        healReportPathDisplay: 'outputs/heal-report.md',
      };
    },
    reviewAdvanceRunFn: (options) => {
      callOrder.push('verifier-review');
      capturedReviewOptions = options;
      return {
        status: 'pass',
        summary: 'verifier accepted pass from logs/runtime.log: one bounded pass',
        runtimeLogPathDisplay: 'logs/runtime.log',
        verifierLogPathDisplay: 'logs/verifier.log',
      };
    },
  });

  assert.deepEqual(callOrder, ['iterate', 'executor-review', 'verifier-review']);
  assert.deepEqual(capturedSelectionOptions, {
    repoRoot,
    templatesDir,
    runId: 'sample-run',
  });
  assert.equal(capturedOptions.repoRoot, repoRoot);
  assert.equal(capturedOptions.templatesDir, templatesDir);
  assert.equal(capturedOptions.runId, 'sample-run');
  assert.equal(capturedOptions.adapter, 'mock');
  assert.equal(capturedOptions.env, env);
  assert.equal(capturedOptions.processRunner, processRunner);
  assert.equal(capturedExecutionReviewOptions.iterationResult.selectedItemId, 'P-701');
  assert.equal(capturedExecutionReviewOptions.selectedItemId, 'P-701');
  assert.equal(capturedReviewOptions.iterationResult.selectedItemId, 'P-701');
  assert.equal(capturedReviewOptions.selectedItemId, 'P-701');
  assert.equal(capturedReviewOptions.executionReviewResult.summary, 'recorded pass from logs/runtime.log: one bounded pass');
  assert.equal(result.selectedItemId, 'P-701');
  assert.equal(result.status, 'pass');
  assert.equal(result.executorStatus, 'pass');
  assert.match(result.executorSummary, /recorded pass from logs\/runtime\.log: one bounded pass/);
  assert.equal(result.iterationStatus, 'pass');
  assert.match(result.summary, /verifier accepted pass/i);
});

test('advanceRun still invokes verifier review after one healer-owned bounded iterate-run step', () => {
  const repoRoot = path.resolve('C:/repo-under-test');
  const templatesDir = path.resolve('C:/repo-under-test/specs/templates/qa-run');
  const callOrder = [];
  let capturedSelectionOptions = null;
  let capturedExecutionReviewOptions = null;
  let capturedReviewOptions = null;

  const result = advanceRun({
    repoRoot,
    templatesDir,
    runId: 'sample-run',
    adapter: 'mock',
    loadAdvanceRunSelectionFn: (options) => {
      capturedSelectionOptions = options;
      return {
        selectedItemId: 'P-702',
        healingItem: true,
      };
    },
    iterateRunFn: (options) => {
      callOrder.push('iterate');
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-702',
        status: 'pass',
        summary: 'one bounded healer pass',
      };
    },
    reviewAdvanceRunExecutionFn: (options) => {
      callOrder.push('healer-review');
      capturedExecutionReviewOptions = options;
      return {
        status: 'pass',
        summary: 'recorded pass from logs/runtime.log: one bounded healer pass',
        selectedItemId: options.selectedItemId,
        runtimeLogPathDisplay: 'logs/runtime.log',
        fallbackLogPathDisplay: 'logs/fallback.log',
        healReportPathDisplay: 'outputs/heal-report.md',
      };
    },
    reviewAdvanceRunFn: (options) => {
      callOrder.push('verifier-review');
      capturedReviewOptions = options;
      return {
        status: 'pass',
        summary: 'verifier accepted pass from logs/runtime.log: one bounded healer pass',
        runtimeLogPathDisplay: 'logs/runtime.log',
        verifierLogPathDisplay: 'logs/verifier.log',
      };
    },
  });

  assert.deepEqual(callOrder, ['iterate', 'healer-review', 'verifier-review']);
  assert.deepEqual(capturedSelectionOptions, {
    repoRoot,
    templatesDir,
    runId: 'sample-run',
  });
  assert.equal(capturedExecutionReviewOptions.selectedItemId, 'P-702');
  assert.equal(capturedReviewOptions.selectedItemId, 'P-702');
  assert.equal(result.healingItem, true);
  assert.equal(result.selectedItemId, 'P-702');
  assert.equal(result.executorStatus, 'pass');
  assert.equal(result.verifierStatus, 'pass');
  assert.match(result.summary, /verifier accepted pass/i);
});

test('advanceRun records a verifier-backed pass after one bounded iterate-run execution', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-731',
        goal: 'pass this selected item',
      }),
      createProgressBlock({
        id: 'P-732',
        goal: 'leave this untouched',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: '1 passed (0.9s)',
      runtimeLayer: 'playwright-cli',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'pass',
      QA_HARNESS_MOCK_SUMMARY: '1 passed (0.9s)',
      QA_HARNESS_MOCK_RUNTIME_LAYER: 'playwright-cli',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.selectedItemId, 'P-731');
  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(iteration.executorSummary, /recorded pass from logs\/runtime\.log: 1 passed \(0\.9s\)/);
  assert.equal(iteration.verifierStatus, 'pass');
  assert.equal(iteration.iterationStatus, 'pass');
  assert.match(iteration.summary, /verifier accepted pass from logs\/runtime\.log: 1 passed \(0\.9s\)/);
  assert.match(iteration.verifierSummary, /verifier accepted pass from logs\/runtime\.log: 1 passed \(0\.9s\)/);
  assert.match(verifierLog, /status=pass/);
  assert.match(verifierLog, /Selected item: P-731 - pass this selected item/);
  assert.match(verifierLog, /Runtime log: logs\/runtime\.log/);
  assert.match(updatedProgress, /Status: `pass`/);
  assert.match(
    updatedProgress,
    /Result: `pass via npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in logs\/verifier\.log \(runtime logs\/runtime\.log\)`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-732` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Result: `existing result`/,
  );
});

test('advanceRun records a verifier-backed pass after one healer-owned bounded iterate-run execution', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-733',
        goal: 'heal the stale assertion',
        owner: 'qa-healer',
        retryBudget: '2',
      }),
      createProgressBlock({
        id: 'P-734',
        goal: 'leave this untouched',
        owner: 'qa-executor',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'targeted healing pass',
      runtimeLayer: 'playwright-cli',
      smallestFailingUnit: 'stale onboarding assertion',
      rootCauseHypothesis: 'outdated expectation for the onboarding copy',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'pass',
      QA_HARNESS_MOCK_SUMMARY: 'targeted healing pass',
      QA_HARNESS_MOCK_RUNTIME_LAYER: 'playwright-cli',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.equal(iteration.healingItem, true);
  assert.equal(iteration.selectedItemId, 'P-733');
  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(
    iteration.executorSummary,
    /recorded pass from outputs\/heal-report\.md: targeted healing pass; smallest failing unit: stale onboarding assertion; hypothesis: outdated expectation for the onboarding copy/,
  );
  assert.equal(iteration.verifierStatus, 'pass');
  assert.match(
    iteration.summary,
    /verifier accepted pass from outputs\/heal-report\.md: targeted healing pass; smallest failing unit: stale onboarding assertion; hypothesis: outdated expectation for the onboarding copy/,
  );
  assert.match(verifierLog, /status=pass/);
  assert.match(verifierLog, /Selected item: P-733 - heal the stale assertion/);
  assert.match(verifierLog, /Healing item: yes/);
  assert.match(verifierLog, /Heal report: outputs\/heal-report\.md/);
  assert.match(verifierLog, /Heal report smallest failing unit: stale onboarding assertion/);
  assert.match(verifierLog, /Heal report root-cause hypothesis: outdated expectation for the onboarding copy/);
  assert.match(updatedProgress, /Status: `pass`/);
  assert.match(
    updatedProgress,
    new RegExp(
      '- \\[x\\] `P-733` Goal: heal the stale assertion[\\s\\S]*?Retry budget: `2`[\\s\\S]*?Result: `pass via npm run qa:orchestrator -- advance-run --run-id '
      + result.runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + ' --adapter mock; evidence in logs/verifier\\.log \\(runtime logs/runtime\\.log; heal report outputs/heal-report\\.md\\)`',
    ),
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-734` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Result: `existing result`/,
  );
  assert.match(healReport, /status=pass/);
  assert.match(healReport, /Selected item: P-733 - heal the stale assertion/);
  assert.match(healReport, /Retry budget: 2 -> 2/);
  assert.match(healReport, /Smallest failing unit: stale onboarding assertion/);
  assert.match(healReport, /Root-cause hypothesis: outdated expectation for the onboarding copy/);
});

test('advanceRun records a verifier-backed pass after one explorer-owned bounded iterate-run discovery', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-735',
        goal: 'identify bounded coverage gaps around the docs navigation',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
      }),
      createProgressBlock({
        id: 'P-736',
        goal: 'leave this untouched',
        owner: 'qa-executor',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'identified 2 bounded coverage gaps',
      runtimeLayer: 'playwright-cli',
      coverageScope: 'docs navigation',
      gapCandidates: [
        {
          gap: 'missing collapsed menu coverage',
          candidateScenario: 'cover collapsed menu open and close',
          evidence: ['evidence/screenshots/menu-collapsed.png'],
        },
        {
          gap: 'missing docs return-path coverage',
          candidateScenario: 'cover docs return CTA back to the home page',
          evidence: ['logs/runtime.log'],
        },
      ],
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.explorerItem, true);
  assert.equal(iteration.selectedItemId, 'P-735');
  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(
    iteration.executorSummary,
    /recorded pass from outputs\/gap-analysis\.md: 2 gap candidates for docs navigation: identified 2 bounded coverage gaps/,
  );
  assert.equal(iteration.verifierStatus, 'pass');
  assert.match(
    iteration.verifierSummary,
    /verifier accepted pass from outputs\/gap-analysis\.md: 2 gap candidates for docs navigation: identified 2 bounded coverage gaps/,
  );
  assert.match(gapAnalysis, /status=pass/);
  assert.match(gapAnalysis, /Selected item: P-735 - identify bounded coverage gaps around the docs navigation/);
  assert.match(gapAnalysis, /Scope: docs navigation/);
  assert.match(gapAnalysis, /Candidate count: 2/);
  assert.match(gapAnalysis, /Candidate 1 gap: missing collapsed menu coverage/);
  assert.match(gapAnalysis, /Candidate 1 scenario: cover collapsed menu open and close/);
  assert.match(gapAnalysis, /Candidate 1 evidence: evidence\/screenshots\/menu-collapsed\.png/);
  assert.match(gapAnalysis, /Candidate 2 gap: missing docs return-path coverage/);
  assert.match(gapAnalysis, /Candidate 2 scenario: cover docs return CTA back to the home page/);
  assert.match(verifierLog, /Explorer item: yes/);
  assert.match(verifierLog, /Gap analysis: outputs\/gap-analysis\.md/);
  assert.match(verifierLog, /Gap analysis scope: docs navigation/);
  assert.match(verifierLog, /Gap candidate count: 2/);
  assert.match(
    updatedProgress,
    new RegExp(
      '- \\[x\\] `P-735` Goal: identify bounded coverage gaps around the docs navigation[\\s\\S]*?Result: `pass via npm run qa:orchestrator -- advance-run --run-id '
      + result.runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + ' --adapter mock; evidence in logs/verifier\\.log \\(runtime logs/runtime\\.log; gap analysis outputs/gap-analysis\\.md\\)`',
    ),
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-736` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Result: `existing result`/,
  );
});

test('advanceRun preserves fail behavior and fallback summaries for explorer-owned items', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-737',
        goal: 'inspect coverage gaps around the docs drawer',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'scope drift prevented bounded coverage comparison',
      runtimeLayer: 'mcp',
      fallbackReason: 'Playwright CLI could not stabilize the docs drawer',
      coverageScope: 'docs drawer',
      gapCandidates: [
        {
          gap: 'menu close state remains unverified',
          candidateScenario: 'cover closing the drawer after choosing docs',
        },
      ],
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const fallbackLog = fs.readFileSync(result.runPaths.fallbackLogPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');

  assert.equal(iteration.explorerItem, true);
  assert.equal(iteration.status, 'fail');
  assert.equal(iteration.executorStatus, 'fail');
  assert.match(
    iteration.executorSummary,
    /recorded fail from outputs\/gap-analysis\.md: 1 gap candidate for docs drawer: scope drift prevented bounded coverage comparison; fallback in logs\/fallback\.log: Playwright CLI could not stabilize the docs drawer/,
  );
  assert.equal(iteration.verifierStatus, 'fail');
  assert.match(
    iteration.verifierSummary,
    /verifier confirmed fail from outputs\/gap-analysis\.md: 1 gap candidate for docs drawer: scope drift prevented bounded coverage comparison; fallback in logs\/fallback\.log: Playwright CLI could not stabilize the docs drawer/,
  );
  assert.match(updatedProgress, /Status: `fail`/);
  assert.match(updatedProgress, /Fallback reason: `Playwright CLI could not stabilize the docs drawer`/);
  assert.match(fallbackLog, /Selected item: P-737 - inspect coverage gaps around the docs drawer/);
  assert.match(fallbackLog, /Fallback reason: Playwright CLI could not stabilize the docs drawer/);
  assert.match(gapAnalysis, /status=fail/);
  assert.match(gapAnalysis, /Scope: docs drawer/);
  assert.match(gapAnalysis, /Candidate count: 1/);
  assert.match(gapAnalysis, /Candidate 1 gap: menu close state remains unverified/);
  assert.match(gapAnalysis, /Candidate 1 scenario: cover closing the drawer after choosing docs/);
});

test('advanceRun preserves blocked terminal behavior while verifier reads richer explorer gap-analysis signals', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-737B',
        goal: 'inspect docs footer coverage gaps',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'blocked',
      summary: 'manual review required before another bounded discovery',
      runtimeLayer: 'playwright-test',
      coverageScope: 'docs footer',
      observedGap: 'footer CTA state remains unproven under offline mode',
      additionTarget: 'Features/homepage.feature :: Offline footer return path',
      evidence: ['evidence/screenshots/footer-offline.png'],
      escalationReason: 'manual product clarification required before planner handoff',
      stopReason: 'bounded discovery stopped after footer navigation diverged',
      gapCandidates: [
        {
          gap: 'offline footer return path remains uncovered',
          additionTarget: 'Features/homepage.feature :: Offline footer return path',
          evidence: ['evidence/screenshots/footer-offline.png'],
        },
      ],
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.explorerItem, true);
  assert.equal(iteration.status, 'blocked');
  assert.equal(iteration.executorStatus, 'blocked');
  assert.match(
    iteration.executorSummary,
    /recorded blocked from outputs\/gap-analysis\.md: 1 gap candidate for docs footer: manual review required before another bounded discovery/,
  );
  assert.equal(iteration.verifierStatus, 'blocked');
  assert.match(
    iteration.verifierSummary,
    /verifier confirmed blocked from outputs\/gap-analysis\.md: 1 gap candidate for docs footer: manual review required before another bounded discovery/,
  );
  assert.match(updatedProgress, /Status: `blocked`/);
  assert.match(
    updatedProgress,
    /Result: `blocked: verifier confirmed blocked from outputs\/gap-analysis\.md: 1 gap candidate for docs footer: manual review required before another bounded discovery; evidence in logs\/verifier\.log`/,
  );
  assert.match(gapAnalysis, /Escalation reason: manual product clarification required before planner handoff/);
  assert.match(gapAnalysis, /Stop reason: bounded discovery stopped after footer navigation diverged/);
  assert.match(verifierLog, /Gap analysis observed gap: footer CTA state remains unproven under offline mode/);
  assert.match(verifierLog, /Gap analysis addition target: Features\/homepage\.feature :: Offline footer return path/);
  assert.match(verifierLog, /Gap analysis supporting evidence: evidence\/screenshots\/footer-offline\.png/);
  assert.match(verifierLog, /Gap analysis escalation reason: manual product clarification required before planner handoff/);
  assert.match(verifierLog, /Gap analysis stop reason: bounded discovery stopped after footer navigation diverged/);
});

test('advanceRun records a verifier-backed pass after one planner-handoff-backed bounded scenario addition', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-001',
        goal: 'cover collapsed menu open and close for docs navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
      createProgressBlock({
        id: 'P-739',
        goal: 'leave this untouched',
        owner: 'qa-executor',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, featurePath, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths);
  const processRunner = createScenarioAdditionProcessRunner({
    runPaths: result.runPaths,
    addedScenarioOrOutline: 'Scenario: Cover collapsed menu open and close',
    scenarioBlock: [
      '  Scenario: Cover collapsed menu open and close',
      '    Given I open "/docs/intro"',
      '    Then the title should contain "Installation"',
      '    And the url should contain "/docs/intro"',
    ].join('\n'),
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const canonicalFeature = fs.readFileSync(featurePath, 'utf8');
  const promotionReport = fs.readFileSync(result.runPaths.promotionReportPath, 'utf8');
  const scenarioAddition = fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.scenarioAdditionItem, true);
  assert.equal(iteration.selectedItemId, 'P-GAP-001');
  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(
    iteration.executorSummary,
    /recorded pass from outputs\/scenario-addition\.md: added Scenario: Cover collapsed menu open and close in normalized\.feature: appended one bounded scenario to normalized\.feature/,
  );
  assert.equal(iteration.verifierStatus, 'pass');
  assert.match(
    iteration.verifierSummary,
    /verifier accepted pass from outputs\/scenario-addition\.md: added Scenario: Cover collapsed menu open and close in normalized\.feature: appended one bounded scenario to normalized\.feature; promotion in outputs\/promotion-report\.md: promoted Scenario: Cover collapsed menu open and close into Features\/homepage\.feature\./,
  );
  assert.match(scenarioAddition, /status=pass/);
  assert.match(promotionReport, /status=pass/);
  assert.match(promotionReport, /Source artifact: outputs\/scenario-addition\.md/);
  assert.match(promotionReport, /Canonical feature target: Features\/homepage\.feature/);
  assert.match(promotionReport, /Promoted scenario or outline: Scenario: Cover collapsed menu open and close/);
  assert.match(promotionReport, /Verification evidence: logs\/verifier\.log, outputs\/scenario-addition\.md, logs\/runtime\.log/);
  assert.match(
    canonicalFeature,
    /Scenario: Cover collapsed menu open and close[\s\S]*?Given I open "\/docs\/intro"[\s\S]*?Then the title should contain "Installation"/,
  );
  assert.equal(fs.existsSync(path.join(repoRoot, 'Features', 'steps', 'promotion-generated.ts')), false);
  assert.match(verifierLog, /Scenario-addition item: yes/);
  assert.match(verifierLog, /Planner handoff: outputs\/planner-handoff\.md/);
  assert.match(verifierLog, /Scenario addition: outputs\/scenario-addition\.md/);
  assert.match(verifierLog, /Promotion report: outputs\/promotion-report\.md/);
  assert.match(verifierLog, /Canonical promotion target: Features\/homepage\.feature/);
  assert.match(
    verifierLog,
    /Planner handoff summary: accepted gap candidate 1 for docs navigation: P-GAP-001 from cover collapsed menu open and close/,
  );
  assert.match(verifierLog, /Scenario addition target artifact: normalized\.feature/);
  assert.match(verifierLog, /Added scenario or outline: Scenario: Cover collapsed menu open and close/);
  assert.match(verifierLog, /Scenario addition supporting evidence: normalized\.feature, logs\/runtime\.log/);
  assert.match(
    verifierLog,
    /Promotion summary: promoted Scenario: Cover collapsed menu open and close into Features\/homepage\.feature\./,
  );
  assert.match(
    updatedProgress,
    /- \[x\] `P-GAP-001` Goal: cover collapsed menu open and close for docs navigation[\s\S]*?Result: `pass via npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in logs\/verifier\.log \(runtime logs\/runtime\.log; scenario addition outputs\/scenario-addition\.md; promotion report outputs\/promotion-report\.md\)`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-739` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Result: `existing result`/,
  );
});

test('advanceRun preserves canonical promotion behavior after execution controls are recorded', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-901',
        goal: 'cover collapsed menu open and close for docs navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, featurePath, result } = createFeatureRun(t, { progressContent });
  writeGeneratedSpec(repoRoot, result.runId);
  const { runner } = createMockCommandRunner();

  verifyRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    project: 'firefox',
    headed: true,
    debug: false,
    baseUrl: 'https://staging.example.test',
    targetEnv: 'staging',
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    env: { ...process.env },
    commandRunner: runner,
  });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-901',
    summary: 'accepted gap candidate 1 for docs navigation: P-GAP-901 from cover collapsed menu open and close',
  });
  const processRunner = createScenarioAdditionProcessRunner({
    runPaths: result.runPaths,
    addedScenarioOrOutline: 'Scenario: Cover collapsed menu open and close',
    scenarioBlock: [
      '  Scenario: Cover collapsed menu open and close',
      '    Given I open "/docs/intro"',
      '    Then the title should contain "Installation"',
      '    And the url should contain "/docs/intro"',
    ].join('\n'),
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const canonicalFeature = fs.readFileSync(featurePath, 'utf8');
  const promotionReport = fs.readFileSync(result.runPaths.promotionReportPath, 'utf8');
  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.verifierStatus, 'pass');
  assert.match(promotionReport, /status=pass/);
  assert.match(promotionReport, /Canonical feature target: Features\/homepage\.feature/);
  assert.match(canonicalFeature, /Scenario: Cover collapsed menu open and close/);
  assert.equal(countOccurrences(prdContent, /^## Execution Controls$/gm), 1);
});

test('advanceRun creates minimal reusable canonical step coverage only when the promoted scenario needs it', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-005',
        goal: 'hover the docs link once for homepage navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `homepage navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, featurePath, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-005',
    scope: 'homepage navigation',
    candidateScenario: 'hover the docs link once',
    summary: 'accepted gap candidate 1 for homepage navigation: P-GAP-005 from hover the docs link once',
  });
  const processRunner = createScenarioAdditionProcessRunner({
    runPaths: result.runPaths,
    addedScenarioOrOutline: 'Scenario: Hover the docs link once',
    scenarioBlock: [
      '  Scenario: Hover the docs link once',
      '    Given I open "/"',
      '    When I hover "getByRole(\'link\', { name: \'Docs\' })"',
      '    Then the url should contain "/"',
    ].join('\n'),
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const canonicalFeature = fs.readFileSync(featurePath, 'utf8');
  const generatedSteps = fs.readFileSync(path.join(repoRoot, 'Features', 'steps', 'promotion-generated.ts'), 'utf8');
  const promotionReport = fs.readFileSync(result.runPaths.promotionReportPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.verifierStatus, 'pass');
  assert.match(canonicalFeature, /Scenario: Hover the docs link once/);
  assert.match(generatedSteps, /Generated reusable steps for canonical promotion-backed scenarios/);
  assert.match(generatedSteps, /When\('I hover \{string\}'/);
  assert.doesNotMatch(generatedSteps, /I check \{string\}/);
  assert.match(promotionReport, /status=pass/);
  assert.match(promotionReport, /Canonical step target: Features\/steps\/promotion-generated\.ts/);
  assert.match(promotionReport, /Step action: created/);
  assert.match(promotionReport, /Added reusable step expressions: I hover \{string\}/);
});

test('advanceRun blocks canonical promotion when run artifacts resolve multiple canonical feature targets', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-006',
        goal: 'cover the docs ambiguity path for homepage navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `homepage navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, featurePath, result } = createFeatureRun(t, { progressContent });
  writeFeature(repoRoot, 'Features/other.feature', 'Feature: Other\n');
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-006',
    scope: 'homepage navigation',
    candidateScenario: 'cover the docs ambiguity path',
    candidateAdditionTarget: 'Features/other.feature :: alternate docs target',
    summary: 'accepted gap candidate 1 for homepage navigation: P-GAP-006 from cover the docs ambiguity path',
  });
  const processRunner = createScenarioAdditionProcessRunner({
    runPaths: result.runPaths,
    addedScenarioOrOutline: 'Scenario: Cover the docs ambiguity path',
    scenarioBlock: [
      '  Scenario: Cover the docs ambiguity path',
      '    Given I open "/"',
      '    Then the url should contain "/"',
    ].join('\n'),
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const canonicalFeature = fs.readFileSync(featurePath, 'utf8');
  const promotionReport = fs.readFileSync(result.runPaths.promotionReportPath, 'utf8');

  assert.equal(iteration.status, 'blocked');
  assert.equal(iteration.verifierStatus, 'blocked');
  assert.match(
    iteration.verifierSummary,
    /verifier blocked recorded pass: canonical promotion blocked in outputs\/promotion-report\.md: canonical target is ambiguous across Features\/homepage\.feature, Features\/other\.feature\./,
  );
  assert.doesNotMatch(canonicalFeature, /Scenario: Cover the docs ambiguity path/);
  assert.match(promotionReport, /status=blocked/);
  assert.match(promotionReport, /Summary: canonical target is ambiguous across Features\/homepage\.feature, Features\/other\.feature\./);
});

test('advanceRun blocks canonical promotion when the canonical feature target has merge conflict markers', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-007',
        goal: 'cover a docs conflict path for homepage navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `homepage navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, featurePath, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-007',
    scope: 'homepage navigation',
    candidateScenario: 'cover a docs conflict path',
    summary: 'accepted gap candidate 1 for homepage navigation: P-GAP-007 from cover a docs conflict path',
  });
  writeTextFile(featurePath, '<<<<<<< HEAD\nFeature: Conflict\n=======\nFeature: Conflict\n>>>>>>> branch\n');
  const processRunner = createScenarioAdditionProcessRunner({
    runPaths: result.runPaths,
    addedScenarioOrOutline: 'Scenario: Cover a docs conflict path',
    scenarioBlock: [
      '  Scenario: Cover a docs conflict path',
      '    Given I open "/"',
      '    Then the url should contain "/"',
    ].join('\n'),
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const promotionReport = fs.readFileSync(result.runPaths.promotionReportPath, 'utf8');

  assert.equal(iteration.status, 'blocked');
  assert.equal(iteration.verifierStatus, 'blocked');
  assert.match(
    iteration.verifierSummary,
    /verifier blocked recorded pass: canonical promotion blocked in outputs\/promotion-report\.md: Features\/homepage\.feature contains merge conflict markers\./,
  );
  assert.match(promotionReport, /status=blocked/);
  assert.match(promotionReport, /Summary: Features\/homepage\.feature contains merge conflict markers\./);
});

test('advanceRun blocks canonical promotion when the canonical feature has drifted away from the run-local baseline', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-007B',
        goal: 'cover a docs drift path for homepage navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `homepage navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, featurePath, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-007B',
    scope: 'homepage navigation',
    candidateScenario: 'cover a docs drift path',
    summary: 'accepted gap candidate 1 for homepage navigation: P-GAP-007B from cover a docs drift path',
  });
  writeTextFile(
    featurePath,
    [
      '@smoke',
      'Feature: Playwright home page',
      '',
      '  Background:',
      '    Given the browser session is open',
      '',
      '  Scenario: Open the getting started guide',
      '    Given I open "/"',
      '    When I click "getByRole(\'link\', { name: \'Get started\' })"',
      '    Then the title should contain "Get Started"',
      '    And the url should contain "/docs/intro"',
      '    And I should see "getByRole(\'heading\', { name: \'Installation\' })"',
    ].join('\n'),
  );
  const processRunner = createScenarioAdditionProcessRunner({
    runPaths: result.runPaths,
    addedScenarioOrOutline: 'Scenario: Cover a docs drift path',
    scenarioBlock: [
      '  Scenario: Cover a docs drift path',
      '    Given I open "/"',
      '    Then the url should contain "/"',
    ].join('\n'),
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const promotionReport = fs.readFileSync(result.runPaths.promotionReportPath, 'utf8');

  assert.equal(iteration.status, 'blocked');
  assert.equal(iteration.verifierStatus, 'blocked');
  assert.match(
    iteration.verifierSummary,
    /verifier blocked recorded pass: canonical promotion blocked in outputs\/promotion-report\.md: promotion drift detected between normalized\.feature and Features\/homepage\.feature\./,
  );
  assert.match(promotionReport, /status=blocked/);
  assert.match(
    promotionReport,
    /Summary: promotion drift detected between normalized\.feature and Features\/homepage\.feature\./,
  );
});

test('advanceRun fails canonical promotion when promoted step coverage cannot be verified or synthesized', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-008',
        goal: 'cover an unsupported drag path for homepage navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `homepage navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, featurePath, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-008',
    scope: 'homepage navigation',
    candidateScenario: 'cover an unsupported drag path',
    summary: 'accepted gap candidate 1 for homepage navigation: P-GAP-008 from cover an unsupported drag path',
  });
  const processRunner = createScenarioAdditionProcessRunner({
    runPaths: result.runPaths,
    addedScenarioOrOutline: 'Scenario: Cover an unsupported drag path',
    scenarioBlock: [
      '  Scenario: Cover an unsupported drag path',
      '    Given I open "/"',
      '    When I drag "getByRole(\'link\', { name: \'Docs\' })" to "getByRole(\'main\')"',
      '    Then the url should contain "/"',
    ].join('\n'),
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const canonicalFeature = fs.readFileSync(featurePath, 'utf8');
  const promotionReport = fs.readFileSync(result.runPaths.promotionReportPath, 'utf8');

  assert.equal(iteration.status, 'fail');
  assert.equal(iteration.verifierStatus, 'fail');
  assert.match(
    iteration.verifierSummary,
    /verifier rejected recorded pass: canonical promotion failed in outputs\/promotion-report\.md: unverifiable step coverage for "I drag "getByRole\('link', \{ name: 'Docs' \}\)" to "getByRole\('main'\)""\./,
  );
  assert.doesNotMatch(canonicalFeature, /Scenario: Cover an unsupported drag path/);
  assert.match(promotionReport, /status=fail/);
  assert.match(
    promotionReport,
    /Summary: unverifiable step coverage for "I drag "getByRole\('link', \{ name: 'Docs' \}\)" to "getByRole\('main'\)""\./,
  );
});

test('advanceRun preserves fail behavior and fallback summaries for planner-handoff-backed scenario addition items', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-002',
        goal: 'cover closing the docs drawer after choosing docs for docs drawer',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs drawer`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-002',
    scope: 'docs drawer',
    candidateGap: 'drawer close path remains uncovered',
    candidateScenario: 'cover closing the docs drawer after choosing docs',
    summary: 'accepted gap candidate 1 for docs drawer: P-GAP-002 from cover closing the docs drawer after choosing docs',
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'step coverage failed after appending one outline',
      runtimeLayer: 'mcp',
      fallbackReason: 'Playwright CLI could not verify the drawer close path',
      addedScenarioOrOutline: 'Scenario Outline: Close the docs drawer after choosing Docs',
      targetArtifactPath: result.runPaths.normalizedFeaturePath,
      evidence: ['normalized.feature'],
      stopReason: 'bounded addition stopped after unresolved step text',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const scenarioAddition = fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8');
  const fallbackLog = fs.readFileSync(result.runPaths.fallbackLogPath, 'utf8');

  assert.equal(iteration.scenarioAdditionItem, true);
  assert.equal(iteration.status, 'fail');
  assert.equal(iteration.executorStatus, 'fail');
  assert.match(
    iteration.executorSummary,
    /recorded fail from outputs\/scenario-addition\.md: added Scenario Outline: Close the docs drawer after choosing Docs in normalized\.feature: step coverage failed after appending one outline; fallback in logs\/fallback\.log: Playwright CLI could not verify the drawer close path/,
  );
  assert.equal(iteration.verifierStatus, 'fail');
  assert.match(
    iteration.verifierSummary,
    /verifier confirmed fail from outputs\/scenario-addition\.md: added Scenario Outline: Close the docs drawer after choosing Docs in normalized\.feature: step coverage failed after appending one outline; fallback in logs\/fallback\.log: Playwright CLI could not verify the drawer close path/,
  );
  assert.match(updatedProgress, /Status: `fail`/);
  assert.match(updatedProgress, /Fallback reason: `Playwright CLI could not verify the drawer close path`/);
  assert.match(fallbackLog, /Fallback reason: Playwright CLI could not verify the drawer close path/);
  assert.match(scenarioAddition, /status=fail/);
  assert.match(scenarioAddition, /Stop reason: bounded addition stopped after unresolved step text/);
});

test('advanceRun preserves append-only scenario-addition history while keeping planner-owned progress projections deduped', (t) => {
  const { repoRoot, result } = createFeatureRun(t);
  const { runner } = createMockCommandRunner();

  writeGeneratedSpec(repoRoot, result.runId);
  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-002',
    scope: 'docs drawer',
    candidateGap: 'drawer close path remains uncovered',
    candidateScenario: 'cover closing the docs drawer after choosing docs',
    summary: 'accepted gap candidate 1 for docs drawer: P-GAP-002 from cover closing the docs drawer after choosing docs',
  });
  prepareRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    commandRunner: runner,
  });
  writeTextFile(
    result.runPaths.progressPath,
    fs.readFileSync(result.runPaths.progressPath, 'utf8').replace(
      /- \[ \] `P-002` Goal: execute the generated feature-backed run for Playwright home page on Chromium[\s\S]*?  - Fallback reason: ``/,
      [
        '- [x] `P-002` Goal: execute the generated feature-backed run for Playwright home page on Chromium',
        '  - Input: `normalized.feature`',
        '  - Output: runtime proof recorded in `logs/runtime.log`',
        `  - Verify: \`npm run qa:orchestrator -- execute-run --run-id ${result.runId} --project chromium\``,
        '  - Owner: `qa-executor`',
        '  - Status: `pass`',
        '  - Retry budget: `2`',
        '  - Result: `existing executor proof`',
        '  - Fallback reason: ``',
      ].join('\n'),
    ),
  );
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'step coverage failed after appending one outline',
      runtimeLayer: 'mcp',
      fallbackReason: 'Playwright CLI could not verify the drawer close path',
      addedScenarioOrOutline: 'Scenario Outline: Close the docs drawer after choosing Docs',
      targetArtifactPath: result.runPaths.normalizedFeaturePath,
      evidence: ['normalized.feature'],
      stopReason: 'bounded addition stopped after unresolved step text',
    }),
    stderr: '',
  });

  advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });
  advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const progressAfterSecondAdvance = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const scenarioAddition = fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(countOccurrences(progressAfterSecondAdvance, /`P-GAP-002` Goal:/g), 1);
  assert.equal(countOccurrences(progressAfterSecondAdvance, /^## Active Items$/gm), 1);
  assert.match(progressAfterSecondAdvance, /- \[ \] `P-GAP-002` Goal: cover closing the docs drawer after choosing docs for docs drawer[\s\S]*?Status: `fail`/);
  assert.equal(countOccurrences(scenarioAddition, /status=fail/g), 2);
  assert.equal(countOccurrences(verifierLog, /status=fail/g), 2);
});

test('advanceRun preserves blocked terminal behavior while verifier reads scenario-addition artifact signals', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-003',
        goal: 'cover the offline footer return path for docs footer',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs footer`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-003',
    scope: 'docs footer',
    candidateGap: 'offline footer return path remains uncovered',
    candidateScenario: 'cover the offline footer return path',
    summary: 'accepted gap candidate 1 for docs footer: P-GAP-003 from cover the offline footer return path',
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'blocked',
      summary: 'manual review required before another bounded addition',
      runtimeLayer: 'playwright-test',
      addedScenarioOrOutline: 'Scenario: Offline footer return path',
      targetArtifactPath: result.runPaths.normalizedFeaturePath,
      evidence: ['evidence/screenshots/footer-offline.png'],
      escalationReason: 'manual product clarification required before another addition',
      stopReason: 'bounded addition stopped after footer copy diverged',
      blockReason: 'approved handoff no longer matches current footer behavior',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.scenarioAdditionItem, true);
  assert.equal(iteration.status, 'blocked');
  assert.equal(iteration.executorStatus, 'blocked');
  assert.match(
    iteration.executorSummary,
    /recorded blocked from outputs\/scenario-addition\.md: approved handoff no longer matches current footer behavior/,
  );
  assert.equal(iteration.verifierStatus, 'blocked');
  assert.match(
    iteration.verifierSummary,
    /verifier confirmed blocked from outputs\/scenario-addition\.md: approved handoff no longer matches current footer behavior/,
  );
  assert.match(updatedProgress, /Status: `blocked`/);
  assert.match(
    updatedProgress,
    /Result: `blocked: verifier confirmed blocked from outputs\/scenario-addition\.md: approved handoff no longer matches current footer behavior; evidence in logs\/verifier\.log`/,
  );
  assert.match(verifierLog, /Scenario-addition item: yes/);
  assert.match(verifierLog, /Scenario addition target artifact: normalized\.feature/);
  assert.match(verifierLog, /Added scenario or outline: Scenario: Offline footer return path/);
  assert.match(verifierLog, /Scenario addition supporting evidence: evidence\/screenshots\/footer-offline\.png/);
  assert.match(verifierLog, /Scenario addition escalation reason: manual product clarification required before another addition/);
  assert.match(verifierLog, /Scenario addition stop reason: bounded addition stopped after footer copy diverged/);
  assert.match(verifierLog, /Scenario addition block reason: approved handoff no longer matches current footer behavior/);
});

test('advanceRun rejects a recorded planner-handoff-backed pass when scenario addition is missing', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-004',
        goal: 'cover the docs return CTA path for docs navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-004',
    candidateScenario: 'cover the docs return CTA path',
    progressGoal: 'cover the docs return CTA path for docs navigation',
    summary: 'accepted gap candidate 1 for docs navigation: P-GAP-004 from cover the docs return CTA path',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    iterateRunFn: (options) => {
      writeTextFile(
        result.runPaths.progressPath,
        createProgressDocument({
          includeTemplate: false,
          activeBlocks: [
            createProgressBlock({
              id: 'P-GAP-004',
              goal: 'cover the docs return CTA path for docs navigation',
              input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
              output: 'verifier-backed proof recorded in `logs/verifier.log`',
              verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
              owner: 'qa-executor',
              retryBudget: '1',
              checked: true,
              status: 'pass',
              result: 'pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in outputs/scenario-addition.md',
            }),
          ],
        }),
      );
      writeStructuredLogEntry(result.runPaths.runtimeLogPath, 'pass', [
        'Adapter: mock',
        'Selected item: P-GAP-004 - cover the docs return CTA path for docs navigation',
        'Summary: appended one bounded scenario without the scenario-addition artifact',
      ]);

      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-GAP-004',
        status: 'pass',
        summary: 'appended one bounded scenario without the scenario-addition artifact',
      };
    },
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.scenarioAdditionItem, true);
  assert.equal(iteration.status, 'fail');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(
    iteration.executorSummary,
    /executor recorded pass without scenario addition artifact in outputs\/scenario-addition\.md\./,
  );
  assert.equal(iteration.verifierStatus, 'fail');
  assert.match(
    iteration.verifierSummary,
    /verifier rejected recorded pass: scenario addition missing in outputs\/scenario-addition\.md\./,
  );
  assert.match(updatedProgress, /Status: `fail`/);
  assert.equal(fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8'), '# Scenario Addition\n\nNot started.\n');
});

test('advanceRun rejects a recorded explorer pass when gap analysis is missing', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-738',
        goal: 'identify coverage gaps around the docs footer',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    iterateRunFn: (options) => {
      writeTextFile(
        result.runPaths.progressPath,
        createProgressDocument({
          includeTemplate: false,
          activeBlocks: [
            createProgressBlock({
              id: 'P-738',
              goal: 'identify coverage gaps around the docs footer',
              owner: 'qa-explorer',
              output: 'gap candidates recorded in `outputs/gap-analysis.md`',
              checked: true,
              status: 'pass',
              result: 'pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in outputs/gap-analysis.md',
            }),
          ],
        }),
      );
      writeStructuredLogEntry(result.runPaths.runtimeLogPath, 'pass', [
        'Adapter: mock',
        'Selected item: P-738 - identify coverage gaps around the docs footer',
        'Summary: identified coverage gaps without the explorer artifact',
      ]);

      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-738',
        status: 'pass',
        summary: 'identified coverage gaps without the explorer artifact',
      };
    },
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.explorerItem, true);
  assert.equal(iteration.status, 'fail');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(iteration.executorSummary, /explorer recorded pass without gap analysis in outputs\/gap-analysis\.md\./);
  assert.equal(iteration.verifierStatus, 'fail');
  assert.match(iteration.verifierSummary, /verifier rejected recorded pass: gap analysis missing in outputs\/gap-analysis\.md\./);
  assert.match(updatedProgress, /Status: `fail`/);
  assert.equal(fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8'), '# Gap Analysis\n\nNot started.\n');
});

test('advanceRun rejects a recorded pass when verifier proof is missing', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-741',
        goal: 'selected item without proof',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    iterateRunFn: (options) => {
      writeTextFile(
        result.runPaths.progressPath,
        createProgressDocument({
          includeTemplate: false,
          activeBlocks: [
            createProgressBlock({
              id: 'P-741',
              goal: 'selected item without proof',
              checked: true,
              status: 'pass',
              result: 'pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in logs/runtime.log',
            }),
          ],
        }),
      );

      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-741',
        status: 'pass',
        summary: 'runtime reported pass without proof',
      };
    },
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.status, 'fail');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(iteration.executorSummary, /executor recorded pass without runtime proof in logs\/runtime\.log\./);
  assert.equal(iteration.verifierStatus, 'fail');
  assert.match(iteration.summary, /verifier rejected recorded pass: runtime proof missing in logs\/runtime\.log/);
  assert.match(verifierLog, /status=fail/);
  assert.match(updatedProgress, /Status: `fail`/);
  assert.match(
    updatedProgress,
    /Result: `fail: verifier rejected recorded pass: runtime proof missing in logs\/runtime\.log\.; evidence in logs\/verifier\.log`/,
  );
});

test('advanceRun reports blocked healer outcomes with concise heal-report-backed summaries', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-742',
        goal: 'heal the stale locator',
        owner: 'qa-healer',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'locator drift on the primary CTA',
      runtimeLayer: 'playwright-cli',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'fail',
      QA_HARNESS_MOCK_SUMMARY: 'locator drift on the primary CTA',
      QA_HARNESS_MOCK_RUNTIME_LAYER: 'playwright-cli',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');
  const verifierLog = fs.readFileSync(result.runPaths.verifierLogPath, 'utf8');

  assert.equal(iteration.healingItem, true);
  assert.equal(iteration.status, 'blocked');
  assert.equal(iteration.executorStatus, 'blocked');
  assert.match(
    iteration.executorSummary,
    /recorded blocked from outputs\/heal-report\.md: retry budget exhausted; hypothesis: locator drift on the primary CTA/,
  );
  assert.equal(iteration.verifierStatus, 'blocked');
  assert.match(
    iteration.verifierSummary,
    /verifier confirmed blocked from outputs\/heal-report\.md: retry budget exhausted; hypothesis: locator drift on the primary CTA/,
  );
  assert.match(healReport, /Selected item: P-742 - heal the stale locator/);
  assert.match(healReport, /Block reason: retry budget exhausted; hypothesis: locator drift on the primary CTA/);
  assert.match(verifierLog, /Healing item: yes/);
  assert.match(verifierLog, /Heal report block reason: retry budget exhausted; hypothesis: locator drift on the primary CTA/);
  assert.match(
    updatedProgress,
    /- \[ \] `P-742` Goal: heal the stale locator[\s\S]*?Status: `blocked`[\s\S]*?Retry budget: `0`[\s\S]*?Result: `blocked: verifier confirmed blocked from outputs\/heal-report\.md: retry budget exhausted; hypothesis: locator drift on the primary CTA; evidence in logs\/verifier\.log`/,
  );
});

test('advanceRun preserves runtime and fallback semantics for healer-owned fail outcomes', (t) => {
  const progressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-743',
        goal: 'heal the flaky locator',
        owner: 'qa-healer',
        retryBudget: '2',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'MCP fallback could not repair the locator',
      runtimeLayer: 'mcp',
      fallbackReason: 'Playwright CLI could not isolate the failing locator',
      smallestFailingUnit: 'checkout button locator',
      rootCauseHypothesis: 'stale data-testid on the checkout button',
      escalationReason: 'manual locator audit required if the next bounded attempt still fails',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'fail',
      QA_HARNESS_MOCK_SUMMARY: 'MCP fallback could not repair the locator',
      QA_HARNESS_MOCK_RUNTIME_LAYER: 'mcp',
      QA_HARNESS_MOCK_FALLBACK_REASON: 'Playwright CLI could not isolate the failing locator',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const fallbackLog = fs.readFileSync(result.runPaths.fallbackLogPath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.equal(iteration.healingItem, true);
  assert.equal(iteration.status, 'fail');
  assert.equal(iteration.executorStatus, 'fail');
  assert.match(
    iteration.executorSummary,
    /recorded fail from outputs\/heal-report\.md: MCP fallback could not repair the locator; smallest failing unit: checkout button locator; hypothesis: stale data-testid on the checkout button; escalation: manual locator audit required if the next bounded attempt still fails; fallback in logs\/fallback\.log: Playwright CLI could not isolate the failing locator/,
  );
  assert.equal(iteration.verifierStatus, 'fail');
  assert.match(
    iteration.verifierSummary,
    /verifier confirmed fail from outputs\/heal-report\.md: MCP fallback could not repair the locator; smallest failing unit: checkout button locator; hypothesis: stale data-testid on the checkout button; escalation: manual locator audit required if the next bounded attempt still fails; fallback in logs\/fallback\.log: Playwright CLI could not isolate the failing locator/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-743` Goal: heal the flaky locator[\s\S]*?Status: `fail`[\s\S]*?Retry budget: `1`[\s\S]*?Fallback reason: `Playwright CLI could not isolate the failing locator`/,
  );
  assert.match(fallbackLog, /Selected item: P-743 - heal the flaky locator/);
  assert.match(fallbackLog, /Fallback reason: Playwright CLI could not isolate the failing locator/);
  assert.match(healReport, /status=fail/);
  assert.match(healReport, /Selected item: P-743 - heal the flaky locator/);
  assert.match(healReport, /Smallest failing unit: checkout button locator/);
  assert.match(healReport, /Root-cause hypothesis: stale data-testid on the checkout button/);
  assert.match(healReport, /Escalation reason: manual locator audit required if the next bounded attempt still fails/);
  assert.match(healReport, /Fallback reason: Playwright CLI could not isolate the failing locator/);
});

test('advanceRun preserves legacy heal-run compatibility through the existing run artifacts', (t) => {
  const legacyProgressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-821',
        goal: 'legacy heal item owned by the executor',
        owner: 'qa-executor',
        retryBudget: '1',
        includeResult: false,
        includeFallbackReason: false,
      }),
      createProgressBlock({
        id: 'P-822',
        goal: 'leave this untouched',
        owner: 'qa-healer',
        retryBudget: '2',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent: legacyProgressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'legacy heal run still cannot stabilize the target step',
      runtimeLayer: 'playwright-cli',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'fail',
      QA_HARNESS_MOCK_SUMMARY: 'legacy heal run still cannot stabilize the target step',
      QA_HARNESS_MOCK_RUNTIME_LAYER: 'playwright-cli',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.healingItem, true);
  assert.equal(iteration.selectedItemId, 'P-821');
  assert.equal(iteration.status, 'blocked');
  assert.equal(iteration.verifierStatus, 'blocked');
  assert.match(
    iteration.verifierSummary,
    /verifier confirmed blocked from outputs\/heal-report\.md: retry budget exhausted; hypothesis: legacy heal run still cannot stabilize the target step/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-821` Goal: legacy heal item owned by the executor[\s\S]*?Status: `blocked`\r?\n  - Retry budget: `0`\r?\n  - Result: `blocked: verifier confirmed blocked from outputs\/heal-report\.md: retry budget exhausted; hypothesis: legacy heal run still cannot stabilize the target step; evidence in logs\/verifier\.log`\r?\n  - Fallback reason: ``\r?\n  - Block reason: `retry budget exhausted; hypothesis: legacy heal run still cannot stabilize the target step`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-822` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Retry budget: `2`[\s\S]*?Result: `existing result`/,
  );
});

test('runCli advance-run validates --run-id, defaults adapter to external, and prints stdout on success', () => {
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const missingRunIdExitCode = runCli(['advance-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(missingRunIdExitCode, 1);
  assert.match(stderr, /--run-id/);
  assert.equal(stdout, '');

  stdout = '';
  stderr = '';

  const exitCode = runCli(['advance-run', '--run-id', 'sample-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    advanceRunFn: (options) => {
      capturedOptions = options;
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-711',
        status: 'pass',
        executorStatus: 'pass',
        executorSummary: 'recorded pass from logs/runtime.log: one bounded pass',
        verifierStatus: 'pass',
        verifierSummary: 'verifier accepted pass from logs/runtime.log: one bounded pass',
        summary: 'verifier accepted pass from logs/runtime.log: one bounded pass',
        verifierLogPathDisplay: 'logs/verifier.log',
        runtimeLogPathDisplay: 'logs/runtime.log',
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(capturedOptions.runId, 'sample-run');
  assert.equal(capturedOptions.adapter, 'external');
  assert.match(
    stdout,
    /Advanced run sample-run item P-711 with external: pass; delegated=pass: recorded pass from logs\/runtime\.log: one bounded pass; verifier=pass: verifier accepted pass from logs\/runtime\.log: one bounded pass; artifacts=logs\/verifier\.log, logs\/runtime\.log/,
  );
});

test('runCli advance-run prints explorer-owned pass outcomes with gap-analysis-backed artifacts', () => {
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['advance-run', '--run-id', 'sample-run', '--adapter', 'mock'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    advanceRunFn: (options) => ({
      runId: options.runId,
      adapter: options.adapter,
      selectedItemId: 'P-711X',
      explorerItem: true,
      status: 'pass',
      executorStatus: 'pass',
      executorSummary: 'recorded pass from outputs/gap-analysis.md: 2 gap candidates for docs navigation: identified 2 bounded coverage gaps',
      verifierStatus: 'pass',
      verifierSummary: 'verifier accepted pass from outputs/gap-analysis.md: 2 gap candidates for docs navigation: identified 2 bounded coverage gaps',
      summary: 'verifier accepted pass from outputs/gap-analysis.md: 2 gap candidates for docs navigation: identified 2 bounded coverage gaps',
      verifierLogPathDisplay: 'logs/verifier.log',
      gapAnalysisPathDisplay: 'outputs/gap-analysis.md',
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(
    stdout,
    /Advanced run sample-run item P-711X with mock: pass; delegated=pass: recorded pass from outputs\/gap-analysis\.md: 2 gap candidates for docs navigation: identified 2 bounded coverage gaps; verifier=pass: verifier accepted pass from outputs\/gap-analysis\.md: 2 gap candidates for docs navigation: identified 2 bounded coverage gaps; artifacts=logs\/verifier\.log, outputs\/gap-analysis\.md/,
  );
});

test('runCli advance-run prints scenario-addition-owned pass outcomes with scenario-addition-backed artifacts', () => {
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['advance-run', '--run-id', 'sample-run', '--adapter', 'mock'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    advanceRunFn: (options) => ({
      runId: options.runId,
      adapter: options.adapter,
      selectedItemId: 'P-GAP-001',
      scenarioAdditionItem: true,
      status: 'pass',
      executorStatus: 'pass',
      executorSummary: 'recorded pass from outputs/scenario-addition.md: added Scenario: Cover collapsed menu open and close in normalized.feature: appended one bounded scenario to normalized.feature',
      verifierStatus: 'pass',
      verifierSummary: 'verifier accepted pass from outputs/scenario-addition.md: added Scenario: Cover collapsed menu open and close in normalized.feature: appended one bounded scenario to normalized.feature; promotion in outputs/promotion-report.md: promoted Scenario: Cover collapsed menu open and close into Features/homepage.feature.',
      summary: 'verifier accepted pass from outputs/scenario-addition.md: added Scenario: Cover collapsed menu open and close in normalized.feature: appended one bounded scenario to normalized.feature; promotion in outputs/promotion-report.md: promoted Scenario: Cover collapsed menu open and close into Features/homepage.feature.',
      verifierLogPathDisplay: 'logs/verifier.log',
      promotionReportPathDisplay: 'outputs/promotion-report.md',
      scenarioAdditionPathDisplay: 'outputs/scenario-addition.md',
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(
    stdout,
    /Advanced run sample-run item P-GAP-001 with mock: pass; delegated=pass: recorded pass from outputs\/scenario-addition\.md: added Scenario: Cover collapsed menu open and close in normalized\.feature: appended one bounded scenario to normalized\.feature; verifier=pass: verifier accepted pass from outputs\/scenario-addition\.md: added Scenario: Cover collapsed menu open and close in normalized\.feature: appended one bounded scenario to normalized\.feature; promotion in outputs\/promotion-report\.md: promoted Scenario: Cover collapsed menu open and close into Features\/homepage\.feature\.; artifacts=logs\/verifier\.log, outputs\/scenario-addition\.md, outputs\/promotion-report\.md/,
  );
});

test('runCli advance-run prints verifier rejection outcomes to stderr and returns exit code 1', () => {
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['advance-run', '--run-id', 'sample-run', '--adapter', 'mock'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    advanceRunFn: (options) => ({
      runId: options.runId,
      adapter: options.adapter,
      selectedItemId: 'P-711A',
      status: 'fail',
      executorStatus: 'pass',
      executorSummary: 'recorded pass from logs/runtime.log: one bounded pass',
      verifierStatus: 'fail',
      verifierSummary: 'verifier rejected recorded pass: runtime proof missing in logs/runtime.log.',
      summary: 'verifier rejected recorded pass: runtime proof missing in logs/runtime.log.',
      verifierLogPathDisplay: 'logs/verifier.log',
      runtimeLogPathDisplay: 'logs/runtime.log',
    }),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Advanced run sample-run item P-711A with mock: fail; delegated=pass: recorded pass from logs\/runtime\.log: one bounded pass; verifier=fail: verifier rejected recorded pass: runtime proof missing in logs\/runtime\.log\.; artifacts=logs\/verifier\.log, logs\/runtime\.log/,
  );
});

test('runCli advance-run prints healer-owned blocked outcomes to stderr and returns exit code 1', () => {
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const exitCode = runCli(['advance-run', '--run-id', 'sample-run', '--adapter', 'mock'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    advanceRunFn: (options) => {
      capturedOptions = options;
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-712',
        healingItem: true,
        status: 'blocked',
        executorStatus: 'blocked',
        executorSummary: 'recorded blocked from outputs/heal-report.md: requires manual follow-up',
        verifierStatus: 'blocked',
        verifierSummary: 'verifier confirmed blocked from outputs/heal-report.md: requires manual follow-up',
        summary: 'verifier confirmed blocked from outputs/heal-report.md: requires manual follow-up',
        verifierLogPathDisplay: 'logs/verifier.log',
        healReportPathDisplay: 'outputs/heal-report.md',
      };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.equal(capturedOptions.adapter, 'mock');
  assert.match(
    stderr,
    /Advanced run sample-run item P-712 with mock: blocked; delegated=blocked: recorded blocked from outputs\/heal-report\.md: requires manual follow-up; verifier=blocked: verifier confirmed blocked from outputs\/heal-report\.md: requires manual follow-up; artifacts=logs\/verifier\.log, outputs\/heal-report\.md/,
  );
});

test('runCli advance-run prints executor failure outcomes to stderr and returns exit code 1', () => {
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const exitCode = runCli(['advance-run', '--run-id', 'sample-run', '--adapter', 'mock'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    advanceRunFn: (options) => {
      capturedOptions = options;
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-713',
        status: 'fail',
        executorStatus: 'fail',
        executorSummary: 'recorded fail from logs/runtime.log: runtime proof failed',
        verifierStatus: 'fail',
        verifierSummary: 'verifier confirmed fail from logs/runtime.log: runtime proof failed',
        summary: 'verifier confirmed fail from logs/runtime.log: runtime proof failed',
        verifierLogPathDisplay: 'logs/verifier.log',
        runtimeLogPathDisplay: 'logs/runtime.log',
      };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.equal(capturedOptions.adapter, 'mock');
  assert.match(
    stderr,
    /Advanced run sample-run item P-713 with mock: fail; delegated=fail: recorded fail from logs\/runtime\.log: runtime proof failed; verifier=fail: verifier confirmed fail from logs\/runtime\.log: runtime proof failed; artifacts=logs\/verifier\.log, logs\/runtime\.log/,
  );
});

test('runCli advance-run prints healer-owned fail outcomes to stderr and returns exit code 1', () => {
  let stdout = '';
  let stderr = '';

  const exitCode = runCli(['advance-run', '--run-id', 'sample-run', '--adapter', 'mock'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    advanceRunFn: (options) => ({
      runId: options.runId,
      adapter: options.adapter,
      selectedItemId: 'P-713A',
      healingItem: true,
      status: 'fail',
      executorStatus: 'fail',
      executorSummary: 'recorded fail from outputs/heal-report.md: healer attempt still failed',
      verifierStatus: 'fail',
      verifierSummary: 'verifier confirmed fail from outputs/heal-report.md: healer attempt still failed',
      summary: 'verifier confirmed fail from outputs/heal-report.md: healer attempt still failed',
      verifierLogPathDisplay: 'logs/verifier.log',
      runtimeLogPathDisplay: 'logs/runtime.log',
      healReportPathDisplay: 'outputs/heal-report.md',
    }),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Advanced run sample-run item P-713A with mock: fail; delegated=fail: recorded fail from outputs\/heal-report\.md: healer attempt still failed; verifier=fail: verifier confirmed fail from outputs\/heal-report\.md: healer attempt still failed; artifacts=logs\/verifier\.log, outputs\/heal-report\.md/,
  );
});

test('runCli iterate-run and loop-run remain intact after executor/verifier-backed advance-run composition', () => {
  let stdout = '';
  let stderr = '';

  const iterateExitCode = runCli(['iterate-run', '--run-id', 'sample-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    iterateRunFn: () => ({
      runId: 'sample-run',
      adapter: 'external',
      selectedItemId: 'P-721',
      status: 'pass',
      summary: 'existing iterate flow',
      runtimeLogPathDisplay: 'logs/runtime.log',
    }),
  });

  assert.equal(iterateExitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Iterated run sample-run item P-721 with external: pass - existing iterate flow; artifacts=logs\/runtime\.log/);

  stdout = '';
  stderr = '';

  const loopExitCode = runCli(['loop-run', '--run-id', 'sample-run', '--max-iterations', '2'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    loopRunFn: () => ({
      runId: 'sample-run',
      adapter: 'external',
      maxIterations: 2,
      completedIterations: 1,
      stopReason: 'no-actionable-items',
      status: 'completed',
      lastSelectedItemId: 'P-722',
      loopReportPathDisplay: 'outputs/loop-report.md',
    }),
  });

  assert.equal(loopExitCode, 0);
  assert.equal(stderr, '');
  assert.match(
    stdout,
    /Looped run sample-run with external: completed after 1\/2 iterations; stop=no-actionable-items; last-item=P-722; artifacts=outputs\/loop-report\.md/,
  );
});

test('runCli iterate-run validates --run-id, defaults adapter to external, and forwards explicit adapters', () => {
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const missingRunIdExitCode = runCli(['iterate-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(missingRunIdExitCode, 1);
  assert.match(stderr, /--run-id/);
  assert.equal(stdout, '');

  stdout = '';
  stderr = '';

  const defaultAdapterExitCode = runCli(['iterate-run', '--run-id', 'sample-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    iterateRunFn: (options) => {
      capturedOptions = options;
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-001',
        status: 'pass',
        summary: 'one bounded pass',
        runtimeLogPathDisplay: 'logs/runtime.log',
      };
    },
  });

  assert.equal(defaultAdapterExitCode, 0);
  assert.equal(stderr, '');
  assert.equal(capturedOptions.runId, 'sample-run');
  assert.equal(capturedOptions.adapter, 'external');
  assert.match(stdout, /Iterated run sample-run item P-001 with external: pass - one bounded pass; artifacts=logs\/runtime\.log/);

  stdout = '';
  stderr = '';

  const explicitAdapterExitCode = runCli(['iterate-run', '--run-id', 'sample-run', '--adapter', 'mock'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    iterateRunFn: (options) => {
      capturedOptions = options;
      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: 'P-002',
        status: 'blocked',
        summary: 'requires manual follow-up',
        runtimeLogPathDisplay: 'logs/runtime.log',
      };
    },
  });

  assert.equal(explicitAdapterExitCode, 1);
  assert.equal(stdout, '');
  assert.equal(capturedOptions.adapter, 'mock');
  assert.match(stderr, /Iterated run sample-run item P-002 with mock: blocked - requires manual follow-up; artifacts=logs\/runtime\.log/);
});

test('runCli loop-run validates arguments, parses max iterations, and routes operator output', () => {
  let stdout = '';
  let stderr = '';
  let capturedOptions = null;

  const missingRunIdExitCode = runCli(['loop-run', '--max-iterations', '2'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(missingRunIdExitCode, 1);
  assert.match(stderr, /--run-id/);
  assert.equal(stdout, '');

  stdout = '';
  stderr = '';

  const missingMaxIterationsExitCode = runCli(['loop-run', '--run-id', 'sample-run'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(missingMaxIterationsExitCode, 1);
  assert.match(stderr, /--max-iterations/);
  assert.equal(stdout, '');

  stdout = '';
  stderr = '';

  const invalidMaxIterationsExitCode = runCli(['loop-run', '--run-id', 'sample-run', '--max-iterations', '0'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(invalidMaxIterationsExitCode, 1);
  assert.match(stderr, /--max-iterations must be a positive integer/);
  assert.equal(stdout, '');

  stdout = '';
  stderr = '';

  const completedExitCode = runCli(['loop-run', '--run-id', 'sample-run', '--max-iterations', '3'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    loopRunFn: (options) => {
      capturedOptions = options;
      return {
        runId: options.runId,
        adapter: options.adapter,
        maxIterations: options.maxIterations,
        completedIterations: 2,
        stopReason: 'no-actionable-items',
        status: 'completed',
        lastSelectedItemId: 'P-601',
        loopReportPathDisplay: 'outputs/loop-report.md',
      };
    },
  });

  assert.equal(completedExitCode, 0);
  assert.equal(stderr, '');
  assert.equal(capturedOptions.runId, 'sample-run');
  assert.equal(capturedOptions.adapter, 'external');
  assert.equal(capturedOptions.maxIterations, 3);
  assert.match(
    stdout,
    /Looped run sample-run with external: completed after 2\/3 iterations; stop=no-actionable-items; last-item=P-601; artifacts=outputs\/loop-report\.md/,
  );

  stdout = '';
  stderr = '';

  const budgetExitCode = runCli(
    ['loop-run', '--run-id', 'sample-run', '--max-iterations', '2', '--adapter', 'mock'],
    {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      loopRunFn: (options) => {
        capturedOptions = options;
        return {
          runId: options.runId,
          adapter: options.adapter,
          maxIterations: options.maxIterations,
          completedIterations: 2,
          stopReason: 'max-iterations-reached',
          status: 'budget-exhausted',
          lastSelectedItemId: 'P-602',
          loopReportPathDisplay: 'outputs/loop-report.md',
          progressPathDisplay: 'progress.md',
        };
      },
    },
  );

  assert.equal(budgetExitCode, 0);
  assert.equal(stderr, '');
  assert.equal(capturedOptions.adapter, 'mock');
  assert.equal(capturedOptions.maxIterations, 2);
  assert.match(
    stdout,
    /Looped run sample-run with mock: budget-exhausted after 2\/2 iterations; stop=max-iterations-reached; last-item=P-602; artifacts=outputs\/loop-report\.md, progress\.md/,
  );

  stdout = '';
  stderr = '';

  const failExitCode = runCli(['loop-run', '--run-id', 'sample-run', '--max-iterations', '4'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    loopRunFn: () => ({
      runId: 'sample-run',
      adapter: 'external',
      maxIterations: 4,
      completedIterations: 1,
      stopReason: 'fail',
      status: 'fail',
      lastSelectedItemId: 'P-603',
      loopReportPathDisplay: 'outputs/loop-report.md',
      runtimeLogDisplayPath: 'logs/runtime.log',
    }),
  });

  assert.equal(failExitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Looped run sample-run with external: fail after 1\/4 iterations; stop=fail; last-item=P-603; artifacts=outputs\/loop-report\.md, logs\/runtime\.log/,
  );

  stdout = '';
  stderr = '';

  const blockedExitCode = runCli(['loop-run', '--run-id', 'sample-run', '--max-iterations', '4'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    loopRunFn: () => ({
      runId: 'sample-run',
      adapter: 'external',
      maxIterations: 4,
      completedIterations: 1,
      stopReason: 'blocked',
      status: 'blocked',
      lastSelectedItemId: 'P-604',
      loopReportPathDisplay: 'outputs/loop-report.md',
      runtimeLogDisplayPath: 'logs/runtime.log',
    }),
  });

  assert.equal(blockedExitCode, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /Looped run sample-run with external: blocked after 1\/4 iterations; stop=blocked; last-item=P-604; artifacts=outputs\/loop-report\.md, logs\/runtime\.log/,
  );
});

test('loopRun passes multiple actionable items and stops when none remain', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-601',
        goal: 'pass the first loop item',
      }),
      createProgressBlock({
        id: 'P-602',
        goal: 'pass the second loop item',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const calls = [];
  const processRunner = () => {
    calls.push(calls.length + 1);
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: `loop pass ${calls.length}`,
      }),
      stderr: '',
    };
  };

  const loopResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 5,
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(loopResult.status, 'completed');
  assert.equal(loopResult.stopReason, 'no-actionable-items');
  assert.equal(loopResult.completedIterations, 2);
  assert.equal(loopResult.lastSelectedItemId, 'P-602');
  assert.equal(calls.length, 2);
  assert.match(
    updatedProgress,
    /- \[x\] `P-601` Goal: pass the first loop item[\s\S]*?Status: `pass`/,
  );
  assert.match(
    updatedProgress,
    /- \[x\] `P-602` Goal: pass the second loop item[\s\S]*?Status: `pass`/,
  );
});

test('loopRun stops on fail and leaves later actionable items untouched', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-611',
        goal: 'fail the first loop item',
      }),
      createProgressBlock({
        id: 'P-612',
        goal: 'leave this item for later',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let callCount = 0;
  const processRunner = () => {
    callCount += 1;
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'fail',
        summary: 'loop fail summary',
      }),
      stderr: '',
    };
  };

  const loopResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 4,
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const loopReport = fs.readFileSync(result.runPaths.loopReportPath, 'utf8');

  assert.equal(loopResult.status, 'fail');
  assert.equal(loopResult.stopReason, 'fail');
  assert.equal(loopResult.completedIterations, 1);
  assert.equal(loopResult.lastSelectedItemId, 'P-611');
  assert.equal(callCount, 1);
  assert.match(
    updatedProgress,
    /- \[ \] `P-611` Goal: fail the first loop item[\s\S]*?Status: `fail`[\s\S]*?Result: `fail: loop fail summary`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-612` Goal: leave this item for later[\s\S]*?Status: `todo`/,
  );
  assert.match(loopReport, /Stop reason: fail/);
  assert.match(loopReport, /Final status: fail/);
});

test('loopRun stops on terminal blocked and leaves later actionable items untouched', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-621',
        goal: 'block the first loop item',
      }),
      createProgressBlock({
        id: 'P-622',
        goal: 'keep this item queued',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let callCount = 0;
  const processRunner = () => {
    callCount += 1;
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'blocked',
        summary: 'loop blocked summary',
      }),
      stderr: '',
    };
  };

  const loopResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 4,
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const loopReport = fs.readFileSync(result.runPaths.loopReportPath, 'utf8');

  assert.equal(loopResult.status, 'blocked');
  assert.equal(loopResult.stopReason, 'blocked');
  assert.equal(loopResult.completedIterations, 1);
  assert.equal(loopResult.lastSelectedItemId, 'P-621');
  assert.equal(callCount, 1);
  assert.match(
    updatedProgress,
    /- \[ \] `P-621` Goal: block the first loop item[\s\S]*?Status: `blocked`[\s\S]*?Result: `blocked: loop blocked summary`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-622` Goal: keep this item queued[\s\S]*?Status: `todo`/,
  );
  assert.match(loopReport, /Stop reason: blocked/);
  assert.match(loopReport, /Final status: blocked/);
});

test('loopRun stops immediately when no actionable items remain before iteration start', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-631',
        goal: 'already passed',
        checked: true,
        status: 'pass',
      }),
      createProgressBlock({
        id: 'P-632',
        goal: 'already blocked',
        status: 'blocked',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let iterateCalls = 0;

  const loopResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 3,
    iterateRunFn: () => {
      iterateCalls += 1;
      throw new Error('loopRun should not invoke iterateRun when no actionable items remain.');
    },
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const loopReport = fs.readFileSync(result.runPaths.loopReportPath, 'utf8');

  assert.equal(loopResult.status, 'completed');
  assert.equal(loopResult.stopReason, 'no-actionable-items');
  assert.equal(loopResult.completedIterations, 0);
  assert.equal(loopResult.lastSelectedItemId, '');
  assert.equal(iterateCalls, 0);
  assert.equal(updatedProgress, progressContent);
  assert.match(loopReport, /Completed iterations: 0/);
  assert.match(loopReport, /Last selected item: none/);
});

test('loopRun enforces max iterations even when work remains', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-641',
        goal: 'pass loop item one',
      }),
      createProgressBlock({
        id: 'P-642',
        goal: 'pass loop item two',
      }),
      createProgressBlock({
        id: 'P-643',
        goal: 'leave this queued after budget exhaustion',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let callCount = 0;
  const processRunner = () => {
    callCount += 1;
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: `budget pass ${callCount}`,
      }),
      stderr: '',
    };
  };

  const loopResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 2,
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const loopReport = fs.readFileSync(result.runPaths.loopReportPath, 'utf8');

  assert.equal(loopResult.status, 'budget-exhausted');
  assert.equal(loopResult.stopReason, 'max-iterations-reached');
  assert.equal(loopResult.completedIterations, 2);
  assert.equal(loopResult.lastSelectedItemId, 'P-642');
  assert.equal(callCount, 2);
  assert.match(
    updatedProgress,
    /- \[x\] `P-641` Goal: pass loop item one[\s\S]*?Status: `pass`/,
  );
  assert.match(
    updatedProgress,
    /- \[x\] `P-642` Goal: pass loop item two[\s\S]*?Status: `pass`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-643` Goal: leave this queued after budget exhaustion[\s\S]*?Status: `todo`/,
  );
  assert.match(loopReport, /Stop reason: max-iterations-reached/);
  assert.match(loopReport, /Final status: budget-exhausted/);
});

test('loopRun invokes a fresh iterateRun per iteration and reloads run artifacts from disk', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-651',
        goal: 'first fresh-session item',
      }),
      createProgressBlock({
        id: 'P-652',
        goal: 'second fresh-session item',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const selectedItems = [];
  const capturedCalls = [];

  const loopResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 4,
    iterateRunFn: (options) => {
      capturedCalls.push(options);
      const currentProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
      const selectedItem = findNextActionableProgressItem(currentProgress);
      selectedItems.push(selectedItem.id);

      if (capturedCalls.length === 1) {
        writeTextFile(
          result.runPaths.progressPath,
          createProgressDocument({
            activeBlocks: [
              createProgressBlock({
                id: 'P-651',
                goal: 'first fresh-session item',
                checked: true,
                status: 'pass',
                result: 'stub first pass',
              }),
              createProgressBlock({
                id: 'P-652',
                goal: 'second fresh-session item',
              }),
            ],
          }),
        );
      } else {
        writeTextFile(
          result.runPaths.progressPath,
          createProgressDocument({
            activeBlocks: [
              createProgressBlock({
                id: 'P-651',
                goal: 'first fresh-session item',
                checked: true,
                status: 'pass',
                result: 'stub first pass',
              }),
              createProgressBlock({
                id: 'P-652',
                goal: 'second fresh-session item',
                checked: true,
                status: 'pass',
                result: 'stub second pass',
              }),
            ],
          }),
        );
      }

      return {
        runId: options.runId,
        adapter: options.adapter,
        selectedItemId: selectedItem.id,
        status: 'pass',
        summary: `stub pass ${capturedCalls.length}`,
      };
    },
  });

  assert.equal(loopResult.status, 'completed');
  assert.equal(loopResult.completedIterations, 2);
  assert.deepEqual(selectedItems, ['P-651', 'P-652']);
  assert.equal(capturedCalls.length, 2);
  assert.equal(capturedCalls[0].runId, result.runId);
  assert.equal(capturedCalls[1].runId, result.runId);
  assert.equal(capturedCalls[0].adapter, 'mock');
  assert.equal(capturedCalls[1].adapter, 'mock');
});

test('loopRun appends one structured loop-report block per invocation', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-661',
        goal: 'single loop item',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'single loop pass',
    }),
    stderr: '',
  });

  assert.equal(fs.existsSync(result.runPaths.loopReportPath), false);

  const firstResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 3,
    env: process.env,
    processRunner,
  });
  const secondResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 2,
  });

  const loopReport = fs.readFileSync(result.runPaths.loopReportPath, 'utf8');

  assert.equal(firstResult.status, 'completed');
  assert.equal(secondResult.status, 'completed');
  assert.match(loopReport, /^# Loop Report\r?\n\r?\n\[/);
  assert.equal((loopReport.match(/Run ID:/g) || []).length, 2);
  assert.match(loopReport, /Configured max iterations: 3/);
  assert.match(loopReport, /Configured max iterations: 2/);
  assert.match(loopReport, /Runtime log: logs\/runtime\.log/);
});

test('loopRun preserves legacy run compatibility and creates loop-report lazily', (t) => {
  const legacyProgressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-671',
        goal: 'legacy loop item missing fields',
        includeResult: false,
        includeFallbackReason: false,
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent: legacyProgressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'legacy loop pass',
    }),
    stderr: '',
  });

  assert.equal(fs.existsSync(result.runPaths.loopReportPath), false);

  const loopResult = loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    maxIterations: 2,
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const loopReport = fs.readFileSync(result.runPaths.loopReportPath, 'utf8');

  assert.equal(loopResult.status, 'completed');
  assert.match(
    updatedProgress,
    /- \[x\] `P-671` Goal: legacy loop item missing fields[\s\S]*?Status: `pass`\r?\n  - Retry budget: `1`\r?\n  - Result: `pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in logs\/runtime\.log`\r?\n  - Fallback reason: ``/,
  );
  assert.match(loopReport, /Completed iterations: 1/);
});

test('loopRun does not mutate unrelated runs', (t) => {
  const repoRoot = createTempRepo(t);
  const featurePath = writeFeature(
    repoRoot,
    'Features/homepage.feature',
    [
      '@smoke',
      'Feature: Playwright home page',
      '',
      '  Scenario: Open the docs',
      '    Given the browser session is open',
    ].join('\n'),
  );
  const firstRun = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:34:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: featurePath,
    },
  });
  const secondRun = createRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    now: new Date('2026-04-09T12:35:56.000Z'),
    request: {
      intent: 'plan',
      sourceType: 'feature',
      sourceRef: featurePath,
    },
  });

  writeTextFile(
    firstRun.runPaths.progressPath,
    createProgressDocument({
      activeBlocks: [
        createProgressBlock({
          id: 'P-681',
          goal: 'mutate only this run',
        }),
      ],
    }),
  );
  writeTextFile(
    secondRun.runPaths.progressPath,
    createProgressDocument({
      activeBlocks: [
        createProgressBlock({
          id: 'P-682',
          goal: 'leave this other run untouched',
          result: 'preserve this sibling run',
        }),
      ],
    }),
  );

  const originalSecondProgress = fs.readFileSync(secondRun.runPaths.progressPath, 'utf8');
  const originalSecondRuntimeLog = fs.readFileSync(secondRun.runPaths.runtimeLogPath, 'utf8');
  const originalSecondFallbackLog = fs.readFileSync(secondRun.runPaths.fallbackLogPath, 'utf8');
  const originalSecondHealReport = fs.readFileSync(secondRun.runPaths.healReportPath, 'utf8');

  loopRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: firstRun.runId,
    adapter: 'mock',
    maxIterations: 2,
    env: process.env,
    processRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'isolated loop pass',
      }),
      stderr: '',
    }),
  });

  assert.equal(fs.readFileSync(secondRun.runPaths.progressPath, 'utf8'), originalSecondProgress);
  assert.equal(fs.readFileSync(secondRun.runPaths.runtimeLogPath, 'utf8'), originalSecondRuntimeLog);
  assert.equal(fs.readFileSync(secondRun.runPaths.fallbackLogPath, 'utf8'), originalSecondFallbackLog);
  assert.equal(fs.readFileSync(secondRun.runPaths.healReportPath, 'utf8'), originalSecondHealReport);
  assert.equal(fs.existsSync(secondRun.runPaths.loopReportPath), false);
});

test('parseProgressItems skips the template section and findNextActionableProgressItem preserves file order', () => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-001',
        goal: 'already done',
        checked: true,
        status: 'pass',
      }),
      createProgressBlock({
        id: 'P-002',
        goal: 'terminal block',
        status: 'blocked',
      }),
      createProgressBlock({
        id: 'P-003',
        goal: 'retry this failed item first',
        status: 'fail',
        includeResult: false,
      }),
      createProgressBlock({
        id: 'P-004',
        goal: 'later todo item',
        status: 'todo',
      }),
    ],
  });

  const items = parseProgressItems(progressContent);
  const nextItem = findNextActionableProgressItem(progressContent);

  assert.deepEqual(items.map((item) => item.id), ['P-001', 'P-002', 'P-003', 'P-004']);
  assert.equal(items.some((item) => item.id === 'P-TEMPLATE'), false);
  assert.equal(items.find((item) => item.id === 'P-003').result, '');
  assert.equal(nextItem.id, 'P-003');
});

test('iterateRun passes explicit artifact args to the external adapter and invokes a fresh child per call', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-101',
        goal: 'first selected item',
        verify: '`verify first`',
      }),
      createProgressBlock({
        id: 'P-102',
        goal: 'second selected item',
        verify: '`verify second`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const calls = [];
  const processRunner = (command, args, cwd, spawnOptions) => {
    calls.push({ command, args, cwd, spawnOptions });
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: `adapter pass ${calls.length}`,
      }),
      stderr: '',
    };
  };
  const env = {
    ...process.env,
    QA_HARNESS_EXTERNAL_RUNTIME_CMD: 'external-runtime',
    QA_HARNESS_EXTERNAL_RUNTIME_ARGS: '["--mode","fresh"]',
  };

  const firstIteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env,
    processRunner,
  });
  const secondIteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env,
    processRunner,
  });

  assert.equal(firstIteration.selectedItemId, 'P-101');
  assert.equal(secondIteration.selectedItemId, 'P-102');
  assert.equal(calls.length, 2);

  for (const call of calls) {
    assert.equal(call.command, 'external-runtime');
    assert.equal(call.cwd, repoRoot);
    assert.deepEqual(call.args.slice(0, 2), ['--mode', 'fresh']);
    assert.equal(call.spawnOptions.env.QA_HARNESS_EXTERNAL_RUNTIME_CMD, 'external-runtime');
    assert.equal(valueAfterFlag(call.args, '--run-id'), result.runId);
    assert.equal(valueAfterFlag(call.args, '--run-dir'), result.runPaths.runDir);
    assert.equal(valueAfterFlag(call.args, '--prompt-path'), result.runPaths.promptPath);
    assert.equal(valueAfterFlag(call.args, '--prd-path'), result.runPaths.prdPath);
    assert.equal(valueAfterFlag(call.args, '--progress-path'), result.runPaths.progressPath);
    assert.equal(valueAfterFlag(call.args, '--normalized-feature-path'), result.runPaths.normalizedFeaturePath);
  }

  assert.equal(valueAfterFlag(calls[0].args, '--item-id'), 'P-101');
  assert.equal(valueAfterFlag(calls[0].args, '--item-goal'), 'first selected item');
  assert.equal(valueAfterFlag(calls[0].args, '--item-verify'), '`verify first`');
  assert.equal(valueAfterFlag(calls[1].args, '--item-id'), 'P-102');
  assert.equal(valueAfterFlag(calls[1].args, '--item-goal'), 'second selected item');
  assert.equal(valueAfterFlag(calls[1].args, '--item-verify'), '`verify second`');
});

test('iterateRun defaults the external adapter to the shipped worker when no command override is configured', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-111',
        goal: 'default worker invocation',
        owner: 'qa-executor',
        verify: '`npm run qa:orchestrator -- execute-run --run-id 20260409T123456Z-plan-homepage --project chromium`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let capturedCall = null;
  const processRunner = (command, args, cwd, spawnOptions) => {
    capturedCall = { command, args, cwd, spawnOptions };
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'default external worker pass',
        runtimeLayer: 'playwright-cli',
        evidence: ['normalized.feature'],
      }),
      stderr: '',
    };
  };

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env: { ...process.env },
    processRunner,
  });

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(capturedCall.command, process.execPath);
  assert.match(capturedCall.args[0], /qa-runtime-external-worker\.js$/);
  assert.equal(capturedCall.cwd, repoRoot);
  assert.equal(capturedCall.spawnOptions.env.QA_HARNESS_ACTIVE_BROWSER_RUNTIME, 'playwright-cli');
  assert.equal(valueAfterFlag(capturedCall.args, '--run-id'), result.runId);
  assert.equal(valueAfterFlag(capturedCall.args, '--run-dir'), result.runPaths.runDir);
  assert.equal(valueAfterFlag(capturedCall.args, '--prompt-path'), result.runPaths.promptPath);
  assert.equal(valueAfterFlag(capturedCall.args, '--prd-path'), result.runPaths.prdPath);
  assert.equal(valueAfterFlag(capturedCall.args, '--progress-path'), result.runPaths.progressPath);
  assert.equal(valueAfterFlag(capturedCall.args, '--normalized-feature-path'), result.runPaths.normalizedFeaturePath);
  assert.match(runtimeLog, /Worker role: executor/);
  assert.match(runtimeLog, /Worker attempt: 20260409T123456Z-plan-homepage\/P-111/);
});

test('iterateRun invokes the Playwright test/debug bridge after the primary runtime requests it', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-151',
        goal: 'bridge this item',
        fallbackReason: 'old fallback should be cleared',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const calls = [];
  const env = {
    ...process.env,
    QA_HARNESS_EXTERNAL_RUNTIME_CMD: 'external-runtime',
    QA_HARNESS_EXTERNAL_RUNTIME_ARGS: '["--mode","fresh"]',
    QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD: 'playwright-bridge',
    QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS: '["--debug","--fresh"]',
  };
  const processRunner = (command, args, cwd, spawnOptions) => {
    calls.push({ command, args, cwd, spawnOptions });

    if (command === 'external-runtime') {
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'blocked',
          summary: 'cli needs richer Playwright diagnostics',
          runtimeLayer: 'playwright-cli',
          requestPlaywrightBridge: true,
          bridgeReason: 'Playwright CLI could not diagnose the failing assertion cleanly.',
        }),
        stderr: '',
      };
    }

    if (command === 'playwright-bridge') {
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'pass',
          summary: 'bridge recovered the failing interaction',
          runtimeLayer: 'playwright-test',
          evidence: ['trace.zip'],
        }),
        stderr: '',
      };
    }

    throw new Error(`Unexpected command ${command}`);
  };

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    project: 'firefox',
    headed: true,
    debug: true,
    baseUrl: 'https://staging.example.test',
    targetEnv: 'staging',
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const fallbackLog = fs.readFileSync(result.runPaths.fallbackLogPath, 'utf8');
  const prdContent = fs.readFileSync(result.runPaths.prdPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.runtimeLayer, 'playwright-test');
  assert.equal(iteration.bridgeUsed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'external-runtime');
  assert.deepEqual(calls[0].args.slice(0, 2), ['--mode', 'fresh']);
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_ACTIVE_BROWSER_RUNTIME, 'playwright-cli');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_BROWSER_ACTION_ORDER, 'playwright-cli,playwright-test,mcp');
  assert.equal(calls[1].command, 'playwright-bridge');
  assert.deepEqual(calls[1].args.slice(0, 2), ['--debug', '--fresh']);
  assert.equal(calls[1].spawnOptions.env.QA_HARNESS_ACTIVE_BROWSER_RUNTIME, 'playwright-test');
  assert.equal(calls[1].spawnOptions.env.QA_HARNESS_PREVIOUS_BROWSER_RUNTIME, 'playwright-cli');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_EXECUTION_PROJECT, 'firefox');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_EXECUTION_HEADED, 'true');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_EXECUTION_DEBUG, 'true');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_EXECUTION_TRACE, 'on');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_EXECUTION_VIDEO, 'retain-on-failure');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_EXECUTION_SCREENSHOT, 'only-on-failure');
  assert.equal(calls[0].spawnOptions.env.PLAYWRIGHT_BASE_URL, 'https://staging.example.test');
  assert.equal(calls[0].spawnOptions.env.QA_HARNESS_TARGET_ENV, 'staging');
  assert.equal(calls[0].spawnOptions.env.PWDEBUG, '1');
  assert.equal(calls[1].spawnOptions.env.QA_HARNESS_EXECUTION_PROJECT, 'firefox');
  assert.equal(calls[1].spawnOptions.env.PLAYWRIGHT_BASE_URL, 'https://staging.example.test');
  assert.equal(
    calls[1].spawnOptions.env.QA_HARNESS_BRIDGE_REASON,
    'Playwright CLI could not diagnose the failing assertion cleanly.',
  );
  assert.match(runtimeLog, /Runtime order: playwright-cli -> playwright-test -> mcp/);
  assert.match(runtimeLog, /Playwright bridge: invoked/);
  assert.match(runtimeLog, /Project: firefox/);
  assert.match(runtimeLog, /Headed execution: enabled/);
  assert.match(runtimeLog, /Debug execution: enabled/);
  assert.match(runtimeLog, /Bridge command: playwright-bridge --debug --fresh/);
  assert.match(runtimeLog, /Bridge runtime layer: playwright-test/);
  assert.match(updatedProgress, /Status: `pass`/);
  assert.match(updatedProgress, /Fallback reason: ``/);
  assert.equal(fallbackLog, '');
  assert.equal(countOccurrences(prdContent, /^## Execution Controls$/gm), 1);
  assert.match(prdContent, /Browser project: `firefox`/);
});

test('iterateRun records MCP fallback reasons in progress.md and logs/fallback.log', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-161',
        goal: 'record fallback',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const env = {
    ...process.env,
    QA_HARNESS_EXTERNAL_RUNTIME_CMD: 'external-runtime',
    QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD: 'playwright-bridge',
  };
  const processRunner = (command) => {
    if (command === 'external-runtime') {
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'blocked',
          summary: 'cli requires bridge follow-up',
          runtimeLayer: 'playwright-cli',
          requestPlaywrightBridge: true,
          bridgeReason: 'CLI could not inspect the page state that caused the failure.',
        }),
        stderr: '',
      };
    }

    if (command === 'playwright-bridge') {
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'pass',
          summary: 'mcp captured the needed page state',
          runtimeLayer: 'mcp',
          fallbackReason: 'CLI could not inspect the cross-origin iframe and Playwright test/debug could not re-express it.',
        }),
        stderr: '',
      };
    }

    throw new Error(`Unexpected command ${command}`);
  };

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const fallbackLog = fs.readFileSync(result.runPaths.fallbackLogPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.runtimeLayer, 'mcp');
  assert.match(updatedProgress, /Fallback reason: `CLI could not inspect the cross-origin iframe and Playwright test\/debug could not re-express it\.`/);
  assert.match(runtimeLog, /Runtime layer: mcp/);
  assert.match(runtimeLog, /Fallback reason: CLI could not inspect the cross-origin iframe and Playwright test\/debug could not re-express it\./);
  assert.match(fallbackLog, /status=mcp/);
  assert.match(fallbackLog, /Selected item: P-161 - record fallback/);
  assert.match(fallbackLog, /Runtime log: logs\/runtime\.log/);
  assert.match(fallbackLog, /Fallback log: logs\/fallback\.log/);
  assert.match(fallbackLog, /Fallback reason: CLI could not inspect the cross-origin iframe and Playwright test\/debug could not re-express it\./);
});

test('executeExternalWorker honors recorded execution controls for Playwright execution proof', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-181',
        goal: 'execute the generated homepage scenario with recorded controls',
        owner: 'qa-executor',
        verify: '`npm run qa:orchestrator -- execute-run --run-id 20260409T123456Z-plan-homepage --project chromium`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeGeneratedSpec(repoRoot, result.runId);
  const { runner } = createMockCommandRunner();

  verifyRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    project: 'firefox',
    headed: true,
    debug: true,
    baseUrl: 'https://staging.example.test',
    targetEnv: 'staging',
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    env: { ...process.env },
    commandRunner: runner,
  });

  const toolCalls = [];
  const workerResult = executeExternalWorker({
    'run-id': result.runId,
    'run-dir': result.runPaths.runDir,
    'prompt-path': result.runPaths.promptPath,
    'prd-path': result.runPaths.prdPath,
    'progress-path': result.runPaths.progressPath,
    'normalized-feature-path': result.runPaths.normalizedFeaturePath,
    'item-id': 'P-181',
    'item-goal': 'execute the generated homepage scenario with recorded controls',
    'item-verify': '`npm run qa:orchestrator -- execute-run --run-id 20260409T123456Z-plan-homepage --project chromium`',
  }, {
    runTool: (command, args, cwd, workerEnv) => {
      toolCalls.push({ command, args, cwd, workerEnv });
      const commandDisplay = formatToolInvocationDisplay(command, args);

      if (args[0] === 'bddgen' && args[1] === 'export') {
        return { status: 0, stdout: 'List of all steps (9)\n', stderr: '', commandDisplay };
      }

      if (args[0] === 'bddgen' && args[1] === 'test') {
        writeGeneratedSpec(repoRoot, result.runId);
        return { status: 0, stdout: 'generated\n', stderr: '', commandDisplay };
      }

      if (args[0] === 'playwright' && args[1] === 'test' && args.includes('--list')) {
        return { status: 0, stdout: 'Total: 1 test\n', stderr: '', commandDisplay };
      }

      if (args[0] === 'playwright' && args[1] === 'test') {
        return { status: 0, stdout: '1 passed (0.1s)\n', stderr: '', commandDisplay };
      }

      throw new Error(`Unexpected worker tool invocation: ${commandDisplay}`);
    },
  });

  const executionCall = toolCalls.find(({ args }) => args[0] === 'playwright' && args[1] === 'test' && !args.includes('--list'));

  assert.equal(workerResult.status, 'pass');
  assert.match(workerResult.summary, /recorded runtime proof on firefox/);
  assert.ok(executionCall);
  assert.ok(executionCall.args.includes('--project=firefox'));
  assert.ok(executionCall.args.includes('--headed'));
  assert.ok(executionCall.args.includes('--debug'));
  assert.ok(executionCall.args.includes('--trace=on'));
  assert.ok(executionCall.args.includes('--video=retain-on-failure'));
  assert.ok(executionCall.args.includes('--screenshot=only-on-failure'));
  assert.equal(executionCall.workerEnv.PLAYWRIGHT_BASE_URL, 'https://staging.example.test');
  assert.equal(executionCall.workerEnv.QA_HARNESS_TARGET_ENV, 'staging');
  assert.equal(executionCall.workerEnv.PWDEBUG, '1');
});

test('iterateRun runs the shipped external worker for one bounded explorer iteration and records gap analysis', (t) => {
  const featureContent = [
    '@smoke',
    'Feature: Playwright home page',
    '',
    '  Scenario: Open the docs',
    '    Given the browser session is open',
    '    Given I open "/"',
    '    When I click "getByRole(\'link\', { name: \'Get started\' })"',
    '    Then the title should contain "Installation"',
    '    And the url should contain "/docs/intro"',
    '    And I should see "getByRole(\'heading\', { name: \'Installation\' })"',
    '',
  ].join('\n');
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-181X',
        goal: 'inspect bounded direct-open coverage',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent, featureContent });
  installStubProjectCli(repoRoot);

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env: { ...process.env },
    processRunner: createExternalWorkerProcessRunner(result.runId),
  });

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');
  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.explorerItem, true);
  assert.match(runtimeLog, /qa-runtime-external-worker\.js/);
  assert.match(runtimeLog, /Worker role: explorer/);
  assert.match(runtimeLog, /Worker attempt: 20260409T123456Z-plan-homepage\/P-181X/);
  assert.match(gapAnalysis, /status=pass/);
  assert.match(gapAnalysis, /Worker role: explorer/);
  assert.match(gapAnalysis, /Observed gap: the Installation page direct-open coverage is missing from normalized\.feature/);
  assert.match(gapAnalysis, /Candidate scenario: open the Installation page directly/);
  assert.match(gapAnalysis, /Candidate 1 scenario: open the Installation page directly/);
  assert.match(gapAnalysis, /Candidate 1 addition target: normalized\.feature/);
  assert.match(
    gapAnalysis,
    /Candidate 1 evidence: normalized\.feature, \.features-gen\/\.qa-harness\/runs\/20260409T123456Z-plan-homepage\/normalized\.feature\.spec\.js/,
  );
  assert.match(updatedProgress, /Status: `pass`/);
  assert.match(updatedProgress, /Result: `pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter external; evidence in outputs\/gap-analysis\.md`/);
});

test('iterateRun runs the shipped external worker for one bounded executor iteration and records runtime proof', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-191',
        goal: 'execute the generated homepage scenario',
        owner: 'qa-executor',
        output: 'runtime proof recorded in `logs/runtime.log`',
        verify: '`npm run qa:orchestrator -- execute-run --run-id 20260409T123456Z-plan-homepage --project chromium`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  installStubProjectCli(repoRoot);

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env: { ...process.env },
    processRunner: createExternalWorkerProcessRunner(result.runId, {
      playwrightExecStdout: '1 passed (0.1s)\n',
    }),
  });

  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');
  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.explorerItem, false);
  assert.match(runtimeLog, /status=pass/);
  assert.match(runtimeLog, /qa-runtime-external-worker\.js/);
  assert.match(runtimeLog, /Worker role: executor/);
  assert.match(runtimeLog, /Summary: recorded runtime proof on chromium/);
  assert.match(
    runtimeLog,
    /Evidence: normalized\.feature, \.features-gen\/\.qa-harness\/runs\/20260409T123456Z-plan-homepage\/normalized\.feature\.spec\.js/,
  );
  assert.doesNotMatch(runtimeLog, /demo runtime completed bounded item/);
  assert.match(updatedProgress, /Status: `pass`/);
  assert.match(updatedProgress, /Result: `pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter external; evidence in logs\/runtime\.log`/);
});

test('iterateRun keeps planner-handoff scenario-addition semantics intact with the shipped external worker', (t) => {
  const featureContent = [
    '@smoke',
    'Feature: Playwright home page',
    '',
    '  Scenario: Open the docs',
    '    Given the browser session is open',
    '    Given I open "/"',
    '    When I click "getByRole(\'link\', { name: \'Get started\' })"',
    '    Then the title should contain "Installation"',
    '    And the url should contain "/docs/intro"',
    '    And I should see "getByRole(\'heading\', { name: \'Installation\' })"',
    '',
  ].join('\n');
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-181',
        goal: 'open the Installation page directly for homepage',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `homepage`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent, featureContent });
  installStubProjectCli(repoRoot);
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-181',
    scope: 'homepage',
    candidateGap: 'the Installation page direct-open coverage is missing from normalized.feature',
    candidateScenario: 'open the Installation page directly',
    summary: 'accepted gap candidate 1 for homepage: P-GAP-181 from open the Installation page directly',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'external',
    env: { ...process.env },
    processRunner: createExternalWorkerProcessRunner(result.runId, {
      playwrightExecStdout: '2 passed (0.2s)\n',
    }),
  });

  const normalizedFeature = fs.readFileSync(result.runPaths.normalizedFeaturePath, 'utf8');
  const scenarioAddition = fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.scenarioAdditionItem, true);
  assert.match(normalizedFeature, /Scenario: Open the Installation page directly/);
  assert.match(normalizedFeature, /Given I open "\/docs\/intro"/);
  assert.match(normalizedFeature, /Then the title should contain "Installation"/);
  assert.match(scenarioAddition, /status=pass/);
  assert.match(scenarioAddition, /Worker role: scenario-addition/);
  assert.match(scenarioAddition, /Added scenario or outline: Scenario: Open the Installation page directly/);
  assert.match(scenarioAddition, /Target artifact: normalized\.feature/);
  assert.match(
    scenarioAddition,
    /Supporting evidence: normalized\.feature, \.features-gen\/\.qa-harness\/runs\/20260409T123456Z-plan-homepage\/normalized\.feature\.spec\.js/,
  );
});

test('iterateRun replaces an existing fallback reason with the latest MCP fallback reason', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-171',
        goal: 'replace stale fallback',
        fallbackReason: 'stale fallback reason',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'blocked',
      summary: 'direct mcp fallback',
      runtimeLayer: 'mcp',
      fallbackReason: 'Playwright CLI and Playwright test/debug both lacked the required browser primitive.',
    }),
    stderr: '',
  });

  iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  assert.doesNotMatch(updatedProgress, /stale fallback reason/);
  assert.match(
    updatedProgress,
    /Fallback reason: `Playwright CLI and Playwright test\/debug both lacked the required browser primitive\.`/,
  );
});

test('iterateRun with the mock adapter marks the selected item pass and leaves later items untouched', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-201',
        goal: 'pass this selected item',
      }),
      createProgressBlock({
        id: 'P-202',
        goal: 'leave this for later',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let capturedCall = null;
  const processRunner = (command, args, cwd, spawnOptions) => {
    capturedCall = { command, args, cwd, spawnOptions };
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'mock pass summary',
      }),
      stderr: '',
    };
  };

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'pass',
      QA_HARNESS_MOCK_SUMMARY: 'mock pass summary',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(capturedCall.command, process.execPath);
  assert.match(capturedCall.args[0], /qa-runtime-mock-adapter\.js$/);
  assert.equal(capturedCall.cwd, repoRoot);
  assert.equal(capturedCall.spawnOptions.env.QA_HARNESS_MOCK_STATUS, 'pass');
  assert.equal(capturedCall.spawnOptions.env.QA_HARNESS_MOCK_SUMMARY, 'mock pass summary');
  assert.match(
    updatedProgress,
    /- \[x\] `P-201` Goal: pass this selected item[\s\S]*?Status: `pass`[\s\S]*?Result: `pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in logs\/runtime\.log`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-202` Goal: leave this for later[\s\S]*?Status: `todo`/,
  );
  assert.match(runtimeLog, /Adapter: mock/);
  assert.match(runtimeLog, /Selected item: P-201 - pass this selected item/);
  assert.match(runtimeLog, /Summary: mock pass summary/);
});

test('iterateRun keeps no-fallback cases clean and clears stale fallback state', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-211',
        goal: 'clear fallback state',
        fallbackReason: 'stale fallback reason',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'clean pass without fallback',
      runtimeLayer: 'playwright-cli',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const fallbackLog = fs.readFileSync(result.runPaths.fallbackLogPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.equal(iteration.runtimeLayer, 'playwright-cli');
  assert.doesNotMatch(updatedProgress, /stale fallback reason/);
  assert.match(updatedProgress, /Fallback reason: ``/);
  assert.equal(fallbackLog, '');
});

test('iterateRun records richer gap-analysis metadata for explorer-owned pass iterations', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-212X',
        goal: 'inspect docs navigation coverage',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
      }),
      createProgressBlock({
        id: 'P-213X',
        goal: 'leave this untouched',
        owner: 'qa-executor',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'identified one bounded coverage gap',
      runtimeLayer: 'playwright-cli',
      coverageScope: 'docs navigation',
      observedGap: 'collapsed menu state is only partially covered',
      candidateScenario: 'cover collapsed menu open and close',
      additionTarget: 'Features/homepage.feature :: Docs navigation',
      evidence: ['logs/runtime.log'],
      gapCandidates: [
        {
          gap: 'missing collapsed menu coverage',
          candidateScenario: 'cover collapsed menu open and close',
          additionTarget: 'Features/homepage.feature :: Docs navigation',
          evidence: ['evidence/screenshots/menu-collapsed.png'],
        },
      ],
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');

  assert.equal(iteration.explorerItem, true);
  assert.equal(iteration.selectedItemId, 'P-212X');
  assert.equal(iteration.status, 'pass');
  assert.match(
    updatedProgress,
    /- \[x\] `P-212X` Goal: inspect docs navigation coverage[\s\S]*?Status: `pass`[\s\S]*?Result: `pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in outputs\/gap-analysis\.md`/,
  );
  assert.match(gapAnalysis, /status=pass/);
  assert.match(gapAnalysis, /Observed gap: collapsed menu state is only partially covered/);
  assert.match(gapAnalysis, /Candidate scenario: cover collapsed menu open and close/);
  assert.match(gapAnalysis, /Candidate addition target: Features\/homepage\.feature :: Docs navigation/);
  assert.match(gapAnalysis, /Runtime evidence: logs\/runtime\.log/);
  assert.match(gapAnalysis, /Supporting evidence: logs\/runtime\.log, evidence\/screenshots\/menu-collapsed\.png/);
  assert.match(gapAnalysis, /Candidate 1 gap: missing collapsed menu coverage/);
  assert.match(gapAnalysis, /Candidate 1 scenario: cover collapsed menu open and close/);
  assert.match(gapAnalysis, /Candidate 1 addition target: Features\/homepage\.feature :: Docs navigation/);
  assert.match(gapAnalysis, /Candidate 1 evidence: evidence\/screenshots\/menu-collapsed\.png/);
  assert.match(
    updatedProgress,
    /- \[ \] `P-213X` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Result: `existing result`/,
  );
});

test('iterateRun records richer gap-analysis metadata for explorer-owned fail iterations', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-214X',
        goal: 'inspect docs drawer coverage gaps',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'scope drift prevented bounded coverage comparison',
      runtimeLayer: 'mcp',
      fallbackReason: 'Playwright CLI could not stabilize the docs drawer',
      coverageScope: 'docs drawer',
      observedGap: 'drawer close state could not be observed cleanly',
      additionTarget: 'Features/homepage.feature :: Docs drawer regression coverage',
      evidence: ['logs/runtime.log'],
      stopReason: 'bounded exploration stopped after unstable drawer state',
      gapCandidates: [
        {
          gap: 'menu close state remains unverified',
          candidateScenario: 'cover closing the drawer after choosing docs',
          additionTarget: 'Features/homepage.feature :: Docs drawer regression coverage',
          evidence: ['traces/docs-drawer.zip'],
        },
      ],
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');

  assert.equal(iteration.explorerItem, true);
  assert.equal(iteration.status, 'fail');
  assert.match(updatedProgress, /Status: `fail`/);
  assert.match(updatedProgress, /Fallback reason: `Playwright CLI could not stabilize the docs drawer`/);
  assert.match(gapAnalysis, /status=fail/);
  assert.match(gapAnalysis, /Observed gap: drawer close state could not be observed cleanly/);
  assert.match(gapAnalysis, /Candidate addition target: Features\/homepage\.feature :: Docs drawer regression coverage/);
  assert.match(gapAnalysis, /Supporting evidence: logs\/runtime\.log, traces\/docs-drawer\.zip/);
  assert.match(gapAnalysis, /Fallback reason: Playwright CLI could not stabilize the docs drawer/);
  assert.match(gapAnalysis, /Stop reason: bounded exploration stopped after unstable drawer state/);
  assert.match(gapAnalysis, /Candidate 1 scenario: cover closing the drawer after choosing docs/);
  assert.match(gapAnalysis, /Candidate 1 addition target: Features\/homepage\.feature :: Docs drawer regression coverage/);
  assert.match(gapAnalysis, /Candidate 1 evidence: traces\/docs-drawer\.zip/);
});

test('iterateRun records richer gap-analysis metadata for explorer-owned blocked iterations', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-215X',
        goal: 'inspect docs footer coverage gaps',
        owner: 'qa-explorer',
        output: 'gap candidates recorded in `outputs/gap-analysis.md`',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'blocked',
      summary: 'manual review required before another bounded discovery',
      runtimeLayer: 'playwright-test',
      coverageScope: 'docs footer',
      observedGap: 'footer CTA state remains unproven under offline mode',
      additionTarget: 'Features/homepage.feature :: Offline footer return path',
      evidence: ['evidence/screenshots/footer-offline.png'],
      escalationReason: 'manual product clarification required before planner handoff',
      stopReason: 'bounded discovery stopped after footer navigation diverged',
      gapCandidates: [
        {
          gap: 'offline footer return path remains uncovered',
          additionTarget: 'Features/homepage.feature :: Offline footer return path',
          evidence: ['evidence/screenshots/footer-offline.png'],
        },
      ],
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const gapAnalysis = fs.readFileSync(result.runPaths.gapAnalysisPath, 'utf8');

  assert.equal(iteration.explorerItem, true);
  assert.equal(iteration.status, 'blocked');
  assert.match(updatedProgress, /Status: `blocked`/);
  assert.match(updatedProgress, /Result: `blocked: manual review required before another bounded discovery`/);
  assert.match(gapAnalysis, /status=blocked/);
  assert.match(gapAnalysis, /Observed gap: footer CTA state remains unproven under offline mode/);
  assert.match(gapAnalysis, /Candidate addition target: Features\/homepage\.feature :: Offline footer return path/);
  assert.match(gapAnalysis, /Supporting evidence: evidence\/screenshots\/footer-offline\.png/);
  assert.match(gapAnalysis, /Escalation reason: manual product clarification required before planner handoff/);
  assert.match(gapAnalysis, /Stop reason: bounded discovery stopped after footer navigation diverged/);
  assert.match(gapAnalysis, /Candidate 1 gap: offline footer return path remains uncovered/);
  assert.match(gapAnalysis, /Candidate 1 addition target: Features\/homepage\.feature :: Offline footer return path/);
});

test('iterateRun records structured scenario-addition metadata for accepted planner-handoff pass iterations', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-001',
        goal: 'cover collapsed menu open and close for docs navigation',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs navigation`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths);
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'appended one bounded scenario to normalized.feature',
      runtimeLayer: 'playwright-cli',
      addedScenarioOrOutline: 'Scenario: Cover collapsed menu open and close',
      targetArtifactPath: result.runPaths.normalizedFeaturePath,
      evidence: ['normalized.feature', 'logs/runtime.log'],
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const scenarioAddition = fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8');

  assert.equal(iteration.scenarioAdditionItem, true);
  assert.equal(iteration.selectedItemId, 'P-GAP-001');
  assert.equal(iteration.status, 'pass');
  assert.match(
    updatedProgress,
    /- \[x\] `P-GAP-001` Goal: cover collapsed menu open and close for docs navigation[\s\S]*?Status: `pass`[\s\S]*?Result: `pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in outputs\/scenario-addition\.md`/,
  );
  assert.match(scenarioAddition, /status=pass/);
  assert.match(scenarioAddition, /Planner handoff: outputs\/planner-handoff\.md/);
  assert.match(
    scenarioAddition,
    /Accepted handoff summary: accepted gap candidate 1 for docs navigation: P-GAP-001 from cover collapsed menu open and close/,
  );
  assert.match(scenarioAddition, /Planner candidate scenario: cover collapsed menu open and close/);
  assert.match(scenarioAddition, /Added scenario or outline: Scenario: Cover collapsed menu open and close/);
  assert.match(scenarioAddition, /Target artifact: normalized\.feature/);
  assert.match(scenarioAddition, /Supporting evidence: normalized\.feature, logs\/runtime\.log/);
  assert.match(scenarioAddition, /Summary: appended one bounded scenario to normalized\.feature/);
});

test('iterateRun records structured scenario-addition metadata for accepted planner-handoff fail iterations', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-002',
        goal: 'cover closing the docs drawer after choosing docs',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs drawer`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-002',
    scope: 'docs drawer',
    candidateGap: 'drawer close path remains uncovered',
    candidateScenario: 'cover closing the docs drawer after choosing docs',
    summary: 'accepted gap candidate 1 for docs drawer: P-GAP-002 from cover closing the docs drawer after choosing docs',
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'step coverage failed after appending one outline',
      runtimeLayer: 'playwright-test',
      addedScenarioOrOutline: 'Scenario Outline: Close the docs drawer after choosing Docs',
      targetArtifactPath: result.runPaths.normalizedFeaturePath,
      evidence: ['normalized.feature'],
      stopReason: 'bounded addition stopped after unresolved step text',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const scenarioAddition = fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8');

  assert.equal(iteration.scenarioAdditionItem, true);
  assert.equal(iteration.status, 'fail');
  assert.match(updatedProgress, /Status: `fail`/);
  assert.match(scenarioAddition, /status=fail/);
  assert.match(
    scenarioAddition,
    /Added scenario or outline: Scenario Outline: Close the docs drawer after choosing Docs/,
  );
  assert.match(scenarioAddition, /Target artifact: normalized\.feature/);
  assert.match(scenarioAddition, /Supporting evidence: normalized\.feature/);
  assert.match(scenarioAddition, /Stop reason: bounded addition stopped after unresolved step text/);
  assert.match(scenarioAddition, /Summary: step coverage failed after appending one outline/);
});

test('iterateRun records structured scenario-addition metadata for accepted planner-handoff blocked iterations', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-GAP-003',
        goal: 'cover the offline footer return path for docs footer',
        input: 'accepted gap candidate 1 in `outputs/gap-analysis.md` for `docs footer`',
        output: 'verifier-backed proof recorded in `logs/verifier.log`',
        verify: '`npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage`',
        owner: 'qa-executor',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  writeAcceptedPlannerHandoffEntry(result.runPaths, {
    itemId: 'P-GAP-003',
    scope: 'docs footer',
    candidateGap: 'offline footer return path remains uncovered',
    candidateScenario: 'cover the offline footer return path',
    summary: 'accepted gap candidate 1 for docs footer: P-GAP-003 from cover the offline footer return path',
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'blocked',
      summary: 'manual review required before another bounded addition',
      runtimeLayer: 'mcp',
      fallbackReason: 'Playwright CLI could not confirm the mutated footer path',
      addedScenarioOrOutline: 'Scenario: Offline footer return path',
      targetArtifactPath: result.runPaths.normalizedFeaturePath,
      evidence: ['evidence/screenshots/footer-offline.png'],
      escalationReason: 'manual product clarification required before another addition',
      stopReason: 'bounded addition stopped after footer copy diverged',
      blockReason: 'approved handoff no longer matches current footer behavior',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const scenarioAddition = fs.readFileSync(result.runPaths.scenarioAdditionPath, 'utf8');
  const fallbackLog = fs.readFileSync(result.runPaths.fallbackLogPath, 'utf8');

  assert.equal(iteration.scenarioAdditionItem, true);
  assert.equal(iteration.status, 'blocked');
  assert.match(updatedProgress, /Status: `blocked`/);
  assert.match(updatedProgress, /Fallback reason: `Playwright CLI could not confirm the mutated footer path`/);
  assert.match(fallbackLog, /Fallback reason: Playwright CLI could not confirm the mutated footer path/);
  assert.match(scenarioAddition, /status=blocked/);
  assert.match(scenarioAddition, /Added scenario or outline: Scenario: Offline footer return path/);
  assert.match(scenarioAddition, /Target artifact: normalized\.feature/);
  assert.match(scenarioAddition, /Supporting evidence: evidence\/screenshots\/footer-offline\.png/);
  assert.match(scenarioAddition, /Fallback reason: Playwright CLI could not confirm the mutated footer path/);
  assert.match(scenarioAddition, /Escalation reason: manual product clarification required before another addition/);
  assert.match(scenarioAddition, /Stop reason: bounded addition stopped after footer copy diverged/);
  assert.match(scenarioAddition, /Block reason: approved handoff no longer matches current footer behavior/);
});

test('iterateRun decrements retry budget on healing failure', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-221',
        goal: 'heal the failing locator',
        owner: 'qa-healer',
        retryBudget: '2',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'locator drift on the checkout button',
      smallestFailingUnit: 'checkout button locator',
      rootCauseHypothesis: 'stale data-testid on the checkout button',
      escalationReason: 'manual selector review required if the next bounded attempt still fails',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.equal(iteration.status, 'fail');
  assert.match(
    updatedProgress,
    /- \[ \] `P-221` Goal: heal the failing locator[\s\S]*?Status: `fail`[\s\S]*?Retry budget: `1`[\s\S]*?Result: `fail: locator drift on the checkout button`/,
  );
  assert.match(healReport, /^# Heal Report\r?\n\r?\n\[/);
  assert.match(healReport, /status=fail/);
  assert.match(healReport, /Selected item: P-221 - heal the failing locator/);
  assert.match(healReport, /Retry budget: 2 -> 1/);
  assert.match(healReport, /Smallest failing unit: checkout button locator/);
  assert.match(healReport, /Root-cause hypothesis: stale data-testid on the checkout button/);
  assert.match(healReport, /Escalation reason: manual selector review required if the next bounded attempt still fails/);
});

test('iterateRun does not decrement retry budget when a healing item passes', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-231',
        goal: 'heal the failing assertion',
        owner: 'qa-healer',
        retryBudget: '2',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'targeted healing pass',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.equal(iteration.status, 'pass');
  assert.match(
    updatedProgress,
    /- \[x\] `P-231` Goal: heal the failing assertion[\s\S]*?Status: `pass`[\s\S]*?Retry budget: `2`/,
  );
  assert.match(healReport, /^# Heal Report\r?\n\r?\n\[/);
  assert.match(healReport, /status=pass/);
  assert.match(healReport, /Selected item: P-231 - heal the failing assertion/);
  assert.match(healReport, /Retry budget: 2 -> 2/);
  assert.match(healReport, /Recorded status: pass/);
  assert.match(healReport, /Summary: targeted healing pass/);
});

test('iterateRun does not decrement retry budget for non-healing items', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-241',
        goal: 'execute a standard runtime step',
        owner: 'qa-executor',
        retryBudget: '2',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'ordinary execution failure',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.equal(iteration.status, 'fail');
  assert.match(
    updatedProgress,
    /- \[ \] `P-241` Goal: execute a standard runtime step[\s\S]*?Status: `fail`[\s\S]*?Retry budget: `2`[\s\S]*?Result: `fail: ordinary execution failure`/,
  );
  assert.equal(healReport, '# Heal Report\n\nNot started.\n');
});

test('iterateRun marks a healing item blocked when the retry budget reaches zero', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-251',
        goal: 'heal the stale locator',
        owner: 'qa-healer',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'locator drift on the primary CTA',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');

  assert.equal(iteration.status, 'blocked');
  assert.match(
    updatedProgress,
    /- \[ \] `P-251` Goal: heal the stale locator[\s\S]*?Status: `blocked`[\s\S]*?Retry budget: `0`[\s\S]*?Result: `blocked: retry budget exhausted; hypothesis: locator drift on the primary CTA`/,
  );
  assert.match(runtimeLog, /status=fail/);
  assert.match(runtimeLog, /Recorded progress status: blocked/);
});

test('iterateRun appends a structured heal-report entry when healing exhausts the retry budget', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-261',
        goal: 'heal a failing scenario',
        owner: 'qa-healer',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'blocked',
      summary: 'requires manual confirmation after repeated locator drift',
      smallestFailingUnit: 'checkout CTA locator',
      rootCauseHypothesis: 'locator drift on the primary CTA',
      escalationReason: 'manual product copy review required before another bounded repair',
    }),
    stderr: '',
  });

  iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.match(healReport, /^# Heal Report\r?\n\r?\n\[/);
  assert.match(healReport, /status=blocked/);
  assert.match(healReport, /Selected item: P-261 - heal a failing scenario/);
  assert.match(healReport, /Retry budget: 1 -> 0/);
  assert.match(healReport, /Smallest failing unit: checkout CTA locator/);
  assert.match(healReport, /Root-cause hypothesis: locator drift on the primary CTA/);
  assert.match(healReport, /Escalation reason: manual product copy review required before another bounded repair/);
  assert.match(healReport, /Block reason: retry budget exhausted; hypothesis: locator drift on the primary CTA/);
  assert.match(healReport, /Runtime log: logs\/runtime\.log/);
});

test('iterateRun records block reason and root-cause hypothesis for blocked healing items', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-271',
        goal: 'heal a broken assertion',
        owner: 'qa-healer',
        retryBudget: '1',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'assertion still points at the old onboarding copy',
    }),
    stderr: '',
  });

  iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.match(
    updatedProgress,
    /Block reason: `retry budget exhausted; hypothesis: assertion still points at the old onboarding copy`/,
  );
  assert.match(
    healReport,
    /Block reason: retry budget exhausted; hypothesis: assertion still points at the old onboarding copy/,
  );
});

test('iterateRun preserves legacy healing items and adds bounded block metadata compatibly', (t) => {
  const legacyProgressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-281',
        goal: 'legacy heal item',
        owner: 'qa-healer',
        retryBudget: '1',
        includeResult: false,
        includeFallbackReason: false,
      }),
      createProgressBlock({
        id: 'P-282',
        goal: 'leave this untouched',
        owner: 'qa-executor',
        retryBudget: '2',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent: legacyProgressContent,
  });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'legacy healer still cannot resolve the stale locator',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.selectedItemId, 'P-281');
  assert.match(
    updatedProgress,
    /- \[ \] `P-281` Goal: legacy heal item[\s\S]*?Status: `blocked`\r?\n  - Retry budget: `0`\r?\n  - Result: `blocked: retry budget exhausted; hypothesis: legacy healer still cannot resolve the stale locator`\r?\n  - Fallback reason: ``\r?\n  - Block reason: `retry budget exhausted; hypothesis: legacy healer still cannot resolve the stale locator`/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-282` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Retry budget: `2`[\s\S]*?Result: `existing result`/,
  );
});

test('iterateRun limits healing mutations to the selected item and expected run artifacts', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-291',
        goal: 'heal one item only',
        owner: 'qa-healer',
        retryBudget: '2',
      }),
      createProgressBlock({
        id: 'P-292',
        goal: 'do not mutate this sibling item',
        owner: 'qa-healer',
        retryBudget: '2',
        result: 'preserve me',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, {
    intent: 'heal',
    progressContent,
  });
  const originalPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const originalPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');
  const originalFeature = fs.readFileSync(result.runPaths.normalizedFeaturePath, 'utf8');
  const originalSecondBlock = parseProgressItems(progressContent).find((item) => item.id === 'P-292').block;
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'fail',
      summary: 'one bounded healing failure',
    }),
    stderr: '',
  });

  iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: process.env,
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const updatedPrd = fs.readFileSync(result.runPaths.prdPath, 'utf8');
  const updatedPrompt = fs.readFileSync(result.runPaths.promptPath, 'utf8');
  const updatedFeature = fs.readFileSync(result.runPaths.normalizedFeaturePath, 'utf8');
  const healReport = fs.readFileSync(result.runPaths.healReportPath, 'utf8');

  assert.match(
    updatedProgress,
    /- \[ \] `P-291` Goal: heal one item only[\s\S]*?Retry budget: `1`[\s\S]*?Result: `fail: one bounded healing failure`/,
  );
  assert.match(updatedProgress, new RegExp(originalSecondBlock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(updatedPrd, originalPrd);
  assert.equal(updatedPrompt, originalPrompt);
  assert.equal(updatedFeature, originalFeature);
  assert.match(healReport, /Selected item: P-291 - heal one item only/);
  assert.doesNotMatch(healReport, /P-292 - do not mutate this sibling item/);
});

test('iterateRun marks the selected item fail when the runtime adapter reports failure', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-301',
        goal: 'fail this item',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let capturedCall = null;
  const processRunner = (command, args, cwd, spawnOptions) => {
    capturedCall = { command, args, cwd, spawnOptions };
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'fail',
        summary: 'mock fail summary',
      }),
      stderr: '',
    };
  };

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'fail',
      QA_HARNESS_MOCK_SUMMARY: 'mock fail summary',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');

  assert.equal(iteration.status, 'fail');
  assert.equal(capturedCall.command, process.execPath);
  assert.match(capturedCall.args[0], /qa-runtime-mock-adapter\.js$/);
  assert.equal(capturedCall.spawnOptions.env.QA_HARNESS_MOCK_STATUS, 'fail');
  assert.match(
    updatedProgress,
    /- \[ \] `P-301` Goal: fail this item[\s\S]*?Status: `fail`[\s\S]*?Result: `fail: mock fail summary`/,
  );
  assert.match(runtimeLog, /status=fail/);
  assert.match(runtimeLog, /Parsed status: fail/);
  assert.match(runtimeLog, /Summary: mock fail summary/);
});

test('iterateRun marks the selected item blocked when the runtime adapter reports blocked', (t) => {
  const progressContent = createProgressDocument({
    activeBlocks: [
      createProgressBlock({
        id: 'P-401',
        goal: 'block this item',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent });
  let capturedCall = null;
  const processRunner = (command, args, cwd, spawnOptions) => {
    capturedCall = { command, args, cwd, spawnOptions };
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'blocked',
        summary: 'needs manual decision',
      }),
      stderr: '',
    };
  };

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'blocked',
      QA_HARNESS_MOCK_SUMMARY: 'needs manual decision',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');
  const runtimeLog = fs.readFileSync(result.runPaths.runtimeLogPath, 'utf8');

  assert.equal(iteration.status, 'blocked');
  assert.equal(capturedCall.command, process.execPath);
  assert.match(capturedCall.args[0], /qa-runtime-mock-adapter\.js$/);
  assert.equal(capturedCall.spawnOptions.env.QA_HARNESS_MOCK_STATUS, 'blocked');
  assert.match(
    updatedProgress,
    /- \[ \] `P-401` Goal: block this item[\s\S]*?Status: `blocked`[\s\S]*?Result: `blocked: needs manual decision`/,
  );
  assert.match(runtimeLog, /status=blocked/);
  assert.match(runtimeLog, /Parsed status: blocked/);
  assert.match(runtimeLog, /Summary: needs manual decision/);
});

test('advanceRun preserves legacy run compatibility by delegating to iterateRun', (t) => {
  const legacyProgressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-801',
        goal: 'legacy item missing result',
        includeResult: false,
        includeFallbackReason: false,
      }),
      createProgressBlock({
        id: 'P-802',
        goal: 'leave this untouched',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent: legacyProgressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'legacy advance pass',
    }),
    stderr: '',
  });

  const iteration = advanceRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'pass',
      QA_HARNESS_MOCK_SUMMARY: 'legacy advance pass',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.selectedItemId, 'P-801');
  assert.equal(iteration.executorStatus, 'pass');
  assert.match(iteration.executorSummary, /recorded pass from logs\/runtime\.log: legacy advance pass/);
  assert.equal(iteration.verifierStatus, 'pass');
  assert.match(iteration.summary, /verifier accepted pass from logs\/runtime\.log: legacy advance pass/);
  assert.match(
    updatedProgress,
    /- \[x\] `P-801` Goal: legacy item missing result[\s\S]*?Status: `pass`\r?\n  - Retry budget: `1`\r?\n  - Result: `pass via npm run qa:orchestrator -- advance-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in logs\/verifier\.log \(runtime logs\/runtime\.log\)`\r?\n  - Fallback reason: ``/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-802` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Result: `existing result`/,
  );
});

test('iterateRun updates legacy progress items without Result lines and does not rewrite unrelated items', (t) => {
  const legacyProgressContent = createProgressDocument({
    includeTemplate: false,
    activeBlocks: [
      createProgressBlock({
        id: 'P-501',
        goal: 'legacy item missing result',
        includeResult: false,
        includeFallbackReason: false,
      }),
      createProgressBlock({
        id: 'P-502',
        goal: 'leave this untouched',
        result: 'existing result',
      }),
    ],
  });
  const { repoRoot, result } = createFeatureRun(t, { progressContent: legacyProgressContent });
  const processRunner = () => ({
    status: 0,
    stdout: JSON.stringify({
      status: 'pass',
      summary: 'legacy pass summary',
    }),
    stderr: '',
  });

  const iteration = iterateRun({
    repoRoot,
    templatesDir: realTemplatesDir,
    runId: result.runId,
    adapter: 'mock',
    env: {
      ...process.env,
      QA_HARNESS_MOCK_STATUS: 'pass',
      QA_HARNESS_MOCK_SUMMARY: 'legacy pass summary',
    },
    processRunner,
  });

  const updatedProgress = fs.readFileSync(result.runPaths.progressPath, 'utf8');

  assert.equal(iteration.selectedItemId, 'P-501');
  assert.match(
    updatedProgress,
    /- \[x\] `P-501` Goal: legacy item missing result[\s\S]*?Status: `pass`\r?\n  - Retry budget: `1`\r?\n  - Result: `pass via npm run qa:orchestrator -- iterate-run --run-id 20260409T123456Z-plan-homepage --adapter mock; evidence in logs\/runtime\.log`\r?\n  - Fallback reason: ``/,
  );
  assert.match(
    updatedProgress,
    /- \[ \] `P-502` Goal: leave this untouched[\s\S]*?Status: `todo`[\s\S]*?Result: `existing result`/,
  );
});

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
