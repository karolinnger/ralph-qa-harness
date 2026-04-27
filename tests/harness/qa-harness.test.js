'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.QA_HARNESS_COMMAND_PREFIX = 'npx ralph-qa-harness';

const {
  createRunId,
  findGeneratedSpecsForRun,
  findNextActionableProgressItem,
  getTemplatePlaceholders,
  parseProgressItems,
  prepare,
  resolveHarnessPaths,
  resolveProjectCliInvocation,
  runCli,
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
    ...items.flatMap((item) => [
      `- [ ] \`${item.id}\` Goal: ${item.goal}`,
      '  - Input: `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`',
      `  - Output: ${item.output || '`iteration evidence`'}`,
      '  - Verify: `ralph-qa-harness verify`',
      '  - Owner: `copilot`',
      '  - Status: `todo`',
      '  - Retry budget: `1`',
      '  - Result: ``',
      '  - Evidence: ``',
      '',
    ]),
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

  for (const expectedPath of [
    paths.configPath,
    paths.prdPath,
    paths.progressPath,
    paths.promptPath,
    paths.normalizedFeaturePath,
    paths.statePath,
    paths.runsDir,
    paths.runDir,
  ]) {
    assert.equal(expectedPath.startsWith(paths.harnessDir), true);
    assert.equal(expectedPath.startsWith(packageRoot), false);
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
    `  ${expectedPrefix} run --max-iterations <positive-integer>`,
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
    `  ${configuredPrefix} run --max-iterations <positive-integer>`,
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
    runCli(['run', '--max-iterations', '3'], commonOptions),
    runCli(['status'], commonOptions),
    runCli(['verify'], commonOptions),
  ];

  assert.deepEqual(exitCodes, [0, 0, 0, 0, 0]);
  assert.equal(stderr, '');
  assert.match(stdout, /Doctor passed/);
  assert.match(stdout, /prepared/);
  assert.match(stdout, /ran/);
  assert.match(stdout, /status ok/);
  assert.match(stdout, /verified/);
  assert.deepEqual(calls.map((call) => call.command), ['doctor', 'prepare', 'run', 'status', 'verify']);
  assert.ok(calls.every((call) => call.options.repoRoot === repoRoot));
  assert.ok(calls.slice(1).every((call) => call.options.harnessPaths.repoRoot === repoRoot));
  assert.ok(calls.slice(1).every((call) => call.options.harnessPaths.harnessDir === path.join(repoRoot, '.qa-harness')));
  assert.ok(calls.slice(1).every((call) => call.options.harnessPaths.normalizedFeaturePath === path.join(repoRoot, '.qa-harness', 'normalized.feature')));
  assert.equal(calls[1].options.from, 'Features/homepage.feature');
  assert.equal(calls[2].options.maxIterations, 3);
  assert.deepEqual(Object.keys(calls[3].options).sort(), ['harnessPaths', 'repoRoot']);
  assert.deepEqual(Object.keys(calls[4].options).sort(), ['harnessPaths', 'repoRoot']);
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

  const excludeContent = fs.readFileSync(path.join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
  assert.match(excludeContent, /^\.qa-harness\/$/m);
  assert.match(excludeContent, /^\.features-gen\/\.qa-harness\/$/m);
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

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Run .* stopped after 3 iterations: budget-exhausted/);
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
      '  - Owner: `copilot`',
      '  - Status: `pass`',
      '  - Retry budget: `0`',
      '  - Result: `done`',
      '  - Evidence: `done evidence`',
      '',
      '- [ ] `P-002` Goal: build the selected worker prompt.',
      '  - Input: `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`',
      '  - Output: `.qa-harness/runs/<run-id>/iterations/001/worker-prompt.md`',
      '  - Verify: `inspect worker-prompt.md`',
      '  - Owner: `copilot`',
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
  const exitCode = runCli(['run', '--max-iterations', '1'], {
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
      '  - Owner: `copilot`',
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

  assert.equal(exitCode, 0);
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

  assert.equal(exitCode, 0);
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

  assert.equal(exitCode, 0);
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
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t);
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
  assert.match(stdout, /Run .* stopped after 1 iterations: budget-exhausted/);
  assert.deepEqual(calls.map((call) => call.args), [
    [],
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list', '.features-gen/.qa-harness/runs/20260427T081000Z-run-x/normalized.feature.spec.js'],
  ]);
  assert.match(progressContent, /- \[x\] `P-001` Goal: execute `Features\/x\.feature`/);
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

  const exitCode = runCli(['run', '--max-iterations', '1'], {
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
      expectedExitCode: 0,
      expectedStream: 'stdout',
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
  assert.match(stdout, /Run .* stopped after 1 iterations: budget-exhausted/);
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
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.iterationCount, 1);
  assert.equal(runValidation.status, 'pass');
  assert.equal(runValidation.runId, state.latestRunId);
  assert.equal(summary.iteration, 1);
  assert.equal(summary.footer.status, 'pass');
  assert.equal(iterationValidation.status, 'pass');
  assert.equal(iterationValidation.runId, state.latestRunId);
  assert.equal(iterationValidation.iteration, 1);
  assert.equal(Array.isArray(iterationValidation.commands), true);
  assert.match(loopReport, /# QA Harness Loop Report/);
  assert.match(loopReport, /Run id:/);
  assert.match(loopReport, /Final status: budget-exhausted/);
  assert.match(workerPrompt, /# Copilot Worker Prompt/);
  assert.match(workerPrompt, /## Selected Progress Item/);
  assert.match(diffPatch, /No worker file changes detected for this iteration\.|diff --git/);
});

test('status and report artifacts stay linked to a run created through the CLI', (t) => {
  const { repoRoot, harnessPaths } = createPreparedLeanRun(t, {
    prepareNow: new Date('2026-04-27T08:32:00.000Z'),
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
  assert.match(runStdout, new RegExp(`Run ${runId} stopped after 1 iterations: budget-exhausted`));
  assert.equal(statusExitCode, 0);
  assert.equal(statusStderr, '');
  assert.match(statusStdout, new RegExp(`Run id: ${runId}`));
  assert.match(statusStdout, /Run status: budget-exhausted/);
  assert.match(statusStdout, /Stop reason: budget-exhausted/);
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

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });
  const relativeGeneratedSpecPath = path.relative(repoRoot, generatedSpecPath).replace(/\\/g, '/');

  assert.equal(result.status, 'pass');
  assert.equal(result.runId, runId);
  assert.equal(result.listedTestCount, 2);
  assert.deepEqual(result.commands.map((commandResult) => commandResult.exitCode), [0, 0, 0]);
  assert.deepEqual(calls.map((call) => call.args), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list', relativeGeneratedSpecPath],
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
  assert.deepEqual(result.generatedSpecs, [generatedSpecPath]);
  assert.match(result.output, /bddgen test generated 1 spec/);
  assert.match(result.output, /playwright test --list found 2 tests/);
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
  assert.equal(validation.commands.length, 3);
  assert.match(validation.commands[0].commandDisplay, /^npx(?:\.cmd)? bddgen export$/);
  assert.match(validation.commands[1].commandDisplay, /^npx(?:\.cmd)? bddgen test$/);
  assert.match(validation.commands[2].commandDisplay, /^npx(?:\.cmd)? playwright test --list /);
  assert.equal(validation.commands[0].stdout, 'List of all steps (5)\n');
  assert.equal(validation.commands[1].stdout, 'generated specs\n');
  assert.equal(validation.commands[2].stdout, 'Total: 1 test\n');
  for (const commandResult of validation.commands) {
    assert.match(commandResult.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(commandResult.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof commandResult.durationMs, 'number');
  }
});

test('verify CLI passes with an injected command runner and clear operator output', (t) => {
  const result = runVerifyCliWithInjectedRunner(t);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls.map((call) => call.args.slice(0, 3)), [
    ['bddgen', 'export'],
    ['bddgen', 'test'],
    ['playwright', 'test', '--list'],
  ]);
  assert.ok(result.calls.every((call) => call.cwd === result.repoRoot));
  assert.match(result.stdout, /Verification passed: bddgen export registered 6 steps/);
  assert.match(result.stdout, /bddgen test generated 1 spec/);
  assert.match(result.stdout, /playwright test --list found 2 tests/);
  assert.match(result.stdout, /Command: npx(?:\.cmd)? bddgen export/);
  assert.match(result.stdout, /Command: npx(?:\.cmd)? bddgen test/);
  assert.match(result.stdout, /Command: npx(?:\.cmd)? playwright test --list/);
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
    { argv: ['prepare'], pattern: /Missing required option --from/ },
    { argv: ['prepare', '--from'], pattern: /Missing value for option --from/ },
    { argv: ['run'], pattern: /Missing value for option --max-iterations/ },
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

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
