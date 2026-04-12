'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  findGeneratedSpecsForRun,
  parseExportedStepCount,
  parseListedTestCount,
  parseProgressItems,
  resolveProjectCliInvocation,
} = require('./qa-harness');
const RECORDED_EXECUTION_CONTROL_DEFAULTS = Object.freeze({
  project: 'chromium',
  headed: false,
  debug: false,
  baseUrl: '',
  targetEnv: '',
  trace: 'on-first-retry',
  video: 'off',
  screenshot: 'off',
});

function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function normalizeDisplayPath(value) {
  return value.split(path.sep).join('/');
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    options[key] = value;
    index += 1;
  }

  return options;
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function sanitizeInlineCode(value) {
  return String(value).replace(/`/g, "'").replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function sanitizeOptionalInlineCode(value) {
  return value == null ? '' : sanitizeInlineCode(value);
}

function summarizeOutput(output, fallbackMessage) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return fallbackMessage;
  }

  const primaryMatch =
    lines.find((line) => /^\d+\)/.test(line) || /^Error:/i.test(line)) ||
    [...lines].reverse().find((line) => /\b\d+\s+(passed|failed|skipped)\b/i.test(line)) ||
    lines[lines.length - 1];

  return primaryMatch;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function formatCommandArg(arg) {
  return /[\s"]/u.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function formatCommandDisplay(command, args) {
  return [command, ...args].map(formatCommandArg).join(' ');
}

function runTool(command, args, cwd, env) {
  const invocation = resolveProjectCliInvocation(command, args, cwd);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    commandDisplay: formatCommandDisplay(invocation.command, invocation.args),
  };
}

function resolveRunTool(dependencies) {
  return dependencies && typeof dependencies.runTool === 'function' ? dependencies.runTool : runTool;
}

function tokenize(value) {
  return sanitizeOptionalInlineCode(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function uniqueStrings(values) {
  const normalizedValues = [];
  const seenValues = new Set();

  for (const value of values) {
    const normalizedValue = sanitizeOptionalInlineCode(value);
    if (!normalizedValue || seenValues.has(normalizedValue)) {
      continue;
    }

    seenValues.add(normalizedValue);
    normalizedValues.push(normalizedValue);
  }

  return normalizedValues;
}

function readMarkdownSummaryField(content, label) {
  const match = content.match(new RegExp(`^- ${escapeForRegExp(label)}:\\s*(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function stripMarkdownInlineCode(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return sanitizeOptionalInlineCode(value.trim().replace(/^`|`$/g, '').trim());
}

function readExecutionControlBoolean(prdContent, label, fallbackValue) {
  const rawValue = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, label)).toLowerCase();
  if (!rawValue) {
    return fallbackValue;
  }

  if (['enabled', 'true', 'yes', 'on', '1'].includes(rawValue)) {
    return true;
  }

  if (['disabled', 'false', 'no', 'off', '0'].includes(rawValue)) {
    return false;
  }

  return fallbackValue;
}

function readRecordedExecutionControls(prdContent, itemVerify) {
  if (!/(^|\r?\n)## Execution Controls$/m.test(prdContent)) {
    return null;
  }

  const readOptionalField = (label) => {
    const rawValue = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, label));
    return /^not set$/i.test(rawValue) ? '' : sanitizeOptionalInlineCode(rawValue);
  };

  return {
    recorded: true,
    project:
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Browser project'))
      || parseRequestedProject(itemVerify),
    headed: readExecutionControlBoolean(
      prdContent,
      'Headed execution',
      RECORDED_EXECUTION_CONTROL_DEFAULTS.headed,
    ),
    debug: readExecutionControlBoolean(
      prdContent,
      'Debug execution',
      RECORDED_EXECUTION_CONTROL_DEFAULTS.debug,
    ),
    baseUrl: readOptionalField('Base URL override'),
    targetEnv: readOptionalField('Target environment'),
    trace:
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Trace setting'))
      || RECORDED_EXECUTION_CONTROL_DEFAULTS.trace,
    video:
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Video setting'))
      || RECORDED_EXECUTION_CONTROL_DEFAULTS.video,
    screenshot:
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Screenshot setting'))
      || RECORDED_EXECUTION_CONTROL_DEFAULTS.screenshot,
  };
}

function resolveExecutionControls(prdContent, itemVerify) {
  const recordedControls = readRecordedExecutionControls(prdContent, itemVerify);
  if (recordedControls) {
    return recordedControls;
  }

  return {
    recorded: false,
    project: parseRequestedProject(itemVerify),
    headed: false,
    debug: false,
    baseUrl: '',
    targetEnv: '',
    trace: '',
    video: '',
    screenshot: '',
  };
}

function appendPlaywrightExecutionControlArgs(baseArgs, executionControls, options = {}) {
  const args = Array.isArray(baseArgs) ? [...baseArgs] : [];
  if (!executionControls) {
    return args;
  }

  if (options.includeProject !== false && executionControls.project) {
    args.push(`--project=${executionControls.project}`);
  }

  if (!executionControls.recorded) {
    return args;
  }

  if (executionControls.headed) {
    args.push('--headed');
  }

  if (executionControls.debug) {
    args.push('--debug');
  }

  if (executionControls.trace) {
    args.push(`--trace=${executionControls.trace}`);
  }

  if (executionControls.video) {
    args.push(`--video=${executionControls.video}`);
  }

  if (executionControls.screenshot) {
    args.push(`--screenshot=${executionControls.screenshot}`);
  }

  return args;
}

function buildExecutionControlEnv(env, executionControls) {
  if (!executionControls || !executionControls.recorded) {
    return env;
  }

  const nextEnv = {
    ...env,
    QA_HARNESS_EXECUTION_PROJECT: executionControls.project,
    QA_HARNESS_EXECUTION_HEADED: executionControls.headed ? 'true' : 'false',
    QA_HARNESS_EXECUTION_DEBUG: executionControls.debug ? 'true' : 'false',
    QA_HARNESS_EXECUTION_TRACE: executionControls.trace,
    QA_HARNESS_EXECUTION_VIDEO: executionControls.video,
    QA_HARNESS_EXECUTION_SCREENSHOT: executionControls.screenshot,
    PWDEBUG: executionControls.debug ? '1' : '0',
  };

  if (executionControls.baseUrl) {
    nextEnv.PLAYWRIGHT_BASE_URL = executionControls.baseUrl;
  }

  if (executionControls.targetEnv) {
    nextEnv.QA_HARNESS_TARGET_ENV = executionControls.targetEnv;
  }

  return nextEnv;
}

function resolveCoverageScope(prdContent, selectedItemGoal) {
  const labels = [
    'Guided scenario scope',
    'Guided feature scope',
    'Guided risk areas',
    'Autonomous target',
    'Primary scenario scope',
    'Source reference',
  ];

  for (const label of labels) {
    const value = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, label));
    if (value && !/^not provided$/i.test(value)) {
      return value;
    }
  }

  return sanitizeInlineCode(selectedItemGoal || 'normalized.feature');
}

function parseFeatureModel(featureText) {
  const featureMatch = featureText.match(/^\s*Feature:\s*(.+)$/m);
  const lines = featureText.split(/\r?\n/);
  const scenarios = [];
  let currentScenario = null;

  for (const rawLine of lines) {
    const scenarioMatch = rawLine.match(/^\s*Scenario(?: Outline)?:\s*(.+)$/);
    if (scenarioMatch) {
      currentScenario = {
        title: scenarioMatch[1].trim(),
        steps: [],
      };
      scenarios.push(currentScenario);
      continue;
    }

    const stepMatch = rawLine.match(/^\s*(Given|When|Then|And|But)\s+(.+)$/);
    if (stepMatch && currentScenario) {
      currentScenario.steps.push({
        keyword: stepMatch[1],
        text: stepMatch[2].trim(),
      });
    }
  }

  return {
    featureTitle: featureMatch ? featureMatch[1].trim() : 'normalized feature',
    scenarios,
  };
}

function parseScenarioSignals(scenario) {
  const openPaths = [];
  const assertedPaths = [];
  const titleAssertions = [];
  const visibleTargets = [];
  const clickTargets = [];

  for (const step of scenario.steps) {
    const stepText = step.text;
    const openMatch = stepText.match(/^I open "([^"]+)"$/);
    if (openMatch) {
      openPaths.push(openMatch[1]);
      continue;
    }

    const urlMatch = stepText.match(/^the url should contain "([^"]+)"$/);
    if (urlMatch) {
      assertedPaths.push(urlMatch[1]);
      continue;
    }

    const titleMatch = stepText.match(/^the title should contain "([^"]+)"$/);
    if (titleMatch) {
      titleAssertions.push(titleMatch[1]);
      continue;
    }

    const visibleMatch = stepText.match(/^I should see "([^"]+)"$/);
    if (visibleMatch) {
      visibleTargets.push(visibleMatch[1]);
      continue;
    }

    const clickMatch = stepText.match(/^I click "([^"]+)"$/);
    if (clickMatch) {
      clickTargets.push(clickMatch[1]);
    }
  }

  return {
    title: scenario.title,
    openPaths,
    assertedPaths,
    titleAssertions,
    visibleTargets,
    clickTargets,
  };
}

function formatPathLabel(urlPath) {
  const cleanedPath = sanitizeOptionalInlineCode(urlPath).replace(/^\/+|\/+$/g, '');
  if (!cleanedPath) {
    return 'the home page';
  }

  return `the ${cleanedPath.replace(/[-_/]+/g, ' ')} page`;
}

function resolveDirectOpenDescriptor(signal, urlPath) {
  if (signal.titleAssertions.length > 0) {
    return `the ${signal.titleAssertions[0]} page`;
  }

  return formatPathLabel(urlPath);
}

function capitalizeFirst(value) {
  const text = sanitizeOptionalInlineCode(value);
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
}

function collectDirectOpenCoverageCandidates(featureModel, relativeSpecPaths) {
  const directOpenPaths = new Set();
  const candidates = [];
  const seenCandidates = new Set();
  const scenarioSignals = featureModel.scenarios.map(parseScenarioSignals);

  for (const signal of scenarioSignals) {
    for (const openPath of signal.openPaths) {
      directOpenPaths.add(openPath);
    }
  }

  for (const signal of scenarioSignals) {
    for (const assertedPath of signal.assertedPaths) {
      if (!assertedPath || directOpenPaths.has(assertedPath) || assertedPath === signal.openPaths[0]) {
        continue;
      }

      const descriptor = resolveDirectOpenDescriptor(signal, assertedPath);
      const candidateScenario = `open ${descriptor} directly`;
      const candidateKey = `${assertedPath}|${candidateScenario}`;
      if (seenCandidates.has(candidateKey)) {
        continue;
      }

      seenCandidates.add(candidateKey);
      candidates.push({
        urlPath: assertedPath,
        descriptor,
        sourceScenarioTitle: signal.title,
        scenarioTitle: `Scenario: ${capitalizeFirst(candidateScenario)}`,
        candidateScenario,
        gap: `${descriptor} direct-open coverage is missing from normalized.feature`,
        additionTarget: 'normalized.feature',
        titleAssertion: signal.titleAssertions[0] || '',
        visibleTarget: signal.visibleTargets[0] || '',
        evidence: uniqueStrings(['normalized.feature', ...relativeSpecPaths]),
      });
    }
  }

  return candidates;
}

function parseStructuredLogEntries(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  let currentEntry = null;

  for (const line of lines) {
    if (/^\[[^\]]+\] status=/.test(line)) {
      if (currentEntry) {
        entries.push(currentEntry);
      }

      currentEntry = {
        header: line,
        lines: [],
      };
      continue;
    }

    if (!currentEntry) {
      continue;
    }

    if (line.trim()) {
      currentEntry.lines.push(line);
    }
  }

  if (currentEntry) {
    entries.push(currentEntry);
  }

  return entries;
}

function readStructuredLogValue(entry, label) {
  const prefix = `${label}: `;
  const matchingLine = Array.isArray(entry.lines)
    ? entry.lines.find((line) => line.startsWith(prefix))
    : '';
  return matchingLine ? matchingLine.slice(prefix.length).trim() : '';
}

function readAcceptedPlannerHandoffRecord(runDir, itemId) {
  const plannerHandoffPath = path.join(runDir, 'outputs', 'planner-handoff.md');
  if (!pathExists(plannerHandoffPath)) {
    return null;
  }

  const entries = parseStructuredLogEntries(readText(plannerHandoffPath));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!/status=accepted\b/.test(entry.header)) {
      continue;
    }

    const progressItemId = readStructuredLogValue(entry, 'Progress item id');
    if (progressItemId !== itemId) {
      continue;
    }

    return {
      summary: sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Summary')),
      candidateGap: sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Candidate gap')),
      candidateScenario: sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Candidate scenario')),
      candidateAdditionTarget: sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Candidate addition target')),
    };
  }

  return null;
}

function parseRequestedProject(itemVerify) {
  const match = sanitizeOptionalInlineCode(itemVerify).match(/--project(?:=|\s+)([^\s`]+)/);
  return match ? match[1] : 'chromium';
}

function resolveRepoRoot(runDir) {
  return path.resolve(runDir, '..', '..', '..');
}

function runVerificationProbe(context, dependencies) {
  const repoRoot = context.repoRoot;
  const runToolFn = resolveRunTool(dependencies);
  const toolEnv = buildExecutionControlEnv(context.env, context.executionControls);
  const exportResult = runToolFn(getNpxCommand(), ['bddgen', 'export'], repoRoot, toolEnv);
  if (exportResult.status !== 0) {
    throw new Error(`bddgen export failed: ${summarizeOutput(`${exportResult.stdout}\n${exportResult.stderr}`, 'bddgen export failed.')}`);
  }

  const exportedStepCount = parseExportedStepCount(`${exportResult.stdout}\n${exportResult.stderr}`);
  if (exportedStepCount < 1) {
    throw new Error('bddgen export returned zero registered steps.');
  }

  const generateResult = runToolFn(getNpxCommand(), ['bddgen', 'test'], repoRoot, toolEnv);
  if (generateResult.status !== 0) {
    throw new Error(`bddgen test failed: ${summarizeOutput(`${generateResult.stdout}\n${generateResult.stderr}`, 'bddgen test failed.')}`);
  }

  const generatedSpecs = findGeneratedSpecsForRun(repoRoot, context.runId);
  if (generatedSpecs.length === 0) {
    throw new Error(`No generated Playwright specs were found for run ${context.runId}.`);
  }

  const relativeSpecPaths = generatedSpecs.map((generatedSpecPath) =>
    normalizeDisplayPath(path.relative(repoRoot, generatedSpecPath)),
  );
  const listArgs = ['playwright', 'test', '--list', escapeForRegExp(context.runId)];
  if (context.executionControls && context.executionControls.project) {
    listArgs.push(`--project=${context.executionControls.project}`);
  }
  const listResult = runToolFn(getNpxCommand(), listArgs, repoRoot, toolEnv);
  if (listResult.status !== 0) {
    throw new Error(`playwright test --list failed: ${summarizeOutput(`${listResult.stdout}\n${listResult.stderr}`, 'playwright test --list failed.')}`);
  }

  const listedTestCount = parseListedTestCount(`${listResult.stdout}\n${listResult.stderr}`);
  if (listedTestCount < 1) {
    throw new Error(`playwright test --list did not find generated tests for run ${context.runId}.`);
  }

  return {
    exportedStepCount,
    listedTestCount,
    generatedSpecs,
    relativeSpecPaths,
    commandEvidence: uniqueStrings([
      exportResult.commandDisplay,
      generateResult.commandDisplay,
      listResult.commandDisplay,
    ]),
  };
}

function runExecutionProof(context, verification, dependencies) {
  const project = context.executionControls && context.executionControls.project
    ? context.executionControls.project
    : parseRequestedProject(context.itemVerify);
  const executionArgs = appendPlaywrightExecutionControlArgs(
    ['playwright', 'test', ...verification.relativeSpecPaths],
    context.executionControls,
    { includeProject: true },
  );
  const runToolFn = resolveRunTool(dependencies);
  const executionResult = runToolFn(
    getNpxCommand(),
    executionArgs,
    context.repoRoot,
    buildExecutionControlEnv(context.env, context.executionControls),
  );
  const combinedOutput = `${executionResult.stdout}\n${executionResult.stderr}`;

  return {
    project,
    status: executionResult.status === 0 ? 'pass' : 'fail',
    summary: summarizeOutput(combinedOutput, 'Playwright execution did not report a summary.'),
    commandDisplay: executionResult.commandDisplay,
    stdout: executionResult.stdout,
    stderr: executionResult.stderr,
  };
}

function buildExplorerResult(context, dependencies) {
  const verification = runVerificationProbe(context, dependencies);
  const featureModel = parseFeatureModel(context.normalizedFeatureContent);
  const gapCandidates = collectDirectOpenCoverageCandidates(featureModel, verification.relativeSpecPaths);
  const selectedCandidate = gapCandidates[0];
  const coverageScope = resolveCoverageScope(context.prdContent, context.itemGoal);

  if (!selectedCandidate) {
    return {
      status: 'blocked',
      summary: 'no bounded direct-open coverage gap could be derived from normalized.feature',
      runtimeLayer: 'playwright-cli',
      evidence: uniqueStrings(['normalized.feature', ...verification.relativeSpecPaths]),
      coverageScope,
      gapCandidates: [],
      stopReason: 'artifact analysis found no uncovered direct-open navigation target',
      blockReason: 'no deterministic explorer candidate remained after replaying the current normalized.feature scope',
    };
  }

  return {
    status: 'pass',
    summary: 'identified one bounded direct-open coverage gap',
    runtimeLayer: 'playwright-cli',
    evidence: uniqueStrings(['normalized.feature', ...verification.relativeSpecPaths]),
    coverageScope,
    observedGap: selectedCandidate.gap,
    candidateScenario: selectedCandidate.candidateScenario,
    additionTarget: selectedCandidate.additionTarget,
    gapCandidates: gapCandidates.map((candidate) => ({
      gap: candidate.gap,
      candidateScenario: candidate.candidateScenario,
      additionTarget: candidate.additionTarget,
      evidence: candidate.evidence,
    })),
  };
}

function scoreScenarioCandidate(queryTokens, candidate) {
  const candidateTokens = new Set([
    ...tokenize(candidate.descriptor),
    ...tokenize(candidate.sourceScenarioTitle),
    ...tokenize(candidate.titleAssertion),
    ...tokenize(candidate.urlPath),
  ]);
  let score = 0;

  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

function buildScenarioBlock(candidate, requestedScenarioText) {
  const requestedHeading = sanitizeOptionalInlineCode(requestedScenarioText);
  const heading = requestedHeading
    ? requestedHeading.replace(/^Scenario:\s*/i, '')
    : candidate.scenarioTitle.replace(/^Scenario:\s*/i, '');
  const scenarioHeading = `Scenario: ${capitalizeFirst(heading)}`;
  const stepLines = [`Given I open "${candidate.urlPath}"`];

  if (candidate.titleAssertion) {
    stepLines.push(`Then the title should contain "${candidate.titleAssertion}"`);
    stepLines.push(`And the url should contain "${candidate.urlPath}"`);
  } else {
    stepLines.push(`Then the url should contain "${candidate.urlPath}"`);
  }

  if (candidate.visibleTarget) {
    stepLines.push(`And I should see "${candidate.visibleTarget}"`);
  }

  const block = [
    `  ${scenarioHeading}`,
    ...stepLines.map((line) => `    ${line}`),
  ].join('\n');

  return {
    addedScenarioOrOutline: scenarioHeading,
    block,
  };
}

function appendScenarioIfMissing(normalizedFeaturePath, scenarioHeading, scenarioBlock) {
  const content = readText(normalizedFeaturePath);
  if (content.includes(`  ${scenarioHeading}`)) {
    return false;
  }

  const nextContent = content.trimEnd()
    ? `${content.trimEnd()}\n\n${scenarioBlock}\n`
    : `${scenarioBlock}\n`;
  writeText(normalizedFeaturePath, nextContent);
  return true;
}

function buildScenarioAdditionResult(context, dependencies) {
  const verification = runVerificationProbe(context, dependencies);
  const featureModel = parseFeatureModel(context.normalizedFeatureContent);
  const plannerHandoffRecord = context.plannerHandoffRecord;
  const candidatePool = collectDirectOpenCoverageCandidates(featureModel, verification.relativeSpecPaths);
  const queryTokens = tokenize([
    plannerHandoffRecord && plannerHandoffRecord.candidateScenario,
    plannerHandoffRecord && plannerHandoffRecord.summary,
    context.itemGoal,
  ].join(' '));
  const selectedCandidate = candidatePool
    .map((candidate) => ({
      candidate,
      score: scoreScenarioCandidate(queryTokens, candidate),
    }))
    .sort((left, right) => right.score - left.score)[0];

  if (!selectedCandidate || !selectedCandidate.candidate) {
    return {
      status: 'blocked',
      summary: 'planner handoff could not be mapped onto a deterministic scenario addition',
      runtimeLayer: 'playwright-cli',
      evidence: uniqueStrings(['normalized.feature', ...verification.relativeSpecPaths]),
      addedScenarioOrOutline: '',
      targetArtifactPath: context.normalizedFeaturePath,
      blockReason: 'no deterministic direct-open target matched the accepted planner handoff',
      stopReason: 'scenario addition stopped before mutating normalized.feature',
    };
  }

  const scenarioBuild = buildScenarioBlock(
    selectedCandidate.candidate,
    plannerHandoffRecord && plannerHandoffRecord.candidateScenario,
  );
  const added = appendScenarioIfMissing(
    context.normalizedFeaturePath,
    scenarioBuild.addedScenarioOrOutline,
    scenarioBuild.block,
  );
  const postMutationVerification = runVerificationProbe({
    ...context,
    normalizedFeatureContent: readText(context.normalizedFeaturePath),
  }, dependencies);
  const execution = runExecutionProof(context, postMutationVerification, dependencies);

  return {
    status: execution.status,
    summary: added
      ? execution.status === 'pass'
        ? 'appended one bounded scenario to normalized.feature'
        : execution.summary
      : execution.status === 'pass'
        ? 'scenario already present in normalized.feature'
        : execution.summary,
    runtimeLayer: 'playwright-cli',
    evidence: uniqueStrings(['normalized.feature', ...postMutationVerification.relativeSpecPaths]),
    addedScenarioOrOutline: scenarioBuild.addedScenarioOrOutline,
    targetArtifactPath: context.normalizedFeaturePath,
    stopReason: execution.status === 'fail' ? execution.summary : '',
  };
}

function resolveFailureDiagnosis(summary) {
  const normalizedSummary = sanitizeOptionalInlineCode(summary);
  const locatorMatch = normalizedSummary.match(/locator\((.+?)\)/i);

  if (locatorMatch) {
    return {
      smallestFailingUnit: locatorMatch[1],
      rootCauseHypothesis: 'locator resolution drifted from the page state proved by the current run artifacts',
      escalationReason: 'manual locator review required before another bounded healing attempt',
    };
  }

  if (/strict mode violation/i.test(normalizedSummary)) {
    return {
      smallestFailingUnit: 'ambiguous locator',
      rootCauseHypothesis: 'the current selector resolves multiple elements under the verified page state',
      escalationReason: 'manual selector review required before another bounded healing attempt',
    };
  }

  if (/timeout/i.test(normalizedSummary)) {
    return {
      smallestFailingUnit: 'timed-out page assertion',
      rootCauseHypothesis: 'the page did not reach the expected state within the bounded execution window',
      escalationReason: 'manual state or wait-condition review required before another bounded healing attempt',
    };
  }

  return {
    smallestFailingUnit: 'generated run-backed scenario',
    rootCauseHypothesis: 'the current execution proof still fails under the selected bounded artifact set',
    escalationReason: 'manual repair follow-up required before another bounded healing attempt',
  };
}

function buildExecutorLikeResult(context, healerItem, dependencies) {
  const verification = runVerificationProbe(context, dependencies);
  const execution = runExecutionProof(context, verification, dependencies);

  if (execution.status === 'pass') {
    return {
      status: 'pass',
      summary: `recorded runtime proof on ${execution.project}`,
      runtimeLayer: 'playwright-cli',
      evidence: uniqueStrings(['normalized.feature', ...verification.relativeSpecPaths]),
    };
  }

  const diagnosis = healerItem ? resolveFailureDiagnosis(execution.summary) : null;
  return {
    status: 'fail',
    summary: execution.summary,
    runtimeLayer: 'playwright-cli',
    evidence: uniqueStrings(['normalized.feature', ...verification.relativeSpecPaths]),
    smallestFailingUnit: diagnosis ? diagnosis.smallestFailingUnit : '',
    rootCauseHypothesis: diagnosis ? diagnosis.rootCauseHypothesis : '',
    escalationReason: diagnosis ? diagnosis.escalationReason : '',
  };
}

function buildContext(options) {
  const runDir = path.resolve(options['run-dir']);
  const repoRoot = resolveRepoRoot(runDir);
  const progressPath = path.resolve(options['progress-path']);
  const prdPath = path.resolve(options['prd-path']);
  const normalizedFeaturePath = path.resolve(options['normalized-feature-path']);
  const progressContent = readText(progressPath);
  const progressItems = parseProgressItems(progressContent);
  const selectedItem = progressItems.find((item) => item.id === options['item-id']) || {
    id: options['item-id'] || '',
    goal: options['item-goal'] || '',
    verify: options['item-verify'] || '',
    owner: '',
  };

  const prdContent = readText(prdPath);

  return {
    env: process.env,
    repoRoot,
    runId: options['run-id'] || '',
    runDir,
    prdContent,
    progressContent,
    normalizedFeatureContent: readText(normalizedFeaturePath),
    normalizedFeaturePath,
    progressPath,
    itemId: selectedItem.id,
    itemGoal: selectedItem.goal || options['item-goal'] || '',
    itemVerify: selectedItem.verify || options['item-verify'] || '',
    owner: selectedItem.owner || '',
    executionControls: resolveExecutionControls(prdContent, selectedItem.verify || options['item-verify'] || ''),
    plannerHandoffRecord: readAcceptedPlannerHandoffRecord(runDir, selectedItem.id),
  };
}

function executeExternalWorker(options, dependencies = {}) {
  const context = buildContext(options);
  const owner = context.owner.toLowerCase();
  const healerItem = /\bheal(?:er)?\b/.test(owner);
  const explorerItem = /\bexplor(?:e|er)\b/.test(owner);
  const scenarioAdditionItem = Boolean(context.plannerHandoffRecord) || /^P-GAP-/i.test(context.itemId);

  if (scenarioAdditionItem) {
    return buildScenarioAdditionResult(context, dependencies);
  }

  if (explorerItem) {
    return buildExplorerResult(context, dependencies);
  }

  return buildExecutorLikeResult(context, healerItem, dependencies);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = executeExternalWorker(options);
  process.stdout.write(JSON.stringify(result));
}

module.exports = {
  buildContext,
  buildExecutorLikeResult,
  buildExplorerResult,
  buildScenarioAdditionResult,
  executeExternalWorker,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: error instanceof Error ? error.message : String(error),
      runtimeLayer: 'playwright-cli',
      evidence: [],
    }));
  }
}
