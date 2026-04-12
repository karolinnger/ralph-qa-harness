'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ALLOWED_INTENTS = new Set(['plan', 'implement', 'inspect', 'execute', 'heal', 'coverage']);
const ALLOWED_SOURCE_TYPES = new Set(['jira', 'feature', 'scenario', 'run', 'freeform']);
const ALLOWED_MODES = new Set(['standard', 'guided-exploratory', 'autonomous-exploratory']);
const ALLOWED_SCOPES = new Set(['single-scenario', 'single-feature', 'feature-area', 'run']);
const PREPARE_RUN_FREEFORM_DEFAULTS = Object.freeze({
  intent: 'plan',
  mode: 'standard',
  scope: 'single-feature',
});
const PREPARE_RUN_FREEFORM_INTENT_PATTERNS = Object.freeze([
  { value: 'implement', pattern: /\bimplement\b/i },
  { value: 'inspect', pattern: /\binspect\b/i },
  { value: 'execute', pattern: /\bexecute\b/i },
  { value: 'heal', pattern: /\bheal\b/i },
  { value: 'coverage', pattern: /\bcoverage\b/i },
]);
const PREPARE_RUN_FREEFORM_MODE_PATTERNS = Object.freeze([
  { value: 'guided-exploratory', pattern: /\bguided[- ]exploratory\b/i },
  { value: 'autonomous-exploratory', pattern: /\bautonomous[- ]exploratory\b/i },
]);
const PREPARE_RUN_FREEFORM_SCOPE_PATTERNS = Object.freeze([
  { value: 'single-scenario', pattern: /\bsingle[- ]scenario\b/i },
  { value: 'single-feature', pattern: /\bsingle[- ]feature\b/i },
  { value: 'feature-area', pattern: /\bfeature[- ]area\b/i },
  { value: 'run', pattern: /\bscope\s*[:=]?\s*run\b/i },
]);
const DEFAULT_EXECUTION_CONTROLS = Object.freeze({
  project: 'chromium',
  headed: false,
  debug: false,
  baseUrl: '',
  targetEnv: '',
  trace: 'on-first-retry',
  video: 'off',
  screenshot: 'off',
});
const DEFAULT_HARNESS_COMMAND_PREFIX = 'npx ralph-qa-harness';
const SUPPORTED_PLAYWRIGHT_CONFIG_FILES = Object.freeze([
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.mjs',
  'playwright.config.cjs',
]);

const REQUIRED_DIR_KEYS = [
  'runDir',
  'evidenceDir',
  'screenshotsDir',
  'snapshotsDir',
  'tracesDir',
  'videosDir',
  'logsDir',
  'outputsDir',
];

const REQUIRED_FILE_KEYS = [
  'prdPath',
  'progressPath',
  'promptPath',
  'normalizedFeaturePath',
  'runtimeLogPath',
  'verifierLogPath',
  'fallbackLogPath',
  'gapAnalysisPath',
  'promotionReportPath',
  'healReportPath',
];

const ACTIONABLE_PROGRESS_STATUSES = new Set(['todo', 'doing', 'fail']);
const TERMINAL_PROGRESS_STATUSES = new Set(['pass', 'blocked']);
const RUNTIME_ADAPTER_NAMES = new Set(['mock', 'external']);
const RUNTIME_RESULT_STATUSES = new Set(['pass', 'fail', 'blocked']);
const PLAYWRIGHT_RUNTIME_ORDER = Object.freeze(['playwright-cli', 'playwright-test', 'mcp']);
const PLAYWRIGHT_RUNTIME_LAYERS = new Set(PLAYWRIGHT_RUNTIME_ORDER);
const GAP_ANALYSIS_ARTIFACT_TITLE = 'Gap Analysis';
const HEAL_REPORT_ARTIFACT_TITLE = 'Heal Report';
const LOOP_REPORT_ARTIFACT_TITLE = 'Loop Report';
const PLANNER_HANDOFF_ARTIFACT_TITLE = 'Planner Handoff';
const PROMOTION_REPORT_ARTIFACT_TITLE = 'Promotion Report';
const SCENARIO_ADDITION_ARTIFACT_TITLE = 'Scenario Addition';
const GAP_ANALYSIS_ARTIFACT_DISPLAY = 'outputs/gap-analysis.md';
const PLANNER_HANDOFF_ARTIFACT_DISPLAY = 'outputs/planner-handoff.md';
const PROMOTION_REPORT_ARTIFACT_DISPLAY = 'outputs/promotion-report.md';
const SCENARIO_ADDITION_ARTIFACT_DISPLAY = 'outputs/scenario-addition.md';
const CANONICAL_PROMOTION_STEP_FILE_DISPLAY = 'Features/steps/promotion-generated.ts';
const PROMOTION_STEP_FILE_HEADER = '// Generated reusable steps for canonical promotion-backed scenarios.';
const PLANNER_HANDOFF_PROGRESS_ITEM_ID_PREFIX = 'P-GAP-';
const PLANNER_HANDOFF_OWNER = 'qa-executor';
const PLANNER_HANDOFF_RETRY_BUDGET = '1';
const DEFAULT_PRD_CONSTRAINT_LINES = Object.freeze([
  '- Prefer Playwright CLI first.',
  '- Use Playwright test/debug second.',
  '- Use MCP only with explicit fallback reason recorded in `progress.md` and `logs/fallback.log`.',
  '- Keep work atomic enough for one progress item per iteration.',
]);
const CONCRETE_GAP_SCENARIO_PATTERN =
  /^(?:cover|verify|exercise|assert|open|close|click|submit|navigate|return|select|toggle|create|edit|delete|save|load|render)\b/i;
const VAGUE_GAP_SCENARIO_PATTERN =
  /\b(?:coverage|more tests?|additional tests?|additional scenarios?|broader coverage|wider coverage)\b/i;
const PROMOTION_GENERATED_STEP_LIBRARY = Object.freeze([
  {
    expression: 'I capture a snapshot',
    helperImports: [],
    importExpect: false,
    keywords: ['When'],
    lines: [
      "When('I capture a snapshot', async ({ page }) => {",
      '  await page.screenshot();',
      '});',
    ],
  },
  {
    expression: 'I type {string}',
    helperImports: [],
    importExpect: false,
    keywords: ['When'],
    lines: [
      "When('I type {string}', async ({ page }, value: string) => {",
      '  await page.keyboard.type(value);',
      '});',
    ],
  },
  {
    expression: 'I hover {string}',
    helperImports: ['resolveActionTarget'],
    importExpect: false,
    keywords: ['When'],
    lines: [
      "When('I hover {string}', async ({ page }, target: string) => {",
      '  await resolveActionTarget(page, target).hover();',
      '});',
    ],
  },
  {
    expression: 'I check {string}',
    helperImports: ['resolveActionTarget'],
    importExpect: false,
    keywords: ['When'],
    lines: [
      "When('I check {string}', async ({ page }, target: string) => {",
      '  await resolveActionTarget(page, target).check();',
      '});',
    ],
  },
  {
    expression: 'I select {string} from {string}',
    helperImports: ['resolveActionTarget'],
    importExpect: false,
    keywords: ['When'],
    lines: [
      "When('I select {string} from {string}', async ({ page }, value: string, target: string) => {",
      '  await resolveActionTarget(page, target).selectOption(value);',
      '});',
    ],
  },
  {
    expression: 'I upload {string} to {string}',
    helperImports: ['resolveActionTarget'],
    importExpect: false,
    keywords: ['When'],
    lines: [
      "When('I upload {string} to {string}', async ({ page }, filePath: string, target: string) => {",
      '  await resolveActionTarget(page, target).setInputFiles(filePath);',
      '});',
    ],
  },
  {
    expression: 'I should not see {string}',
    helperImports: ['resolveVisibilityTarget'],
    importExpect: true,
    keywords: ['Then'],
    lines: [
      "Then('I should not see {string}', async ({ page }, target: string) => {",
      '  await expect(resolveVisibilityTarget(page, target)).not.toBeVisible();',
      '});',
    ],
  },
]);

function normalizeDisplayPath(value) {
  return value.split(path.sep).join('/');
}

function replaceOnce(content, target, replacement, label) {
  const index = content.indexOf(target);
  if (index === -1) {
    throw new Error(`Template ${label} is missing token ${target}.`);
  }

  return `${content.slice(0, index)}${replacement}${content.slice(index + target.length)}`;
}

function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

function assertFileExists(filePath, description) {
  if (!pathExists(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${description} is missing at ${normalizeDisplayPath(filePath)}.`);
  }
}

function assertDirectoryExists(dirPath, description) {
  if (!pathExists(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${description} is missing at ${normalizeDisplayPath(dirPath)}.`);
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function resolvePackageRoot() {
  return path.resolve(__dirname, '..');
}

function resolveTemplatesDir() {
  return path.join(resolvePackageRoot(), 'templates', 'qa-run');
}

function getHarnessCommandPrefix(env = process.env) {
  const rawPrefix = typeof env.QA_HARNESS_COMMAND_PREFIX === 'string'
    ? env.QA_HARNESS_COMMAND_PREFIX.trim()
    : '';
  return rawPrefix || DEFAULT_HARNESS_COMMAND_PREFIX;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRunId(now, intent, sourceRef) {
  const timestamp = (now instanceof Date ? now : new Date(now))
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

  const basename = path.basename(sourceRef, path.extname(sourceRef));
  const slug = slugify(basename) || 'run';
  return `${timestamp}-${intent}-${slug}`;
}

function resolveDisplayPath(repoRoot, targetPath) {
  const relativePath = path.relative(repoRoot, targetPath);
  if (!relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return normalizeDisplayPath(relativePath || '.');
  }

  return normalizeDisplayPath(targetPath);
}

function resolveRunDirDisplay(repoRoot, runPaths) {
  return normalizeDisplayPath(path.relative(repoRoot, runPaths.runDir));
}

function formatVerifyRunSummary(result) {
  return `${result.exportedStepCount} exported steps, ${result.listedTestCount} listed tests`;
}

function formatClarifierSummary(request) {
  const constraintCount = Array.isArray(request.constraints) ? request.constraints.length : 0;
  const constraintSummary = constraintCount > 0 ? `; ${constraintCount} constraint${constraintCount === 1 ? '' : 's'}` : '';
  return (
    `normalized feature-backed ${request.intent} request from ${request.sourceRefDisplay}; ` +
    `mode=${request.mode}; scope=${request.scope}${constraintSummary}`
  );
}

function formatExistingRunPrepareSummary(runId, runPathDisplay, constraints) {
  const constraintCount = Array.isArray(constraints) ? constraints.length : 0;
  const constraintSummary = constraintCount > 0 ? `; ${constraintCount} constraint${constraintCount === 1 ? '' : 's'}` : '';
  return `reloaded existing run ${runId} from ${sanitizeInlineCode(runPathDisplay)} for in-place planner refinement${constraintSummary}`;
}

function formatPlannerSummary(featureMetadata) {
  const featureTitle = featureMetadata && featureMetadata.featureTitle
    ? sanitizeInlineCode(featureMetadata.featureTitle)
    : 'normalized feature';
  const scenarioCount = Number.isInteger(featureMetadata && featureMetadata.scenarioCount)
    ? featureMetadata.scenarioCount
    : 0;
  const scenarioLabel = `${scenarioCount} scenario${scenarioCount === 1 ? '' : 's'}`;
  return `refined PRD.md, progress.md, and PROMPT.md for ${featureTitle} (${scenarioLabel})`;
}

function parseFeatureMetadata(featureText, sourceDisplayPath) {
  const featureMatch = featureText.match(/^\s*Feature:\s*(.+)$/m);
  const scenarioMatches = Array.from(featureText.matchAll(/^\s*Scenario(?: Outline)?:\s*(.+)$/gm));
  const scenarioTitles = scenarioMatches.map((match) => match[1].trim()).filter(Boolean);

  return {
    featureTitle: featureMatch ? featureMatch[1].trim() : path.basename(sourceDisplayPath, '.feature'),
    scenarioCount: scenarioTitles.length,
    scenarioTitles,
    primaryScenarioTitle: scenarioTitles[0] || '',
  };
}

function validateRequestEnvelope(request, options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const intent = request.intent;
  const sourceType = request.sourceType;
  const sourceRef = request.sourceRef;
  const mode = request.mode || 'standard';
  const scope = request.scope || 'single-feature';
  const constraints = Array.isArray(request.constraints)
    ? request.constraints.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    : [];

  if (!ALLOWED_INTENTS.has(intent)) {
    throw new Error(`Unsupported intent "${intent}". Expected one of: ${Array.from(ALLOWED_INTENTS).join(', ')}.`);
  }

  if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
    throw new Error(
      `Unsupported source type "${sourceType}". Expected one of: ${Array.from(ALLOWED_SOURCE_TYPES).join(', ')}.`,
    );
  }

  if (sourceType !== 'feature') {
    throw new Error(`This bootstrap slice only supports --source-type feature. Received "${sourceType}".`);
  }

  if (!sourceRef) {
    throw new Error('Missing required option --source-ref for create-run.');
  }

  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(`Unsupported mode "${mode}". Expected one of: ${Array.from(ALLOWED_MODES).join(', ')}.`);
  }

  if (!ALLOWED_SCOPES.has(scope)) {
    throw new Error(`Unsupported scope "${scope}". Expected one of: ${Array.from(ALLOWED_SCOPES).join(', ')}.`);
  }

  const sourcePath = path.resolve(repoRoot, sourceRef);
  assertFileExists(sourcePath, 'Feature source');

  if (path.extname(sourcePath).toLowerCase() !== '.feature') {
    throw new Error(`Feature source must end with .feature. Received ${normalizeDisplayPath(sourcePath)}.`);
  }

  return {
    intent,
    sourceType,
    sourceRef: sourcePath,
    sourceRefDisplay: resolveDisplayPath(repoRoot, sourcePath),
    mode,
    scope,
    constraints,
  };
}

function hasMeaningfulString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeConstraintList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const uniqueConstraints = new Set();
  const normalizedConstraints = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalizedValue = sanitizeInlineCode(value);
    if (!normalizedValue || uniqueConstraints.has(normalizedValue)) {
      continue;
    }

    uniqueConstraints.add(normalizedValue);
    normalizedConstraints.push(normalizedValue);
  }

  return normalizedConstraints;
}

function extractFreeformPrepareRunField(requestText, definitions, label, defaultValue) {
  const matchedValues = Array.from(
    new Set(
      definitions
        .filter((entry) => entry.pattern.test(requestText))
        .map((entry) => entry.value),
    ),
  );

  if (matchedValues.length > 1) {
    throw new Error(
      `Freeform prepare-run request is ambiguous about ${label}. Matched: ${matchedValues.join(', ')}.`,
    );
  }

  return matchedValues[0] || defaultValue;
}

function extractFreeformPrepareRunFeaturePath(requestText, repoRoot) {
  const candidatePattern =
    /(?:^|[\s"'`(])((?:[A-Za-z]:)?(?:\.{1,2}[\\/])?(?:[^\s"'`()]+[\\/])*[^\s"'`()]+\.feature)(?=$|[\s"'`),.;:])/gi;
  const candidateMap = new Map();

  for (const match of requestText.matchAll(candidatePattern)) {
    const candidate = match[1].trim();
    if (!candidate) {
      continue;
    }

    const resolvedPath = path.resolve(repoRoot, candidate);
    const relativePath = normalizeDisplayPath(path.relative(repoRoot, resolvedPath));
    const recognizableFeaturePath =
      /(^|[\\/])Features([\\/]|$)/i.test(candidate)
      || /(^|[\\/])Features([\\/]|$)/i.test(relativePath)
      || (pathExists(resolvedPath) && fs.statSync(resolvedPath).isFile());

    if (!recognizableFeaturePath) {
      continue;
    }

    candidateMap.set(resolvedPath, {
      candidate,
      displayPath: resolveDisplayPath(repoRoot, resolvedPath),
    });
  }

  const candidates = Array.from(candidateMap.values());
  if (candidates.length === 0) {
    throw new Error(
      'Freeform prepare-run requests must include one concrete local feature path such as Features/homepage.feature.',
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      `Freeform prepare-run must reference exactly one local feature path. Found ${candidates.length}: ${candidates.map((entry) => entry.displayPath).join(', ')}.`,
    );
  }

  return candidates[0].candidate;
}

function normalizeFreeformPrepareRunRequest(request, options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const requestText = sanitizeInlineCode(request && request.request);

  if (!requestText) {
    throw new Error('Freeform prepare-run requires a non-empty operator request.');
  }

  if (/\b(?:jira|ticket)\b/i.test(requestText) || /\b[A-Z][A-Z0-9]+-\d+\b/u.test(requestText)) {
    throw new Error(
      'Freeform prepare-run only supports local feature-backed requests. Jira or ticket intake is not supported in this slice.',
    );
  }

  if (
    /(?:^|[\s"'`(])(?:[^\s"'`()]+[\\/])*(?:PRD\.md|PROMPT\.md|progress\.md|[^\s"'`()]+\.spec\.[cm]?[jt]sx?|[^\s"'`()]+\.test\.[cm]?[jt]sx?)(?=$|[\s"'`),.;:])/i
      .test(requestText)
  ) {
    throw new Error(
      'Freeform prepare-run only supports local .feature sources. Non-feature artifact or spec intake is not supported in this slice.',
    );
  }

  const featurePath = extractFreeformPrepareRunFeaturePath(requestText, repoRoot);
  const normalizedRequest = {
    intent: extractFreeformPrepareRunField(
      requestText,
      PREPARE_RUN_FREEFORM_INTENT_PATTERNS,
      'intent',
      PREPARE_RUN_FREEFORM_DEFAULTS.intent,
    ),
    sourceType: 'feature',
    sourceRef: featurePath,
    mode: extractFreeformPrepareRunField(
      requestText,
      PREPARE_RUN_FREEFORM_MODE_PATTERNS,
      'mode',
      PREPARE_RUN_FREEFORM_DEFAULTS.mode,
    ),
    scope: extractFreeformPrepareRunField(
      requestText,
      PREPARE_RUN_FREEFORM_SCOPE_PATTERNS,
      'scope',
      PREPARE_RUN_FREEFORM_DEFAULTS.scope,
    ),
    constraints: Array.isArray(request && request.constraints) ? request.constraints : [],
  };

  return validateRequestEnvelope(normalizedRequest, { repoRoot });
}

function clarifyPrepareRunRequest(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const request = options.request || {};
  const hasFreeformRequest = hasMeaningfulString(request.request);
  const hasStructuredFields = ['intent', 'sourceType', 'sourceRef', 'mode', 'scope']
    .some((key) => hasMeaningfulString(request[key]));
  let normalizedRequest;

  if (hasFreeformRequest && hasStructuredFields) {
    throw new Error('Prepare-run accepts either the structured feature-backed form or --request, but not both.');
  }

  if (hasFreeformRequest) {
    normalizedRequest = normalizeFreeformPrepareRunRequest(request, { repoRoot });
  } else {
    normalizedRequest = validateRequestEnvelope(request, { repoRoot });
  }

  return {
    request: normalizedRequest,
    summary: formatClarifierSummary(normalizedRequest),
  };
}

function resolveRunPaths(repoRoot, runId) {
  const runDir = path.join(repoRoot, '.qa-harness', 'runs', runId);
  const evidenceDir = path.join(runDir, 'evidence');
  const logsDir = path.join(runDir, 'logs');
  const outputsDir = path.join(runDir, 'outputs');

  return {
    runId,
    runDir,
    prdPath: path.join(runDir, 'PRD.md'),
    progressPath: path.join(runDir, 'progress.md'),
    promptPath: path.join(runDir, 'PROMPT.md'),
    normalizedFeaturePath: path.join(runDir, 'normalized.feature'),
    evidenceDir,
    screenshotsDir: path.join(evidenceDir, 'screenshots'),
    snapshotsDir: path.join(evidenceDir, 'snapshots'),
    tracesDir: path.join(evidenceDir, 'traces'),
    videosDir: path.join(evidenceDir, 'videos'),
    logsDir,
    runtimeLogPath: path.join(logsDir, 'runtime.log'),
    verifierLogPath: path.join(logsDir, 'verifier.log'),
    fallbackLogPath: path.join(logsDir, 'fallback.log'),
    outputsDir,
    gapAnalysisPath: path.join(outputsDir, 'gap-analysis.md'),
    plannerHandoffPath: path.join(outputsDir, 'planner-handoff.md'),
    promotionReportPath: path.join(outputsDir, 'promotion-report.md'),
    scenarioAdditionPath: path.join(outputsDir, 'scenario-addition.md'),
    healReportPath: path.join(outputsDir, 'heal-report.md'),
    loopReportPath: path.join(outputsDir, 'loop-report.md'),
  };
}

function ensureRunTree(runPaths) {
  for (const key of REQUIRED_DIR_KEYS) {
    fs.mkdirSync(runPaths[key], { recursive: true });
  }
}

function stampPrdTemplate(template, data) {
  let content = template;

  content = replaceOnce(content, '<run-id>', data.runId, 'PRD.md');
  content = replaceOnce(content, '<intent>', data.intent, 'PRD.md');
  content = replaceOnce(content, '<mode>', data.mode, 'PRD.md');
  content = replaceOnce(content, '<source-type>', data.sourceType, 'PRD.md');
  content = replaceOnce(content, '<ticket, file, scenario, or run>', data.sourceRefDisplay, 'PRD.md');
  content = replaceOnce(content, 'Describe the exact QA outcome this run must achieve.', data.objective, 'PRD.md');
  content = replaceOnce(content, '<scenario or feature area>', data.primaryScenarioScope, 'PRD.md');
  content = replaceOnce(content, '<optional>', 'not provided', 'PRD.md');
  content = replaceOnce(content, '<optional>', data.sourceRefDisplay, 'PRD.md');
  content = replaceOnce(content, '<optional>', 'not provided', 'PRD.md');
  content = replaceOnce(content, '<optional>', data.userGuidance, 'PRD.md');
  content = replaceOnce(content, '<criterion 1>', data.successCriteria[0], 'PRD.md');
  content = replaceOnce(content, '<criterion 2>', data.successCriteria[1], 'PRD.md');
  content = replaceOnce(content, '<criterion 3>', data.successCriteria[2], 'PRD.md');
  content = replaceOnce(content, '<out of scope 1>', data.outOfScope[0], 'PRD.md');
  content = replaceOnce(content, '<out of scope 2>', data.outOfScope[1], 'PRD.md');
  content = replaceOnce(content, '<gap 1>', data.knownGaps[0], 'PRD.md');
  content = replaceOnce(content, '<gap 2>', data.knownGaps[1], 'PRD.md');
  content = replaceOnce(content, '<command or procedure>', data.verification.command, 'PRD.md');
  content = replaceOnce(content, '<snapshot, trace, output, scenario pass>', data.verification.evidence, 'PRD.md');

  if (data.constraints.length > 0) {
    const marker = '- Keep work atomic enough for one progress item per iteration.';
    const injectedConstraints = data.constraints.map((constraint) => `- User constraint: ${constraint}`).join('\n');
    content = replaceOnce(content, marker, `${marker}\n${injectedConstraints}`, 'PRD.md');
  }

  return content;
}

function stampPromptTemplate(template, data) {
  let content = template;

  content = replaceOnce(content, '<run-id>', data.runId, 'PROMPT.md');
  content = replaceOnce(content, '<intent>', data.intent, 'PROMPT.md');
  content = replaceOnce(content, '<mode>', data.mode, 'PROMPT.md');
  content = replaceOnce(content, '<source-ref>', data.sourceRefDisplay, 'PROMPT.md');

  return content;
}

function stampProgressTemplate(template, data) {
  let content = template;

  content = content.replace(/npm run qa:orchestrator --/g, getHarnessCommandPrefix());
  content = replaceOnce(content, '<run-id>', data.runId, 'progress.md');
  content = replaceOnce(content, '<run-id>', data.runId, 'progress.md');
  content = replaceOnce(content, '<small atomic goal>', 'one small, verifiable goal', 'progress.md');
  content = replaceOnce(content, '<single source>', 'one source artifact', 'progress.md');
  content = replaceOnce(content, '<single artifact or code change>', 'one artifact or code change', 'progress.md');
  content = replaceOnce(content, '<single proof step>', 'one proof step', 'progress.md');
  content = replaceOnce(content, '<agent>', 'qa-agent', 'progress.md');
  content = replaceOnce(content, '<jira ticket or feature path>', data.sourceRefDisplay, 'progress.md');

  return content;
}

function createRun(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const request = validateRequestEnvelope(options.request, { repoRoot });
  const featureContent = readText(request.sourceRef);
  const featureMetadata = parseFeatureMetadata(featureContent, request.sourceRefDisplay);
  const runId = createRunId(options.now || new Date(), request.intent, request.sourceRefDisplay);
  const runPaths = resolveRunPaths(repoRoot, runId);

  ensureRunTree(runPaths);

  const prdTemplate = readText(path.join(templatesDir, 'PRD.md'));
  const progressTemplate = readText(path.join(templatesDir, 'progress.md'));
  const promptTemplate = readText(path.join(templatesDir, 'PROMPT.md'));

  const prdContent = stampPrdTemplate(prdTemplate, {
    runId,
    intent: request.intent,
    mode: request.mode,
    sourceType: request.sourceType,
    sourceRefDisplay: request.sourceRefDisplay,
    primaryScenarioScope: featureMetadata.featureTitle,
    constraints: request.constraints,
    objective: `Prepare and execute a feature-backed QA harness run for ${request.sourceRefDisplay} so the verifier can prove the artifact set is complete and the executor can prove one generated scenario passes on Chromium.`,
    userGuidance: request.constraints.length > 0 ? request.constraints.join('; ') : 'not provided',
    successCriteria: [
      `normalized.feature preserves the source feature from ${request.sourceRefDisplay} for this bootstrap slice.`,
      `Verification succeeds via ${buildHarnessCommandDescription('verify-run', { runId })}.`,
      `Execution succeeds via ${buildHarnessCommandDescription('execute-run', {
        runId,
        executionControls: {
          shouldPersist: false,
          controls: {
            ...DEFAULT_EXECUTION_CONTROLS,
            project: 'chromium',
          },
        },
        includeProject: true,
      })}, with runtime proof recorded in logs/runtime.log.`,
    ],
    outOfScope: [
      'Jira ingestion, scenario extraction, and non-feature source normalization are deferred.',
      'Fresh-session loop orchestration, healing automation, and exploratory coverage expansion are deferred.',
    ],
    knownGaps: [
      'Feature normalization is identity-only in this slice.',
      'Execution is limited to generated Playwright specs; there is no autonomous Ralph loop yet.',
    ],
    verification: {
      command: buildHarnessCommandDescription('execute-run', {
        runId,
        executionControls: {
          shouldPersist: false,
          controls: {
            ...DEFAULT_EXECUTION_CONTROLS,
            project: 'chromium',
          },
        },
        includeProject: true,
      }),
      evidence: 'verifier log, runtime log, generated Playwright specs, Playwright pass output',
    },
  });

  const progressContent = stampProgressTemplate(progressTemplate, {
    runId,
    sourceRefDisplay: request.sourceRefDisplay,
  });
  const promptContent = stampPromptTemplate(promptTemplate, {
    runId,
    intent: request.intent,
    mode: request.mode,
    sourceRefDisplay: request.sourceRefDisplay,
  });

  writeText(runPaths.prdPath, prdContent);
  writeText(runPaths.progressPath, progressContent);
  writeText(runPaths.promptPath, promptContent);
  writeText(runPaths.normalizedFeaturePath, featureContent);
  writeText(runPaths.runtimeLogPath, '');
  writeText(runPaths.verifierLogPath, '');
  writeText(runPaths.fallbackLogPath, '');
  writeText(runPaths.gapAnalysisPath, `# ${GAP_ANALYSIS_ARTIFACT_TITLE}\n\nNot started.\n`);
  writeText(runPaths.plannerHandoffPath, `# ${PLANNER_HANDOFF_ARTIFACT_TITLE}\n\nNot started.\n`);
  writeText(runPaths.promotionReportPath, `# ${PROMOTION_REPORT_ARTIFACT_TITLE}\n\nNot started.\n`);
  writeText(runPaths.scenarioAdditionPath, `# ${SCENARIO_ADDITION_ARTIFACT_TITLE}\n\nNot started.\n`);
  writeText(runPaths.healReportPath, `# ${HEAL_REPORT_ARTIFACT_TITLE}\n\nNot started.\n`);

  return {
    request,
    runId,
    runPaths,
    featureMetadata,
  };
}

function recordClarifierSummaryInArtifacts(runPaths, summary) {
  if (!runPaths || !runPaths.prdPath || !pathExists(runPaths.prdPath)) {
    return;
  }

  const normalizedSummary = sanitizeInlineCode(summary);
  const prdContent = readText(runPaths.prdPath);
  if (prdContent.includes('## Request Normalization')) {
    return;
  }

  const section = [
    '## Request Normalization',
    '',
    '- Clarifier status: `accepted`',
    `- Clarifier summary: \`${normalizedSummary}\``,
  ].join('\n');

  writeText(runPaths.prdPath, `${prdContent.replace(/\s*$/, '')}\n\n${section}\n`);
}

function normalizeMarkdownSpacing(content) {
  const normalizedContent = String(content)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/g, '')
    .trimEnd();

  return normalizedContent ? `${normalizedContent}\n` : '';
}

function getMarkdownSectionRanges(content, title) {
  const headings = getMarkdownSectionHeadings(content);
  const ranges = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading.title !== title) {
      continue;
    }

    ranges.push({
      start: heading.start,
      end: index + 1 < headings.length ? headings[index + 1].start : content.length,
    });
  }

  return ranges;
}

function readMarkdownSectionBody(content, title) {
  const ranges = getMarkdownSectionRanges(content, title);
  if (ranges.length === 0) {
    return '';
  }

  const sectionContent = content.slice(ranges[0].start, ranges[0].end);
  const bodyMatch = sectionContent.match(/^##\s+.+\r?\n([\s\S]*)$/);
  return bodyMatch ? bodyMatch[1].replace(/^\r?\n/, '').trim() : '';
}

function upsertMarkdownSection(content, title, body) {
  const normalizedBody = String(body == null ? '' : body).replace(/^\s+|\s+$/g, '');
  const sectionRanges = getMarkdownSectionRanges(content, title);

  if (sectionRanges.length === 0) {
    if (!normalizedBody) {
      return normalizeMarkdownSpacing(content);
    }

    return normalizeMarkdownSpacing(`${content.replace(/\s*$/, '')}\n\n## ${title}\n\n${normalizedBody}\n`);
  }

  let updatedContent = content;
  for (let index = sectionRanges.length - 1; index >= 1; index -= 1) {
    const range = sectionRanges[index];
    updatedContent = `${updatedContent.slice(0, range.start)}${updatedContent.slice(range.end)}`;
  }

  const firstRange = sectionRanges[0];
  const replacement = normalizedBody ? `## ${title}\n\n${normalizedBody}\n\n` : '';
  updatedContent = `${updatedContent.slice(0, firstRange.start)}${replacement}${updatedContent.slice(firstRange.end)}`;

  return normalizeMarkdownSpacing(updatedContent);
}

function stripMarkdownInlineCode(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return sanitizeOptionalInlineCode(value.trim().replace(/^`|`$/g, '').trim());
}

function resolvePlannerSourceRefDisplay(artifactSet, options = {}) {
  const candidates = [
    options.request && options.request.sourceRefDisplay,
    stripMarkdownInlineCode(readMarkdownSummaryField(artifactSet.prdContent, 'Feature input')),
    stripMarkdownInlineCode(readMarkdownSummaryField(artifactSet.prdContent, 'Source reference')),
    stripMarkdownInlineCode(readMarkdownSummaryField(artifactSet.promptContent, 'Source reference')),
  ];

  for (const candidate of candidates) {
    if (!candidate || /^not provided$/i.test(candidate)) {
      continue;
    }

    return sanitizeInlineCode(candidate);
  }

  return 'normalized.feature';
}

function readRecordedPlannerConstraints(prdContent) {
  if (typeof prdContent !== 'string' || !prdContent.trim()) {
    return [];
  }

  return normalizeConstraintList(
    Array.from(prdContent.matchAll(/^- User constraint:\s*(.+)$/gm))
      .map((match) => sanitizeInlineCode(match[1])),
  );
}

function parseBooleanOptionValue(value, optionName) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalizedValue) {
    throw new Error(`Missing value for option ${optionName}.`);
  }

  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalizedValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${optionName} must be one of: true, false, yes, no, on, off, 1, 0.`);
}

function formatExecutionControlToggle(value) {
  return value ? 'enabled' : 'disabled';
}

function normalizeOptionalExecutionControlValue(value, fallback = '') {
  const normalizedValue = sanitizeOptionalInlineCode(value);
  return normalizedValue || fallback;
}

function parseRequestedProjectValue(value) {
  const match = sanitizeOptionalInlineCode(value).match(/--project(?:=|\s+)([^\s`]+)/);
  return match ? match[1] : '';
}

function readRecordedExecutionControls(prdContent, options = {}) {
  if (getMarkdownSectionRanges(prdContent, 'Execution Controls').length === 0) {
    return null;
  }

  const fallbackProject = normalizeOptionalExecutionControlValue(
    options.defaultProject,
    DEFAULT_EXECUTION_CONTROLS.project,
  );
  const readBooleanField = (label, fallbackValue) => {
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
  };
  const readOptionalField = (label) => {
    const rawValue = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, label));
    return /^not set$/i.test(rawValue) ? '' : sanitizeOptionalInlineCode(rawValue);
  };

  return {
    project: normalizeOptionalExecutionControlValue(
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Browser project')),
      fallbackProject,
    ),
    headed: readBooleanField('Headed execution', DEFAULT_EXECUTION_CONTROLS.headed),
    debug: readBooleanField('Debug execution', DEFAULT_EXECUTION_CONTROLS.debug),
    baseUrl: readOptionalField('Base URL override'),
    targetEnv: readOptionalField('Target environment'),
    trace: normalizeOptionalExecutionControlValue(
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Trace setting')),
      DEFAULT_EXECUTION_CONTROLS.trace,
    ),
    video: normalizeOptionalExecutionControlValue(
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Video setting')),
      DEFAULT_EXECUTION_CONTROLS.video,
    ),
    screenshot: normalizeOptionalExecutionControlValue(
      stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Screenshot setting')),
      DEFAULT_EXECUTION_CONTROLS.screenshot,
    ),
  };
}

function readExplicitExecutionControlOverrides(options = {}) {
  const overrides = {};

  if (hasMeaningfulString(options.project)) {
    overrides.project = sanitizeInlineCode(options.project);
  }

  if (Object.prototype.hasOwnProperty.call(options, 'headed') && options.headed !== undefined) {
    overrides.headed = parseBooleanOptionValue(options.headed, '--headed');
  }

  if (Object.prototype.hasOwnProperty.call(options, 'debug') && options.debug !== undefined) {
    overrides.debug = parseBooleanOptionValue(options.debug, '--debug');
  }

  if (hasMeaningfulString(options.baseUrl)) {
    overrides.baseUrl = sanitizeInlineCode(options.baseUrl);
  }

  if (hasMeaningfulString(options.targetEnv)) {
    overrides.targetEnv = sanitizeInlineCode(options.targetEnv);
  }

  if (hasMeaningfulString(options.trace)) {
    overrides.trace = sanitizeInlineCode(options.trace);
  }

  if (hasMeaningfulString(options.video)) {
    overrides.video = sanitizeInlineCode(options.video);
  }

  if (hasMeaningfulString(options.screenshot)) {
    overrides.screenshot = sanitizeInlineCode(options.screenshot);
  }

  return overrides;
}

function resolveExecutionControls(options = {}) {
  const artifactSet = options.artifactSet || null;
  const prdContent = options.prdContent || (artifactSet && artifactSet.prdContent) || '';
  const defaultProject = normalizeOptionalExecutionControlValue(
    options.defaultProject,
    DEFAULT_EXECUTION_CONTROLS.project,
  );
  const recordedControls = readRecordedExecutionControls(prdContent, { defaultProject });
  const explicitOverrides = readExplicitExecutionControlOverrides(options);
  const hasExplicitOverrides = Object.keys(explicitOverrides).length > 0;
  const controls = {
    project: normalizeOptionalExecutionControlValue(
      explicitOverrides.project,
      recordedControls ? recordedControls.project : defaultProject,
    ),
    headed:
      Object.prototype.hasOwnProperty.call(explicitOverrides, 'headed')
        ? explicitOverrides.headed
        : recordedControls
          ? recordedControls.headed
          : DEFAULT_EXECUTION_CONTROLS.headed,
    debug:
      Object.prototype.hasOwnProperty.call(explicitOverrides, 'debug')
        ? explicitOverrides.debug
        : recordedControls
          ? recordedControls.debug
          : DEFAULT_EXECUTION_CONTROLS.debug,
    baseUrl:
      Object.prototype.hasOwnProperty.call(explicitOverrides, 'baseUrl')
        ? explicitOverrides.baseUrl
        : recordedControls
          ? recordedControls.baseUrl
          : '',
    targetEnv:
      Object.prototype.hasOwnProperty.call(explicitOverrides, 'targetEnv')
        ? explicitOverrides.targetEnv
        : recordedControls
          ? recordedControls.targetEnv
          : '',
    trace: normalizeOptionalExecutionControlValue(
      explicitOverrides.trace,
      recordedControls ? recordedControls.trace : DEFAULT_EXECUTION_CONTROLS.trace,
    ),
    video: normalizeOptionalExecutionControlValue(
      explicitOverrides.video,
      recordedControls ? recordedControls.video : DEFAULT_EXECUTION_CONTROLS.video,
    ),
    screenshot: normalizeOptionalExecutionControlValue(
      explicitOverrides.screenshot,
      recordedControls ? recordedControls.screenshot : DEFAULT_EXECUTION_CONTROLS.screenshot,
    ),
  };

  return {
    controls,
    recordedControls,
    explicitOverrides,
    hasExplicitOverrides,
    shouldPersist: hasExplicitOverrides || Boolean(recordedControls),
  };
}

function buildExecutionControlsPrdSection(controls) {
  return [
    `- Browser project: \`${sanitizeInlineCode(controls.project || DEFAULT_EXECUTION_CONTROLS.project)}\``,
    `- Headed execution: \`${formatExecutionControlToggle(controls.headed)}\``,
    `- Debug execution: \`${formatExecutionControlToggle(controls.debug)}\``,
    `- Base URL override: \`${sanitizeInlineCode(controls.baseUrl || 'not set')}\``,
    `- Target environment: \`${sanitizeInlineCode(controls.targetEnv || 'not set')}\``,
    `- Trace setting: \`${sanitizeInlineCode(controls.trace || DEFAULT_EXECUTION_CONTROLS.trace)}\``,
    `- Video setting: \`${sanitizeInlineCode(controls.video || DEFAULT_EXECUTION_CONTROLS.video)}\``,
    `- Screenshot setting: \`${sanitizeInlineCode(controls.screenshot || DEFAULT_EXECUTION_CONTROLS.screenshot)}\``,
  ].join('\n');
}

function buildExecutionControlsPromptSection(controls) {
  return [
    `- Browser project: \`${sanitizeInlineCode(controls.project || DEFAULT_EXECUTION_CONTROLS.project)}\``,
    `- Headed execution: \`${formatExecutionControlToggle(controls.headed)}\``,
    `- Debug execution: \`${formatExecutionControlToggle(controls.debug)}\``,
    `- Base URL override: \`${sanitizeInlineCode(controls.baseUrl || 'not set')}\``,
    `- Target environment: \`${sanitizeInlineCode(controls.targetEnv || 'not set')}\``,
    `- Trace setting: \`${sanitizeInlineCode(controls.trace || DEFAULT_EXECUTION_CONTROLS.trace)}\``,
    `- Video setting: \`${sanitizeInlineCode(controls.video || DEFAULT_EXECUTION_CONTROLS.video)}\``,
    `- Screenshot setting: \`${sanitizeInlineCode(controls.screenshot || DEFAULT_EXECUTION_CONTROLS.screenshot)}\``,
    '- Reuse the recorded execution controls for verifier, executor, healer, and explorer work.',
  ].join('\n');
}

function persistExecutionControls(artifactSet, executionControlState) {
  if (!artifactSet || !executionControlState || !executionControlState.shouldPersist) {
    return artifactSet;
  }

  const nextPrdContent = upsertMarkdownSection(
    artifactSet.prdContent,
    'Execution Controls',
    buildExecutionControlsPrdSection(executionControlState.controls),
  );
  const nextPromptContent = upsertMarkdownSection(
    artifactSet.promptContent,
    'Execution Controls Context',
    buildExecutionControlsPromptSection(executionControlState.controls),
  );

  if (nextPrdContent !== artifactSet.prdContent) {
    writeText(artifactSet.runPaths.prdPath, nextPrdContent);
  }

  if (nextPromptContent !== artifactSet.promptContent) {
    writeText(artifactSet.runPaths.promptPath, nextPromptContent);
  }

  return {
    ...artifactSet,
    prdContent: nextPrdContent,
    promptContent: nextPromptContent,
  };
}

function buildExecutionControlCliArgs(controls, options = {}) {
  if (!controls) {
    return [];
  }

  const args = [];
  if (options.includeProject !== false) {
    args.push('--project', sanitizeInlineCode(controls.project || DEFAULT_EXECUTION_CONTROLS.project));
  }

  if (controls.headed) {
    args.push('--headed', 'true');
  }

  if (controls.debug) {
    args.push('--debug', 'true');
  }

  if (controls.baseUrl) {
    args.push('--base-url', sanitizeInlineCode(controls.baseUrl));
  }

  if (controls.targetEnv) {
    args.push('--target-env', sanitizeInlineCode(controls.targetEnv));
  }

  if (options.includeEvidenceSettings) {
    args.push('--trace', sanitizeInlineCode(controls.trace || DEFAULT_EXECUTION_CONTROLS.trace));
    args.push('--video', sanitizeInlineCode(controls.video || DEFAULT_EXECUTION_CONTROLS.video));
    args.push('--screenshot', sanitizeInlineCode(controls.screenshot || DEFAULT_EXECUTION_CONTROLS.screenshot));
  }

  return args;
}

function buildHarnessCommandDescription(commandName, options = {}) {
  const commandParts = [getHarnessCommandPrefix(options.env), commandName];

  if (hasMeaningfulString(options.runId)) {
    commandParts.push('--run-id', options.runId);
  }

  if (hasMeaningfulString(options.adapter)) {
    commandParts.push('--adapter', options.adapter);
  }

  if (options.maxIterations != null) {
    commandParts.push('--max-iterations', String(options.maxIterations));
  }

  if (options.executionControls && (options.executionControls.shouldPersist || options.includeProject)) {
    commandParts.push(
      ...buildExecutionControlCliArgs(options.executionControls.controls, {
        includeProject: options.includeProject !== false,
        includeEvidenceSettings: options.executionControls.shouldPersist,
      }),
    );
  }

  return [commandParts[0], ...commandParts.slice(1).map(formatCommandArg)].join(' ');
}

function buildExecutionControlLogLines(controls) {
  if (!controls) {
    return [];
  }

  return [
    `Project: ${sanitizeInlineCode(controls.project || DEFAULT_EXECUTION_CONTROLS.project)}`,
    `Headed execution: ${formatExecutionControlToggle(controls.headed)}`,
    `Debug execution: ${formatExecutionControlToggle(controls.debug)}`,
    `Base URL override: ${sanitizeInlineCode(controls.baseUrl || 'not set')}`,
    `Target environment: ${sanitizeInlineCode(controls.targetEnv || 'not set')}`,
    `Trace setting: ${sanitizeInlineCode(controls.trace || DEFAULT_EXECUTION_CONTROLS.trace)}`,
    `Video setting: ${sanitizeInlineCode(controls.video || DEFAULT_EXECUTION_CONTROLS.video)}`,
    `Screenshot setting: ${sanitizeInlineCode(controls.screenshot || DEFAULT_EXECUTION_CONTROLS.screenshot)}`,
  ];
}

function resolvePlannerConstraints(options = {}) {
  return normalizeConstraintList([
    ...readRecordedPlannerConstraints(
      options.prdContent || (options.artifactSet && options.artifactSet.prdContent) || '',
    ),
    ...(Array.isArray(options.request && options.request.constraints) ? options.request.constraints : []),
    ...(Array.isArray(options.constraints) ? options.constraints : []),
  ]);
}

function parseRunMode(prdContent) {
  const mode = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Mode')).toLowerCase();
  return ALLOWED_MODES.has(mode) ? mode : 'standard';
}

function splitGuidedConstraintValues(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  return normalizeStringList(value.split(/\s*[;,]\s*/u));
}

function parseGuidedExplorationConstraintFields(constraints) {
  const featureScopes = [];
  const scenarioScopes = [];
  const riskAreas = [];
  let iterationBudget = null;

  for (const constraint of normalizeConstraintList(constraints)) {
    let match = constraint.match(
      /^(?:guided\s+)?(?:feature(?:s)?|feature scope)\s*[:=]\s*(.+)$/iu,
    );
    if (match) {
      featureScopes.push(...splitGuidedConstraintValues(match[1]));
      continue;
    }

    match = constraint.match(
      /^(?:guided\s+)?(?:scenario(?:s)?|scenario scope)\s*[:=]\s*(.+)$/iu,
    );
    if (match) {
      scenarioScopes.push(...splitGuidedConstraintValues(match[1]));
      continue;
    }

    match = constraint.match(
      /^(?:guided\s+)?(?:risk(?:\s+area)?(?:s)?|risk scope|risk focus|risk focus areas)\s*[:=]\s*(.+)$/iu,
    );
    if (match) {
      riskAreas.push(...splitGuidedConstraintValues(match[1]));
      continue;
    }

    match = constraint.match(
      /^(?:guided\s+)?(?:iteration budget|exploration budget|max iterations?|budget)\s*[:=]\s*(\d+)$/iu,
    );
    if (match) {
      iterationBudget = Number.parseInt(match[1], 10);
    }
  }

  return {
    featureScopes: normalizeStringList(featureScopes),
    scenarioScopes: normalizeStringList(scenarioScopes),
    riskAreas: normalizeStringList(riskAreas),
    iterationBudget,
  };
}

function formatGuidedExplorationList(values) {
  return values.length > 0 ? values.join(', ') : 'not provided';
}

function formatGuidedExplorationCount(value) {
  return value == null ? 'not provided' : String(value);
}

function buildGuidedExplorationStopConditions(guidedExploration) {
  const stopConditions = [
    'one bounded discovery outcome per iteration',
    'stay within the selected run artifacts and selected exploration item',
  ];

  if (
    guidedExploration.featureScopes.length > 0
    || guidedExploration.scenarioScopes.length > 0
    || guidedExploration.riskAreas.length > 0
  ) {
    stopConditions.push('scope must remain within the recorded guided feature, scenario, and risk constraints');
  }

  if (guidedExploration.iterationBudget != null) {
    stopConditions.push(
      `stop after ${guidedExploration.iterationBudget} recorded guided exploration iteration(s) in ${GAP_ANALYSIS_ARTIFACT_DISPLAY}`,
    );
  }

  return stopConditions;
}

function formatGuidedExplorationScopeSummary(guidedExploration) {
  const segments = [];

  if (guidedExploration.featureScopes.length > 0) {
    segments.push(`feature: ${guidedExploration.featureScopes.join(', ')}`);
  }

  if (guidedExploration.scenarioScopes.length > 0) {
    segments.push(`scenario: ${guidedExploration.scenarioScopes.join(', ')}`);
  }

  if (guidedExploration.riskAreas.length > 0) {
    segments.push(`risk areas: ${guidedExploration.riskAreas.join(', ')}`);
  }

  return segments.join('; ');
}

function formatAutonomousExplorationCount(value) {
  return value == null ? 'not provided' : String(value);
}

function resolveGuidedExplorationScopeKind(options = {}) {
  const requestedScope = sanitizeOptionalInlineCode(options.request && options.request.scope).toLowerCase();
  if (ALLOWED_SCOPES.has(requestedScope)) {
    return requestedScope;
  }

  const recordedScope = sanitizeOptionalInlineCode(
    readMarkdownSummaryField(
      (options.artifactSet && options.artifactSet.prdContent) || options.prdContent || '',
      'Guided scope kind',
    ),
  ).toLowerCase();
  if (ALLOWED_SCOPES.has(recordedScope)) {
    return recordedScope;
  }

  return 'single-feature';
}

function countRecordedGuidedExplorationIterations(runPaths) {
  if (!runPaths || !hasMeaningfulString(runPaths.gapAnalysisPath) || !pathExists(runPaths.gapAnalysisPath)) {
    return 0;
  }

  return parseStructuredLogEntries(readText(runPaths.gapAnalysisPath)).length;
}

function countRecordedAutonomousExplorationIterations(runPaths) {
  if (!runPaths || !hasMeaningfulString(runPaths.gapAnalysisPath) || !pathExists(runPaths.gapAnalysisPath)) {
    return 0;
  }

  return parseStructuredLogEntries(readText(runPaths.gapAnalysisPath))
    .filter((entry) => /^yes$/iu.test(readStructuredLogValue(entry, 'Autonomous exploration')))
    .length;
}

function resolveAutonomousExplorationTargetSelection(options = {}) {
  const prdContent = options.prdContent || '';
  const recordedTarget = sanitizeOptionalInlineCode(
    stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Autonomous target')),
  );
  if (recordedTarget) {
    return {
      targetKind:
        sanitizeOptionalInlineCode(
          stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Autonomous target kind')),
        ).toLowerCase() || 'scenario',
      target: recordedTarget,
      targetSource:
        sanitizeOptionalInlineCode(
          stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Autonomous target source')),
        ) || 'normalized.feature:first-scenario',
    };
  }

  if (options.featureMetadata && hasMeaningfulString(options.featureMetadata.primaryScenarioTitle)) {
    return {
      targetKind: 'scenario',
      target: sanitizeInlineCode(options.featureMetadata.primaryScenarioTitle),
      targetSource: 'normalized.feature:first-scenario',
    };
  }

  return {
    targetKind: 'feature',
    target: sanitizeInlineCode(
      (options.featureMetadata && options.featureMetadata.featureTitle) || 'normalized feature',
    ),
    targetSource: 'normalized.feature:feature-title',
  };
}

function buildAutonomousExplorationStopFrame(autonomousExploration) {
  return [
    'one bounded discovery outcome per iteration',
    'stay within the selected run artifacts and selected exploration item',
    `stay within the recorded autonomous ${sanitizeInlineCode(autonomousExploration.targetKind || 'exploration')} target`,
    `stop after ${autonomousExploration.iterationBudget} recorded autonomous exploration iteration(s) in ${GAP_ANALYSIS_ARTIFACT_DISPLAY}`,
    'stop and route findings through planner review before scenario addition',
  ];
}

function resolveAutonomousExplorationPlan(options = {}) {
  const artifactSet = options.artifactSet || null;
  const prdContent = options.prdContent || (artifactSet && artifactSet.prdContent) || '';
  const intent = sanitizeOptionalInlineCode(
    options.request && options.request.intent ? options.request.intent : parseRunIntent(prdContent),
  ).toLowerCase();
  const mode = sanitizeOptionalInlineCode(
    options.request && options.request.mode ? options.request.mode : parseRunMode(prdContent),
  ).toLowerCase();

  if (intent !== 'coverage' || mode !== 'autonomous-exploratory') {
    return {
      active: false,
      targetKind: '',
      target: '',
      targetSource: '',
      iterationBudget: null,
      recordedIterations: 0,
      remainingIterations: null,
      stopFrame: [],
      stopFrameText: '',
    };
  }

  const featureMetadata =
    options.featureMetadata
    || (artifactSet
      ? parseFeatureMetadata(
        artifactSet.normalizedFeatureContent,
        resolvePlannerSourceRefDisplay(artifactSet, options),
      )
      : {
        featureTitle: 'normalized feature',
        primaryScenarioTitle: '',
      });
  const targetSelection = resolveAutonomousExplorationTargetSelection({
    ...options,
    featureMetadata,
    prdContent,
  });
  const recordedIterationBudget = parseOptionalNonNegativeInteger(
    stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Autonomous iteration budget')),
  );
  const recordedIterations = countRecordedAutonomousExplorationIterations(
    options.runPaths || (artifactSet && artifactSet.runPaths),
  );
  const iterationBudget = recordedIterationBudget == null ? 1 : Math.max(recordedIterationBudget, 1);
  const remainingIterations = Math.max(iterationBudget - recordedIterations, 0);
  const recordedStopFrame = sanitizeOptionalInlineCode(
    stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Autonomous stop frame')),
  );
  const stopFrame = recordedStopFrame
    ? recordedStopFrame.split(/\s*;\s*/u).map((value) => sanitizeInlineCode(value)).filter(Boolean)
    : buildAutonomousExplorationStopFrame({
      ...targetSelection,
      iterationBudget,
    });

  return {
    active: true,
    ...targetSelection,
    iterationBudget,
    recordedIterations,
    remainingIterations,
    stopFrame,
    stopFrameText: stopFrame.join('; '),
  };
}

function resolveGuidedExplorationPlan(options = {}) {
  const artifactSet = options.artifactSet || null;
  const prdContent = options.prdContent || (artifactSet && artifactSet.prdContent) || '';
  const intent = sanitizeOptionalInlineCode(
    options.request && options.request.intent ? options.request.intent : parseRunIntent(prdContent),
  ).toLowerCase();
  const mode = sanitizeOptionalInlineCode(
    options.request && options.request.mode ? options.request.mode : parseRunMode(prdContent),
  ).toLowerCase();

  if (intent !== 'coverage' || mode !== 'guided-exploratory') {
    return {
      active: false,
      constraints: [],
      featureScopes: [],
      scenarioScopes: [],
      riskAreas: [],
      iterationBudget: null,
      recordedIterations: 0,
      remainingIterations: null,
      scopeKind: '',
      stopConditions: [],
      stopConditionsText: '',
      scopeSummary: '',
    };
  }

  const sourceRefDisplay = options.sourceRefDisplay
    || (artifactSet ? resolvePlannerSourceRefDisplay(artifactSet, options) : 'normalized.feature');
  const featureMetadata =
    options.featureMetadata
    || (artifactSet
      ? parseFeatureMetadata(artifactSet.normalizedFeatureContent, sourceRefDisplay)
      : {
        featureTitle: 'normalized feature',
        primaryScenarioTitle: '',
      });
  const scopeKind = resolveGuidedExplorationScopeKind({
    ...options,
    artifactSet,
    prdContent,
  });
  const constraints = Array.isArray(options.plannerConstraints)
    ? normalizeConstraintList(options.plannerConstraints)
    : resolvePlannerConstraints({
      ...options,
      artifactSet,
      prdContent,
    });
  const parsedConstraintFields = parseGuidedExplorationConstraintFields(constraints);
  const featureScopes = parsedConstraintFields.featureScopes.length > 0
    ? parsedConstraintFields.featureScopes
    : (scopeKind === 'single-feature' || scopeKind === 'feature-area' || scopeKind === 'run')
      ? normalizeStringList([featureMetadata.featureTitle])
      : [];
  const scenarioScopes = parsedConstraintFields.scenarioScopes.length > 0
    ? parsedConstraintFields.scenarioScopes
    : scopeKind === 'single-scenario' && featureMetadata.primaryScenarioTitle
      ? normalizeStringList([featureMetadata.primaryScenarioTitle])
      : [];
  const recordedIterations = countRecordedGuidedExplorationIterations(
    options.runPaths || (artifactSet && artifactSet.runPaths),
  );
  const iterationBudget = parsedConstraintFields.iterationBudget;
  const remainingIterations = iterationBudget == null
    ? null
    : Math.max(iterationBudget - recordedIterations, 0);
  const guidedExploration = {
    active: true,
    constraints,
    featureScopes,
    scenarioScopes,
    riskAreas: parsedConstraintFields.riskAreas,
    iterationBudget,
    recordedIterations,
    remainingIterations,
    scopeKind,
    stopConditions: [],
    stopConditionsText: '',
    scopeSummary: '',
  };

  guidedExploration.stopConditions = buildGuidedExplorationStopConditions(guidedExploration);
  guidedExploration.stopConditionsText = guidedExploration.stopConditions.join('; ');
  guidedExploration.scopeSummary = formatGuidedExplorationScopeSummary(guidedExploration);

  return guidedExploration;
}

function buildGuidedExplorationSectionLines(guidedExploration) {
  return [
    '- Guided mode: `enabled`',
    `- Guided scope kind: \`${sanitizeInlineCode(guidedExploration.scopeKind || 'single-feature')}\``,
    `- Guided feature scope: \`${sanitizeInlineCode(formatGuidedExplorationList(guidedExploration.featureScopes))}\``,
    `- Guided scenario scope: \`${sanitizeInlineCode(formatGuidedExplorationList(guidedExploration.scenarioScopes))}\``,
    `- Guided risk areas: \`${sanitizeInlineCode(formatGuidedExplorationList(guidedExploration.riskAreas))}\``,
    `- Guided iteration budget: \`${sanitizeInlineCode(formatGuidedExplorationCount(guidedExploration.iterationBudget))}\``,
    `- Guided iterations recorded: \`${sanitizeInlineCode(formatGuidedExplorationCount(guidedExploration.recordedIterations))}\``,
    `- Guided iterations remaining: \`${sanitizeInlineCode(formatGuidedExplorationCount(guidedExploration.remainingIterations))}\``,
    `- Guided findings artifact: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
    `- Guided stop conditions: \`${sanitizeInlineCode(guidedExploration.stopConditionsText)}\``,
  ].join('\n');
}

function buildAutonomousExplorationSectionLines(autonomousExploration) {
  return [
    '- Autonomous mode: `enabled`',
    `- Autonomous target kind: \`${sanitizeInlineCode(autonomousExploration.targetKind || 'feature')}\``,
    `- Autonomous target: \`${sanitizeInlineCode(autonomousExploration.target || 'not selected')}\``,
    `- Autonomous target source: \`${sanitizeInlineCode(autonomousExploration.targetSource || 'normalized.feature')}\``,
    `- Autonomous iteration budget: \`${sanitizeInlineCode(formatAutonomousExplorationCount(autonomousExploration.iterationBudget))}\``,
    `- Autonomous iterations recorded: \`${sanitizeInlineCode(formatAutonomousExplorationCount(autonomousExploration.recordedIterations))}\``,
    `- Autonomous iterations remaining: \`${sanitizeInlineCode(formatAutonomousExplorationCount(autonomousExploration.remainingIterations))}\``,
    `- Autonomous findings artifact: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
    `- Autonomous stop frame: \`${sanitizeInlineCode(autonomousExploration.stopFrameText)}\``,
  ].join('\n');
}

function recordPlannerConstraintsInPrd(prdContent, constraints) {
  const normalizedConstraints = normalizeConstraintList(constraints);
  const existingConstraintSection = readMarkdownSectionBody(prdContent, 'Constraints');
  const baseConstraintLines = (
    existingConstraintSection
      ? existingConstraintSection.split(/\r?\n/u)
      : DEFAULT_PRD_CONSTRAINT_LINES
  )
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^- User constraint:\s*/u.test(line));
  const nextConstraintLines = [
    ...(baseConstraintLines.length > 0 ? baseConstraintLines : DEFAULT_PRD_CONSTRAINT_LINES),
    ...normalizedConstraints.map((constraint) => `- User constraint: ${constraint}`),
  ];

  return upsertMarkdownSection(prdContent, 'Constraints', nextConstraintLines.join('\n'));
}

function buildPlannerGapCandidateKey(candidate) {
  return sanitizeInlineCode([
    candidate.selectedItem || 'missing-selected-item',
    candidate.scope || 'missing-scope',
    candidate.gap || 'missing-gap',
    candidate.candidateScenario || 'missing-scenario',
    candidate.additionTarget || candidate.candidateAdditionTarget || 'missing-addition-target',
  ].join(' | '));
}

function parseStructuredLogListValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  return normalizeStringList(value.split(',').map((entry) => entry.trim()));
}

function parseGapAnalysisCandidateRecords(content) {
  const entries = parseStructuredLogEntries(content);
  const records = [];
  const seenCandidateKeys = new Set();

  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    const candidateMap = new Map();
    const selectedItem = sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Selected item'));
    const scope = sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Scope'));
    const summary = sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Summary'));
    const runtimeStatus = sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Runtime status'));
    const runtimeLog = sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Runtime log'));

    for (const line of entry.lines) {
      const candidateMatch = line.match(/^Candidate (\d+) (gap|scenario|addition target|evidence): (.+)$/);
      if (!candidateMatch) {
        continue;
      }

      const ordinal = Number.parseInt(candidateMatch[1], 10);
      const field = candidateMatch[2];
      const value = candidateMatch[3].trim();
      const currentRecord = candidateMap.get(ordinal) || {
        ordinal,
        gap: '',
        candidateScenario: '',
        additionTarget: '',
        evidence: [],
      };

      if (field === 'gap') {
        currentRecord.gap = sanitizeInlineCode(value);
      } else if (field === 'scenario') {
        currentRecord.candidateScenario = sanitizeInlineCode(value);
      } else if (field === 'addition target') {
        currentRecord.additionTarget = sanitizeInlineCode(value);
      } else if (field === 'evidence') {
        currentRecord.evidence = parseStructuredLogListValue(value);
      }

      candidateMap.set(ordinal, currentRecord);
    }

    const ordinals = Array.from(candidateMap.keys()).sort((left, right) => left - right);
    for (const ordinal of ordinals) {
      const candidate = candidateMap.get(ordinal);
      const record = {
        entryTimestamp: entry.timestamp,
        entryStatus: entry.status,
        selectedItem,
        scope,
        summary,
        runtimeStatus,
        runtimeLog,
        ordinal,
        gap: candidate.gap,
        candidateScenario: candidate.candidateScenario,
        additionTarget: candidate.additionTarget,
        evidence: candidate.evidence,
      };
      const candidateKey = buildPlannerGapCandidateKey(record);
      if (seenCandidateKeys.has(candidateKey)) {
        continue;
      }

      seenCandidateKeys.add(candidateKey);
      records.push({
        ...record,
        candidateKey,
      });
    }
  }

  return records;
}

function buildPlannerGapGoal(candidate) {
  return sanitizeInlineCode(`${candidate.candidateScenario} for ${candidate.scope}`);
}

function buildPlannerGapInput(candidate) {
  return `accepted gap candidate ${candidate.ordinal} in \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\` for \`${sanitizeInlineCode(candidate.scope)}\``;
}

function buildPlannerGapOutput() {
  return 'verifier-backed proof recorded in `logs/verifier.log`';
}

function buildPlannerGapVerify(runId) {
  return `\`${buildHarnessCommandDescription('advance-run', { runId })}\``;
}

function parsePlannerHandoffItemId(value) {
  const match = /^P-GAP-(\d+)$/.exec(sanitizeOptionalInlineCode(value));
  return match ? Number.parseInt(match[1], 10) : null;
}

function allocateNextPlannerHandoffItemId(progressContent, acceptedRecords) {
  const usedIds = new Set();
  const registerItemId = (itemId) => {
    const numericId = parsePlannerHandoffItemId(itemId);
    if (numericId != null) {
      usedIds.add(numericId);
    }
  };

  parseProgressItems(progressContent).forEach((item) => registerItemId(item.id));
  acceptedRecords.forEach((record) => registerItemId(record.itemId));

  let nextId = 1;
  while (usedIds.has(nextId)) {
    nextId += 1;
  }

  return `${PLANNER_HANDOFF_PROGRESS_ITEM_ID_PREFIX}${String(nextId).padStart(3, '0')}`;
}

function getGapCandidateRejectionReason(candidate) {
  if (!candidate.scope) {
    return 'missing recorded scope in outputs/gap-analysis.md.';
  }

  if (!candidate.gap) {
    return 'missing candidate gap text in outputs/gap-analysis.md.';
  }

  if (!candidate.candidateScenario) {
    return 'missing candidate scenario text in outputs/gap-analysis.md.';
  }

  if (!CONCRETE_GAP_SCENARIO_PATTERN.test(candidate.candidateScenario)) {
    return 'candidate scenario must start with one concrete scenario-sized action.';
  }

  if (VAGUE_GAP_SCENARIO_PATTERN.test(candidate.candidateScenario)) {
    return 'candidate scenario must avoid generic coverage wording and name one concrete scenario-sized change.';
  }

  return '';
}

function buildPlannerGapHandoffSummary(prefix, candidate, detail) {
  const scopeLabel = candidate.scope ? ` for ${candidate.scope}` : '';
  return `${prefix} gap candidate ${candidate.ordinal}${scopeLabel}: ${sanitizeInlineCode(detail)}`;
}

function readPlannerHandoffState(runPaths) {
  if (!pathExists(runPaths.plannerHandoffPath)) {
    return {
      acceptedCount: 0,
      rejectedCount: 0,
      reviewedCandidateKeys: new Set(),
      acceptedRecords: [],
      latestSummary: '',
    };
  }

  const entries = parseStructuredLogEntries(readText(runPaths.plannerHandoffPath));
  const reviewedCandidateKeys = new Set();
  const latestDecisionByCandidateKey = new Map();
  let latestSummary = '';

  for (const entry of entries) {
    const rawCandidateKey = sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Candidate key'));
    const selectedItem = readStructuredLogValue(entry, 'Selected item');
    const scope = readStructuredLogValue(entry, 'Scope');
    const candidateGap = readStructuredLogValue(entry, 'Candidate gap');
    const candidateScenario = readStructuredLogValue(entry, 'Candidate scenario');
    const candidateAdditionTarget = readStructuredLogValue(entry, 'Candidate addition target');
    const candidateKey = buildPlannerGapCandidateKey({
      selectedItem,
      scope,
      gap: candidateGap,
      candidateScenario,
      candidateAdditionTarget,
    }) || rawCandidateKey;

    if (rawCandidateKey) {
      reviewedCandidateKeys.add(rawCandidateKey);
    }
    if (candidateKey) {
      reviewedCandidateKeys.add(candidateKey);
    }

    const summary = sanitizeOptionalInlineCode(readStructuredLogValue(entry, 'Summary'));
    if (summary) {
      latestSummary = summary;
    }

    if (entry.status === 'accepted') {
      latestDecisionByCandidateKey.set(candidateKey || rawCandidateKey || `accepted-${latestDecisionByCandidateKey.size}`, {
        status: 'accepted',
        record: {
          candidateKey: candidateKey || rawCandidateKey,
          itemId: readStructuredLogValue(entry, 'Progress item id'),
          goal: readStructuredLogValue(entry, 'Progress goal'),
          input: readStructuredLogValue(entry, 'Progress input'),
          output: readStructuredLogValue(entry, 'Progress output'),
          verify: readStructuredLogValue(entry, 'Progress verify'),
          owner: readStructuredLogValue(entry, 'Progress owner'),
          retryBudget: readStructuredLogValue(entry, 'Progress retry budget'),
          sourceArtifact: readStructuredLogValue(entry, 'Source artifact'),
          selectedItem,
          scope,
          candidateOrdinal: readStructuredLogValue(entry, 'Candidate ordinal'),
          candidateGap,
          candidateScenario,
          candidateAdditionTarget,
          candidateEvidence: parseStructuredLogListValue(readStructuredLogValue(entry, 'Candidate evidence')),
          summary,
        },
      });
    } else if (entry.status === 'rejected') {
      latestDecisionByCandidateKey.set(candidateKey || rawCandidateKey || `rejected-${latestDecisionByCandidateKey.size}`, {
        status: 'rejected',
      });
    }
  }

  const acceptedRecordMap = new Map();
  let rejectedCount = 0;

  for (const candidateState of latestDecisionByCandidateKey.values()) {
    if (candidateState.status === 'accepted') {
      const acceptedRecord = candidateState.record;
      const acceptedRecordKey =
        sanitizeOptionalInlineCode(acceptedRecord.itemId)
        || sanitizeOptionalInlineCode(acceptedRecord.candidateKey)
        || `accepted-${acceptedRecordMap.size}`;
      acceptedRecordMap.set(acceptedRecordKey, acceptedRecord);
    } else if (candidateState.status === 'rejected') {
      rejectedCount += 1;
    }
  }

  const acceptedRecords = Array.from(acceptedRecordMap.values()).sort((left, right) => {
    const leftNumericId = parsePlannerHandoffItemId(left.itemId);
    const rightNumericId = parsePlannerHandoffItemId(right.itemId);

    if (leftNumericId != null && rightNumericId != null) {
      return leftNumericId - rightNumericId;
    }

    return sanitizeOptionalInlineCode(left.itemId || left.candidateKey).localeCompare(
      sanitizeOptionalInlineCode(right.itemId || right.candidateKey),
    );
  });

  return {
    acceptedCount: acceptedRecords.length,
    rejectedCount,
    reviewedCandidateKeys,
    acceptedRecords,
    latestSummary,
  };
}

function readAcceptedPlannerHandoffRecord(runPaths, itemId) {
  const normalizedItemId = sanitizeOptionalInlineCode(itemId);
  if (!normalizedItemId) {
    return null;
  }

  const handoffState = readPlannerHandoffState(runPaths);
  return handoffState.acceptedRecords.find((record) => sanitizeOptionalInlineCode(record.itemId) === normalizedItemId) || null;
}

function buildPlannerGapProgressItem(candidate, runId, itemId) {
  return {
    itemId,
    goal: buildPlannerGapGoal(candidate),
    input: buildPlannerGapInput(candidate),
    output: buildPlannerGapOutput(),
    verify: buildPlannerGapVerify(runId),
    owner: PLANNER_HANDOFF_OWNER,
    retryBudget: PLANNER_HANDOFF_RETRY_BUDGET,
    status: 'todo',
    resultText: '',
    fallbackReason: '',
  };
}

function resolvePlannerGapHandoff(options) {
  const existingRunRefinement = options.existingRunRefinement === true;
  const runPaths = options.artifactSet.runPaths;
  const reportPathDisplay = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.plannerHandoffPath));
  const handoffState = readPlannerHandoffState(runPaths);
  const acceptedRecords = [...handoffState.acceptedRecords];
  let acceptedCount = handoffState.acceptedCount;
  let rejectedCount = handoffState.rejectedCount;
  let latestSummary = handoffState.latestSummary;
  let reviewedCandidate = null;

  if (existingRunRefinement) {
    const gapCandidates = parseGapAnalysisCandidateRecords(readText(runPaths.gapAnalysisPath));
    const nextCandidate = gapCandidates.find((candidate) => !handoffState.reviewedCandidateKeys.has(candidate.candidateKey)) || null;

    if (nextCandidate) {
      const rejectionReason = getGapCandidateRejectionReason(nextCandidate);
      if (rejectionReason) {
        latestSummary = buildPlannerGapHandoffSummary('rejected', nextCandidate, rejectionReason);
        rejectedCount += 1;
        reviewedCandidate = {
          status: 'rejected',
          summary: latestSummary,
          reason: rejectionReason,
          candidate: nextCandidate,
        };
        writePlannerHandoffReport(runPaths.plannerHandoffPath, 'rejected', [
          `Source artifact: ${GAP_ANALYSIS_ARTIFACT_DISPLAY}`,
          `Candidate key: ${nextCandidate.candidateKey}`,
          `Gap analysis timestamp: ${sanitizeInlineCode(nextCandidate.entryTimestamp)}`,
          `Selected item: ${sanitizeOptionalInlineCode(nextCandidate.selectedItem)}`,
          `Scope: ${sanitizeOptionalInlineCode(nextCandidate.scope)}`,
          `Candidate ordinal: ${nextCandidate.ordinal}`,
          `Candidate gap: ${sanitizeOptionalInlineCode(nextCandidate.gap)}`,
          `Candidate scenario: ${sanitizeOptionalInlineCode(nextCandidate.candidateScenario)}`,
          ...(nextCandidate.additionTarget
            ? [`Candidate addition target: ${sanitizeOptionalInlineCode(nextCandidate.additionTarget)}`]
            : []),
          `Decision: rejected`,
          `Reason: ${sanitizeInlineCode(rejectionReason)}`,
          `Summary: ${latestSummary}`,
        ]);
      } else {
        const itemId = allocateNextPlannerHandoffItemId(options.artifactSet.progressContent, acceptedRecords);
        const progressItem = buildPlannerGapProgressItem(nextCandidate, options.runId, itemId);
        latestSummary = buildPlannerGapHandoffSummary('accepted', nextCandidate, `${itemId} from ${nextCandidate.candidateScenario}`);
        acceptedCount += 1;
        reviewedCandidate = {
          status: 'accepted',
          summary: latestSummary,
          candidate: nextCandidate,
          progressItem,
        };
        acceptedRecords.push({
          candidateKey: nextCandidate.candidateKey,
          itemId: progressItem.itemId,
          goal: progressItem.goal,
          input: progressItem.input,
          output: progressItem.output,
          verify: progressItem.verify,
          owner: progressItem.owner,
          retryBudget: progressItem.retryBudget,
          summary: latestSummary,
        });
        writePlannerHandoffReport(runPaths.plannerHandoffPath, 'accepted', [
          `Source artifact: ${GAP_ANALYSIS_ARTIFACT_DISPLAY}`,
          `Candidate key: ${nextCandidate.candidateKey}`,
          `Gap analysis timestamp: ${sanitizeInlineCode(nextCandidate.entryTimestamp)}`,
          `Selected item: ${sanitizeOptionalInlineCode(nextCandidate.selectedItem)}`,
          `Scope: ${sanitizeOptionalInlineCode(nextCandidate.scope)}`,
          `Candidate ordinal: ${nextCandidate.ordinal}`,
          `Candidate gap: ${sanitizeOptionalInlineCode(nextCandidate.gap)}`,
          `Candidate scenario: ${sanitizeOptionalInlineCode(nextCandidate.candidateScenario)}`,
          ...(nextCandidate.additionTarget
            ? [`Candidate addition target: ${sanitizeOptionalInlineCode(nextCandidate.additionTarget)}`]
            : []),
          `Candidate evidence: ${nextCandidate.evidence.join(', ')}`,
          `Decision: accepted`,
          `Progress item id: ${progressItem.itemId}`,
          `Progress goal: ${progressItem.goal}`,
          `Progress input: ${progressItem.input}`,
          `Progress output: ${progressItem.output}`,
          `Progress verify: ${progressItem.verify}`,
          `Progress owner: ${progressItem.owner}`,
          `Progress retry budget: ${progressItem.retryBudget}`,
          `Summary: ${latestSummary}`,
        ]);
      }
    }
  }

  return {
    acceptedCount,
    rejectedCount,
    acceptedRecords,
    latestSummary,
    reviewedCandidate,
    reportPathDisplay,
    active: acceptedCount > 0 || rejectedCount > 0 || reviewedCandidate != null,
  };
}

function buildPlannerGapHandoffSection(gapHandoff) {
  if (!gapHandoff || !gapHandoff.active) {
    return '';
  }

  return [
    `- Handoff source: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
    `- Accepted gap items: \`${gapHandoff.acceptedCount}\``,
    `- Rejected gap proposals: \`${gapHandoff.rejectedCount}\``,
    `- Planner handoff artifact: \`${gapHandoff.reportPathDisplay}\``,
    `- Latest handoff summary: \`${sanitizeOptionalInlineCode(gapHandoff.latestSummary || 'not recorded')}\``,
  ].join('\n');
}

function buildPlannerPrdContent(prdContent, options) {
  const scenarioCount = Number.isInteger(options.featureMetadata && options.featureMetadata.scenarioCount)
    ? options.featureMetadata.scenarioCount
    : 0;
  const featureTitle = sanitizeInlineCode(options.featureMetadata && options.featureMetadata.featureTitle
    ? options.featureMetadata.featureTitle
    : 'normalized feature');
  const sourceRefDisplay = sanitizeInlineCode(options.sourceRefDisplay || 'normalized.feature');
  const objectiveSummary =
    `Prepare one bounded feature-backed QA harness run for \`${sourceRefDisplay}\` ` +
    `using \`normalized.feature\` as the execution truth for \`${featureTitle}\` ` +
    `(${scenarioCount} scenario${scenarioCount === 1 ? '' : 's'}). ` +
    'The run is ready only after planner refinement completes and verifier proof passes.';
  const knownGapsLines = [
    `- \`normalized.feature\` stays identical to \`${sourceRefDisplay}\` in this slice.`,
    '- Planner refinement is limited to `PRD.md`, `progress.md`, and `PROMPT.md` inside the current run.',
  ].join('\n');
  const plannerSectionLines = [
    '- Planner status: `refined`',
    `- Planner summary: \`${sanitizeInlineCode(options.plannerSummary)}\``,
    `- Feature title: \`${featureTitle}\``,
    `- Scenario count: \`${scenarioCount}\``,
    '- Planned artifact set: `PRD.md`, `progress.md`, `PROMPT.md`, and `normalized.feature`',
  ].join('\n');

  let updatedContent = upsertMarkdownSection(prdContent, 'Objective', objectiveSummary);
  updatedContent = recordPlannerConstraintsInPrd(updatedContent, options.constraints);
  updatedContent = upsertMarkdownSection(updatedContent, 'Known Gaps or Ambiguities', knownGapsLines);
  updatedContent = upsertMarkdownSection(updatedContent, 'Planner Refinement', plannerSectionLines);
  updatedContent = upsertMarkdownSection(
    updatedContent,
    'Explorer Gap Handoff',
    options.gapHandoff && options.gapHandoff.active ? buildPlannerGapHandoffSection(options.gapHandoff) : '',
  );
  updatedContent = upsertMarkdownSection(
    updatedContent,
    'Guided Exploration',
    options.guidedExploration && options.guidedExploration.active
      ? buildGuidedExplorationSectionLines(options.guidedExploration)
      : '',
  );
  updatedContent = upsertMarkdownSection(
    updatedContent,
    'Autonomous Exploration',
    options.autonomousExploration && options.autonomousExploration.active
      ? buildAutonomousExplorationSectionLines(options.autonomousExploration)
      : '',
  );

  return updatedContent;
}

function buildGuidedExplorerProgressBlock(options) {
  const featureTitle = sanitizeInlineCode(options.featureTitle || 'normalized feature');
  const scopeLabel = sanitizeOptionalInlineCode(options.guidedExploration && options.guidedExploration.featureScopes[0]);
  const scenarioLabel = sanitizeOptionalInlineCode(
    options.guidedExploration
    && options.guidedExploration.scenarioScopes.length > 0
      ? options.guidedExploration.scenarioScopes[0]
      : '',
  );
  const riskLabel = sanitizeOptionalInlineCode(
    options.guidedExploration
    && options.guidedExploration.riskAreas.length > 0
      ? options.guidedExploration.riskAreas.join(', ')
      : '',
  );
  const goalScope = scenarioLabel || scopeLabel || featureTitle;
  const riskSuffix = riskLabel ? ` around ${riskLabel}` : '';

  return buildProgressItemBlock({
    itemId: 'P-002',
    goal: `identify one bounded guided coverage gap for ${goalScope}${riskSuffix}`,
    input: '`PRD.md` guided exploration scope, `progress.md` guided stop conditions, and `normalized.feature`',
    output: `gap candidates recorded in \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
    verify: `\`${buildHarnessCommandDescription('advance-run', { runId: options.runId })}\``,
    owner: 'qa-explorer',
    status: 'todo',
    retryBudget: '1',
    resultText: '',
    fallbackReason: '',
  });
}

function buildAutonomousExplorerProgressBlock(options) {
  const targetLabel = sanitizeInlineCode(
    options.autonomousExploration && options.autonomousExploration.target
      ? options.autonomousExploration.target
      : options.featureTitle || 'normalized feature',
  );

  return buildProgressItemBlock({
    itemId: 'P-002',
    goal: `identify one bounded autonomous coverage gap for ${targetLabel}`,
    input: '`PRD.md` autonomous exploration target, `progress.md` autonomous stop frame, and `normalized.feature`',
    output: `gap candidates recorded in \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
    verify: `\`${buildHarnessCommandDescription('advance-run', { runId: options.runId })}\``,
    owner: 'qa-explorer',
    status: 'todo',
    retryBudget: '1',
    resultText: '',
    fallbackReason: '',
  });
}

function buildPreferredProgressItemMap(progressContent) {
  const itemMap = new Map();

  for (const item of parseProgressItems(progressContent)) {
    const existingItem = itemMap.get(item.id);
    if (!existingItem) {
      itemMap.set(item.id, item);
      continue;
    }

    const existingIsActive = existingItem.sectionTitle === 'Active Items';
    const currentIsActive = item.sectionTitle === 'Active Items';
    if (currentIsActive || !existingIsActive) {
      itemMap.set(item.id, item);
    }
  }

  return itemMap;
}

function removeProgressItemsOutsideSection(content, sectionTitle, itemIds) {
  if (!(itemIds instanceof Set) || itemIds.size === 0) {
    return content;
  }

  const removableItems = parseProgressItems(content)
    .filter((item) => item.sectionTitle !== sectionTitle && itemIds.has(item.id))
    .sort((left, right) => right.start - left.start);

  let updatedContent = content;
  for (const item of removableItems) {
    updatedContent = `${updatedContent.slice(0, item.start)}${updatedContent.slice(item.end)}`;
  }

  return normalizeMarkdownSpacing(updatedContent);
}

function buildPlannerProgressContent(progressContent, options) {
  const featureTitle = sanitizeInlineCode(options.featureMetadata && options.featureMetadata.featureTitle
    ? options.featureMetadata.featureTitle
    : 'normalized feature');
  const sourceRefDisplay = sanitizeInlineCode(options.sourceRefDisplay || 'normalized.feature');
  const plannerRefined = options.plannerRefined === true;
  const existingProgressItems = buildPreferredProgressItemMap(progressContent);
  const verifierFallbackBlock = buildProgressItemBlock({
    itemId: 'P-001',
    goal: `verify planner-refined artifacts and generated BDD specs for ${featureTitle}`,
    input: `\`${sourceRefDisplay}\`, \`PRD.md\`, \`progress.md\`, \`PROMPT.md\`, \`normalized.feature\``,
    output: 'verifier proof recorded in `logs/verifier.log`',
    verify: `\`${buildHarnessCommandDescription('verify-run', { runId: options.runId })}\``,
    owner: 'qa-verifier',
    status: 'todo',
    retryBudget: '1',
    resultText: '',
    fallbackReason: '',
  });
  const verifierBlock = plannerRefined
    && existingProgressItems.get('P-001')
    && sanitizeOptionalInlineCode(existingProgressItems.get('P-001').owner) === 'qa-verifier'
    ? existingProgressItems.get('P-001').block
    : verifierFallbackBlock;
  const executorFallbackBlock = buildProgressItemBlock({
    itemId: 'P-002',
    goal: `execute the generated feature-backed run for ${featureTitle} on Chromium`,
    input: '`normalized.feature`',
    output: 'runtime proof recorded in `logs/runtime.log`',
    verify: `\`${buildHarnessCommandDescription('execute-run', {
      runId: options.runId,
      executionControls: {
        shouldPersist: false,
        controls: {
          ...DEFAULT_EXECUTION_CONTROLS,
          project: 'chromium',
        },
      },
      includeProject: true,
    })}\``,
    owner: 'qa-executor',
    status: 'todo',
    retryBudget: '2',
    resultText: '',
    fallbackReason: '',
  });
  const executorExistingItem = existingProgressItems.get('P-002');
  const executorBlock = plannerRefined && executorExistingItem && !isExplorerOwner(executorExistingItem.owner)
    ? executorExistingItem.block
    : executorFallbackBlock;
  const plannerHandoffBlocks = Array.isArray(options.gapHandoff && options.gapHandoff.acceptedRecords)
    ? options.gapHandoff.acceptedRecords.map((record) => {
      const existingItem = existingProgressItems.get(record.itemId);
      if (existingItem) {
        return existingItem.block;
      }

      return buildProgressItemBlock({
        itemId: record.itemId,
        goal: record.goal,
        input: record.input,
        output: record.output,
        verify: record.verify,
        owner: record.owner || PLANNER_HANDOFF_OWNER,
        status: 'todo',
        retryBudget: record.retryBudget || PLANNER_HANDOFF_RETRY_BUDGET,
        resultText: '',
        fallbackReason: '',
      });
    })
    : [];
  const guidedExploration = options.guidedExploration && options.guidedExploration.active
    ? options.guidedExploration
    : null;
  const autonomousExploration = options.autonomousExploration && options.autonomousExploration.active
    ? options.autonomousExploration
    : null;
  const existingExplorerItem = existingProgressItems.get('P-002');
  const explorerBlock = plannerRefined && existingExplorerItem && isExplorerOwner(existingExplorerItem.owner)
    ? existingExplorerItem.block
    : guidedExploration
      ? buildGuidedExplorerProgressBlock({
        featureTitle,
        runId: options.runId,
        guidedExploration,
      })
      : buildAutonomousExplorerProgressBlock({
        featureTitle,
        runId: options.runId,
        autonomousExploration,
      });
  const activeItemBlocks = guidedExploration || autonomousExploration
    ? [verifierBlock, ...plannerHandoffBlocks, explorerBlock]
    : [verifierBlock, executorBlock, ...plannerHandoffBlocks];
  const activeItemIds = new Set(activeItemBlocks
    .map((block) => parseProgressItemBlock(block))
    .filter(Boolean)
    .map((item) => item.id));
  let updatedContent = upsertMarkdownSection(
    progressContent,
    'Active Items',
    activeItemBlocks.join('\n\n'),
  );

  updatedContent = upsertMarkdownSection(
    updatedContent,
    'Guided Exploration',
    guidedExploration
      ? [
        buildGuidedExplorationSectionLines(guidedExploration),
        `- Guided explorer artifact: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
        '- Planner handoff remains the boundary before scenario addition.',
      ].join('\n')
      : '',
  );
  updatedContent = upsertMarkdownSection(
    updatedContent,
    'Autonomous Exploration',
    autonomousExploration
      ? [
        buildAutonomousExplorationSectionLines(autonomousExploration),
        `- Autonomous explorer artifact: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
        '- Planner handoff remains the boundary before scenario addition.',
      ].join('\n')
      : '',
  );

  return removeProgressItemsOutsideSection(updatedContent, 'Active Items', activeItemIds);
}

function buildPlannerPromptContent(promptContent, options) {
  const scenarioCount = Number.isInteger(options.featureMetadata && options.featureMetadata.scenarioCount)
    ? options.featureMetadata.scenarioCount
    : 0;
  const featureTitle = sanitizeInlineCode(options.featureMetadata && options.featureMetadata.featureTitle
    ? options.featureMetadata.featureTitle
    : 'normalized feature');
  const plannerContextLines = [
    `- Planned feature: \`${featureTitle}\``,
    `- Scenario count: \`${scenarioCount}\``,
    '- Planner-owned artifacts: `PRD.md`, `progress.md`, and `PROMPT.md`',
    '- Execution truth remains: `normalized.feature`',
    '- When no selected item is provided, execute the first actionable planner-authored item already written in `progress.md`.',
  ].join('\n');

  let updatedContext = plannerContextLines;
  if (options.gapHandoff && options.gapHandoff.active) {
    updatedContext = [
      plannerContextLines,
      `- Explorer handoff source: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
      `- Accepted explorer handoff items: \`${options.gapHandoff.acceptedCount}\``,
      `- Latest explorer handoff: \`${sanitizeOptionalInlineCode(options.gapHandoff.latestSummary || 'not recorded')}\``,
    ].join('\n');
  }

  let updatedContent = upsertMarkdownSection(promptContent, 'Planner Context', updatedContext);
  updatedContent = upsertMarkdownSection(
    updatedContent,
    'Guided Exploration Context',
    options.guidedExploration && options.guidedExploration.active
      ? [
        buildGuidedExplorationSectionLines(options.guidedExploration),
        `- Guided explorer output: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
        '- Do not mutate scenarios during guided exploration; planner handoff remains the boundary before scenario addition.',
      ].join('\n')
      : '',
  );
  updatedContent = upsertMarkdownSection(
    updatedContent,
    'Autonomous Exploration Context',
    options.autonomousExploration && options.autonomousExploration.active
      ? [
        buildAutonomousExplorationSectionLines(options.autonomousExploration),
        `- Autonomous explorer output: \`${GAP_ANALYSIS_ARTIFACT_DISPLAY}\``,
        '- Do not mutate scenarios during autonomous exploration; planner handoff remains the boundary before scenario addition.',
      ].join('\n')
      : '',
  );

  return updatedContent;
}

function planPreparedRunArtifacts(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);

  if (!options.runId) {
    throw new Error('Missing required option --run-id for planner refinement.');
  }

  const artifactSet = options.artifactSet || loadRunArtifactSet({
    repoRoot,
    templatesDir,
    runId: options.runId,
  });
  const sourceRefDisplay = resolvePlannerSourceRefDisplay(artifactSet, options);
  const plannerConstraints = resolvePlannerConstraints(options);
  const featureMetadata =
    options.featureMetadata
    || parseFeatureMetadata(artifactSet.normalizedFeatureContent, sourceRefDisplay);
  const guidedExploration = resolveGuidedExplorationPlan({
    ...options,
    artifactSet,
    featureMetadata,
    sourceRefDisplay,
    plannerConstraints,
  });
  const autonomousExploration = resolveAutonomousExplorationPlan({
    ...options,
    artifactSet,
    featureMetadata,
    sourceRefDisplay,
  });
  const gapHandoff = resolvePlannerGapHandoff({
    ...options,
    artifactSet,
  });
  const plannerRefined =
    /(^|\r?\n)## Planner Refinement$/m.test(artifactSet.prdContent)
    || /(^|\r?\n)## Planner Context$/m.test(artifactSet.promptContent);
  const basePlannerSummary = formatPlannerSummary(featureMetadata);
  const plannerSummary = gapHandoff.reviewedCandidate
    ? `${basePlannerSummary}; ${gapHandoff.latestSummary}`
    : basePlannerSummary;
  const nextPrdContent = buildPlannerPrdContent(artifactSet.prdContent, {
    sourceRefDisplay,
    featureMetadata,
    plannerSummary,
    constraints: plannerConstraints,
    gapHandoff,
    guidedExploration,
    autonomousExploration,
  });
  const nextProgressContent = buildPlannerProgressContent(artifactSet.progressContent, {
    sourceRefDisplay,
    featureMetadata,
    runId: options.runId,
    plannerRefined,
    gapHandoff,
    guidedExploration,
    autonomousExploration,
  });
  const nextPromptContent = buildPlannerPromptContent(artifactSet.promptContent, {
    featureMetadata,
    gapHandoff,
    guidedExploration,
    autonomousExploration,
  });

  writeText(artifactSet.runPaths.prdPath, nextPrdContent);
  writeText(artifactSet.runPaths.progressPath, nextProgressContent);
  writeText(artifactSet.runPaths.promptPath, nextPromptContent);

  return {
    runId: options.runId,
    runPaths: artifactSet.runPaths,
    featureMetadata,
    summary: plannerSummary,
    gapHandoff,
  };
}

function prepareRun(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const clarifyRequestFn = options.clarifyRequestFn || clarifyPrepareRunRequest;
  const createRunFn = options.createRunFn || createRun;
  const planRunFn = options.planRunFn || planPreparedRunArtifacts;
  const verifyRunFn = options.verifyRunFn || verifyRun;
  const hasRunId = hasMeaningfulString(options.runId);
  const hasRequestInput =
    options.request
    && typeof options.request === 'object'
    && ['request', 'intent', 'sourceType', 'sourceRef', 'mode', 'scope'].some((key) => hasMeaningfulString(options.request[key]));

  if (hasRunId && hasRequestInput) {
    throw new Error('Prepare-run accepts either the structured feature-backed form, --request, or --run-id, but not more than one input mode.');
  }

  if (hasRunId) {
    const runId = options.runId.trim();
    const existingArtifactSet = loadRunArtifactSet({
      repoRoot,
      templatesDir,
      runId,
    });
    const existingRunSummary = formatExistingRunPrepareSummary(
      runId,
      resolveRunDirDisplay(repoRoot, existingArtifactSet.runPaths),
      options.constraints,
    );
    let planning;

    try {
      planning = planRunFn({
        repoRoot,
        templatesDir,
        runId,
        runPaths: existingArtifactSet.runPaths,
        artifactSet: existingArtifactSet,
        constraints: options.constraints,
        existingRunRefinement: true,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.prepareRunFailure = {
        stage: 'planner',
        runId,
        runPaths: existingArtifactSet.runPaths,
        runPathDisplay: resolveRunDirDisplay(repoRoot, existingArtifactSet.runPaths),
        clarifierSummary: existingRunSummary,
        plannerSummary: sanitizeInlineCode(failure.message),
        retainedArtifactSummary: 'existing artifacts retained.',
      };
      throw failure;
    }

    try {
      const verification = verifyRunFn({
        repoRoot,
        templatesDir,
        runId,
        commandRunner: options.commandRunner,
      });

      return {
        runId,
        runPaths: planning.runPaths || existingArtifactSet.runPaths,
        clarifierSummary: existingRunSummary,
        plannerResult: planning,
        plannerSummary: planning.summary,
        verifyResult: verification,
        verifierSummary: formatVerifyRunSummary(verification),
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.prepareRunFailure = {
        stage: 'verification',
        runId,
        runPaths: planning && planning.runPaths ? planning.runPaths : existingArtifactSet.runPaths,
        runPathDisplay: resolveRunDirDisplay(
          repoRoot,
          planning && planning.runPaths ? planning.runPaths : existingArtifactSet.runPaths,
        ),
        clarifierSummary: existingRunSummary,
        plannerSummary: planning && planning.summary ? planning.summary : '',
        verifierSummary: sanitizeInlineCode(failure.message),
        retainedArtifactSummary: 'existing artifacts retained.',
      };
      throw failure;
    }
  }

  let clarification;

  try {
    clarification = clarifyRequestFn({
      repoRoot,
      request: options.request,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!failure.prepareRunFailure) {
      failure.prepareRunFailure = {
        stage: 'clarifier',
        clarifierSummary: sanitizeInlineCode(failure.message),
      };
    }

    throw failure;
  }

  const createdRun = createRunFn({
    repoRoot,
    templatesDir,
    now: options.now,
    request: clarification.request,
  });
  recordClarifierSummaryInArtifacts(createdRun.runPaths, clarification.summary);
  let planning;

  try {
    planning = planRunFn({
      repoRoot,
      templatesDir,
      runId: createdRun.runId,
      runPaths: createdRun.runPaths,
      request: clarification.request,
      featureMetadata: createdRun.featureMetadata,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.prepareRunFailure = {
      stage: 'planner',
      runId: createdRun.runId,
      runPaths: createdRun.runPaths,
      runPathDisplay: resolveRunDirDisplay(repoRoot, createdRun.runPaths),
      clarifierSummary: clarification.summary,
      plannerSummary: sanitizeInlineCode(failure.message),
    };
    throw failure;
  }

  try {
    const verification = verifyRunFn({
      repoRoot,
      templatesDir,
      runId: createdRun.runId,
      commandRunner: options.commandRunner,
    });

    return {
      ...createdRun,
      clarification,
      clarifierSummary: clarification.summary,
      plannerResult: planning,
      plannerSummary: planning.summary,
      verifyResult: verification,
      verifierSummary: formatVerifyRunSummary(verification),
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.prepareRunFailure = {
      stage: 'verification',
      runId: createdRun.runId,
      runPaths: createdRun.runPaths,
      runPathDisplay: resolveRunDirDisplay(repoRoot, createdRun.runPaths),
      clarifierSummary: clarification.summary,
      plannerSummary: planning && planning.summary ? planning.summary : '',
      verifierSummary: sanitizeInlineCode(failure.message),
    };
    throw failure;
  }
}

function extractTemplatePlaceholders(templateContent) {
  return templateContent.match(/<[^>\r\n]+>/g) || [];
}

function getTemplatePlaceholders(templatesDir) {
  const placeholderSet = new Set();

  for (const templateName of ['PRD.md', 'progress.md', 'PROMPT.md']) {
    const templatePath = path.join(templatesDir, templateName);
    const templateContent = readText(templatePath);
    for (const placeholder of extractTemplatePlaceholders(templateContent)) {
      placeholderSet.add(placeholder);
    }
  }

  return Array.from(placeholderSet);
}

function assertNoTemplatePlaceholders(filePath, placeholders) {
  const content = readText(filePath);
  const remaining = placeholders.filter((placeholder) => content.includes(placeholder));

  if (remaining.length > 0) {
    throw new Error(
      `Found unresolved template placeholders in ${normalizeDisplayPath(filePath)}: ${remaining.join(', ')}.`,
    );
  }
}

function assertRunStructure(runPaths) {
  for (const key of REQUIRED_DIR_KEYS) {
    assertDirectoryExists(runPaths[key], key);
  }

  for (const key of REQUIRED_FILE_KEYS) {
    assertFileExists(runPaths[key], key);
  }
}

function assertRunTemplatesResolved(runPaths, templatesDir) {
  const placeholders = getTemplatePlaceholders(templatesDir);
  assertNoTemplatePlaceholders(runPaths.prdPath, placeholders);
  assertNoTemplatePlaceholders(runPaths.progressPath, placeholders);
  assertNoTemplatePlaceholders(runPaths.promptPath, placeholders);
}

function loadRunArtifactSet(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const runPaths = resolveRunPaths(repoRoot, runId);

  assertDirectoryExists(runPaths.runDir, 'Run directory');
  assertRunStructure(runPaths);
  assertRunTemplatesResolved(runPaths, templatesDir);

  return {
    repoRoot,
    templatesDir,
    runId,
    runPaths,
    prdContent: readText(runPaths.prdPath),
    progressContent: readText(runPaths.progressPath),
    promptContent: readText(runPaths.promptPath),
    normalizedFeatureContent: readText(runPaths.normalizedFeaturePath),
  };
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function resolveProjectCliInvocation(command, args, cwd) {
  const normalizedArgs = Array.isArray(args) ? [...args] : [];
  const normalizedCommand = typeof command === 'string' ? command.trim().toLowerCase() : '';

  if (normalizedCommand !== 'npx' && normalizedCommand !== 'npx.cmd') {
    return {
      command,
      args: normalizedArgs,
    };
  }

  const [tool, ...toolArgs] = normalizedArgs;
  if (tool === 'bddgen') {
    const bddgenCliPath = path.join(cwd, 'node_modules', 'playwright-bdd', 'dist', 'cli', 'index.js');
    if (pathExists(bddgenCliPath)) {
      return {
        command: process.execPath,
        args: [bddgenCliPath, ...toolArgs],
      };
    }
  }

  if (tool === 'playwright') {
    const playwrightCliPath = path.join(cwd, 'node_modules', 'playwright', 'cli.js');
    if (pathExists(playwrightCliPath)) {
      return {
        command: process.execPath,
        args: [playwrightCliPath, ...toolArgs],
      };
    }
  }

  return {
    command,
    args: normalizedArgs,
  };
}

function quoteWindowsShellArg(value) {
  if (value.length === 0) {
    return '""';
  }

  if (!/[ \t"&<>|^]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function runProcess(command, args, cwd, options = {}) {
  const invocation = resolveProjectCliInvocation(command, args, cwd);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: options.env || process.env,
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
  };
}

function runCommand(command, args, cwd, options = {}) {
  return runProcess(command, args, cwd, options);
}

function parseExportedStepCount(output) {
  const match = output.match(/List of all steps \((\d+)\)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseListedTestCount(output) {
  const totalMatch = output.match(/Total:\s+(\d+)\s+tests?/i);
  if (totalMatch) {
    return Number.parseInt(totalMatch[1], 10);
  }

  if (/No tests found/i.test(output)) {
    return 0;
  }

  return output
    .split(/\r?\n/)
    .filter((line) => /\u203a/.test(line))
    .length;
}

function walkFiles(rootDir) {
  if (!pathExists(rootDir)) {
    return [];
  }

  const results = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }

  return results;
}

function findGeneratedSpecsForRun(repoRoot, runId) {
  const generatedRoot = path.join(repoRoot, '.features-gen');
  return walkFiles(generatedRoot).filter(
    (filePath) =>
      filePath.includes(runId) && /\.spec\.(c|m)?[jt]s$/i.test(filePath),
  ).sort();
}

function appendStructuredLog(filePath, status, lines) {
  const timestamp = new Date().toISOString();
  const block = [`[${timestamp}] status=${status}`, ...lines].join('\n');
  fs.appendFileSync(filePath, `${block}\n\n`, 'utf8');
}

function writeVerifierLog(filePath, status, lines) {
  appendStructuredLog(filePath, status, lines);
}

function writeRuntimeLog(filePath, status, lines) {
  appendStructuredLog(filePath, status, lines);
}

function writeFallbackLog(filePath, status, lines) {
  appendStructuredLog(filePath, status, lines);
}

function prepareReportFileForAppend(filePath, title) {
  const placeholderContent = `# ${title}\n\nNot started.\n`;
  if (!pathExists(filePath)) {
    writeText(filePath, `# ${title}\n\n`);
    return;
  }

  if (readText(filePath) === placeholderContent) {
    writeText(filePath, `# ${title}\n\n`);
  }
}

function writeHealReport(filePath, status, lines) {
  prepareReportFileForAppend(filePath, HEAL_REPORT_ARTIFACT_TITLE);
  appendStructuredLog(filePath, status, lines);
}

function writeLoopReport(filePath, status, lines) {
  prepareReportFileForAppend(filePath, LOOP_REPORT_ARTIFACT_TITLE);
  appendStructuredLog(filePath, status, lines);
}

function writeGapAnalysisReport(filePath, status, lines) {
  prepareReportFileForAppend(filePath, GAP_ANALYSIS_ARTIFACT_TITLE);
  appendStructuredLog(filePath, status, lines);
}

function writePlannerHandoffReport(filePath, status, lines) {
  prepareReportFileForAppend(filePath, PLANNER_HANDOFF_ARTIFACT_TITLE);
  appendStructuredLog(filePath, status, lines);
}

function writePromotionReport(filePath, status, lines) {
  prepareReportFileForAppend(filePath, PROMOTION_REPORT_ARTIFACT_TITLE);
  appendStructuredLog(filePath, status, lines);
}

function writeScenarioAdditionReport(filePath, status, lines) {
  prepareReportFileForAppend(filePath, SCENARIO_ADDITION_ARTIFACT_TITLE);
  appendStructuredLog(filePath, status, lines);
}

function parseStructuredLogEntries(content) {
  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  if (!normalizedContent) {
    return [];
  }

  return normalizedContent
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const [headerLine, ...lines] = block.split(/\r?\n/);
      const headerMatch = headerLine.match(/^\[(.+)\] status=([a-z-]+)$/);
      if (!headerMatch) {
        return null;
      }

      return {
        timestamp: headerMatch[1],
        status: headerMatch[2].trim().toLowerCase(),
        lines,
      };
    })
    .filter(Boolean);
}

function readLatestStructuredLogEntry(filePath) {
  if (!pathExists(filePath)) {
    return null;
  }

  const entries = parseStructuredLogEntries(readText(filePath));
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function readStructuredLogValue(entry, label) {
  if (!entry || !Array.isArray(entry.lines)) {
    return '';
  }

  const prefix = `${label}: `;
  const matchingLine = entry.lines.find((line) => line.startsWith(prefix));
  return matchingLine ? matchingLine.slice(prefix.length).trim() : '';
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

function formatCommandArg(arg) {
  return /[\s"]/u.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function formatCommandDisplay(command, args) {
  return [command, ...args].map(formatCommandArg).join(' ');
}

function normalizeRuntimeLayer(value) {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PLAYWRIGHT_RUNTIME_LAYERS.has(normalizedValue) ? normalizedValue : '';
}

function buildRuntimePolicyEnv(env, overrides = {}) {
  return {
    ...env,
    QA_HARNESS_BROWSER_ACTION_ORDER: PLAYWRIGHT_RUNTIME_ORDER.join(','),
    ...overrides,
  };
}

function applyExecutionControlsToEnv(env, executionControlState, overrides = {}) {
  const baseEnv = buildRuntimePolicyEnv(env, overrides);
  if (!executionControlState || !executionControlState.shouldPersist) {
    return baseEnv;
  }

  const controls = executionControlState.controls;
  const nextEnv = {
    ...baseEnv,
    QA_HARNESS_EXECUTION_PROJECT: controls.project,
    QA_HARNESS_EXECUTION_HEADED: controls.headed ? 'true' : 'false',
    QA_HARNESS_EXECUTION_DEBUG: controls.debug ? 'true' : 'false',
    QA_HARNESS_EXECUTION_TRACE: controls.trace,
    QA_HARNESS_EXECUTION_VIDEO: controls.video,
    QA_HARNESS_EXECUTION_SCREENSHOT: controls.screenshot,
    PWDEBUG: controls.debug ? '1' : '0',
  };

  if (controls.baseUrl) {
    nextEnv.PLAYWRIGHT_BASE_URL = controls.baseUrl;
  }

  if (controls.targetEnv) {
    nextEnv.QA_HARNESS_TARGET_ENV = controls.targetEnv;
  }

  return nextEnv;
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

function buildProgressResultText(status, summary, commandDescription, logPathDisplay) {
  if (status === 'pass') {
    return `pass via ${commandDescription}; evidence in ${logPathDisplay}`;
  }

  return `${status}: ${sanitizeInlineCode(summary)}`;
}

function buildVerifierBackedProgressResultText(
  status,
  summary,
  commandDescription,
  verifierLogDisplayPath,
  runtimeLogDisplayPath,
  additionalEvidenceRefs = [],
) {
  if (status === 'pass') {
    const evidenceSegments = [
      `runtime ${runtimeLogDisplayPath}`,
      ...normalizeStringList(additionalEvidenceRefs),
    ];
    return `pass via ${commandDescription}; evidence in ${verifierLogDisplayPath} (${evidenceSegments.join('; ')})`;
  }

  return `${status}: ${sanitizeInlineCode(summary)}; evidence in ${verifierLogDisplayPath}`;
}

function readMarkdownSummaryField(content, label) {
  const match = content.match(new RegExp(`^- ${escapeForRegExp(label)}:\\s*(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function parseRunIntent(prdContent) {
  return readMarkdownSummaryField(prdContent, 'Intent').replace(/^`|`$/g, '').toLowerCase();
}

function isHealingOwner(owner) {
  return /\bheal(?:er)?\b/i.test(owner);
}

function isHealingProgressItem(item, prdContent) {
  return isHealingOwner(item.owner) || parseRunIntent(prdContent) === 'heal';
}

function isExplorerOwner(owner) {
  return /\bexplor(?:e|er)\b/i.test(owner);
}

function hasExplorerScopeCue(value) {
  return /\b(?:explor(?:e|er|ation)|coverage|gap)\b/i.test(value);
}

function isExplorerProgressItem(item, prdContent) {
  if (isExplorerOwner(item.owner)) {
    return true;
  }

  if (parseRunIntent(prdContent) !== 'coverage') {
    return false;
  }

  return [
    item.goal,
    item.output,
    item.verify,
  ].some((value) => typeof value === 'string' && hasExplorerScopeCue(value));
}

function parseRetryBudgetValue(value) {
  if (typeof value !== 'string') {
    return 0;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return 0;
  }

  return Number.parseInt(normalizedValue, 10);
}

function parseOptionalNonNegativeInteger(value) {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(normalizedValue)) {
    return null;
  }

  return Number.parseInt(normalizedValue, 10);
}

function parsePositiveIntegerOption(value, optionName) {
  const normalizedValue =
    typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';

  if (!normalizedValue) {
    throw new Error(`Missing value for option ${optionName}.`);
  }

  if (!/^\d+$/.test(normalizedValue) || Number.parseInt(normalizedValue, 10) < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return Number.parseInt(normalizedValue, 10);
}

function buildHealingRootCauseHypothesis(runtimeResult, stderrSummary) {
  return sanitizeInlineCode(
    runtimeResult.rootCauseHypothesis
    || runtimeResult.fallbackReason
    || runtimeResult.summary
    || stderrSummary
    || 'healing attempt failed without a summary.',
  );
}

function buildHealingBlockReason(runtimeResult, stderrSummary) {
  const hypothesis = buildHealingRootCauseHypothesis(runtimeResult, stderrSummary);
  return `retry budget exhausted; hypothesis: ${hypothesis}`;
}

function resolveHealingDiagnosisSignals(runtimeResult, healingOutcome, stderrSummary) {
  const explicitRootCauseHypothesis = sanitizeOptionalInlineCode(runtimeResult.rootCauseHypothesis);

  return {
    smallestFailingUnit: sanitizeOptionalInlineCode(runtimeResult.smallestFailingUnit),
    rootCauseHypothesis:
      explicitRootCauseHypothesis
      || (healingOutcome.blockedByRetryBudget ? buildHealingRootCauseHypothesis(runtimeResult, stderrSummary) : ''),
    escalationReason: sanitizeOptionalInlineCode(runtimeResult.escalationReason),
  };
}

function resolveHealingIterationOutcome(options) {
  const healingItem = isHealingProgressItem(options.selectedItem, options.prdContent);
  const retryBudgetBefore = parseRetryBudgetValue(options.selectedItem.retryBudget);
  const nonPassRuntime = options.runtimeResult.status !== 'pass';
  const attemptConsumed = healingItem && nonPassRuntime && options.attemptConsumed;
  let retryBudgetAfter = retryBudgetBefore;
  let progressStatus = options.runtimeResult.status;
  let progressSummary = options.runtimeResult.summary;
  let blockReason = '';

  if (!healingItem) {
    return {
      healingItem,
      attemptConsumed: false,
      retryBudgetBefore,
      retryBudgetAfter,
      retryBudgetShouldWrite: false,
      progressStatus,
      progressSummary,
      blockReason,
      blockedByRetryBudget: false,
    };
  }

  if (attemptConsumed) {
    retryBudgetAfter = Math.max(0, retryBudgetBefore - 1);
  }

  if (nonPassRuntime && progressStatus === 'blocked' && retryBudgetAfter > 0) {
    progressStatus = 'fail';
  }

  if (nonPassRuntime && attemptConsumed && retryBudgetAfter === 0) {
    progressStatus = 'blocked';
    blockReason = buildHealingBlockReason(options.runtimeResult, options.stderrSummary);
    progressSummary = blockReason;
  }

  return {
    healingItem,
    attemptConsumed,
    retryBudgetBefore,
    retryBudgetAfter,
    retryBudgetShouldWrite: attemptConsumed,
    progressStatus,
    progressSummary,
    blockReason,
    blockedByRetryBudget: blockReason.length > 0,
  };
}

function getMarkdownSectionHeadings(content) {
  const headings = [];
  const headingPattern = /^##\s+(.+)$/gm;
  let match;

  while ((match = headingPattern.exec(content)) !== null) {
    headings.push({
      title: match[1].trim(),
      start: match.index,
    });
  }

  return headings;
}

function getMarkdownSectionTitleAt(headings, index) {
  let currentTitle = '';

  for (const heading of headings) {
    if (heading.start > index) {
      break;
    }

    currentTitle = heading.title;
  }

  return currentTitle;
}

function readProgressItemField(block, label) {
  const match = block.match(new RegExp(`^  - ${escapeForRegExp(label)}:\\s*(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function normalizeProgressStatus(status, checkboxChecked) {
  if (typeof status === 'string' && status.trim()) {
    return status.trim().toLowerCase();
  }

  return checkboxChecked ? 'pass' : 'todo';
}

function parseProgressItemBlock(block, location = {}) {
  const headerMatch = block.match(/^- \[([ x])\] `([^`]+)` Goal: (.+)$/m);
  if (!headerMatch) {
    return null;
  }

  const checkboxChecked = headerMatch[1] === 'x';
  const status = normalizeProgressStatus(readProgressItemField(block, 'Status').replace(/^`|`$/g, ''), checkboxChecked);

  return {
    ...location,
    block,
    checkboxChecked,
    id: headerMatch[2],
    goal: headerMatch[3].trim(),
    input: readProgressItemField(block, 'Input'),
    output: readProgressItemField(block, 'Output'),
    verify: readProgressItemField(block, 'Verify'),
    owner: readProgressItemField(block, 'Owner').replace(/^`|`$/g, ''),
    status,
    retryBudget: readProgressItemField(block, 'Retry budget').replace(/^`|`$/g, ''),
    result: readProgressItemField(block, 'Result').replace(/^`|`$/g, ''),
    fallbackReason: readProgressItemField(block, 'Fallback reason').replace(/^`|`$/g, ''),
    blockReason: readProgressItemField(block, 'Block reason').replace(/^`|`$/g, ''),
  };
}

function parseProgressItems(content) {
  const headings = getMarkdownSectionHeadings(content);
  const items = [];
  const blockPattern = /^- \[[ x]\] `[^`]+` Goal: .*(?:\r?\n  - .*)*/gm;
  let match;

  while ((match = blockPattern.exec(content)) !== null) {
    const sectionTitle = getMarkdownSectionTitleAt(headings, match.index);
    if (sectionTitle === 'Item Template') {
      continue;
    }

    const item = parseProgressItemBlock(match[0], {
      start: match.index,
      end: match.index + match[0].length,
      sectionTitle,
    });

    if (item) {
      items.push(item);
    }
  }

  return items;
}

function findProgressItem(content, predicate) {
  const matchingItems = parseProgressItems(content).filter(predicate);
  return matchingItems.find((item) => item.sectionTitle === 'Active Items') || matchingItems[0] || null;
}

function findProgressItemByOwner(content, owner) {
  return findProgressItem(content, (item) => item.owner === owner);
}

function findNextActionableProgressItem(content) {
  const actionableItems = parseProgressItems(content).filter((item) => ACTIONABLE_PROGRESS_STATUSES.has(item.status));
  return actionableItems.find((item) => item.sectionTitle === 'Active Items') || actionableItems[0] || null;
}

function upsertProgressItemField(block, label, value, options = {}) {
  const fieldPattern = new RegExp(`^  - ${escapeForRegExp(label)}: .*?$`, 'm');
  const line = `  - ${label}: ${value}`;

  if (fieldPattern.test(block)) {
    return block.replace(fieldPattern, line);
  }

  if (options.insertBeforeLabel) {
    const anchorPattern = new RegExp(`^  - ${escapeForRegExp(options.insertBeforeLabel)}: .*?$`, 'm');
    if (anchorPattern.test(block)) {
      return block.replace(anchorPattern, `${line}\n$&`);
    }
  }

  return `${block}\n${line}`;
}

function updateProgressItemBlock(block, status, resultText, options = {}) {
  let updated = block.replace(/^- \[[ x]\]/, status === 'pass' ? '- [x]' : '- [ ]');
  updated = upsertProgressItemField(updated, 'Status', `\`${status}\``);
  if (Object.prototype.hasOwnProperty.call(options, 'retryBudget') && options.retryBudget !== undefined) {
    updated = upsertProgressItemField(updated, 'Retry budget', `\`${sanitizeInlineCode(options.retryBudget)}\``, {
      insertBeforeLabel: 'Result',
    });
  }
  updated = upsertProgressItemField(updated, 'Result', `\`${sanitizeInlineCode(resultText)}\``, {
    insertBeforeLabel: 'Fallback reason',
  });

  if (Object.prototype.hasOwnProperty.call(options, 'fallbackReason') && options.fallbackReason !== undefined) {
    updated = upsertProgressItemField(
      updated,
      'Fallback reason',
      `\`${sanitizeOptionalInlineCode(options.fallbackReason)}\``,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, 'blockReason') && options.blockReason !== undefined) {
    updated = upsertProgressItemField(
      updated,
      'Block reason',
      `\`${sanitizeOptionalInlineCode(options.blockReason)}\``,
    );
  }

  return updated;
}

function appendProgressItem(content, sectionTitle, block) {
  if (content.endsWith('\n')) {
    return `${content}\n## ${sectionTitle}\n\n${block}\n`;
  }

  return `${content}\n\n## ${sectionTitle}\n\n${block}\n`;
}

function replaceProgressItem(content, item, updatedBlock) {
  return `${content.slice(0, item.start)}${updatedBlock}${content.slice(item.end)}`;
}

function buildProgressItemBlock(options) {
  const lines = [
    `- [${options.status === 'pass' ? 'x' : ' '}] \`${options.itemId}\` Goal: ${options.goal}`,
    `  - Input: ${options.input}`,
    `  - Output: ${options.output}`,
    `  - Verify: ${options.verify}`,
    `  - Owner: \`${options.owner}\``,
    `  - Status: \`${options.status}\``,
    `  - Retry budget: \`${options.retryBudget}\``,
    `  - Result: \`${sanitizeInlineCode(options.resultText)}\``,
    `  - Fallback reason: \`${sanitizeOptionalInlineCode(options.fallbackReason)}\``,
  ];

  if (Object.prototype.hasOwnProperty.call(options, 'blockReason') && options.blockReason !== undefined) {
    lines.push(`  - Block reason: \`${sanitizeOptionalInlineCode(options.blockReason)}\``);
  }

  return lines.join('\n');
}

function upsertProgressItemResult(progressPath, options) {
  const status = options.status;
  const resultText = options.resultText;
  const appendIfMissing = options.appendIfMissing || false;
  const content = readText(progressPath);
  const existingItem = options.itemId
    ? findProgressItem(content, (item) => item.id === options.itemId)
    : findProgressItemByOwner(content, options.owner);

  if (existingItem) {
    const updatedBlock = updateProgressItemBlock(existingItem.block, status, resultText, {
      retryBudget: options.retryBudget,
      fallbackReason: options.fallbackReason,
      blockReason: options.blockReason,
    });
    writeText(progressPath, replaceProgressItem(content, existingItem, updatedBlock));
    return;
  }

  if (!appendIfMissing) {
    return;
  }

  const appendedBlock = buildProgressItemBlock({
    itemId: options.itemId,
    goal: options.goal,
    input: options.input,
    output: options.output,
    verify: options.verify,
    owner: options.owner,
    status,
    retryBudget: options.retryBudget,
    resultText,
    fallbackReason: options.fallbackReason,
    blockReason: options.blockReason,
  });

  writeText(progressPath, appendProgressItem(content, options.sectionTitle, appendedBlock));
}

function assertRuntimeAdapterName(adapterName) {
  if (!RUNTIME_ADAPTER_NAMES.has(adapterName)) {
    throw new Error(
      `Unsupported runtime adapter "${adapterName}". Expected one of: ${Array.from(RUNTIME_ADAPTER_NAMES).join(', ')}.`,
    );
  }
}

function buildRuntimeAdapterArtifactArgs(runId, runPaths, selectedItem) {
  return [
    '--run-id',
    runId,
    '--run-dir',
    runPaths.runDir,
    '--prompt-path',
    runPaths.promptPath,
    '--prd-path',
    runPaths.prdPath,
    '--progress-path',
    runPaths.progressPath,
    '--normalized-feature-path',
    runPaths.normalizedFeaturePath,
    '--item-id',
    selectedItem.id,
    '--item-goal',
    selectedItem.goal,
    '--item-verify',
    selectedItem.verify,
  ];
}

function parseEnvStringArray(rawValue, envVarName) {
  if (!rawValue) {
    return [];
  }

  let parsedValue;
  try {
    parsedValue = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${envVarName} must be a JSON array of strings.`);
  }

  if (!Array.isArray(parsedValue) || parsedValue.some((value) => typeof value !== 'string')) {
    throw new Error(`${envVarName} must be a JSON array of strings.`);
  }

  return parsedValue;
}

function buildRuntimeAdapterInvocation(options) {
  const adapterName = options.adapterName || 'external';
  const repoRoot = options.repoRoot || process.cwd();
  const env = options.env || process.env;
  const baseArgs = buildRuntimeAdapterArtifactArgs(options.runId, options.runPaths, options.selectedItem);
  const configuredArgs = parseEnvStringArray(env.QA_HARNESS_EXTERNAL_RUNTIME_ARGS, 'QA_HARNESS_EXTERNAL_RUNTIME_ARGS');
  const invocationEnv = applyExecutionControlsToEnv(env, options.executionControls, {
    QA_HARNESS_ACTIVE_BROWSER_RUNTIME: 'playwright-cli',
  });

  assertRuntimeAdapterName(adapterName);

  if (adapterName === 'mock') {
    return {
      adapterName,
      command: process.execPath,
      args: [path.join(__dirname, 'qa-runtime-mock-adapter.js'), ...baseArgs],
      cwd: repoRoot,
      env: invocationEnv,
    };
  }

  const command = env.QA_HARNESS_EXTERNAL_RUNTIME_CMD;
  if (typeof command === 'string' && command.trim()) {
    return {
      adapterName,
      command: command.trim(),
      args: [...configuredArgs, ...baseArgs],
      cwd: repoRoot,
      env: invocationEnv,
    };
  }

  return {
    adapterName,
    command: process.execPath,
    args: [path.join(__dirname, 'qa-runtime-external-worker.js'), ...configuredArgs, ...baseArgs],
    cwd: repoRoot,
    env: invocationEnv,
  };
}

function buildPlaywrightBridgeInvocation(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const env = options.env || process.env;
  const command = env.QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD;
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Playwright test/debug bridge requested but QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD is not configured.');
  }

  const baseArgs = buildRuntimeAdapterArtifactArgs(options.runId, options.runPaths, options.selectedItem);
  return {
    adapterName: options.adapterName || 'external',
    command: command.trim(),
    args: [...parseEnvStringArray(env.QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS, 'QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS'), ...baseArgs],
    cwd: repoRoot,
    env: applyExecutionControlsToEnv(env, options.executionControls, {
      QA_HARNESS_ACTIVE_BROWSER_RUNTIME: 'playwright-test',
      QA_HARNESS_PREVIOUS_BROWSER_RUNTIME: 'playwright-cli',
      QA_HARNESS_BRIDGE_REASON: options.bridgeReason || '',
    }),
  };
}

function appendPlaywrightExecutionControlArgs(args, executionControlState, options = {}) {
  const nextArgs = Array.isArray(args) ? [...args] : [];
  if (!executionControlState || !executionControlState.shouldPersist) {
    return nextArgs;
  }

  const controls = executionControlState.controls;
  const includeProject = options.includeProject !== false;
  if (includeProject) {
    nextArgs.push(`--project=${sanitizeInlineCode(controls.project || DEFAULT_EXECUTION_CONTROLS.project)}`);
  }

  if (controls.headed) {
    nextArgs.push('--headed');
  }

  if (controls.debug) {
    nextArgs.push('--debug');
  }

  if (controls.trace) {
    nextArgs.push(`--trace=${sanitizeInlineCode(controls.trace)}`);
  }

  if (controls.video) {
    nextArgs.push(`--video=${sanitizeInlineCode(controls.video)}`);
  }

  if (controls.screenshot) {
    nextArgs.push(`--screenshot=${sanitizeInlineCode(controls.screenshot)}`);
  }

  return nextArgs;
}

function normalizeStringList(value) {
  const values = Array.isArray(value)
    ? value
    : value == null
      ? []
      : [value];
  const normalizedValues = [];
  const seenValues = new Set();

  for (const entry of values) {
    const normalizedEntry = sanitizeOptionalInlineCode(entry);
    if (!normalizedEntry || seenValues.has(normalizedEntry)) {
      continue;
    }

    seenValues.add(normalizedEntry);
    normalizedValues.push(normalizedEntry);
  }

  return normalizedValues;
}

function readObjectStringField(record, keys) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return '';
  }

  for (const key of keys) {
    if (hasMeaningfulString(record[key])) {
      return sanitizeInlineCode(record[key]);
    }
  }

  return '';
}

function readGapCandidateField(candidate, keys) {
  return readObjectStringField(candidate, keys);
}

function normalizeGapCandidates(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedCandidates = [];
  const seenCandidates = new Set();

  for (const candidate of value) {
    let gap = '';
    let candidateScenario = '';
    let additionTarget = '';
    let evidence = [];

    if (typeof candidate === 'string') {
      gap = sanitizeInlineCode(candidate);
    } else if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      gap = readGapCandidateField(candidate, ['gap', 'observedGap', 'summary', 'title']);
      candidateScenario = readGapCandidateField(candidate, ['candidateScenario', 'scenario', 'proposal']);
      additionTarget = readGapCandidateField(candidate, [
        'additionTarget',
        'scenarioAdditionTarget',
        'scenarioTarget',
        'target',
      ]);
      evidence = normalizeStringList(
        [
          ...normalizeStringList(candidate.evidence),
          ...normalizeStringList(candidate.supportingEvidence),
          ...normalizeStringList(candidate.evidenceRefs),
          ...normalizeStringList(candidate.evidenceReferences),
        ],
      );
    }

    if (!gap && !candidateScenario && !additionTarget && evidence.length === 0) {
      continue;
    }

    const key = JSON.stringify([gap, candidateScenario, additionTarget, evidence]);
    if (seenCandidates.has(key)) {
      continue;
    }

    seenCandidates.add(key);
    normalizedCandidates.push({
      gap,
      candidateScenario,
      additionTarget,
      evidence,
    });
  }

  return normalizedCandidates;
}

function normalizeCoverageScope(value) {
  return typeof value === 'string' && value.trim() ? sanitizeInlineCode(value) : '';
}

function flattenGapCandidateEvidence(gapCandidates) {
  if (!Array.isArray(gapCandidates)) {
    return [];
  }

  return normalizeStringList(
    gapCandidates.flatMap((candidate) => (
      candidate && typeof candidate === 'object' && Array.isArray(candidate.evidence)
        ? candidate.evidence
        : []
    )),
  );
}

function resolveExplorerIterationSignals(runtimeResult) {
  const gapCandidates = Array.isArray(runtimeResult.gapCandidates) ? runtimeResult.gapCandidates : [];
  const singleCandidate = gapCandidates.length === 1 ? gapCandidates[0] : null;

  return {
    observedGap: sanitizeOptionalInlineCode(runtimeResult.observedGap || (singleCandidate && singleCandidate.gap)),
    candidateScenario: sanitizeOptionalInlineCode(
      runtimeResult.candidateScenario || (singleCandidate && singleCandidate.candidateScenario),
    ),
    additionTarget: sanitizeOptionalInlineCode(
      runtimeResult.additionTarget || (singleCandidate && singleCandidate.additionTarget),
    ),
    supportingEvidence: normalizeStringList([
      ...normalizeStringList(runtimeResult.evidence),
      ...flattenGapCandidateEvidence(gapCandidates),
    ]),
    escalationReason: sanitizeOptionalInlineCode(runtimeResult.escalationReason),
    stopReason: sanitizeOptionalInlineCode(runtimeResult.stopReason),
  };
}

function resolveExplorerScope(selectedItem, prdContent, runtimeResult) {
  const runtimeScope = normalizeCoverageScope(runtimeResult.coverageScope);
  if (runtimeScope) {
    return runtimeScope;
  }

  const guidedScenarioScope = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Guided scenario scope'));
  if (guidedScenarioScope && !/^not provided$/i.test(guidedScenarioScope)) {
    return sanitizeInlineCode(guidedScenarioScope);
  }

  const guidedFeatureScope = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Guided feature scope'));
  if (guidedFeatureScope && !/^not provided$/i.test(guidedFeatureScope)) {
    return sanitizeInlineCode(guidedFeatureScope);
  }

  const guidedRiskAreas = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Guided risk areas'));
  if (guidedRiskAreas && !/^not provided$/i.test(guidedRiskAreas)) {
    return sanitizeInlineCode(guidedRiskAreas);
  }

  const autonomousTarget = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Autonomous target'));
  if (autonomousTarget && !/^not provided$/i.test(autonomousTarget)) {
    return sanitizeInlineCode(autonomousTarget);
  }

  const primaryScenarioScope = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Primary scenario scope'));
  if (primaryScenarioScope) {
    return sanitizeInlineCode(primaryScenarioScope);
  }

  const sourceReference = stripMarkdownInlineCode(readMarkdownSummaryField(prdContent, 'Source reference'));
  if (sourceReference) {
    return sanitizeInlineCode(sourceReference);
  }

  return sanitizeInlineCode(selectedItem.goal || selectedItem.id);
}

function buildGuidedExplorationArtifactLines(guidedExploration, options = {}) {
  if (!guidedExploration || !guidedExploration.active) {
    return [];
  }

  const lines = [
    'Guided exploration: yes',
    `Guided scope kind: ${sanitizeInlineCode(guidedExploration.scopeKind || 'single-feature')}`,
    `Guided feature scope: ${sanitizeInlineCode(formatGuidedExplorationList(guidedExploration.featureScopes))}`,
    `Guided scenario scope: ${sanitizeInlineCode(formatGuidedExplorationList(guidedExploration.scenarioScopes))}`,
    `Guided risk areas: ${sanitizeInlineCode(formatGuidedExplorationList(guidedExploration.riskAreas))}`,
    `Guided iteration budget: ${sanitizeInlineCode(formatGuidedExplorationCount(guidedExploration.iterationBudget))}`,
  ];

  if (Object.prototype.hasOwnProperty.call(options, 'recordedIterationsBefore')) {
    lines.push(
      `Guided iterations recorded before run: ${sanitizeInlineCode(formatGuidedExplorationCount(options.recordedIterationsBefore))}`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, 'recordedIterationsAfter')) {
    lines.push(
      `Guided iterations recorded after run: ${sanitizeInlineCode(formatGuidedExplorationCount(options.recordedIterationsAfter))}`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, 'remainingIterationsBefore')) {
    lines.push(
      `Guided iterations remaining before run: ${sanitizeInlineCode(formatGuidedExplorationCount(options.remainingIterationsBefore))}`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, 'remainingIterationsAfter')) {
    lines.push(
      `Guided iterations remaining after run: ${sanitizeInlineCode(formatGuidedExplorationCount(options.remainingIterationsAfter))}`,
    );
  }

  lines.push(`Guided findings artifact: ${GAP_ANALYSIS_ARTIFACT_DISPLAY}`);
  lines.push(`Guided stop conditions: ${sanitizeInlineCode(guidedExploration.stopConditionsText)}`);

  return lines;
}

function buildAutonomousExplorationArtifactLines(autonomousExploration, options = {}) {
  if (!autonomousExploration || !autonomousExploration.active) {
    return [];
  }

  const lines = [
    'Autonomous exploration: yes',
    `Autonomous target kind: ${sanitizeInlineCode(autonomousExploration.targetKind || 'feature')}`,
    `Autonomous target: ${sanitizeInlineCode(autonomousExploration.target || 'not selected')}`,
    `Autonomous target source: ${sanitizeInlineCode(autonomousExploration.targetSource || 'normalized.feature')}`,
    `Autonomous iteration budget: ${sanitizeInlineCode(formatAutonomousExplorationCount(autonomousExploration.iterationBudget))}`,
  ];

  if (Object.prototype.hasOwnProperty.call(options, 'recordedIterationsBefore')) {
    lines.push(
      `Autonomous iterations recorded before run: ${sanitizeInlineCode(formatAutonomousExplorationCount(options.recordedIterationsBefore))}`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, 'recordedIterationsAfter')) {
    lines.push(
      `Autonomous iterations recorded after run: ${sanitizeInlineCode(formatAutonomousExplorationCount(options.recordedIterationsAfter))}`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, 'remainingIterationsBefore')) {
    lines.push(
      `Autonomous iterations remaining before run: ${sanitizeInlineCode(formatAutonomousExplorationCount(options.remainingIterationsBefore))}`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, 'remainingIterationsAfter')) {
    lines.push(
      `Autonomous iterations remaining after run: ${sanitizeInlineCode(formatAutonomousExplorationCount(options.remainingIterationsAfter))}`,
    );
  }

  lines.push(`Autonomous findings artifact: ${GAP_ANALYSIS_ARTIFACT_DISPLAY}`);
  lines.push(`Autonomous stop frame: ${sanitizeInlineCode(autonomousExploration.stopFrameText)}`);

  return lines;
}

function formatExplorerGapAnalysisSummary(recordedOutcome, fallbackSummary) {
  const candidateCount = parseOptionalNonNegativeInteger(recordedOutcome.gapAnalysisCandidateCount);
  const scope = sanitizeOptionalInlineCode(recordedOutcome.gapAnalysisScope);
  const baseSummary = sanitizeInlineCode(recordedOutcome.gapAnalysisSummary || fallbackSummary || 'gap analysis summary unavailable.');
  const gapLabel = candidateCount == null
    ? 'gap analysis'
    : `${candidateCount} gap candidate${candidateCount === 1 ? '' : 's'}`;
  const scopeLabel = scope ? `${gapLabel} for ${scope}` : gapLabel;
  return `${scopeLabel}: ${baseSummary}`;
}

function formatHealingReportSummary(recordedOutcome, fallbackSummary) {
  const baseSummary = sanitizeInlineCode(recordedOutcome.healSummary || fallbackSummary || 'heal report summary unavailable.');
  const segments = [baseSummary];

  if (recordedOutcome.healSmallestFailingUnit) {
    segments.push(`smallest failing unit: ${sanitizeInlineCode(recordedOutcome.healSmallestFailingUnit)}`);
  }

  if (recordedOutcome.healRootCauseHypothesis) {
    segments.push(`hypothesis: ${sanitizeInlineCode(recordedOutcome.healRootCauseHypothesis)}`);
  }

  if (recordedOutcome.healEscalationReason) {
    segments.push(`escalation: ${sanitizeInlineCode(recordedOutcome.healEscalationReason)}`);
  }

  return segments.join('; ');
}

function resolveScenarioAdditionTargetArtifact(runPaths, rawValue) {
  if (hasMeaningfulString(rawValue)) {
    const value = rawValue.trim();
    if (path.isAbsolute(value)) {
      return resolveDisplayPath(runPaths.runDir, value);
    }

    return normalizeDisplayPath(value);
  }

  return normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.normalizedFeaturePath));
}

function resolveScenarioAdditionSignals(runtimeResult, runPaths) {
  const blockReason = sanitizeOptionalInlineCode(
    runtimeResult.blockReason || (runtimeResult.status === 'blocked' ? runtimeResult.stopReason : ''),
  );

  return {
    addedScenarioOrOutline: sanitizeOptionalInlineCode(runtimeResult.addedScenarioOrOutline),
    targetArtifact: resolveScenarioAdditionTargetArtifact(runPaths, runtimeResult.targetArtifactPath),
    supportingEvidence: normalizeStringList(runtimeResult.evidence),
    escalationReason: sanitizeOptionalInlineCode(runtimeResult.escalationReason),
    stopReason: sanitizeOptionalInlineCode(runtimeResult.stopReason),
    blockReason,
  };
}

function formatScenarioAdditionSummary(recordedOutcome, fallbackSummary) {
  const baseSummary = sanitizeInlineCode(
    recordedOutcome.scenarioAdditionSummary || fallbackSummary || 'scenario addition summary unavailable.',
  );
  const targetArtifact = sanitizeInlineCode(recordedOutcome.scenarioAdditionTargetArtifact || 'normalized.feature');
  const addedScenarioOrOutline = sanitizeOptionalInlineCode(recordedOutcome.scenarioAdditionAddedScenarioOrOutline);

  if (addedScenarioOrOutline) {
    return `added ${addedScenarioOrOutline} in ${targetArtifact}: ${baseSummary}`;
  }

  return `scenario addition in ${targetArtifact}: ${baseSummary}`;
}

function normalizeFeatureTextForComparison(content) {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
}

function trimTrailingBlankLines(lines) {
  const trimmedLines = [...lines];
  while (trimmedLines.length > 0 && !trimmedLines[trimmedLines.length - 1].trim()) {
    trimmedLines.pop();
  }

  return trimmedLines;
}

function finalizeFeatureScenarioBlock(blockLines, scenarioBlocks) {
  const normalizedLines = trimTrailingBlankLines(blockLines);
  if (normalizedLines.length === 0) {
    return;
  }

  const headingLine = normalizedLines.find((line) => /^\s*Scenario(?: Outline)?:\s+/.test(line)) || '';
  scenarioBlocks.push({
    headingLine: sanitizeInlineCode(headingLine.trim()),
    blockText: normalizeFeatureTextForComparison(normalizedLines.join('\n')),
  });
}

function parseFeatureScenarioBlocks(featureContent) {
  const normalizedContent = normalizeFeatureTextForComparison(featureContent);
  const lines = normalizedContent ? normalizedContent.split('\n') : [];
  const scenarioBlocks = [];
  const preambleLines = [];
  let currentScenarioLines = null;
  let pendingScenarioTags = [];

  for (const line of lines) {
    if (/^\s*@/.test(line)) {
      if (currentScenarioLines) {
        finalizeFeatureScenarioBlock(currentScenarioLines, scenarioBlocks);
        currentScenarioLines = null;
      }

      pendingScenarioTags.push(line);
      continue;
    }

    if (/^\s*Scenario(?: Outline)?:\s+/.test(line)) {
      if (currentScenarioLines) {
        finalizeFeatureScenarioBlock(currentScenarioLines, scenarioBlocks);
      }

      currentScenarioLines = [...pendingScenarioTags, line];
      pendingScenarioTags = [];
      continue;
    }

    if (currentScenarioLines) {
      currentScenarioLines.push(line);
      continue;
    }

    if (pendingScenarioTags.length > 0) {
      preambleLines.push(...pendingScenarioTags);
      pendingScenarioTags = [];
    }

    preambleLines.push(line);
  }

  if (currentScenarioLines) {
    finalizeFeatureScenarioBlock(currentScenarioLines, scenarioBlocks);
  } else if (pendingScenarioTags.length > 0) {
    preambleLines.push(...pendingScenarioTags);
  }

  return {
    preambleText: normalizeFeatureTextForComparison(preambleLines.join('\n')),
    scenarioBlocks,
  };
}

function areScenarioBlockListsEquivalent(leftBlocks, rightBlocks) {
  return (
    Array.isArray(leftBlocks)
    && Array.isArray(rightBlocks)
    && leftBlocks.length === rightBlocks.length
    && leftBlocks.every((block, index) => block.blockText === rightBlocks[index].blockText)
  );
}

function normalizeScenarioHeading(value) {
  const normalizedValue = sanitizeOptionalInlineCode(value);
  if (!normalizedValue) {
    return '';
  }

  if (/^Scenario(?: Outline)?:\s+/i.test(normalizedValue)) {
    const headingMatch = normalizedValue.match(/^(Scenario(?: Outline)?):\s+(.+)$/i);
    if (!headingMatch) {
      return normalizedValue;
    }

    const headingPrefix = /^scenario outline$/i.test(headingMatch[1]) ? 'Scenario Outline' : 'Scenario';
    return `${headingPrefix}: ${headingMatch[2].trim()}`;
  }

  return `Scenario: ${normalizedValue}`;
}

function resolvePromotionScenarioHeading(recordedOutcome, plannerHandoffRecord) {
  const candidates = [
    normalizeScenarioHeading(recordedOutcome && recordedOutcome.scenarioAdditionAddedScenarioOrOutline),
    normalizeScenarioHeading(plannerHandoffRecord && plannerHandoffRecord.candidateScenario),
  ];

  return candidates.find(Boolean) || '';
}

function stripGherkinKeyword(stepLine) {
  const match = String(stepLine || '').trim().match(/^(?:Given|When|Then|And|But)\s+(.+)$/);
  return match ? match[1].trim() : '';
}

function extractFeatureStepTexts(featureContent) {
  const stepTexts = [];

  for (const line of normalizeFeatureTextForComparison(featureContent).split('\n')) {
    const stepText = stripGherkinKeyword(line);
    if (stepText) {
      stepTexts.push(stepText);
    }
  }

  return normalizeStringList(stepTexts);
}

function extractFeaturePathReference(value) {
  if (!hasMeaningfulString(value)) {
    return '';
  }

  const matches = Array.from(
    value.matchAll(/(?:[A-Za-z]:)?(?:[^:\s"'`()]+[\\/])*[^:\s"'`()]+\.feature/giu),
  );

  for (const match of matches) {
    const candidate = sanitizeOptionalInlineCode(match[0]);
    if (candidate && /(^|[\\/])Features([\\/]|$)/i.test(candidate)) {
      return candidate;
    }
  }

  return '';
}

function isPathWithin(parentDir, targetPath) {
  const relativePath = path.relative(parentDir, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveCanonicalPromotionTarget(repoRoot, artifactSet, plannerHandoffRecord) {
  const featuresRoot = path.join(repoRoot, 'Features');
  const candidates = new Map();

  const registerCandidate = (rawValue, sourceLabel) => {
    const featurePath = extractFeaturePathReference(rawValue);
    if (!featurePath) {
      return;
    }

    const resolvedPath = path.resolve(repoRoot, featurePath);
    if (path.extname(resolvedPath).toLowerCase() !== '.feature' || !isPathWithin(featuresRoot, resolvedPath)) {
      return;
    }

    const key = normalizeDisplayPath(resolvedPath);
    const existing = candidates.get(key) || {
      resolvedPath,
      sourceLabels: [],
    };
    existing.sourceLabels.push(sourceLabel);
    candidates.set(key, existing);
  };

  registerCandidate(resolvePlannerSourceRefDisplay(artifactSet), 'source reference');
  registerCandidate(plannerHandoffRecord && plannerHandoffRecord.candidateAdditionTarget, 'planner addition target');

  const resolvedCandidates = Array.from(candidates.values());
  if (resolvedCandidates.length === 0) {
    return {
      status: 'blocked',
      summary: 'canonical target could not be resolved from current run artifacts.',
      targetPath: '',
      targetDisplayPath: '',
      candidateSources: [],
    };
  }

  if (resolvedCandidates.length > 1) {
    return {
      status: 'blocked',
      summary: `canonical target is ambiguous across ${resolvedCandidates.map((candidate) => resolveDisplayPath(repoRoot, candidate.resolvedPath)).join(', ')}.`,
      targetPath: '',
      targetDisplayPath: '',
      candidateSources: resolvedCandidates.flatMap((candidate) => candidate.sourceLabels),
    };
  }

  const targetPath = resolvedCandidates[0].resolvedPath;
  const sourceLabels = resolvedCandidates[0].sourceLabels;
  const targetDisplayPath = resolveDisplayPath(repoRoot, targetPath);
  if (!pathExists(targetPath)) {
    return {
      status: 'blocked',
      summary: `canonical target ${targetDisplayPath} is missing.`,
      targetPath,
      targetDisplayPath,
      candidateSources: sourceLabels,
    };
  }

  return {
    status: 'pass',
    summary: '',
    targetPath,
    targetDisplayPath,
    candidateSources: sourceLabels,
  };
}

function hasConflictMarkers(content) {
  return /^(?:<{7}|={7}|>{7})/m.test(String(content || ''));
}

function unescapeStepExpressionLiteral(rawValue, quote) {
  return String(rawValue || '')
    .replace(new RegExp(`\\\\${escapeForRegExp(quote)}`, 'g'), quote)
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function extractRegisteredStepExpressions(stepFileContent) {
  const expressions = [];
  const pattern = /\b(?:Given|When|Then)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,/g;
  let match;

  while ((match = pattern.exec(stepFileContent)) !== null) {
    expressions.push(unescapeStepExpressionLiteral(match[2], match[1]));
  }

  return normalizeStringList(expressions);
}

function cucumberExpressionToRegExp(expression) {
  let pattern = escapeForRegExp(expression);
  pattern = pattern.replace(/\\\{string\\\}/g, '(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')');
  pattern = pattern.replace(/\\\{int\\\}/g, '-?\\d+');
  pattern = pattern.replace(/\\\{float\\\}/g, '-?(?:\\d+|\\d*\\.\\d+)');
  pattern = pattern.replace(/\\\{word\\\}/g, '[^\\s]+');
  pattern = pattern.replace(/\\\{[^}]+\\\}/g, '.+');
  return new RegExp(`^${pattern}$`);
}

function stepTextMatchesExpression(stepText, expression) {
  try {
    return cucumberExpressionToRegExp(expression).test(stepText);
  } catch (error) {
    return false;
  }
}

function collectStepDefinitions(repoRoot, overrideFiles = new Map()) {
  const stepsDir = path.join(repoRoot, 'Features', 'steps');
  const definitions = [];
  const stepFiles = new Set();

  if (pathExists(stepsDir)) {
    walkFiles(stepsDir)
      .filter((filePath) => /\.(c|m)?tsx?$/i.test(filePath))
      .forEach((filePath) => stepFiles.add(filePath));
  }

  for (const filePath of overrideFiles.keys()) {
    if (/\.(c|m)?tsx?$/i.test(filePath)) {
      stepFiles.add(filePath);
    }
  }

  for (const filePath of Array.from(stepFiles).sort()) {
    const fileContent = overrideFiles.has(filePath)
      ? overrideFiles.get(filePath)
      : readText(filePath);
    const fileDisplayPath = resolveDisplayPath(repoRoot, filePath);
    extractRegisteredStepExpressions(fileContent).forEach((expression) => {
      definitions.push({
        expression,
        fileDisplayPath,
      });
    });
  }

  return definitions;
}

function findMissingFeatureSteps(stepTexts, definitions) {
  return normalizeStringList(
    stepTexts.filter((stepText) => !definitions.some((definition) => stepTextMatchesExpression(stepText, definition.expression))),
  );
}

function resolvePromotionGeneratedStepRecord(stepText) {
  return PROMOTION_GENERATED_STEP_LIBRARY.find((record) => stepTextMatchesExpression(stepText, record.expression)) || null;
}

function buildPromotionGeneratedStepFileContent(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return '';
  }

  const orderedRecords = PROMOTION_GENERATED_STEP_LIBRARY.filter((candidate) =>
    records.some((record) => record.expression === candidate.expression),
  );
  const keywordImports = Array.from(new Set(orderedRecords.flatMap((record) => record.keywords))).sort();
  const helperImports = Array.from(new Set(orderedRecords.flatMap((record) => record.helperImports))).sort();
  const importLines = [];

  if (orderedRecords.some((record) => record.importExpect)) {
    importLines.push("import { expect } from '@playwright/test';");
  }

  importLines.push(`import { ${keywordImports.join(', ')} } from './fixtures';`);

  if (helperImports.length > 0) {
    importLines.push(`import { ${helperImports.join(', ')} } from './index';`);
  }

  return [
    ...importLines,
    '',
    PROMOTION_STEP_FILE_HEADER,
    '',
    orderedRecords.map((record) => record.lines.join('\n')).join('\n\n'),
    '',
  ].join('\n');
}

function buildPromotionStepPlan(repoRoot, finalFeatureContent) {
  const stepTexts = extractFeatureStepTexts(finalFeatureContent);
  const promotionStepFilePath = path.join(repoRoot, ...CANONICAL_PROMOTION_STEP_FILE_DISPLAY.split('/'));
  const overrideFiles = new Map();
  const existingDefinitions = collectStepDefinitions(repoRoot);
  const missingStepTexts = findMissingFeatureSteps(stepTexts, existingDefinitions);

  if (missingStepTexts.length === 0) {
    return {
      status: 'pass',
      summary: 'existing reusable step library already covers the promoted feature.',
      promotionStepFilePath,
      promotionStepFileDisplay: CANONICAL_PROMOTION_STEP_FILE_DISPLAY,
      stepAction: 'unchanged',
      proposedFiles: overrideFiles,
      addedExpressions: [],
    };
  }

  const unresolvedStepTexts = [];
  const requiredGeneratedRecords = [];

  for (const stepText of missingStepTexts) {
    const generatedRecord = resolvePromotionGeneratedStepRecord(stepText);
    if (!generatedRecord) {
      unresolvedStepTexts.push(stepText);
      continue;
    }

    if (!requiredGeneratedRecords.some((record) => record.expression === generatedRecord.expression)) {
      requiredGeneratedRecords.push(generatedRecord);
    }
  }

  if (unresolvedStepTexts.length > 0) {
    return {
      status: 'fail',
      summary: `unverifiable step coverage for ${unresolvedStepTexts.map((stepText) => `"${stepText}"`).join(', ')}.`,
      promotionStepFilePath,
      promotionStepFileDisplay: CANONICAL_PROMOTION_STEP_FILE_DISPLAY,
      stepAction: 'unchanged',
      proposedFiles: overrideFiles,
      addedExpressions: [],
    };
  }

  let existingGeneratedRecords = [];
  if (pathExists(promotionStepFilePath)) {
    const existingGeneratedContent = readText(promotionStepFilePath);
    if (hasConflictMarkers(existingGeneratedContent)) {
      return {
        status: 'blocked',
        summary: `${CANONICAL_PROMOTION_STEP_FILE_DISPLAY} contains merge conflict markers.`,
        promotionStepFilePath,
        promotionStepFileDisplay: CANONICAL_PROMOTION_STEP_FILE_DISPLAY,
        stepAction: 'unchanged',
        proposedFiles: overrideFiles,
        addedExpressions: [],
      };
    }

    if (!existingGeneratedContent.includes(PROMOTION_STEP_FILE_HEADER)) {
      return {
        status: 'blocked',
        summary: `${CANONICAL_PROMOTION_STEP_FILE_DISPLAY} already exists outside promotion ownership.`,
        promotionStepFilePath,
        promotionStepFileDisplay: CANONICAL_PROMOTION_STEP_FILE_DISPLAY,
        stepAction: 'unchanged',
        proposedFiles: overrideFiles,
        addedExpressions: [],
      };
    }

    existingGeneratedRecords = extractRegisteredStepExpressions(existingGeneratedContent)
      .map((expression) => PROMOTION_GENERATED_STEP_LIBRARY.find((record) => record.expression === expression))
      .filter(Boolean);
  }

  const combinedGeneratedRecords = PROMOTION_GENERATED_STEP_LIBRARY.filter((candidate) =>
    existingGeneratedRecords.some((record) => record.expression === candidate.expression)
    || requiredGeneratedRecords.some((record) => record.expression === candidate.expression),
  );
  const nextGeneratedContent = buildPromotionGeneratedStepFileContent(combinedGeneratedRecords);
  overrideFiles.set(promotionStepFilePath, nextGeneratedContent);

  return {
    status: 'pass',
    summary: requiredGeneratedRecords.length > 0
      ? `${pathExists(promotionStepFilePath) ? 'refined' : 'created'} reusable promotion step coverage in ${CANONICAL_PROMOTION_STEP_FILE_DISPLAY}.`
      : 'existing reusable promotion step coverage retained.',
    promotionStepFilePath,
    promotionStepFileDisplay: CANONICAL_PROMOTION_STEP_FILE_DISPLAY,
    stepAction: requiredGeneratedRecords.length > 0
      ? pathExists(promotionStepFilePath)
        ? 'refined'
        : 'created'
      : 'unchanged',
    proposedFiles: overrideFiles,
    addedExpressions: requiredGeneratedRecords.map((record) => record.expression),
  };
}

function writePromotionOutcomeReport(runPaths, status, lines) {
  writePromotionReport(runPaths.promotionReportPath, status, lines);
  return normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.promotionReportPath));
}

function promoteAcceptedScenarioAddition(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const artifactSet = options.artifactSet;
  const runPaths = artifactSet.runPaths;
  const plannerHandoffRecord = options.plannerHandoffRecord || null;
  const selectedItem = options.selectedItem || null;
  const recordedOutcome = options.recordedOutcome || {};
  const promotionReportPathDisplay = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.promotionReportPath));
  const runtimeLogDisplayPath = options.runtimeLogPathDisplay
    || normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.runtimeLogPath));
  const verifierEvidence = normalizeStringList([
    'logs/verifier.log',
    SCENARIO_ADDITION_ARTIFACT_DISPLAY,
    runtimeLogDisplayPath,
  ]);
  const selectedItemLabel = selectedItem ? `${selectedItem.id} - ${selectedItem.goal}` : 'missing';
  const canonicalTarget = resolveCanonicalPromotionTarget(repoRoot, artifactSet, plannerHandoffRecord);
  const scenarioHeading = resolvePromotionScenarioHeading(recordedOutcome, plannerHandoffRecord);

  const baseReportLines = [
    `Selected item: ${selectedItemLabel}`,
    `Source artifact: ${SCENARIO_ADDITION_ARTIFACT_DISPLAY}`,
    `Planner handoff: ${PLANNER_HANDOFF_ARTIFACT_DISPLAY}`,
    `Promotion source: normalized.feature`,
    `Verification evidence: ${verifierEvidence.join(', ')}`,
  ];

  if (canonicalTarget.candidateSources.length > 0) {
    baseReportLines.push(`Target sources: ${canonicalTarget.candidateSources.join(', ')}`);
  }

  if (canonicalTarget.targetDisplayPath) {
    baseReportLines.push(`Canonical feature target: ${canonicalTarget.targetDisplayPath}`);
  }

  if (scenarioHeading) {
    baseReportLines.push(`Promoted scenario or outline: ${scenarioHeading}`);
  }

  const finishPromotion = (status, summary, extraLines = []) => {
    writePromotionOutcomeReport(runPaths, status, [
      ...baseReportLines,
      ...extraLines,
      `Summary: ${sanitizeInlineCode(summary)}`,
    ]);

    return {
      status,
      summary: sanitizeInlineCode(summary),
      promotionReportPathDisplay,
      canonicalFeatureTargetDisplayPath: canonicalTarget.targetDisplayPath || '',
      promotedScenarioOrOutline: scenarioHeading,
      promotionStepFileDisplay: '',
      featureAction: 'unchanged',
      stepAction: 'unchanged',
    };
  };

  if (canonicalTarget.status !== 'pass') {
    return finishPromotion(canonicalTarget.status, canonicalTarget.summary);
  }

  const normalizedFeatureContent = artifactSet.normalizedFeatureContent;
  const canonicalFeatureContent = readText(canonicalTarget.targetPath);
  if (hasConflictMarkers(normalizedFeatureContent)) {
    return finishPromotion('blocked', 'normalized.feature contains merge conflict markers.');
  }

  if (hasConflictMarkers(canonicalFeatureContent)) {
    return finishPromotion('blocked', `${canonicalTarget.targetDisplayPath} contains merge conflict markers.`);
  }

  const normalizedDocument = parseFeatureScenarioBlocks(normalizedFeatureContent);
  const canonicalDocument = parseFeatureScenarioBlocks(canonicalFeatureContent);
  const matchingNormalizedBlocks = scenarioHeading
    ? normalizedDocument.scenarioBlocks.filter((block) => block.headingLine === scenarioHeading)
    : [];
  if (scenarioHeading && matchingNormalizedBlocks.length !== 1) {
    return finishPromotion(
      'fail',
      `promotion could not locate exactly one ${scenarioHeading} block in normalized.feature.`,
    );
  }

  const candidateBlock = matchingNormalizedBlocks[0] || null;
  const candidateIndex = candidateBlock
    ? normalizedDocument.scenarioBlocks.findIndex((block) => block.blockText === candidateBlock.blockText)
    : -1;
  const preambleMatches = normalizedDocument.preambleText === canonicalDocument.preambleText;
  const normalizedWithoutCandidate = candidateIndex >= 0
    ? normalizedDocument.scenarioBlocks.filter((_, index) => index !== candidateIndex)
    : [];
  const canonicalMatchesWithoutCandidate =
    candidateIndex >= 0
    && preambleMatches
    && areScenarioBlockListsEquivalent(normalizedWithoutCandidate, canonicalDocument.scenarioBlocks);
  const canonicalAlreadySynchronized =
    preambleMatches
    && areScenarioBlockListsEquivalent(normalizedDocument.scenarioBlocks, canonicalDocument.scenarioBlocks);

  if (!canonicalAlreadySynchronized && !canonicalMatchesWithoutCandidate) {
    return finishPromotion(
      'blocked',
      `promotion drift detected between normalized.feature and ${canonicalTarget.targetDisplayPath}.`,
    );
  }

  if (!candidateBlock && !canonicalAlreadySynchronized) {
    return finishPromotion('fail', 'promotion could not determine one bounded scenario block to promote.');
  }

  const finalCanonicalFeatureContent = `${normalizeFeatureTextForComparison(normalizedFeatureContent)}\n`;
  const stepPlan = buildPromotionStepPlan(repoRoot, finalCanonicalFeatureContent);
  if (stepPlan.status !== 'pass') {
    return finishPromotion(stepPlan.status, stepPlan.summary, [
      ...(stepPlan.promotionStepFileDisplay
        ? [`Canonical step target: ${stepPlan.promotionStepFileDisplay}`]
        : []),
    ]);
  }

  const finalStepDefinitions = collectStepDefinitions(repoRoot, stepPlan.proposedFiles);
  const unresolvedFeatureSteps = findMissingFeatureSteps(
    extractFeatureStepTexts(finalCanonicalFeatureContent),
    finalStepDefinitions,
  );
  if (unresolvedFeatureSteps.length > 0) {
    return finishPromotion(
      'fail',
      `unverifiable promoted feature step coverage remains for ${unresolvedFeatureSteps.map((stepText) => `"${stepText}"`).join(', ')}.`,
      [
        ...(stepPlan.promotionStepFileDisplay
          ? [`Canonical step target: ${stepPlan.promotionStepFileDisplay}`]
          : []),
      ],
    );
  }

  for (const [filePath, fileContent] of stepPlan.proposedFiles.entries()) {
    writeText(filePath, fileContent);
  }

  if (!canonicalAlreadySynchronized) {
    writeText(canonicalTarget.targetPath, finalCanonicalFeatureContent);
  }

  const summary = canonicalAlreadySynchronized
    ? `canonical target already synchronized for ${scenarioHeading || 'the promoted scenario'} in ${canonicalTarget.targetDisplayPath}.`
    : `promoted ${scenarioHeading || 'one scenario'} into ${canonicalTarget.targetDisplayPath}.`;
  const extraLines = [
    `Feature action: ${canonicalAlreadySynchronized ? 'unchanged' : 'updated from normalized.feature'}`,
    `Step action: ${stepPlan.stepAction}`,
    ...(stepPlan.promotionStepFileDisplay && stepPlan.stepAction !== 'unchanged'
      ? [`Canonical step target: ${stepPlan.promotionStepFileDisplay}`]
      : []),
    ...(stepPlan.addedExpressions.length > 0
      ? [`Added reusable step expressions: ${stepPlan.addedExpressions.join(', ')}`]
      : []),
  ];
  writePromotionOutcomeReport(runPaths, 'pass', [
    ...baseReportLines,
    ...extraLines,
    `Summary: ${sanitizeInlineCode(summary)}`,
  ]);

  return {
    status: 'pass',
    summary: sanitizeInlineCode(summary),
    promotionReportPathDisplay,
    canonicalFeatureTargetDisplayPath: canonicalTarget.targetDisplayPath,
    promotedScenarioOrOutline: scenarioHeading,
    promotionStepFileDisplay: stepPlan.stepAction !== 'unchanged' ? stepPlan.promotionStepFileDisplay : '',
    featureAction: canonicalAlreadySynchronized ? 'unchanged' : 'updated',
    stepAction: stepPlan.stepAction,
  };
}

function parseRuntimeAdapterOutput(stdout) {
  const normalizedStdout = stripAnsi(stdout).trim();
  if (!normalizedStdout) {
    throw new Error('Runtime adapter did not emit JSON to stdout.');
  }

  let parsed;
  try {
    parsed = JSON.parse(normalizedStdout);
  } catch (error) {
    throw new Error(`Runtime adapter stdout did not contain valid JSON: ${sanitizeInlineCode(normalizedStdout)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Runtime adapter stdout must be a JSON object.');
  }

  const status = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : '';
  if (!RUNTIME_RESULT_STATUSES.has(status)) {
    throw new Error('Runtime adapter JSON is missing a valid status.');
  }

  const requestPlaywrightBridge = parsed.requestPlaywrightBridge === true || parsed.requestBridge === true;
  const runtimeLayer =
    normalizeRuntimeLayer(parsed.runtimeLayer || parsed.runtime) ||
    (requestPlaywrightBridge ? 'playwright-cli' : '');
  const fallbackReason = typeof parsed.fallbackReason === 'string' ? parsed.fallbackReason.trim() : '';
  if (runtimeLayer === 'mcp' && !fallbackReason) {
    throw new Error('Runtime adapter JSON using runtimeLayer "mcp" must include fallbackReason.');
  }

  const bridgeReason = requestPlaywrightBridge
    ? (
      typeof parsed.bridgeReason === 'string' && parsed.bridgeReason.trim()
        ? parsed.bridgeReason.trim()
        : 'Playwright CLI could not complete the action; request the Playwright test/debug bridge.'
    )
    : '';
  const runtimeEvidence = normalizeStringList([
    ...normalizeStringList(parsed.evidence),
    ...normalizeStringList(parsed.supportingEvidence),
    ...normalizeStringList(parsed.evidenceRefs),
    ...normalizeStringList(parsed.evidenceReferences),
  ]);
  const gapCandidates = normalizeGapCandidates([
    ...(Array.isArray(parsed.gapCandidates) ? parsed.gapCandidates : []),
    ...(Array.isArray(parsed.gaps) ? parsed.gaps : []),
  ]);

  return {
    status,
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : `${status} without a runtime summary.`,
    evidence: runtimeEvidence,
    smallestFailingUnit: readObjectStringField(parsed, [
      'smallestFailingUnit',
      'smallestUnit',
      'failingUnit',
      'failingTarget',
    ]),
    rootCauseHypothesis: readObjectStringField(parsed, [
      'rootCauseHypothesis',
      'rootCause',
      'hypothesis',
    ]),
    escalationReason: readObjectStringField(parsed, [
      'escalationReason',
      'escalation',
      'manualFollowUpReason',
    ]),
    observedGap: readObjectStringField(parsed, [
      'observedGap',
      'gap',
      'coverageGap',
    ]),
    candidateScenario: readObjectStringField(parsed, [
      'candidateScenario',
      'scenario',
      'proposal',
    ]),
    additionTarget: readObjectStringField(parsed, [
      'additionTarget',
      'scenarioAdditionTarget',
      'scenarioTarget',
      'target',
    ]),
    addedScenarioOrOutline: readObjectStringField(parsed, [
      'addedScenarioOrOutline',
      'addedScenarioOutline',
      'addedScenario',
      'scenarioOutline',
      'addedOutline',
      'scenarioAdditionText',
    ]),
    targetArtifactPath: readObjectStringField(parsed, [
      'targetArtifactPath',
      'targetArtifact',
      'artifactPath',
      'scenarioArtifactPath',
    ]),
    stopReason: readObjectStringField(parsed, [
      'stopReason',
      'blockedReason',
      'blockReason',
      'stop',
    ]),
    blockReason: readObjectStringField(parsed, [
      'blockReason',
      'blockedReason',
    ]),
    fallbackReason,
    runtimeLayer,
    requestPlaywrightBridge,
    bridgeReason,
    gapCandidates,
    coverageScope: normalizeCoverageScope(parsed.coverageScope || parsed.scope || parsed.featureScope),
  };
}

function normalizeRuntimeAdapterResult(processResult) {
  const childExitCode = processResult.status ?? 1;
  const combinedOutput = `${processResult.stdout}\n${processResult.stderr}`;

  if (childExitCode !== 0) {
    return {
      status: 'fail',
      summary: summarizeOutput(combinedOutput, 'Runtime adapter exited with a non-zero status.'),
      evidence: [],
      smallestFailingUnit: '',
      rootCauseHypothesis: '',
      escalationReason: '',
      observedGap: '',
      candidateScenario: '',
      additionTarget: '',
      addedScenarioOrOutline: '',
      targetArtifactPath: '',
      stopReason: '',
      blockReason: '',
      fallbackReason: '',
      runtimeLayer: '',
      requestPlaywrightBridge: false,
      bridgeReason: '',
      gapCandidates: [],
      coverageScope: '',
      childExitCode,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      parseError: '',
    };
  }

  try {
    const parsed = parseRuntimeAdapterOutput(processResult.stdout);
    return {
      ...parsed,
      childExitCode,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      parseError: '',
    };
  } catch (error) {
    return {
      status: 'fail',
      summary: error instanceof Error ? error.message : String(error),
      evidence: [],
      smallestFailingUnit: '',
      rootCauseHypothesis: '',
      escalationReason: '',
      observedGap: '',
      candidateScenario: '',
      additionTarget: '',
      addedScenarioOrOutline: '',
      targetArtifactPath: '',
      stopReason: '',
      blockReason: '',
      fallbackReason: '',
      runtimeLayer: '',
      requestPlaywrightBridge: false,
      bridgeReason: '',
      gapCandidates: [],
      coverageScope: '',
      childExitCode,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function invokeRuntimeProcess(invocation, processRunner) {
  const processResult = processRunner(invocation.command, invocation.args, invocation.cwd, {
    env: invocation.env,
  });

  return {
    invocation,
    processResult,
    runtimeResult: normalizeRuntimeAdapterResult(processResult),
    commandDisplay: formatCommandDisplay(invocation.command, invocation.args),
  };
}

function shouldInvokePlaywrightBridge(runtimeResult) {
  return runtimeResult.requestPlaywrightBridge === true;
}

function getRecordedFallbackReason(runtimeResult) {
  return runtimeResult.runtimeLayer === 'mcp' ? runtimeResult.fallbackReason : '';
}

function isNoActionableProgressError(error, runId) {
  const message = error instanceof Error ? error.message : String(error);
  return message === `No actionable progress items remain for run ${runId}.`;
}

function loadAdvanceRunSelection(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const artifactSet = loadRunArtifactSet({
    repoRoot,
    templatesDir,
    runId,
  });
  const selectedItem = findNextActionableProgressItem(artifactSet.progressContent);

  if (!selectedItem) {
    throw new Error(`No actionable progress items remain for run ${runId}.`);
  }

  return {
    selectedItemId: selectedItem.id,
    healingItem: isHealingProgressItem(selectedItem, artifactSet.prdContent),
    explorerItem: isExplorerProgressItem(selectedItem, artifactSet.prdContent),
    scenarioAdditionItem: Boolean(readAcceptedPlannerHandoffRecord(artifactSet.runPaths, selectedItem.id)),
  };
}

function iterateRun(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const adapterName = options.adapter || 'external';
  const env = options.env || process.env;
  const processRunner = options.processRunner || runProcess;
  let artifactSet = loadRunArtifactSet({
    repoRoot,
    templatesDir,
    runId,
  });
  const selectedItem = findNextActionableProgressItem(artifactSet.progressContent);

  if (!selectedItem) {
    throw new Error(`No actionable progress items remain for run ${runId}.`);
  }

  const executionControlState = resolveExecutionControls({
    ...options,
    artifactSet,
    defaultProject: parseRequestedProjectValue(selectedItem.verify) || DEFAULT_EXECUTION_CONTROLS.project,
  });
  artifactSet = persistExecutionControls(artifactSet, executionControlState);
  const iterateCommandDescription = buildHarnessCommandDescription('iterate-run', {
    runId,
    adapter: adapterName,
    executionControls: executionControlState,
    includeProject: executionControlState.shouldPersist,
  });
  const runtimeLogDisplayPath = normalizeDisplayPath(path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.runtimeLogPath));
  const fallbackLogDisplayPath = normalizeDisplayPath(path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.fallbackLogPath));
  const gapAnalysisPathDisplay = normalizeDisplayPath(path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.gapAnalysisPath));
  const scenarioAdditionPathDisplay =
    normalizeDisplayPath(path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.scenarioAdditionPath));
  let finalStage = null;
  let primaryStage = null;
  let bridgeStage = null;
  let processResult = null;
  let runtimeResult;

  try {
    const primaryInvocation = buildRuntimeAdapterInvocation({
      adapterName,
      repoRoot,
      runId,
      runPaths: artifactSet.runPaths,
      selectedItem,
      env,
      executionControls: executionControlState,
    });
    primaryStage = invokeRuntimeProcess(primaryInvocation, processRunner);
    finalStage = primaryStage;
    processResult = primaryStage.processResult;
    runtimeResult = primaryStage.runtimeResult;

    if (shouldInvokePlaywrightBridge(primaryStage.runtimeResult)) {
      const bridgeInvocation = buildPlaywrightBridgeInvocation({
        adapterName,
        repoRoot,
        runId,
        runPaths: artifactSet.runPaths,
        selectedItem,
        env,
        executionControls: executionControlState,
        bridgeReason: primaryStage.runtimeResult.bridgeReason,
      });
      bridgeStage = invokeRuntimeProcess(bridgeInvocation, processRunner);
      finalStage = bridgeStage;
      processResult = bridgeStage.processResult;
      runtimeResult = bridgeStage.runtimeResult;
    }
  } catch (error) {
    runtimeResult = {
      status: 'fail',
      summary: error instanceof Error ? error.message : String(error),
      evidence: [],
      smallestFailingUnit: '',
      rootCauseHypothesis: '',
      escalationReason: '',
      fallbackReason: '',
      runtimeLayer: '',
      requestPlaywrightBridge: false,
      bridgeReason: '',
      gapCandidates: [],
      coverageScope: '',
      childExitCode: processResult && processResult.status != null ? processResult.status : null,
      stdout: processResult ? processResult.stdout : '',
      stderr: processResult ? processResult.stderr : '',
      parseError: '',
    };
  }

  const commandDisplay = finalStage ? finalStage.commandDisplay : 'not constructed';
  const stderrSummary = runtimeResult.stderr
    ? summarizeOutput(runtimeResult.stderr, 'stderr produced no summary.')
    : '';
  const recordedFallbackReason = getRecordedFallbackReason(runtimeResult);
  const bridgeUsed = Boolean(bridgeStage);
  const healingOutcome = resolveHealingIterationOutcome({
    selectedItem,
    prdContent: artifactSet.prdContent,
    runtimeResult,
    stderrSummary,
    attemptConsumed: Boolean(primaryStage),
  });
  const healingSignals = resolveHealingDiagnosisSignals(runtimeResult, healingOutcome, stderrSummary);
  const explorerItem = isExplorerProgressItem(selectedItem, artifactSet.prdContent);
  const plannerHandoffRecord = readAcceptedPlannerHandoffRecord(artifactSet.runPaths, selectedItem.id);
  const scenarioAdditionItem = Boolean(plannerHandoffRecord);
  const guidedExploration = explorerItem
    ? resolveGuidedExplorationPlan({
      artifactSet,
    })
    : { active: false };
  const autonomousExploration = explorerItem
    ? resolveAutonomousExplorationPlan({
      artifactSet,
    })
    : { active: false };
  const explorerScope = explorerItem
    ? resolveExplorerScope(selectedItem, artifactSet.prdContent, runtimeResult)
    : '';
  const explorerSignals = explorerItem
    ? resolveExplorerIterationSignals(runtimeResult)
    : {
      observedGap: '',
      candidateScenario: '',
      additionTarget: '',
      supportingEvidence: [],
      escalationReason: '',
      stopReason: '',
    };
  const scenarioAdditionSignals = scenarioAdditionItem
    ? resolveScenarioAdditionSignals(runtimeResult, artifactSet.runPaths)
    : {
      addedScenarioOrOutline: '',
      targetArtifact: '',
      supportingEvidence: [],
      escalationReason: '',
      stopReason: '',
      blockReason: '',
    };
  const externalWorkerRole = scenarioAdditionItem
    ? 'scenario-addition'
    : explorerItem
      ? 'explorer'
      : healingOutcome.healingItem
        ? 'healer'
        : 'executor';
  const externalWorkerAttemptId = `${runId}/${selectedItem.id}`;
  const runtimeLines = [
    `Adapter: ${adapterName}`,
    `Runtime order: ${PLAYWRIGHT_RUNTIME_ORDER.join(' -> ')}`,
    `Playwright bridge: ${bridgeUsed ? 'invoked' : 'not-requested'}`,
    ...(executionControlState.shouldPersist
      ? buildExecutionControlLogLines(executionControlState.controls)
      : [`Project: ${executionControlState.controls.project}`]),
    `Selected item: ${selectedItem.id} - ${selectedItem.goal}`,
    `Selected verify step: ${selectedItem.verify}`,
    `Working directory: ${normalizeDisplayPath(repoRoot)}`,
    `Command: ${commandDisplay}`,
    `Artifact paths: ${[
      artifactSet.runPaths.prdPath,
      artifactSet.runPaths.progressPath,
      artifactSet.runPaths.promptPath,
      artifactSet.runPaths.normalizedFeaturePath,
    ]
      .map((artifactPath) => normalizeDisplayPath(artifactPath))
      .join(', ')}`,
    `Child exit code: ${runtimeResult.childExitCode == null ? 'not-started' : runtimeResult.childExitCode}`,
    `Runtime layer: ${runtimeResult.runtimeLayer || 'unspecified'}`,
    `Parsed status: ${runtimeResult.status}`,
    `Summary: ${sanitizeInlineCode(runtimeResult.summary)}`,
  ];

  if (primaryStage) {
    runtimeLines.push(`Primary command: ${primaryStage.commandDisplay}`);
    runtimeLines.push(`Primary runtime layer: ${primaryStage.runtimeResult.runtimeLayer || 'playwright-cli'}`);
    if (primaryStage.runtimeResult.requestPlaywrightBridge) {
      runtimeLines.push(`Bridge reason: ${sanitizeInlineCode(primaryStage.runtimeResult.bridgeReason)}`);
    }
  }

  if (adapterName === 'external') {
    runtimeLines.push(`Worker role: ${externalWorkerRole}`);
    runtimeLines.push(`Worker attempt: ${sanitizeInlineCode(externalWorkerAttemptId)}`);
  }

  if (bridgeStage) {
    runtimeLines.push(`Bridge command: ${bridgeStage.commandDisplay}`);
    runtimeLines.push(`Bridge runtime layer: ${bridgeStage.runtimeResult.runtimeLayer || 'playwright-test'}`);
  }

  if (runtimeResult.evidence.length > 0) {
    runtimeLines.push(`Evidence: ${runtimeResult.evidence.map(sanitizeInlineCode).join(', ')}`);
  }

  if (recordedFallbackReason) {
    runtimeLines.push(`Fallback reason: ${sanitizeInlineCode(recordedFallbackReason)}`);
  }

  if (healingOutcome.healingItem) {
    runtimeLines.push('Healing item: yes');
    runtimeLines.push(`Healing attempt consumed: ${healingOutcome.attemptConsumed ? 'yes' : 'no'}`);
    runtimeLines.push(`Retry budget before: ${healingOutcome.retryBudgetBefore}`);
    runtimeLines.push(`Retry budget after: ${healingOutcome.retryBudgetAfter}`);
    runtimeLines.push(`Recorded progress status: ${healingOutcome.progressStatus}`);
    if (healingOutcome.blockReason) {
      runtimeLines.push(`Block reason: ${sanitizeInlineCode(healingOutcome.blockReason)}`);
    }
    if (healingSignals.smallestFailingUnit) {
      runtimeLines.push(`Smallest failing unit: ${sanitizeInlineCode(healingSignals.smallestFailingUnit)}`);
    }
    if (healingSignals.rootCauseHypothesis) {
      runtimeLines.push(`Root-cause hypothesis: ${sanitizeInlineCode(healingSignals.rootCauseHypothesis)}`);
    }
    if (healingSignals.escalationReason) {
      runtimeLines.push(`Escalation reason: ${sanitizeInlineCode(healingSignals.escalationReason)}`);
    }
  }

  if (explorerItem) {
    runtimeLines.push('Explorer item: yes');
    runtimeLines.push(`Coverage scope: ${sanitizeInlineCode(explorerScope)}`);
    runtimeLines.push(`Gap candidate count: ${runtimeResult.gapCandidates.length}`);
    runtimeLines.push(
      ...buildGuidedExplorationArtifactLines(guidedExploration, {
        recordedIterationsBefore: guidedExploration.recordedIterations,
        remainingIterationsBefore: guidedExploration.remainingIterations,
      }),
    );
    runtimeLines.push(
      ...buildAutonomousExplorationArtifactLines(autonomousExploration, {
        recordedIterationsBefore: autonomousExploration.recordedIterations,
        remainingIterationsBefore: autonomousExploration.remainingIterations,
      }),
    );
  }

  if (scenarioAdditionItem) {
    runtimeLines.push('Scenario-addition item: yes');
    runtimeLines.push(`Planner handoff: ${PLANNER_HANDOFF_ARTIFACT_DISPLAY}`);
    if (plannerHandoffRecord && plannerHandoffRecord.summary) {
      runtimeLines.push(`Planner handoff summary: ${sanitizeInlineCode(plannerHandoffRecord.summary)}`);
    }
    runtimeLines.push(`Target artifact: ${sanitizeInlineCode(scenarioAdditionSignals.targetArtifact)}`);
    if (scenarioAdditionSignals.addedScenarioOrOutline) {
      runtimeLines.push(`Added scenario or outline: ${sanitizeInlineCode(scenarioAdditionSignals.addedScenarioOrOutline)}`);
    }
    if (scenarioAdditionSignals.supportingEvidence.length > 0) {
      runtimeLines.push(`Supporting evidence: ${scenarioAdditionSignals.supportingEvidence.map(sanitizeInlineCode).join(', ')}`);
    }
    if (scenarioAdditionSignals.escalationReason) {
      runtimeLines.push(`Escalation reason: ${sanitizeInlineCode(scenarioAdditionSignals.escalationReason)}`);
    }
    if (scenarioAdditionSignals.stopReason) {
      runtimeLines.push(`Stop reason: ${sanitizeInlineCode(scenarioAdditionSignals.stopReason)}`);
    }
    if (scenarioAdditionSignals.blockReason) {
      runtimeLines.push(`Block reason: ${sanitizeInlineCode(scenarioAdditionSignals.blockReason)}`);
    }
  }

  if (runtimeResult.parseError) {
    runtimeLines.push(`Parse error: ${sanitizeInlineCode(runtimeResult.parseError)}`);
  }

  if (stderrSummary) {
    runtimeLines.push(`Stderr summary: ${sanitizeInlineCode(stderrSummary)}`);
  }

  writeRuntimeLog(artifactSet.runPaths.runtimeLogPath, runtimeResult.status, runtimeLines);
  upsertProgressItemResult(artifactSet.runPaths.progressPath, {
    itemId: selectedItem.id,
    status: healingOutcome.progressStatus,
    resultText: buildProgressResultText(
      healingOutcome.progressStatus,
      healingOutcome.progressSummary,
      iterateCommandDescription,
      explorerItem
        ? gapAnalysisPathDisplay
        : scenarioAdditionItem
          ? scenarioAdditionPathDisplay
          : runtimeLogDisplayPath,
    ),
    retryBudget: healingOutcome.retryBudgetShouldWrite ? String(healingOutcome.retryBudgetAfter) : undefined,
    fallbackReason: recordedFallbackReason,
    blockReason: healingOutcome.blockReason || undefined,
  });

  if (recordedFallbackReason) {
    writeFallbackLog(artifactSet.runPaths.fallbackLogPath, 'mcp', [
      `Adapter: ${adapterName}`,
      `Runtime order: ${PLAYWRIGHT_RUNTIME_ORDER.join(' -> ')}`,
      `Selected item: ${selectedItem.id} - ${selectedItem.goal}`,
      `Runtime layer: ${runtimeResult.runtimeLayer}`,
      `Runtime log: ${runtimeLogDisplayPath}`,
      `Fallback log: ${fallbackLogDisplayPath}`,
      `Fallback reason: ${sanitizeInlineCode(recordedFallbackReason)}`,
      `Summary: ${sanitizeInlineCode(runtimeResult.summary)}`,
    ]);
  }

  if (healingOutcome.healingItem) {
    const healLines = [
      `Selected item: ${selectedItem.id} - ${selectedItem.goal}`,
      `Owner: ${selectedItem.owner || 'unspecified'}`,
      `Worker role: healer`,
      `Worker attempt: ${sanitizeInlineCode(externalWorkerAttemptId)}`,
      `Retry budget: ${healingOutcome.retryBudgetBefore} -> ${healingOutcome.retryBudgetAfter}`,
      `Runtime status: ${runtimeResult.status}`,
      `Recorded status: ${healingOutcome.progressStatus}`,
      `Runtime layer: ${runtimeResult.runtimeLayer || 'unspecified'}`,
      `Runtime log: ${runtimeLogDisplayPath}`,
    ];

    if (healingSignals.smallestFailingUnit) {
      healLines.push(`Smallest failing unit: ${sanitizeInlineCode(healingSignals.smallestFailingUnit)}`);
    }

    if (healingSignals.rootCauseHypothesis) {
      healLines.push(`Root-cause hypothesis: ${sanitizeInlineCode(healingSignals.rootCauseHypothesis)}`);
    }

    if (healingSignals.escalationReason) {
      healLines.push(`Escalation reason: ${sanitizeInlineCode(healingSignals.escalationReason)}`);
    }

    if (recordedFallbackReason) {
      healLines.push(`Fallback reason: ${sanitizeInlineCode(recordedFallbackReason)}`);
    }

    if (healingOutcome.blockReason) {
      healLines.push(`Block reason: ${sanitizeInlineCode(healingOutcome.blockReason)}`);
    }

    healLines.push(`Summary: ${sanitizeInlineCode(runtimeResult.summary)}`);
    writeHealReport(artifactSet.runPaths.healReportPath, healingOutcome.progressStatus, healLines);
  }

  if (explorerItem) {
    const guidedIterationsAfter = guidedExploration.active
      ? guidedExploration.recordedIterations + 1
      : null;
    const guidedRemainingAfter = guidedExploration.active && guidedExploration.iterationBudget != null
      ? Math.max(guidedExploration.iterationBudget - guidedIterationsAfter, 0)
      : null;
    const autonomousIterationsAfter = autonomousExploration.active
      ? autonomousExploration.recordedIterations + 1
      : null;
    const autonomousRemainingAfter = autonomousExploration.active && autonomousExploration.iterationBudget != null
      ? Math.max(autonomousExploration.iterationBudget - autonomousIterationsAfter, 0)
      : null;
    const gapLines = [
      `Selected item: ${selectedItem.id} - ${selectedItem.goal}`,
      `Worker role: explorer`,
      `Worker attempt: ${sanitizeInlineCode(externalWorkerAttemptId)}`,
      `Scope: ${sanitizeInlineCode(explorerScope)}`,
      `Runtime status: ${healingOutcome.progressStatus}`,
      `Runtime layer: ${runtimeResult.runtimeLayer || 'unspecified'}`,
      `Runtime log: ${runtimeLogDisplayPath}`,
      `Candidate count: ${runtimeResult.gapCandidates.length}`,
      ...buildGuidedExplorationArtifactLines(guidedExploration, {
        recordedIterationsBefore: guidedExploration.recordedIterations,
        recordedIterationsAfter: guidedIterationsAfter,
        remainingIterationsBefore: guidedExploration.remainingIterations,
        remainingIterationsAfter: guidedRemainingAfter,
      }),
      ...buildAutonomousExplorationArtifactLines(autonomousExploration, {
        recordedIterationsBefore: autonomousExploration.recordedIterations,
        recordedIterationsAfter: autonomousIterationsAfter,
        remainingIterationsBefore: autonomousExploration.remainingIterations,
        remainingIterationsAfter: autonomousRemainingAfter,
      }),
    ];

    if (runtimeResult.evidence.length > 0) {
      gapLines.push(`Runtime evidence: ${runtimeResult.evidence.map(sanitizeInlineCode).join(', ')}`);
    }

    if (explorerSignals.observedGap) {
      gapLines.push(`Observed gap: ${sanitizeInlineCode(explorerSignals.observedGap)}`);
    }

    if (explorerSignals.candidateScenario) {
      gapLines.push(`Candidate scenario: ${sanitizeInlineCode(explorerSignals.candidateScenario)}`);
    }

    if (explorerSignals.additionTarget) {
      gapLines.push(`Candidate addition target: ${sanitizeInlineCode(explorerSignals.additionTarget)}`);
    }

    if (explorerSignals.supportingEvidence.length > 0) {
      gapLines.push(`Supporting evidence: ${explorerSignals.supportingEvidence.map(sanitizeInlineCode).join(', ')}`);
    }

    if (recordedFallbackReason) {
      gapLines.push(`Fallback reason: ${sanitizeInlineCode(recordedFallbackReason)}`);
    }

    if (explorerSignals.escalationReason) {
      gapLines.push(`Escalation reason: ${sanitizeInlineCode(explorerSignals.escalationReason)}`);
    }

    if (explorerSignals.stopReason) {
      gapLines.push(`Stop reason: ${sanitizeInlineCode(explorerSignals.stopReason)}`);
    }

    runtimeResult.gapCandidates.forEach((candidate, index) => {
      const ordinal = index + 1;
      if (candidate.gap) {
        gapLines.push(`Candidate ${ordinal} gap: ${candidate.gap}`);
      }
      if (candidate.candidateScenario) {
        gapLines.push(`Candidate ${ordinal} scenario: ${candidate.candidateScenario}`);
      }
      if (candidate.additionTarget) {
        gapLines.push(`Candidate ${ordinal} addition target: ${candidate.additionTarget}`);
      }
      if (candidate.evidence.length > 0) {
        gapLines.push(`Candidate ${ordinal} evidence: ${candidate.evidence.join(', ')}`);
      }
    });

    gapLines.push(`Summary: ${sanitizeInlineCode(runtimeResult.summary)}`);
    writeGapAnalysisReport(artifactSet.runPaths.gapAnalysisPath, healingOutcome.progressStatus, gapLines);
  }

  if (scenarioAdditionItem) {
    const scenarioAdditionLines = [
      `Selected item: ${selectedItem.id} - ${selectedItem.goal}`,
      `Worker role: scenario-addition`,
      `Worker attempt: ${sanitizeInlineCode(externalWorkerAttemptId)}`,
      `Planner handoff: ${PLANNER_HANDOFF_ARTIFACT_DISPLAY}`,
      `Runtime status: ${healingOutcome.progressStatus}`,
      `Runtime layer: ${runtimeResult.runtimeLayer || 'unspecified'}`,
      `Runtime log: ${runtimeLogDisplayPath}`,
      `Target artifact: ${sanitizeInlineCode(scenarioAdditionSignals.targetArtifact)}`,
    ];

    if (plannerHandoffRecord && plannerHandoffRecord.summary) {
      scenarioAdditionLines.push(`Accepted handoff summary: ${sanitizeInlineCode(plannerHandoffRecord.summary)}`);
    }

    if (plannerHandoffRecord && plannerHandoffRecord.candidateScenario) {
      scenarioAdditionLines.push(`Planner candidate scenario: ${sanitizeInlineCode(plannerHandoffRecord.candidateScenario)}`);
    }

    if (plannerHandoffRecord && plannerHandoffRecord.candidateAdditionTarget) {
      scenarioAdditionLines.push(
        `Planner addition target: ${sanitizeInlineCode(plannerHandoffRecord.candidateAdditionTarget)}`,
      );
    }

    if (scenarioAdditionSignals.addedScenarioOrOutline) {
      scenarioAdditionLines.push(
        `Added scenario or outline: ${sanitizeInlineCode(scenarioAdditionSignals.addedScenarioOrOutline)}`,
      );
    }

    if (scenarioAdditionSignals.supportingEvidence.length > 0) {
      scenarioAdditionLines.push(
        `Supporting evidence: ${scenarioAdditionSignals.supportingEvidence.map(sanitizeInlineCode).join(', ')}`,
      );
    }

    if (recordedFallbackReason) {
      scenarioAdditionLines.push(`Fallback reason: ${sanitizeInlineCode(recordedFallbackReason)}`);
    }

    if (scenarioAdditionSignals.escalationReason) {
      scenarioAdditionLines.push(`Escalation reason: ${sanitizeInlineCode(scenarioAdditionSignals.escalationReason)}`);
    }

    if (scenarioAdditionSignals.stopReason) {
      scenarioAdditionLines.push(`Stop reason: ${sanitizeInlineCode(scenarioAdditionSignals.stopReason)}`);
    }

    if (scenarioAdditionSignals.blockReason) {
      scenarioAdditionLines.push(`Block reason: ${sanitizeInlineCode(scenarioAdditionSignals.blockReason)}`);
    }

    scenarioAdditionLines.push(`Summary: ${sanitizeInlineCode(runtimeResult.summary)}`);
    writeScenarioAdditionReport(
      artifactSet.runPaths.scenarioAdditionPath,
      healingOutcome.progressStatus,
      scenarioAdditionLines,
    );
  }

  return {
    runId,
    runPaths: artifactSet.runPaths,
    adapter: adapterName,
    executionControls: executionControlState.controls,
    selectedItemId: selectedItem.id,
    selectedItemGoal: selectedItem.goal,
    status: healingOutcome.progressStatus,
    summary: healingOutcome.progressSummary,
    command: commandDisplay,
    runtimeLayer: runtimeResult.runtimeLayer,
    bridgeUsed,
    healingItem: healingOutcome.healingItem,
    explorerItem,
    scenarioAdditionItem,
    fallbackReason: recordedFallbackReason,
    runtimeLogPathDisplay: runtimeLogDisplayPath,
    fallbackLogPathDisplay: fallbackLogDisplayPath,
    gapAnalysisPathDisplay: explorerItem ? gapAnalysisPathDisplay : '',
    scenarioAdditionPathDisplay: scenarioAdditionItem ? scenarioAdditionPathDisplay : '',
    healReportPathDisplay: healingOutcome.healingItem
      ? normalizeDisplayPath(path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.healReportPath))
      : '',
  };
}

function readAdvanceRunRecordedOutcome(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const selectedItemId = options.selectedItemId || '';
  const runPaths = resolveRunPaths(repoRoot, runId);
  const runtimeLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.runtimeLogPath));
  const fallbackLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.fallbackLogPath));
  const gapAnalysisPathDisplay = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.gapAnalysisPath));
  const promotionReportPathDisplay =
    normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.promotionReportPath));
  const scenarioAdditionPathDisplay =
    normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.scenarioAdditionPath));
  const healReportPathDisplay = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.healReportPath));
  const verifierLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.verifierLogPath));
  const artifactSet = loadRunArtifactSet({
    repoRoot,
    templatesDir,
    runId,
  });
  const selectedItem = selectedItemId
    ? findProgressItem(artifactSet.progressContent, (item) => item.id === selectedItemId)
    : null;
  const plannerHandoffRecord = selectedItem ? readAcceptedPlannerHandoffRecord(artifactSet.runPaths, selectedItem.id) : null;
  const healingItem = Boolean(selectedItem && isHealingProgressItem(selectedItem, artifactSet.prdContent));
  const explorerItem = Boolean(selectedItem && isExplorerProgressItem(selectedItem, artifactSet.prdContent));
  const scenarioAdditionItem = Boolean(selectedItem && plannerHandoffRecord);
  const runtimeEntry = readLatestStructuredLogEntry(artifactSet.runPaths.runtimeLogPath);
  const fallbackEntry = readLatestStructuredLogEntry(artifactSet.runPaths.fallbackLogPath);
  const gapEntry = readLatestStructuredLogEntry(artifactSet.runPaths.gapAnalysisPath);
  const scenarioAdditionEntry = readLatestStructuredLogEntry(artifactSet.runPaths.scenarioAdditionPath);
  const healEntry = readLatestStructuredLogEntry(artifactSet.runPaths.healReportPath);
  const runtimeSelectedItem = readStructuredLogValue(runtimeEntry, 'Selected item');
  const runtimeAdapter = readStructuredLogValue(runtimeEntry, 'Adapter');
  const runtimeSummary = readStructuredLogValue(runtimeEntry, 'Summary');
  const fallbackEntrySelectedItem = readStructuredLogValue(fallbackEntry, 'Selected item');
  const gapEntrySelectedItem = readStructuredLogValue(gapEntry, 'Selected item');
  const scenarioAdditionEntrySelectedItem = readStructuredLogValue(scenarioAdditionEntry, 'Selected item');
  const healEntrySelectedItem = readStructuredLogValue(healEntry, 'Selected item');
  const fallbackReason =
    selectedItem && fallbackEntrySelectedItem.startsWith(`${selectedItem.id} -`)
      ? readStructuredLogValue(fallbackEntry, 'Fallback reason')
      : selectedItem
        ? selectedItem.fallbackReason
        : '';
  const healReportMatched = Boolean(selectedItem && healEntrySelectedItem.startsWith(`${selectedItem.id} -`));
  const gapAnalysisMatched = Boolean(
    selectedItem && explorerItem && gapEntrySelectedItem.startsWith(`${selectedItem.id} -`),
  );
  const scenarioAdditionMatched = Boolean(
    selectedItem && scenarioAdditionItem && scenarioAdditionEntrySelectedItem.startsWith(`${selectedItem.id} -`),
  );
  const healBlockReason = healReportMatched
    ? readStructuredLogValue(healEntry, 'Block reason')
    : selectedItem
      ? selectedItem.blockReason
      : '';

  return {
    artifactSet,
    selectedItem,
    plannerHandoffRecord,
    healingItem,
    explorerItem,
    scenarioAdditionItem,
    runtimeEntry,
    fallbackEntry,
    gapEntry,
    scenarioAdditionEntry,
    healEntry,
    runtimeSelectedItem,
    runtimeAdapter,
    runtimeSummary,
    fallbackReason,
    gapAnalysisMatched,
    gapAnalysisScope: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Scope') : '',
    gapAnalysisSummary: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Summary') : '',
    gapAnalysisCandidateCount: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Candidate count') : '',
    gapAnalysisObservedGap: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Observed gap') : '',
    gapAnalysisCandidateScenario: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Candidate scenario') : '',
    gapAnalysisAdditionTarget: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Candidate addition target') : '',
    gapAnalysisSupportingEvidence: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Supporting evidence') : '',
    gapAnalysisEscalationReason: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Escalation reason') : '',
    gapAnalysisStopReason: gapAnalysisMatched ? readStructuredLogValue(gapEntry, 'Stop reason') : '',
    scenarioAdditionMatched,
    scenarioAdditionSummary: scenarioAdditionMatched ? readStructuredLogValue(scenarioAdditionEntry, 'Summary') : '',
    scenarioAdditionAddedScenarioOrOutline: scenarioAdditionMatched
      ? readStructuredLogValue(scenarioAdditionEntry, 'Added scenario or outline')
      : '',
    scenarioAdditionTargetArtifact: scenarioAdditionMatched
      ? readStructuredLogValue(scenarioAdditionEntry, 'Target artifact')
      : '',
    scenarioAdditionSupportingEvidence: scenarioAdditionMatched
      ? readStructuredLogValue(scenarioAdditionEntry, 'Supporting evidence')
      : '',
    scenarioAdditionEscalationReason: scenarioAdditionMatched
      ? readStructuredLogValue(scenarioAdditionEntry, 'Escalation reason')
      : '',
    scenarioAdditionStopReason: scenarioAdditionMatched
      ? readStructuredLogValue(scenarioAdditionEntry, 'Stop reason')
      : '',
    scenarioAdditionBlockReason: scenarioAdditionMatched
      ? readStructuredLogValue(scenarioAdditionEntry, 'Block reason')
      : '',
    healRecordedStatus: healReportMatched
      ? readStructuredLogValue(healEntry, 'Recorded status') || healEntry.status
      : '',
    healRuntimeStatus: healReportMatched ? readStructuredLogValue(healEntry, 'Runtime status') : '',
    healSummary: healReportMatched ? readStructuredLogValue(healEntry, 'Summary') : '',
    healSmallestFailingUnit: healReportMatched ? readStructuredLogValue(healEntry, 'Smallest failing unit') : '',
    healRootCauseHypothesis: healReportMatched ? readStructuredLogValue(healEntry, 'Root-cause hypothesis') : '',
    healEscalationReason: healReportMatched ? readStructuredLogValue(healEntry, 'Escalation reason') : '',
    healBlockReason,
    healReportMatched,
    runtimeLogDisplayPath,
    fallbackLogPathDisplay: fallbackLogDisplayPath,
    gapAnalysisPathDisplay,
    promotionReportPathDisplay,
    scenarioAdditionPathDisplay,
    healReportPathDisplay,
    verifierLogPathDisplay: verifierLogDisplayPath,
  };
}

function reviewAdvanceRunExecutionResult(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const adapterName = options.adapter || 'external';
  const iterationResult = options.iterationResult || {};
  const runPaths = resolveRunPaths(repoRoot, runId);
  const runtimeLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.runtimeLogPath));
  const fallbackLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.fallbackLogPath));
  const gapAnalysisPathDisplay = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.gapAnalysisPath));
  const healReportPathDisplay = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.healReportPath));

  try {
    const selectedItemId = options.selectedItemId || iterationResult.selectedItemId || '';
    const recordedOutcome = readAdvanceRunRecordedOutcome({
      repoRoot,
      templatesDir,
      runId,
      selectedItemId,
    });
    const selectedItem = recordedOutcome.selectedItem;
    const runtimeEntry = recordedOutcome.runtimeEntry;
    const recordedStatus = selectedItem ? selectedItem.status : iterationResult.status || '';
    const explorerItem = recordedOutcome.explorerItem;
    const scenarioAdditionItem = recordedOutcome.scenarioAdditionItem;
    let executorSummary = '';

    if (!selectedItemId) {
      executorSummary = 'executor completed without a selected item id.';
    } else if (!selectedItem) {
      executorSummary = `executor did not record selected item ${selectedItemId} in progress.md.`;
    } else if (!runtimeEntry) {
      executorSummary = `executor recorded ${recordedStatus || 'result'} without runtime proof in ${runtimeLogDisplayPath}.`;
    } else if (recordedOutcome.runtimeSelectedItem && !recordedOutcome.runtimeSelectedItem.startsWith(`${selectedItem.id} -`)) {
      executorSummary =
        `executor recorded ${recordedStatus || 'result'} for ${selectedItem.id}, ` +
        `but runtime proof is for ${recordedOutcome.runtimeSelectedItem}.`;
    } else if (recordedOutcome.runtimeAdapter && recordedOutcome.runtimeAdapter !== adapterName) {
      executorSummary = `executor recorded ${recordedStatus || 'result'} with adapter mismatch (${recordedOutcome.runtimeAdapter}).`;
    } else if (scenarioAdditionItem && recordedStatus === 'pass' && !recordedOutcome.scenarioAdditionMatched) {
      executorSummary =
        `executor recorded pass without scenario addition artifact in ${recordedOutcome.scenarioAdditionPathDisplay}.`;
    } else if (explorerItem && recordedStatus === 'pass' && !recordedOutcome.gapAnalysisMatched) {
      executorSummary = `explorer recorded pass without gap analysis in ${recordedOutcome.gapAnalysisPathDisplay}.`;
    } else {
      const runtimeDetail = recordedOutcome.runtimeSummary || iterationResult.summary || 'runtime summary unavailable.';

      if (recordedStatus === 'pass') {
        if (scenarioAdditionItem) {
          executorSummary =
            `recorded pass from ${recordedOutcome.scenarioAdditionPathDisplay}: ` +
            `${formatScenarioAdditionSummary(recordedOutcome, runtimeDetail)}`;
        } else if (explorerItem) {
          executorSummary =
            `recorded pass from ${recordedOutcome.gapAnalysisPathDisplay}: ` +
            `${formatExplorerGapAnalysisSummary(recordedOutcome, runtimeDetail)}`;
        } else if (recordedOutcome.healingItem && recordedOutcome.healReportMatched) {
          executorSummary =
            `recorded pass from ${recordedOutcome.healReportPathDisplay}: ` +
            `${formatHealingReportSummary(recordedOutcome, runtimeDetail)}`;
        } else {
          executorSummary = `recorded pass from ${runtimeLogDisplayPath}: ${runtimeDetail}`;
        }
      } else if (recordedStatus === 'blocked') {
        const blockedEvidencePathDisplay =
          recordedOutcome.healingItem && recordedOutcome.healReportMatched
            ? healReportPathDisplay
            : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
              ? recordedOutcome.scenarioAdditionPathDisplay
            : explorerItem && recordedOutcome.gapAnalysisMatched
              ? recordedOutcome.gapAnalysisPathDisplay
              : runtimeLogDisplayPath;
        executorSummary =
          `recorded blocked from ${blockedEvidencePathDisplay}: ` +
          `${
            recordedOutcome.healingItem && recordedOutcome.healReportMatched
              ? recordedOutcome.healBlockReason || selectedItem.blockReason || runtimeDetail
              : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
                ? recordedOutcome.scenarioAdditionBlockReason
                  || recordedOutcome.scenarioAdditionStopReason
                  || formatScenarioAdditionSummary(recordedOutcome, runtimeDetail)
              : explorerItem && recordedOutcome.gapAnalysisMatched
                ? formatExplorerGapAnalysisSummary(recordedOutcome, runtimeDetail)
                : runtimeDetail
          }`;
      } else if (recordedStatus === 'fail') {
        const evidencePathDisplay =
          recordedOutcome.healingItem && recordedOutcome.healReportMatched
            ? recordedOutcome.healReportPathDisplay
            : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
              ? recordedOutcome.scenarioAdditionPathDisplay
            : explorerItem && recordedOutcome.gapAnalysisMatched
              ? recordedOutcome.gapAnalysisPathDisplay
              : runtimeLogDisplayPath;
        executorSummary =
          `recorded fail from ${evidencePathDisplay}: ` +
          `${
            recordedOutcome.healingItem && recordedOutcome.healReportMatched
              ? formatHealingReportSummary(recordedOutcome, runtimeDetail)
              : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
                ? formatScenarioAdditionSummary(recordedOutcome, runtimeDetail)
              : explorerItem && recordedOutcome.gapAnalysisMatched
              ? formatExplorerGapAnalysisSummary(recordedOutcome, runtimeDetail)
              : runtimeDetail
          }`;
      } else {
        executorSummary = `executor recorded unexpected status "${recordedStatus || 'missing'}".`;
      }

      if (recordedOutcome.fallbackReason) {
        executorSummary += `; fallback in ${fallbackLogDisplayPath}: ${recordedOutcome.fallbackReason}`;
      }
    }

    return {
      status: recordedStatus || iterationResult.status || 'fail',
      summary: executorSummary,
      selectedItemId: selectedItem ? selectedItem.id : selectedItemId,
      healingItem: recordedOutcome.healingItem,
      explorerItem,
      scenarioAdditionItem,
      runtimeLogPathDisplay: runtimeLogDisplayPath,
      fallbackLogPathDisplay: fallbackLogDisplayPath,
      gapAnalysisPathDisplay: recordedOutcome.gapAnalysisPathDisplay,
      scenarioAdditionPathDisplay: recordedOutcome.scenarioAdditionPathDisplay,
      healReportPathDisplay,
    };
  } catch (error) {
    return {
      status: iterationResult.status || 'fail',
      summary: sanitizeInlineCode(error instanceof Error ? error.message : String(error)),
      selectedItemId: iterationResult.selectedItemId || '',
      runtimeLogPathDisplay: runtimeLogDisplayPath,
      fallbackLogPathDisplay: fallbackLogDisplayPath,
      gapAnalysisPathDisplay,
      scenarioAdditionPathDisplay,
      healReportPathDisplay,
    };
  }
}

function reviewAdvanceRunResult(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const adapterName = options.adapter || 'external';
  const iterationResult = options.iterationResult || {};
  const executionReviewResult = options.executionReviewResult || {};
  const runPaths = resolveRunPaths(repoRoot, runId);
  const runtimeLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.runtimeLogPath));
  const gapAnalysisPathDisplay = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.gapAnalysisPath));
  const scenarioAdditionPathDisplay =
    normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.scenarioAdditionPath));
  const promotionReportPathDisplay =
    normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.promotionReportPath));
  const verifierLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.verifierLogPath));
  let advanceCommandDescription = buildHarnessCommandDescription('advance-run', {
    runId,
    adapter: adapterName,
    executionControls: resolveExecutionControls({
      ...options,
      defaultProject: DEFAULT_EXECUTION_CONTROLS.project,
    }),
    includeProject: false,
  });

  try {
    const selectedItemId = options.selectedItemId || executionReviewResult.selectedItemId || iterationResult.selectedItemId || '';
    const recordedOutcome = readAdvanceRunRecordedOutcome({
      repoRoot,
      templatesDir,
      runId,
      selectedItemId,
    });
    const artifactSet = recordedOutcome.artifactSet;
    const selectedItem = recordedOutcome.selectedItem;
    const executionControlState = resolveExecutionControls({
      ...options,
      artifactSet,
      defaultProject:
        (selectedItem && parseRequestedProjectValue(selectedItem.verify)) || DEFAULT_EXECUTION_CONTROLS.project,
    });
    advanceCommandDescription = buildHarnessCommandDescription('advance-run', {
      runId,
      adapter: adapterName,
      executionControls: executionControlState,
      includeProject: executionControlState.shouldPersist,
    });
    const runtimeEntry = recordedOutcome.runtimeEntry;
    const recordedStatus = selectedItem ? selectedItem.status : '';
    const runtimeLogStatus = runtimeEntry ? runtimeEntry.status : '';
    const baseSummary = recordedOutcome.runtimeSummary || iterationResult.summary || 'runtime summary unavailable.';
    const explorerItem = recordedOutcome.explorerItem;
    const scenarioAdditionItem = recordedOutcome.scenarioAdditionItem;
    const guidedExploration = explorerItem
      ? resolveGuidedExplorationPlan({
        artifactSet,
      })
      : { active: false };
    const autonomousExploration = explorerItem
      ? resolveAutonomousExplorationPlan({
        artifactSet,
      })
      : { active: false };
    let verifierStatus = 'fail';
    let verifierSummary = '';
    let promotionResult = null;

    if (!selectedItemId) {
      verifierSummary = 'advance-run completed without a selected item id.';
    } else if (!selectedItem) {
      verifierSummary = `selected item ${selectedItemId} was not recorded in progress.md.`;
    } else if (!runtimeEntry) {
      verifierSummary = `verifier rejected recorded ${recordedStatus || 'result'}: runtime proof missing in ${runtimeLogDisplayPath}.`;
    } else if (recordedOutcome.runtimeSelectedItem && !recordedOutcome.runtimeSelectedItem.startsWith(`${selectedItem.id} -`)) {
      verifierSummary =
        `verifier rejected recorded ${recordedStatus || 'result'}: ` +
        `runtime proof is for ${recordedOutcome.runtimeSelectedItem}.`;
    } else if (recordedOutcome.runtimeAdapter && recordedOutcome.runtimeAdapter !== adapterName) {
      verifierSummary =
        `verifier rejected recorded ${recordedStatus || 'result'}: ` +
        `runtime adapter mismatch (${recordedOutcome.runtimeAdapter}).`;
    } else if (scenarioAdditionItem && recordedStatus === 'pass' && !recordedOutcome.scenarioAdditionMatched) {
      verifierSummary =
        `verifier rejected recorded pass: scenario addition missing in ${recordedOutcome.scenarioAdditionPathDisplay}.`;
    } else if (explorerItem && recordedStatus === 'pass' && !recordedOutcome.gapAnalysisMatched) {
      verifierSummary =
        `verifier rejected recorded pass: gap analysis missing in ${recordedOutcome.gapAnalysisPathDisplay}.`;
    } else if (recordedStatus === 'pass') {
      if (runtimeLogStatus !== 'pass') {
        verifierSummary = `verifier rejected recorded pass: runtime log status is ${runtimeLogStatus || 'missing'}.`;
      } else {
        if (scenarioAdditionItem) {
          promotionResult = promoteAcceptedScenarioAddition({
            repoRoot,
            artifactSet,
            selectedItem,
            plannerHandoffRecord: recordedOutcome.plannerHandoffRecord,
            recordedOutcome,
            runtimeLogPathDisplay: runtimeLogDisplayPath,
          });
          verifierStatus = promotionResult.status;
          if (promotionResult.status === 'pass') {
            verifierSummary =
              `verifier accepted pass from ${recordedOutcome.scenarioAdditionPathDisplay}: ` +
              `${formatScenarioAdditionSummary(recordedOutcome, baseSummary)}; ` +
              `promotion in ${promotionResult.promotionReportPathDisplay}: ${promotionResult.summary}`;
          } else if (promotionResult.status === 'blocked') {
            verifierSummary =
              `verifier blocked recorded pass: canonical promotion blocked in ` +
              `${promotionResult.promotionReportPathDisplay}: ${promotionResult.summary}`;
          } else {
            verifierSummary =
              `verifier rejected recorded pass: canonical promotion failed in ` +
              `${promotionResult.promotionReportPathDisplay}: ${promotionResult.summary}`;
          }
        } else if (explorerItem) {
          verifierStatus = 'pass';
          verifierSummary =
            `verifier accepted pass from ${recordedOutcome.gapAnalysisPathDisplay}: ` +
            `${formatExplorerGapAnalysisSummary(recordedOutcome, baseSummary)}`;
        } else if (recordedOutcome.healingItem && recordedOutcome.healReportMatched) {
          verifierStatus = 'pass';
          verifierSummary =
            `verifier accepted pass from ${recordedOutcome.healReportPathDisplay}: ` +
            `${formatHealingReportSummary(recordedOutcome, baseSummary)}`;
        } else {
          verifierStatus = 'pass';
          verifierSummary = `verifier accepted pass from ${runtimeLogDisplayPath}: ${baseSummary}`;
        }
      }
    } else if (recordedStatus === 'blocked') {
      verifierStatus = 'blocked';
      const blockedEvidencePathDisplay =
        recordedOutcome.healingItem && recordedOutcome.healReportMatched
          ? recordedOutcome.healReportPathDisplay
          : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
            ? recordedOutcome.scenarioAdditionPathDisplay
          : explorerItem && recordedOutcome.gapAnalysisMatched
            ? recordedOutcome.gapAnalysisPathDisplay
            : runtimeLogDisplayPath;
      verifierSummary =
        `verifier confirmed blocked from ${blockedEvidencePathDisplay}: ` +
        `${
          recordedOutcome.healingItem && recordedOutcome.healReportMatched
            ? recordedOutcome.healBlockReason || selectedItem.blockReason || baseSummary
            : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
              ? recordedOutcome.scenarioAdditionBlockReason
                || recordedOutcome.scenarioAdditionStopReason
                || formatScenarioAdditionSummary(recordedOutcome, baseSummary)
            : explorerItem && recordedOutcome.gapAnalysisMatched
              ? formatExplorerGapAnalysisSummary(recordedOutcome, baseSummary)
              : baseSummary
        }`;
    } else if (recordedStatus === 'fail') {
      verifierStatus = 'fail';
      const evidencePathDisplay =
        recordedOutcome.healingItem && recordedOutcome.healReportMatched
          ? recordedOutcome.healReportPathDisplay
          : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
            ? recordedOutcome.scenarioAdditionPathDisplay
          : explorerItem && recordedOutcome.gapAnalysisMatched
            ? recordedOutcome.gapAnalysisPathDisplay
            : runtimeLogDisplayPath;
      verifierSummary =
        `verifier confirmed fail from ${evidencePathDisplay}: ` +
        `${
          recordedOutcome.healingItem && recordedOutcome.healReportMatched
            ? formatHealingReportSummary(recordedOutcome, baseSummary)
            : scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
              ? formatScenarioAdditionSummary(recordedOutcome, baseSummary)
            : explorerItem && recordedOutcome.gapAnalysisMatched
            ? formatExplorerGapAnalysisSummary(recordedOutcome, baseSummary)
            : baseSummary
        }`;
      if (recordedOutcome.fallbackReason) {
        verifierSummary +=
          `; fallback in ${recordedOutcome.fallbackLogPathDisplay}: ${recordedOutcome.fallbackReason}`;
      }
    } else {
      verifierSummary = `verifier rejected recorded result: unexpected progress status "${recordedStatus || 'missing'}".`;
    }

    const verifierLines = [
      `Selected item: ${selectedItem ? `${selectedItem.id} - ${selectedItem.goal}` : selectedItemId || 'missing'}`,
      `Adapter: ${adapterName}`,
      `Recorded item status: ${recordedStatus || 'missing'}`,
      `Runtime log: ${runtimeLogDisplayPath}`,
      `Runtime log status: ${runtimeLogStatus || 'missing'}`,
    ];
    if (executionControlState.shouldPersist) {
      verifierLines.push(...buildExecutionControlLogLines(executionControlState.controls));
    }

    if (recordedOutcome.runtimeSelectedItem) {
      verifierLines.push(`Runtime proof item: ${sanitizeInlineCode(recordedOutcome.runtimeSelectedItem)}`);
    }

    if (recordedOutcome.healingItem) {
      verifierLines.push('Healing item: yes');
      verifierLines.push(`Heal report: ${recordedOutcome.healReportPathDisplay}`);
      if (recordedOutcome.healRecordedStatus) {
        verifierLines.push(`Heal report status: ${sanitizeInlineCode(recordedOutcome.healRecordedStatus)}`);
      }
      if (recordedOutcome.healRuntimeStatus) {
        verifierLines.push(`Heal report runtime status: ${sanitizeInlineCode(recordedOutcome.healRuntimeStatus)}`);
      }
      if (recordedOutcome.healSmallestFailingUnit) {
        verifierLines.push(
          `Heal report smallest failing unit: ${sanitizeInlineCode(recordedOutcome.healSmallestFailingUnit)}`,
        );
      }
      if (recordedOutcome.healRootCauseHypothesis) {
        verifierLines.push(
          `Heal report root-cause hypothesis: ${sanitizeInlineCode(recordedOutcome.healRootCauseHypothesis)}`,
        );
      }
      if (recordedOutcome.healEscalationReason) {
        verifierLines.push(
          `Heal report escalation reason: ${sanitizeInlineCode(recordedOutcome.healEscalationReason)}`,
        );
      }
    }

    if (recordedOutcome.scenarioAdditionItem) {
      verifierLines.push('Scenario-addition item: yes');
      verifierLines.push(`Planner handoff: ${PLANNER_HANDOFF_ARTIFACT_DISPLAY}`);
      verifierLines.push(`Scenario addition: ${recordedOutcome.scenarioAdditionPathDisplay}`);
      if (recordedOutcome.plannerHandoffRecord && recordedOutcome.plannerHandoffRecord.summary) {
        verifierLines.push(
          `Planner handoff summary: ${sanitizeInlineCode(recordedOutcome.plannerHandoffRecord.summary)}`,
        );
      }
      if (recordedOutcome.scenarioAdditionMatched) {
        verifierLines.push(
          `Scenario addition target artifact: ${sanitizeInlineCode(recordedOutcome.scenarioAdditionTargetArtifact)}`,
        );
        if (recordedOutcome.scenarioAdditionAddedScenarioOrOutline) {
          verifierLines.push(
            `Added scenario or outline: ${sanitizeInlineCode(recordedOutcome.scenarioAdditionAddedScenarioOrOutline)}`,
          );
        }
        if (recordedOutcome.scenarioAdditionSupportingEvidence) {
          verifierLines.push(
            `Scenario addition supporting evidence: ${sanitizeInlineCode(recordedOutcome.scenarioAdditionSupportingEvidence)}`,
          );
        }
        if (recordedOutcome.scenarioAdditionEscalationReason) {
          verifierLines.push(
            `Scenario addition escalation reason: ${sanitizeInlineCode(recordedOutcome.scenarioAdditionEscalationReason)}`,
          );
        }
        if (recordedOutcome.scenarioAdditionStopReason) {
          verifierLines.push(
            `Scenario addition stop reason: ${sanitizeInlineCode(recordedOutcome.scenarioAdditionStopReason)}`,
          );
        }
        if (recordedOutcome.scenarioAdditionBlockReason) {
          verifierLines.push(
            `Scenario addition block reason: ${sanitizeInlineCode(recordedOutcome.scenarioAdditionBlockReason)}`,
          );
        }
      }
      if (promotionResult) {
        verifierLines.push(`Promotion report: ${promotionResult.promotionReportPathDisplay}`);
        if (promotionResult.canonicalFeatureTargetDisplayPath) {
          verifierLines.push(
            `Canonical promotion target: ${sanitizeInlineCode(promotionResult.canonicalFeatureTargetDisplayPath)}`,
          );
        }
        if (promotionResult.promotedScenarioOrOutline) {
          verifierLines.push(
            `Promoted scenario or outline: ${sanitizeInlineCode(promotionResult.promotedScenarioOrOutline)}`,
          );
        }
        if (promotionResult.promotionStepFileDisplay) {
          verifierLines.push(
            `Canonical promotion step target: ${sanitizeInlineCode(promotionResult.promotionStepFileDisplay)}`,
          );
        }
        verifierLines.push(`Promotion feature action: ${sanitizeInlineCode(promotionResult.featureAction)}`);
        verifierLines.push(`Promotion step action: ${sanitizeInlineCode(promotionResult.stepAction)}`);
        verifierLines.push(`Promotion summary: ${sanitizeInlineCode(promotionResult.summary)}`);
      }
    }

    if (explorerItem) {
      verifierLines.push('Explorer item: yes');
      verifierLines.push(`Gap analysis: ${recordedOutcome.gapAnalysisPathDisplay}`);
      verifierLines.push(...buildGuidedExplorationArtifactLines(guidedExploration));
      verifierLines.push(...buildAutonomousExplorationArtifactLines(autonomousExploration));
      if (recordedOutcome.gapAnalysisMatched) {
        verifierLines.push(`Gap analysis scope: ${sanitizeInlineCode(recordedOutcome.gapAnalysisScope)}`);
        verifierLines.push(`Gap candidate count: ${sanitizeInlineCode(recordedOutcome.gapAnalysisCandidateCount)}`);
        if (recordedOutcome.gapAnalysisObservedGap) {
          verifierLines.push(`Gap analysis observed gap: ${sanitizeInlineCode(recordedOutcome.gapAnalysisObservedGap)}`);
        }
        if (recordedOutcome.gapAnalysisCandidateScenario) {
          verifierLines.push(
            `Gap analysis candidate scenario: ${sanitizeInlineCode(recordedOutcome.gapAnalysisCandidateScenario)}`,
          );
        }
        if (recordedOutcome.gapAnalysisAdditionTarget) {
          verifierLines.push(
            `Gap analysis addition target: ${sanitizeInlineCode(recordedOutcome.gapAnalysisAdditionTarget)}`,
          );
        }
        if (recordedOutcome.gapAnalysisSupportingEvidence) {
          verifierLines.push(
            `Gap analysis supporting evidence: ${sanitizeInlineCode(recordedOutcome.gapAnalysisSupportingEvidence)}`,
          );
        }
        if (recordedOutcome.gapAnalysisEscalationReason) {
          verifierLines.push(
            `Gap analysis escalation reason: ${sanitizeInlineCode(recordedOutcome.gapAnalysisEscalationReason)}`,
          );
        }
        if (recordedOutcome.gapAnalysisStopReason) {
          verifierLines.push(`Gap analysis stop reason: ${sanitizeInlineCode(recordedOutcome.gapAnalysisStopReason)}`);
        }
      }
    }

    if (selectedItem && selectedItem.result) {
      verifierLines.push(`Recorded result: ${sanitizeInlineCode(selectedItem.result)}`);
    }

    if (selectedItem && selectedItem.fallbackReason) {
      verifierLines.push(`Fallback reason: ${sanitizeInlineCode(selectedItem.fallbackReason)}`);
    }

    if (selectedItem && selectedItem.blockReason) {
      verifierLines.push(`Block reason: ${sanitizeInlineCode(selectedItem.blockReason)}`);
    }

    if (recordedOutcome.healBlockReason) {
      verifierLines.push(`Heal report block reason: ${sanitizeInlineCode(recordedOutcome.healBlockReason)}`);
    }

    verifierLines.push(`Summary: ${sanitizeInlineCode(verifierSummary)}`);
    writeVerifierLog(artifactSet.runPaths.verifierLogPath, verifierStatus, verifierLines);

    if (selectedItem) {
      upsertProgressItemResult(artifactSet.runPaths.progressPath, {
        itemId: selectedItem.id,
        status: verifierStatus,
        resultText: buildVerifierBackedProgressResultText(
          verifierStatus,
          verifierSummary,
          advanceCommandDescription,
          verifierLogDisplayPath,
          runtimeLogDisplayPath,
          [
            ...(recordedOutcome.healingItem && recordedOutcome.healReportMatched
              ? [`heal report ${recordedOutcome.healReportPathDisplay}`]
              : []),
            ...(scenarioAdditionItem && recordedOutcome.scenarioAdditionMatched
              ? [`scenario addition ${recordedOutcome.scenarioAdditionPathDisplay}`]
              : []),
            ...(promotionResult && promotionResult.promotionReportPathDisplay
              ? [`promotion report ${promotionResult.promotionReportPathDisplay}`]
              : []),
            ...(explorerItem && recordedOutcome.gapAnalysisMatched
              ? [`gap analysis ${recordedOutcome.gapAnalysisPathDisplay}`]
              : []),
          ],
        ),
        fallbackReason: selectedItem.fallbackReason,
        blockReason: verifierStatus === 'blocked' ? selectedItem.blockReason : undefined,
      });
    }

    return {
      status: verifierStatus,
      summary: verifierSummary,
      explorerItem,
      scenarioAdditionItem,
      runtimeLogPathDisplay: runtimeLogDisplayPath,
      gapAnalysisPathDisplay: recordedOutcome.gapAnalysisPathDisplay,
      promotionReportPathDisplay: promotionResult ? promotionResult.promotionReportPathDisplay : '',
      scenarioAdditionPathDisplay: recordedOutcome.scenarioAdditionPathDisplay,
      verifierLogPathDisplay: verifierLogDisplayPath,
    };
  } catch (error) {
    const failureSummary = sanitizeInlineCode(error instanceof Error ? error.message : String(error));
    if (pathExists(runPaths.logsDir)) {
      writeVerifierLog(runPaths.verifierLogPath, 'fail', [
        `Selected item: ${iterationResult.selectedItemId || 'missing'}`,
        `Adapter: ${adapterName}`,
        `Runtime log: ${runtimeLogDisplayPath}`,
        `Summary: ${failureSummary}`,
      ]);
    }

    return {
      status: 'fail',
      summary: failureSummary,
      runtimeLogPathDisplay: runtimeLogDisplayPath,
      gapAnalysisPathDisplay,
      promotionReportPathDisplay,
      scenarioAdditionPathDisplay,
      verifierLogPathDisplay: verifierLogDisplayPath,
    };
  }
}

function advanceRun(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const adapterName = options.adapter || 'external';
  const loadAdvanceRunSelectionFn = options.loadAdvanceRunSelectionFn || loadAdvanceRunSelection;
  const iterateRunFn = options.iterateRunFn || iterateRun;
  const reviewAdvanceRunExecutionFn = options.reviewAdvanceRunExecutionFn || reviewAdvanceRunExecutionResult;
  const reviewAdvanceRunFn = options.reviewAdvanceRunFn || reviewAdvanceRunResult;
  const iterateRunOptions = {
    repoRoot,
    templatesDir,
    runId,
    adapter: adapterName,
    project: options.project,
    headed: options.headed,
    debug: options.debug,
    baseUrl: options.baseUrl,
    targetEnv: options.targetEnv,
    trace: options.trace,
    video: options.video,
    screenshot: options.screenshot,
  };

  if (!runId) {
    throw new Error('Missing required option --run-id.');
  }

  if (Object.prototype.hasOwnProperty.call(options, 'env')) {
    iterateRunOptions.env = options.env;
  }

  if (Object.prototype.hasOwnProperty.call(options, 'processRunner')) {
    iterateRunOptions.processRunner = options.processRunner;
  }

  const selectedRunItem = loadAdvanceRunSelectionFn({
    repoRoot,
    templatesDir,
    runId,
  });
  const iterationResult = iterateRunFn(iterateRunOptions);
  const executionReviewResult = reviewAdvanceRunExecutionFn({
    repoRoot,
    templatesDir,
    runId,
    adapter: adapterName,
    selectedItemId: selectedRunItem.selectedItemId,
    healingItem: selectedRunItem.healingItem,
    iterationResult,
  });
  const reviewResult = reviewAdvanceRunFn({
    repoRoot,
    templatesDir,
    runId,
    adapter: adapterName,
    selectedItemId: selectedRunItem.selectedItemId,
    healingItem: selectedRunItem.healingItem,
    iterationResult,
    executionReviewResult,
  });

  return {
    ...iterationResult,
    selectedItemId: executionReviewResult.selectedItemId || iterationResult.selectedItemId,
    executionControls: iterationResult.executionControls,
    healingItem: selectedRunItem.healingItem,
    explorerItem: selectedRunItem.explorerItem || executionReviewResult.explorerItem || reviewResult.explorerItem,
    scenarioAdditionItem:
      selectedRunItem.scenarioAdditionItem
      || executionReviewResult.scenarioAdditionItem
      || reviewResult.scenarioAdditionItem,
    status: reviewResult.status,
    summary: reviewResult.summary,
    delegatedStatus: executionReviewResult.status,
    delegatedSummary: executionReviewResult.summary,
    executorStatus: executionReviewResult.status,
    executorSummary: executionReviewResult.summary,
    verifierStatus: reviewResult.status,
    verifierSummary: reviewResult.summary,
    runtimeLogPathDisplay: reviewResult.runtimeLogPathDisplay,
    verifierLogPathDisplay: reviewResult.verifierLogPathDisplay,
    fallbackLogPathDisplay: executionReviewResult.fallbackLogPathDisplay,
    gapAnalysisPathDisplay: executionReviewResult.gapAnalysisPathDisplay || reviewResult.gapAnalysisPathDisplay,
    promotionReportPathDisplay: reviewResult.promotionReportPathDisplay,
    scenarioAdditionPathDisplay:
      executionReviewResult.scenarioAdditionPathDisplay || reviewResult.scenarioAdditionPathDisplay,
    healReportPathDisplay: executionReviewResult.healReportPathDisplay,
    iterationStatus: iterationResult.status,
    iterationSummary: iterationResult.summary,
  };
}

function loopRun(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const adapterName = options.adapter || 'external';
  const maxIterations = parsePositiveIntegerOption(options.maxIterations, '--max-iterations');
  const iterateRunFn = options.iterateRunFn || iterateRun;

  if (!runId) {
    throw new Error('Missing required option --run-id.');
  }

  assertRuntimeAdapterName(adapterName);

  let completedIterations = 0;
  let lastSelectedItemId = '';

  const loadArtifactSet = () =>
    loadRunArtifactSet({
      repoRoot,
      templatesDir,
      runId,
    });
  let executionControlState = resolveExecutionControls({
    ...options,
    defaultProject: DEFAULT_EXECUTION_CONTROLS.project,
  });
  try {
    const artifactSet = loadArtifactSet();
    executionControlState = resolveExecutionControls({
      ...options,
      artifactSet,
      defaultProject: DEFAULT_EXECUTION_CONTROLS.project,
    });
    persistExecutionControls(artifactSet, executionControlState);
  } catch (error) {
    if (!pathExists(resolveRunPaths(repoRoot, runId).runDir)) {
      throw error;
    }
  }

  const finalizeLoopRun = (status, stopReason) => {
    const artifactSet = loadArtifactSet();
    executionControlState = resolveExecutionControls({
      artifactSet,
      defaultProject: DEFAULT_EXECUTION_CONTROLS.project,
    });
    const runtimeLogDisplayPath = normalizeDisplayPath(
      path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.runtimeLogPath),
    );
    const progressPathDisplay = normalizeDisplayPath(
      path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.progressPath),
    );
    const loopReportPathDisplay = normalizeDisplayPath(
      path.relative(artifactSet.runPaths.runDir, artifactSet.runPaths.loopReportPath),
    );
    const loopLines = [
      `Run ID: ${runId}`,
      `Adapter: ${adapterName}`,
      `Configured max iterations: ${maxIterations}`,
      `Completed iterations: ${completedIterations}`,
      `Stop reason: ${stopReason}`,
      `Final status: ${status}`,
      `Last selected item: ${lastSelectedItemId || 'none'}`,
      `Runtime log: ${runtimeLogDisplayPath}`,
    ];
    if (executionControlState.shouldPersist) {
      loopLines.push(...buildExecutionControlLogLines(executionControlState.controls));
    }

    writeLoopReport(artifactSet.runPaths.loopReportPath, status, loopLines);

    return {
      runId,
      runPaths: artifactSet.runPaths,
      adapter: adapterName,
      maxIterations,
      completedIterations,
      stopReason,
      status,
      finalStatus: status,
      lastSelectedItemId,
      executionControls: executionControlState.controls,
      runtimeLogPath: artifactSet.runPaths.runtimeLogPath,
      runtimeLogDisplayPath,
      loopReportPath: artifactSet.runPaths.loopReportPath,
      loopReportPathDisplay,
      progressPathDisplay,
    };
  };

  while (true) {
    const artifactSet = loadArtifactSet();
    const nextItem = findNextActionableProgressItem(artifactSet.progressContent);

    if (!nextItem) {
      return finalizeLoopRun('completed', 'no-actionable-items');
    }

    if (completedIterations >= maxIterations) {
      return finalizeLoopRun('budget-exhausted', 'max-iterations-reached');
    }

    try {
      const iterationResult = iterateRunFn({
        repoRoot,
        templatesDir,
        runId,
        adapter: adapterName,
        env: options.env,
        processRunner: options.processRunner,
        project: options.project,
        headed: options.headed,
        debug: options.debug,
        baseUrl: options.baseUrl,
        targetEnv: options.targetEnv,
        trace: options.trace,
        video: options.video,
        screenshot: options.screenshot,
      });

      completedIterations += 1;
      if (iterationResult.selectedItemId) {
        lastSelectedItemId = iterationResult.selectedItemId;
      }

      if (iterationResult.status === 'fail') {
        return finalizeLoopRun('fail', 'fail');
      }

      if (iterationResult.status === 'blocked') {
        return finalizeLoopRun('blocked', 'blocked');
      }
    } catch (error) {
      if (isNoActionableProgressError(error, runId)) {
        return finalizeLoopRun('completed', 'no-actionable-items');
      }

      throw error;
    }
  }
}

function verifyRun(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const commandRunner = options.commandRunner || runCommand;
  const env = options.env || process.env;
  const runPaths = resolveRunPaths(repoRoot, runId);
  let executionControlState = resolveExecutionControls({
    ...options,
    defaultProject: options.project,
  });
  let verifyCommandDescription = buildHarnessCommandDescription('verify-run', {
    runId,
    executionControls: executionControlState,
    includeProject: executionControlState.shouldPersist,
  });

  try {
    let artifactSet = loadRunArtifactSet({
      repoRoot,
      templatesDir,
      runId,
    });
    executionControlState = resolveExecutionControls({
      ...options,
      artifactSet,
      defaultProject: options.project,
    });
    artifactSet = persistExecutionControls(artifactSet, executionControlState);
    verifyCommandDescription = buildHarnessCommandDescription('verify-run', {
      runId,
      executionControls: executionControlState,
      includeProject: executionControlState.shouldPersist,
    });
    const commandEnv = applyExecutionControlsToEnv(env, executionControlState);

    const exportResult = commandRunner(getNpxCommand(), ['bddgen', 'export'], repoRoot, {
      env: commandEnv,
    });
    if (exportResult.status !== 0) {
      throw new Error(`bddgen export failed:\n${exportResult.stderr || exportResult.stdout}`);
    }

    const exportedStepCount = parseExportedStepCount(`${exportResult.stdout}\n${exportResult.stderr}`);
    if (exportedStepCount < 1) {
      throw new Error('bddgen export returned zero registered steps.');
    }

    const generateResult = commandRunner(getNpxCommand(), ['bddgen', 'test'], repoRoot, {
      env: commandEnv,
    });
    if (generateResult.status !== 0) {
      throw new Error(`bddgen test failed:\n${generateResult.stderr || generateResult.stdout}`);
    }

    const generatedSpecs = findGeneratedSpecsForRun(repoRoot, runId);
    if (generatedSpecs.length === 0) {
      throw new Error(`No generated Playwright specs were found for run ${runId}.`);
    }

    const relativeSpecPath = normalizeDisplayPath(path.relative(repoRoot, generatedSpecs[0]));
    const listArgs = ['playwright', 'test', '--list', escapeForRegExp(runId)];
    if (executionControlState.shouldPersist) {
      listArgs.push(`--project=${executionControlState.controls.project}`);
    }
    const listResult = commandRunner(getNpxCommand(), listArgs, repoRoot, {
      env: commandEnv,
    });

    if (listResult.status !== 0) {
      throw new Error(`playwright test --list failed:\n${listResult.stderr || listResult.stdout}`);
    }

    const listedTestCount = parseListedTestCount(`${listResult.stdout}\n${listResult.stderr}`);
    if (listedTestCount < 1) {
      throw new Error(`playwright test --list did not find generated tests for run ${runId}.`);
    }

    const summaryLines = [
      `Run directory: ${normalizeDisplayPath(runPaths.runDir)}`,
      `Exported steps: ${exportedStepCount}`,
      `Generated spec: ${normalizeDisplayPath(relativeSpecPath)}`,
      `Listed tests: ${listedTestCount}`,
    ];
    if (executionControlState.shouldPersist) {
      summaryLines.push(...buildExecutionControlLogLines(executionControlState.controls));
    }

    writeVerifierLog(runPaths.verifierLogPath, 'pass', summaryLines);
    upsertProgressItemResult(runPaths.progressPath, {
      owner: 'qa-verifier',
      status: 'pass',
      resultText: buildProgressResultText(
        'pass',
        summaryLines.join('; '),
        verifyCommandDescription,
        normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.verifierLogPath)),
      ),
    });

    return {
      runId,
      runPaths,
      exportedStepCount,
      listedTestCount,
      generatedSpecs,
      executionControls: executionControlState.controls,
    };
  } catch (error) {
    if (pathExists(runPaths.logsDir)) {
      writeVerifierLog(runPaths.verifierLogPath, 'fail', [error instanceof Error ? error.message : String(error)]);
    }

    if (pathExists(runPaths.progressPath)) {
      upsertProgressItemResult(runPaths.progressPath, {
        owner: 'qa-verifier',
        status: 'fail',
        resultText: buildProgressResultText(
          'fail',
          error instanceof Error ? error.message : String(error),
          verifyCommandDescription,
          normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.verifierLogPath)),
        ),
      });
    }

    throw error;
  }
}

function executeRun(options) {
  const repoRoot = options.repoRoot || process.cwd();
  const templatesDir = options.templatesDir || resolveTemplatesDir(repoRoot);
  const runId = options.runId;
  const commandRunner = options.commandRunner || runCommand;
  const env = options.env || process.env;
  const runPaths = resolveRunPaths(repoRoot, runId);

  assertDirectoryExists(runPaths.runDir, 'Run directory');

  let executionControlState = resolveExecutionControls({
    ...options,
    defaultProject: options.project || DEFAULT_EXECUTION_CONTROLS.project,
  });
  let executeCommandDescription = buildHarnessCommandDescription('execute-run', {
    runId,
    executionControls: executionControlState,
    includeProject: true,
  });
  const runtimeLogDisplayPath = normalizeDisplayPath(path.relative(runPaths.runDir, runPaths.runtimeLogPath));
  let runtimeLogged = false;
  let project = executionControlState.controls.project;

  try {
    let artifactSet = loadRunArtifactSet({
      repoRoot,
      templatesDir,
      runId,
    });
    executionControlState = resolveExecutionControls({
      ...options,
      artifactSet,
      defaultProject: options.project || DEFAULT_EXECUTION_CONTROLS.project,
    });
    artifactSet = persistExecutionControls(artifactSet, executionControlState);
    project = executionControlState.controls.project;
    executeCommandDescription = buildHarnessCommandDescription('execute-run', {
      runId,
      executionControls: executionControlState,
      includeProject: true,
    });
    const commandEnv = applyExecutionControlsToEnv(env, executionControlState);
    const verificationResult = verifyRun({
      repoRoot,
      templatesDir,
      runId,
      commandRunner,
      env,
      project,
    });

    const relativeSpecPaths = verificationResult.generatedSpecs.map((generatedSpec) =>
      normalizeDisplayPath(path.relative(repoRoot, generatedSpec)),
    );
    const executionArgs = appendPlaywrightExecutionControlArgs(
      ['playwright', 'test', ...relativeSpecPaths],
      executionControlState,
      { includeProject: true },
    );
    const executionResult = commandRunner(getNpxCommand(), executionArgs, repoRoot, {
      env: commandEnv,
    });
    const combinedOutput = `${executionResult.stdout}\n${executionResult.stderr}`;
    const summary = summarizeOutput(combinedOutput, 'Playwright execution did not report a summary.');
    const runtimeLines = [
      ...(executionControlState.shouldPersist
        ? buildExecutionControlLogLines(executionControlState.controls)
        : [`Project: ${project}`]),
      `Command: ${formatCommandDisplay(getNpxCommand(), executionArgs)}`,
      `Generated specs: ${relativeSpecPaths.join(', ')}`,
      `Summary: ${summary}`,
    ];

    if (executionResult.status !== 0) {
      writeRuntimeLog(runPaths.runtimeLogPath, 'fail', runtimeLines);
      runtimeLogged = true;
      upsertProgressItemResult(runPaths.progressPath, {
        owner: 'qa-executor',
        status: 'fail',
        resultText: buildProgressResultText('fail', summary, executeCommandDescription, runtimeLogDisplayPath),
        appendIfMissing: true,
        itemId: 'P-RUN-EXEC',
        goal: 'execute generated run-backed scenarios',
        input: '`normalized.feature`',
        output: '`logs/runtime.log`',
        verify: `\`${executeCommandDescription}\``,
        retryBudget: '0',
        sectionTitle: 'Execution Results',
      });
      throw new Error(`Playwright execution failed:\n${combinedOutput.trim() || summary}`);
    }

    writeRuntimeLog(runPaths.runtimeLogPath, 'pass', runtimeLines);
    runtimeLogged = true;
    upsertProgressItemResult(runPaths.progressPath, {
      owner: 'qa-executor',
      status: 'pass',
      resultText: buildProgressResultText('pass', summary, executeCommandDescription, runtimeLogDisplayPath),
      appendIfMissing: true,
      itemId: 'P-RUN-EXEC',
      goal: 'execute generated run-backed scenarios',
      input: '`normalized.feature`',
      output: '`logs/runtime.log`',
      verify: `\`${executeCommandDescription}\``,
      retryBudget: '0',
      sectionTitle: 'Execution Results',
    });

    return {
      runId,
      runPaths,
      project,
      generatedSpecs: verificationResult.generatedSpecs,
      summary,
      executionControls: executionControlState.controls,
    };
  } catch (error) {
    if (!runtimeLogged && pathExists(runPaths.logsDir)) {
      const summary = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(runPaths.runtimeLogPath, 'fail', [
        ...(executionControlState.shouldPersist
          ? buildExecutionControlLogLines(executionControlState.controls)
          : [`Project: ${project}`]),
        `Command: ${executeCommandDescription}`,
        `Summary: ${sanitizeInlineCode(summary)}`,
      ]);
      runtimeLogged = true;
    }

    if (pathExists(runPaths.progressPath)) {
      upsertProgressItemResult(runPaths.progressPath, {
        owner: 'qa-executor',
        status: 'fail',
        resultText: buildProgressResultText(
          'fail',
          error instanceof Error ? error.message : String(error),
          executeCommandDescription,
          runtimeLogDisplayPath,
        ),
        appendIfMissing: true,
        itemId: 'P-RUN-EXEC',
        goal: 'execute generated run-backed scenarios',
        input: '`normalized.feature`',
        output: '`logs/runtime.log`',
        verify: `\`${executeCommandDescription}\``,
        retryBudget: '0',
        sectionTitle: 'Execution Results',
      });
    }

    throw error;
  }
}

function readJsonFile(filePath) {
  return JSON.parse(readText(filePath));
}

function readPackageVersion(filePath) {
  if (!pathExists(filePath) || !fs.statSync(filePath).isFile()) {
    return '';
  }

  try {
    const parsedFile = readJsonFile(filePath);
    return typeof parsedFile.version === 'string' ? parsedFile.version.trim() : '';
  } catch {
    return '';
  }
}

function resolveNpmPackageJsonPath(env = process.env) {
  const npmExecPath = typeof env.npm_execpath === 'string' ? env.npm_execpath.trim() : '';
  const candidatePaths = [];

  if (npmExecPath.endsWith('npm-cli.js')) {
    candidatePaths.push(path.join(path.dirname(path.dirname(npmExecPath)), 'package.json'));
  }

  candidatePaths.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'package.json'));

  for (const candidatePath of candidatePaths) {
    if (pathExists(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }

  return '';
}

function resolvePlaywrightBrowserRoots(repoRoot, env = process.env) {
  const roots = [];
  const configuredRoot = sanitizeOptionalInlineCode(env.PLAYWRIGHT_BROWSERS_PATH);

  if (configuredRoot === '0') {
    roots.push(path.join(repoRoot, 'node_modules', 'playwright-core', '.local-browsers'));
  } else if (configuredRoot) {
    roots.push(path.resolve(repoRoot, configuredRoot));
  }

  const homeDir = os.homedir();
  if (process.platform === 'win32') {
    roots.push(path.join(homeDir, 'AppData', 'Local', 'ms-playwright'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(homeDir, 'Library', 'Caches', 'ms-playwright'));
  } else {
    roots.push(path.join(homeDir, '.cache', 'ms-playwright'));
  }

  return Array.from(new Set(roots.map((rootPath) => path.resolve(rootPath))));
}

function resolvePlaywrightConfigPath(repoRoot) {
  for (const configName of SUPPORTED_PLAYWRIGHT_CONFIG_FILES) {
    const candidatePath = path.join(repoRoot, configName);
    if (pathExists(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }

  return '';
}

function collectFilesRecursively(rootDir, predicate, matches = []) {
  if (!pathExists(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return matches;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursively(entryPath, predicate, matches);
      continue;
    }

    if (entry.isFile() && predicate(entryPath, entry)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

function detectInstalledPlaywrightBrowsers(repoRoot, env = process.env) {
  const installedBrowsers = new Set();
  const inspectedRoots = [];

  for (const browserRoot of resolvePlaywrightBrowserRoots(repoRoot, env)) {
    if (!pathExists(browserRoot) || !fs.statSync(browserRoot).isDirectory()) {
      continue;
    }

    inspectedRoots.push(browserRoot);
    for (const entry of fs.readdirSync(browserRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const normalizedName = entry.name.toLowerCase();
      if (normalizedName.startsWith('chromium-') || normalizedName.startsWith('chromium_headless_shell-')) {
        installedBrowsers.add('chromium');
      } else if (normalizedName.startsWith('firefox-')) {
        installedBrowsers.add('firefox');
      } else if (normalizedName.startsWith('webkit-')) {
        installedBrowsers.add('webkit');
      }
    }
  }

  return {
    installedBrowsers,
    inspectedRoots,
  };
}

function createDoctorCheck(status, label, summary) {
  return {
    status,
    label: sanitizeInlineCode(label),
    summary: sanitizeInlineCode(summary),
  };
}

function validateOptionalCommandArgs(rawValue, envVarName) {
  parseEnvStringArray(rawValue, envVarName);
}

function doctor(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const env = options.env || process.env;
  const requestedProject = hasMeaningfulString(options.project)
    ? sanitizeInlineCode(options.project)
    : DEFAULT_EXECUTION_CONTROLS.project;
  const requestedAdapter = hasMeaningfulString(options.adapter)
    ? sanitizeInlineCode(options.adapter)
    : 'external';
  const requestedBaseUrl = hasMeaningfulString(options.baseUrl)
    ? options.baseUrl
    : hasMeaningfulString(env.PLAYWRIGHT_BASE_URL)
      ? env.PLAYWRIGHT_BASE_URL
      : '';
  const requestedTargetEnv = hasMeaningfulString(options.targetEnv)
    ? options.targetEnv
    : hasMeaningfulString(env.QA_HARNESS_TARGET_ENV)
      ? env.QA_HARNESS_TARGET_ENV
      : '';
  const requireBridge = options.requireBridge === true;
  const checks = [];

  assertRuntimeAdapterName(requestedAdapter);

  checks.push(createDoctorCheck('pass', 'node', `detected ${process.version}`));

  const npmVersion = readPackageVersion(resolveNpmPackageJsonPath(env));
  if (npmVersion) {
    checks.push(createDoctorCheck('pass', 'npm', `detected ${npmVersion}`));
  } else {
    checks.push(createDoctorCheck('fail', 'npm', 'npm package metadata could not be resolved from the current Node installation'));
  }

  const packageJsonPath = path.join(repoRoot, 'package.json');
  const featuresDir = path.join(repoRoot, 'Features');
  const stepsDir = path.join(featuresDir, 'steps');
  const featureFiles = collectFilesRecursively(featuresDir, (entryPath) => entryPath.toLowerCase().endsWith('.feature'));
  const stepFiles = collectFilesRecursively(stepsDir, (entryPath) => entryPath.toLowerCase().endsWith('.ts'));
  const playwrightConfigPath = resolvePlaywrightConfigPath(repoRoot);
  const missingLayoutParts = [];

  if (!pathExists(packageJsonPath)) {
    missingLayoutParts.push('package.json');
  }
  if (!playwrightConfigPath) {
    missingLayoutParts.push('playwright.config.*');
  }
  if (!pathExists(featuresDir) || !fs.statSync(featuresDir).isDirectory()) {
    missingLayoutParts.push('Features/');
  }
  if (!pathExists(stepsDir) || !fs.statSync(stepsDir).isDirectory()) {
    missingLayoutParts.push('Features/steps/');
  }
  if (featureFiles.length === 0) {
    missingLayoutParts.push('Features/**/*.feature');
  }
  if (stepFiles.length === 0) {
    missingLayoutParts.push('Features/steps/**/*.ts');
  }

  if (missingLayoutParts.length > 0) {
    checks.push(createDoctorCheck('fail', 'target-layout', `missing ${missingLayoutParts.join(', ')}`));
  } else {
    checks.push(
      createDoctorCheck(
        'pass',
        'target-layout',
        `found ${path.basename(playwrightConfigPath)}, ${featureFiles.length} feature file(s), and ${stepFiles.length} step file(s)`,
      ),
    );
  }

  const playwrightCliPath = path.join(repoRoot, 'node_modules', 'playwright', 'cli.js');
  const playwrightBddCliPath = path.join(repoRoot, 'node_modules', 'playwright-bdd', 'dist', 'cli', 'index.js');
  const playwrightVersion = readPackageVersion(path.join(repoRoot, 'node_modules', 'playwright', 'package.json'));
  const playwrightBddVersion = readPackageVersion(path.join(repoRoot, 'node_modules', 'playwright-bdd', 'package.json'));
  if (!pathExists(playwrightCliPath)) {
    checks.push(createDoctorCheck('fail', 'playwright', 'local Playwright CLI not found under node_modules/playwright/cli.js'));
  } else if (!pathExists(playwrightBddCliPath)) {
    checks.push(createDoctorCheck('fail', 'playwright', 'local playwright-bdd CLI not found under node_modules/playwright-bdd/dist/cli/index.js'));
  } else if (!playwrightVersion) {
    checks.push(createDoctorCheck('fail', 'playwright', 'local Playwright package metadata could not be read'));
  } else if (!playwrightBddVersion) {
    checks.push(createDoctorCheck('fail', 'playwright', 'local playwright-bdd package metadata could not be read'));
  } else {
    checks.push(
      createDoctorCheck(
        'pass',
        'playwright',
        `playwright ${playwrightVersion} and playwright-bdd ${playwrightBddVersion} detected locally`,
      ),
    );
  }

  if (!pathExists(playwrightCliPath)) {
    checks.push(createDoctorCheck('fail', 'browsers', 'cannot check browser installation without a local Playwright CLI'));
  } else {
    const browserDetection = detectInstalledPlaywrightBrowsers(repoRoot, env);
    if (browserDetection.installedBrowsers.size === 0) {
      const rootSummary = browserDetection.inspectedRoots.length > 0
        ? ` under ${browserDetection.inspectedRoots.map((rootPath) => normalizeDisplayPath(rootPath)).join(', ')}`
        : '';
      checks.push(createDoctorCheck('fail', 'browsers', `no installed Playwright browsers were found${rootSummary}`));
    } else if (
      ['chromium', 'firefox', 'webkit'].includes(requestedProject)
      && !browserDetection.installedBrowsers.has(requestedProject)
    ) {
      checks.push(
        createDoctorCheck(
          'fail',
          'browsers',
          `${requestedProject} is not installed; detected ${Array.from(browserDetection.installedBrowsers).sort().join(', ')}`,
        ),
      );
    } else {
      const browserSummary = ['chromium', 'firefox', 'webkit']
        .filter((browserName) => browserDetection.installedBrowsers.has(browserName))
        .join(', ');
      const projectSegment = ['chromium', 'firefox', 'webkit'].includes(requestedProject)
        ? `; ${requestedProject} is ready`
        : `; unable to map custom project ${requestedProject} to a browser install check`;
      checks.push(createDoctorCheck('pass', 'browsers', `${browserSummary}${projectSegment}`));
    }
  }

  if (requestedAdapter === 'external') {
    const externalCommand = typeof env.QA_HARNESS_EXTERNAL_RUNTIME_CMD === 'string'
      ? env.QA_HARNESS_EXTERNAL_RUNTIME_CMD.trim()
      : '';
    try {
      validateOptionalCommandArgs(env.QA_HARNESS_EXTERNAL_RUNTIME_ARGS, 'QA_HARNESS_EXTERNAL_RUNTIME_ARGS');
      if (externalCommand) {
        checks.push(createDoctorCheck('pass', 'runtime', `custom external runtime configured via ${externalCommand}`));
      } else {
        checks.push(createDoctorCheck('pass', 'runtime', 'bundled external worker will be used'));
      }
    } catch (error) {
      checks.push(createDoctorCheck('fail', 'runtime', error instanceof Error ? error.message : String(error)));
    }
  } else {
    checks.push(createDoctorCheck('pass', 'runtime', 'mock adapter selected for deterministic local testing'));
  }

  const bridgeCommand = typeof env.QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD === 'string'
    ? env.QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD.trim()
    : '';
  const bridgeArgsConfigured =
    typeof env.QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS === 'string' && env.QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS.trim();
  if (requireBridge || bridgeCommand || bridgeArgsConfigured) {
    if (!bridgeCommand) {
      checks.push(createDoctorCheck('fail', 'bridge', 'QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD is required when bridge validation is requested'));
    } else {
      try {
        validateOptionalCommandArgs(env.QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS, 'QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS');
        checks.push(createDoctorCheck('pass', 'bridge', `Playwright bridge configured via ${bridgeCommand}`));
      } catch (error) {
        checks.push(createDoctorCheck('fail', 'bridge', error instanceof Error ? error.message : String(error)));
      }
    }
  } else {
    checks.push(createDoctorCheck('warn', 'bridge', 'Playwright test/debug bridge not configured; CLI-only execution remains available'));
  }

  if (requestedBaseUrl) {
    try {
      const parsedBaseUrl = new URL(requestedBaseUrl);
      checks.push(createDoctorCheck('pass', 'inputs', `base URL ${parsedBaseUrl.toString()}${requestedTargetEnv ? `; target environment ${requestedTargetEnv}` : ''}`));
    } catch {
      checks.push(createDoctorCheck('fail', 'inputs', `base URL must be an absolute URL; received ${sanitizeInlineCode(requestedBaseUrl)}`));
    }
  } else if (requestedTargetEnv) {
    checks.push(createDoctorCheck('pass', 'inputs', `target environment ${sanitizeInlineCode(requestedTargetEnv)}; using target project baseURL defaults`));
  } else {
    checks.push(createDoctorCheck('pass', 'inputs', 'using target project Playwright config defaults'));
  }

  const failureCount = checks.filter((check) => check.status === 'fail').length;
  const warningCount = checks.filter((check) => check.status === 'warn').length;

  return {
    repoRoot,
    checks,
    failureCount,
    warningCount,
    status: failureCount > 0 ? 'fail' : 'pass',
  };
}

function formatDoctorOutput(result) {
  const lines = [`Doctor for ${normalizeDisplayPath(result.repoRoot)}:`];

  for (const check of result.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.label}: ${check.summary}`);
  }

  if (result.status === 'pass') {
    lines.push(
      result.warningCount > 0
        ? `Doctor passed with ${result.warningCount} warning${result.warningCount === 1 ? '' : 's'}.`
        : 'Doctor passed.',
    );
  } else {
    lines.push(`Doctor failed with ${result.failureCount} blocking issue${result.failureCount === 1 ? '' : 's'}.`);
  }

  return `${lines.join('\n')}\n`;
}

function usage() {
  const executionControlsUsage =
    '[--project <project>] [--headed <true|false>] [--debug <true|false>] ' +
    '[--base-url <url>] [--target-env <name>] [--trace <mode>] [--video <mode>] [--screenshot <mode>]';
  const bridgeUsage = '[--adapter <name>] [--require-bridge <true|false>] [--project <project>] [--base-url <url>] [--target-env <name>]';
  const commandPrefix = getHarnessCommandPrefix();
  return [
    'Usage:',
    `  ${commandPrefix} create-run --intent <intent> --source-type feature --source-ref <feature-path> [--mode <mode>] [--scope <scope>] [--constraint "..."]`,
    `  ${commandPrefix} prepare-run --intent <intent> --source-type feature --source-ref <feature-path> [--mode <mode>] [--scope <scope>] [--constraint "..."]`,
    `  ${commandPrefix} prepare-run --request "<operator request>" [--constraint "..."]`,
    `  ${commandPrefix} prepare-run --run-id <run-id> [--constraint "..."]`,
    `  ${commandPrefix} doctor ${bridgeUsage}`,
    `  ${commandPrefix} preflight ${bridgeUsage}`,
    `  ${commandPrefix} verify-run --run-id <run-id> ${executionControlsUsage}`,
    `  ${commandPrefix} execute-run --run-id <run-id> ${executionControlsUsage}`,
    `  ${commandPrefix} advance-run --run-id <run-id> [--adapter <name>] ${executionControlsUsage}`,
    `  ${commandPrefix} iterate-run --run-id <run-id> [--adapter <name>] ${executionControlsUsage}`,
    `  ${commandPrefix} loop-run --run-id <run-id> --max-iterations <n> [--adapter <name>] ${executionControlsUsage}`,
  ].join('\n');
}

function resolveOperatorRunPaths(repoRoot, runId, runPaths) {
  if (!hasMeaningfulString(runId)) {
    return runPaths || null;
  }

  return {
    ...resolveRunPaths(repoRoot, runId),
    ...(runPaths || {}),
  };
}

function resolveRunRelativeArtifactDisplay(runPaths, artifactPath) {
  if (!runPaths || !hasMeaningfulString(runPaths.runDir) || !hasMeaningfulString(artifactPath)) {
    return '';
  }

  return normalizeDisplayPath(path.relative(runPaths.runDir, artifactPath));
}

function formatArtifactReferenceSegment(artifactRefs) {
  const seenArtifactRefs = new Set();
  const normalizedArtifactRefs = [];

  for (const artifactRef of artifactRefs) {
    const normalizedArtifactRef = sanitizeOptionalInlineCode(artifactRef);

    if (!normalizedArtifactRef || seenArtifactRefs.has(normalizedArtifactRef)) {
      continue;
    }

    seenArtifactRefs.add(normalizedArtifactRef);
    normalizedArtifactRefs.push(normalizedArtifactRef);
  }

  if (normalizedArtifactRefs.length === 0) {
    return '';
  }

  return `; artifacts=${normalizedArtifactRefs.join(', ')}`;
}

function formatPrepareRunSuccessOperatorOutput(repoRoot, result) {
  const runPaths = resolveOperatorRunPaths(repoRoot, result.runId, result.runPaths);
  const plannerGapHandoff =
    result.plannerResult && result.plannerResult.gapHandoff && result.plannerResult.gapHandoff.active
      ? result.plannerResult.gapHandoff
      : null;
  const verifierSummary =
    typeof result.verifierSummary === 'string' && result.verifierSummary.trim()
      ? result.verifierSummary.trim()
      : result.verifyResult
        ? formatVerifyRunSummary(result.verifyResult)
        : 'verification passed';
  const clarifierSummary =
    typeof result.clarifierSummary === 'string' && result.clarifierSummary.trim()
      ? result.clarifierSummary.trim()
      : result.clarification && typeof result.clarification.summary === 'string' && result.clarification.summary.trim()
        ? result.clarification.summary.trim()
        : 'request normalized';
  const plannerSummary =
    typeof result.plannerSummary === 'string' && result.plannerSummary.trim()
      ? result.plannerSummary.trim()
      : result.plannerResult && typeof result.plannerResult.summary === 'string' && result.plannerResult.summary.trim()
        ? result.plannerResult.summary.trim()
        : 'artifacts refined';
  const artifactSegment = formatArtifactReferenceSegment([
    resolveRunRelativeArtifactDisplay(runPaths, runPaths && runPaths.progressPath),
    resolveRunRelativeArtifactDisplay(runPaths, runPaths && runPaths.verifierLogPath),
    plannerGapHandoff ? plannerGapHandoff.reportPathDisplay : '',
  ]);

  return (
    `Prepared run ${result.runId} at ${resolveRunDirDisplay(repoRoot, runPaths)}: ` +
    `ready; clarifier=${clarifierSummary}; planner=${plannerSummary}; verifier=${verifierSummary}` +
    `${artifactSegment}\n`
  );
}

function formatPrepareRunFailureOperatorOutput(repoRoot, failure, error) {
  const clarifierSummary = failure.clarifierSummary || sanitizeInlineCode(
    error instanceof Error ? error.message : String(error),
  );

  if (failure.stage === 'clarifier') {
    return `Prepare-run clarifier rejected request: ${clarifierSummary}\n`;
  }

  const runId = failure.runId || 'unknown-run';
  const runPaths = resolveOperatorRunPaths(repoRoot, runId, failure.runPaths);
  const runPathDisplay = failure.runPathDisplay
    || (runPaths ? resolveRunDirDisplay(repoRoot, runPaths) : '.');
  const plannerSummary = failure.plannerSummary || sanitizeInlineCode(
    error instanceof Error ? error.message : String(error),
  );
  const retainedArtifactSummary = failure.retainedArtifactSummary || 'created artifacts retained.';
  const artifactSegment = formatArtifactReferenceSegment(
    failure.stage === 'planner'
      ? [
        resolveRunRelativeArtifactDisplay(runPaths, runPaths && runPaths.prdPath),
        resolveRunRelativeArtifactDisplay(runPaths, runPaths && runPaths.progressPath),
        resolveRunRelativeArtifactDisplay(runPaths, runPaths && runPaths.promptPath),
      ]
      : [
        resolveRunRelativeArtifactDisplay(runPaths, runPaths && runPaths.progressPath),
        resolveRunRelativeArtifactDisplay(runPaths, runPaths && runPaths.verifierLogPath),
      ],
  );

  if (failure.stage === 'planner') {
    return (
      `Prepare-run planner failed for ${runId} at ${runPathDisplay}: ` +
      `clarifier=${clarifierSummary}; planner=${plannerSummary}; retained=${retainedArtifactSummary}` +
      `${artifactSegment}\n`
    );
  }

  const verifierSummary = failure.verifierSummary || sanitizeInlineCode(
    error instanceof Error ? error.message : String(error),
  );

  return (
    `Prepare-run verification failed for ${runId} at ${runPathDisplay}: ` +
    `clarifier=${clarifierSummary}; planner=${plannerSummary}; verifier=${verifierSummary}; ` +
    `retained=${retainedArtifactSummary}${artifactSegment}\n`
  );
}

function formatBoundedIterationOperatorOutput(action, result) {
  const selectedItemSegment = result.selectedItemId ? ` item ${result.selectedItemId}` : '';
  const primaryArtifactDisplay =
    result.healingItem && result.healReportPathDisplay
      ? result.healReportPathDisplay
      : result.scenarioAdditionItem && result.scenarioAdditionPathDisplay
        ? result.scenarioAdditionPathDisplay
      : result.explorerItem && result.gapAnalysisPathDisplay
        ? result.gapAnalysisPathDisplay
        : result.runtimeLogPathDisplay || '';

  return (
    `${action} run ${result.runId}${selectedItemSegment} with ${result.adapter}: ` +
    `${result.status} - ${result.summary}` +
    `${formatArtifactReferenceSegment([primaryArtifactDisplay])}\n`
  );
}

function formatAdvanceRunOperatorOutput(result) {
  const selectedItemSegment = result.selectedItemId ? ` item ${result.selectedItemId}` : '';
  const delegatedStatus = result.delegatedStatus || result.executorStatus || result.iterationStatus || result.status;
  const verifierStatus = result.verifierStatus || result.status;
  const delegatedSummary = sanitizeInlineCode(
    result.delegatedSummary || result.executorSummary || result.iterationSummary || result.summary || 'summary unavailable.',
  );
  const verifierSummary = sanitizeInlineCode(result.verifierSummary || result.summary || 'summary unavailable.');
  const followUpArtifactRefs = [result.verifierLogPathDisplay || 'logs/verifier.log'];

  if (result.healingItem && result.healReportPathDisplay) {
    followUpArtifactRefs.push(result.healReportPathDisplay);
  } else if (result.scenarioAdditionItem) {
    if (result.scenarioAdditionPathDisplay) {
      followUpArtifactRefs.push(result.scenarioAdditionPathDisplay);
    }
    if (result.promotionReportPathDisplay) {
      followUpArtifactRefs.push(result.promotionReportPathDisplay);
    }
  } else if (result.explorerItem && result.gapAnalysisPathDisplay) {
    followUpArtifactRefs.push(result.gapAnalysisPathDisplay);
  } else {
    followUpArtifactRefs.push(result.runtimeLogPathDisplay || 'logs/runtime.log');
  }

  if (
    (delegatedSummary.includes('fallback') || verifierSummary.includes('fallback'))
    && result.fallbackLogPathDisplay
  ) {
    followUpArtifactRefs.push(result.fallbackLogPathDisplay);
  }

  return (
    `Advanced run ${result.runId}${selectedItemSegment} with ${result.adapter}: ${result.status}; ` +
    `delegated=${delegatedStatus}: ${delegatedSummary}; ` +
    `verifier=${verifierStatus}: ${verifierSummary}` +
    `${formatArtifactReferenceSegment(followUpArtifactRefs)}\n`
  );
}

function formatLoopRunOperatorOutput(result) {
  const lastItemSegment = result.lastSelectedItemId ? `; last-item=${result.lastSelectedItemId}` : '';
  const artifactRefs = [result.loopReportPathDisplay || 'outputs/loop-report.md'];

  if (result.status === 'budget-exhausted' && result.progressPathDisplay) {
    artifactRefs.push(result.progressPathDisplay);
  } else if ((result.status === 'fail' || result.status === 'blocked') && result.runtimeLogDisplayPath) {
    artifactRefs.push(result.runtimeLogDisplayPath);
  }

  return (
    `Looped run ${result.runId} with ${result.adapter}: ${result.status} ` +
    `after ${result.completedIterations}/${result.maxIterations} iterations; stop=${result.stopReason}` +
    `${lastItemSegment}${formatArtifactReferenceSegment(artifactRefs)}\n`
  );
}

function parseCliArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const [command, ...rest] = argv;
  const options = { constraint: [] };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".\n\n${usage()}`);
    }

    const key = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for option ${token}.\n\n${usage()}`);
    }

    if (key === 'constraint') {
      options.constraint.push(value);
    } else {
      options[key] = value;
    }

    index += 1;
  }

  return { command, options };
}

function buildExecutionControlCliOptions(cliOptions) {
  const executionControlOptions = {};

  if (hasMeaningfulString(cliOptions.project)) {
    executionControlOptions.project = cliOptions.project;
  }

  if (Object.prototype.hasOwnProperty.call(cliOptions, 'headed')) {
    executionControlOptions.headed = parseBooleanOptionValue(cliOptions.headed, '--headed');
  }

  if (Object.prototype.hasOwnProperty.call(cliOptions, 'debug')) {
    executionControlOptions.debug = parseBooleanOptionValue(cliOptions.debug, '--debug');
  }

  if (hasMeaningfulString(cliOptions['base-url'])) {
    executionControlOptions.baseUrl = cliOptions['base-url'];
  }

  if (hasMeaningfulString(cliOptions['target-env'])) {
    executionControlOptions.targetEnv = cliOptions['target-env'];
  }

  if (hasMeaningfulString(cliOptions.trace)) {
    executionControlOptions.trace = cliOptions.trace;
  }

  if (hasMeaningfulString(cliOptions.video)) {
    executionControlOptions.video = cliOptions.video;
  }

  if (hasMeaningfulString(cliOptions.screenshot)) {
    executionControlOptions.screenshot = cliOptions.screenshot;
  }

  return executionControlOptions;
}

function buildPrepareRunCliOptions(cliOptions) {
  const hasRunId = hasMeaningfulString(cliOptions['run-id']);
  const hasFreeformRequestOption = Object.prototype.hasOwnProperty.call(cliOptions, 'request');
  const hasFreeformRequest = hasMeaningfulString(cliOptions.request);
  const hasStructuredOptions = ['intent', 'source-type', 'source-ref', 'mode', 'scope']
    .some((key) => hasMeaningfulString(cliOptions[key]));

  if (hasFreeformRequestOption && !hasFreeformRequest) {
    throw new Error(`Missing value for option --request.\n\n${usage()}`);
  }

  if (hasFreeformRequest && hasStructuredOptions) {
    throw new Error(`Prepare-run accepts either the structured feature-backed form or --request, but not both.\n\n${usage()}`);
  }

  if (hasRunId && (hasFreeformRequest || hasStructuredOptions)) {
    throw new Error(
      `Prepare-run accepts either the structured feature-backed form, --request, or --run-id, but not more than one input mode.\n\n${usage()}`,
    );
  }

  if (hasRunId) {
    return {
      runId: cliOptions['run-id'],
      constraints: cliOptions.constraint,
    };
  }

  if (hasFreeformRequest) {
    return {
      request: {
        request: cliOptions.request,
        constraints: cliOptions.constraint,
      },
    };
  }

  return {
    request: {
      intent: cliOptions.intent,
      sourceType: cliOptions['source-type'],
      sourceRef: cliOptions['source-ref'],
      mode: cliOptions.mode,
      scope: cliOptions.scope,
      constraints: cliOptions.constraint,
    },
  };
}

function buildDoctorCliOptions(cliOptions) {
  const doctorOptions = {};

  if (hasMeaningfulString(cliOptions.project)) {
    doctorOptions.project = cliOptions.project;
  }

  if (hasMeaningfulString(cliOptions.adapter)) {
    doctorOptions.adapter = cliOptions.adapter;
  }

  if (hasMeaningfulString(cliOptions['base-url'])) {
    doctorOptions.baseUrl = cliOptions['base-url'];
  }

  if (hasMeaningfulString(cliOptions['target-env'])) {
    doctorOptions.targetEnv = cliOptions['target-env'];
  }

  if (Object.prototype.hasOwnProperty.call(cliOptions, 'require-bridge')) {
    doctorOptions.requireBridge = parseBooleanOptionValue(cliOptions['require-bridge'], '--require-bridge');
  }

  return doctorOptions;
}

function runCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const repoRoot = options.repoRoot || process.cwd();
  const prepareRunFn = options.prepareRunFn || prepareRun;
  const createRunFn = options.createRunFn || createRun;
  const doctorFn = options.doctorFn || doctor;
  const verifyRunFn = options.verifyRunFn || verifyRun;
  const executeRunFn = options.executeRunFn || executeRun;
  const advanceRunFn = options.advanceRunFn || advanceRun;
  const iterateRunFn = options.iterateRunFn || iterateRun;
  const loopRunFn = options.loopRunFn || loopRun;

  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }

    if (parsed.command === 'create-run') {
      const result = createRunFn({
        repoRoot,
        request: {
          intent: parsed.options.intent,
          sourceType: parsed.options['source-type'],
          sourceRef: parsed.options['source-ref'],
          mode: parsed.options.mode,
          scope: parsed.options.scope,
          constraints: parsed.options.constraint,
        },
      });

      stdout.write(
        `Created run ${result.runId} at ${normalizeDisplayPath(path.relative(repoRoot, result.runPaths.runDir))}\n`,
      );
      return 0;
    }

    if (parsed.command === 'prepare-run') {
      try {
        const result = prepareRunFn({
          repoRoot,
          ...buildPrepareRunCliOptions(parsed.options),
        });
        stdout.write(formatPrepareRunSuccessOperatorOutput(repoRoot, result));
        return 0;
      } catch (error) {
        if (error && typeof error === 'object' && error.prepareRunFailure) {
          stderr.write(formatPrepareRunFailureOperatorOutput(repoRoot, error.prepareRunFailure, error));
          return 1;
        }

        throw error;
      }
    }

    if (parsed.command === 'doctor' || parsed.command === 'preflight') {
      const result = doctorFn({
        repoRoot,
        env: options.env || process.env,
        ...buildDoctorCliOptions(parsed.options),
      });
      const output = formatDoctorOutput(result);

      if (result.status === 'pass') {
        stdout.write(output);
        return 0;
      }

      stderr.write(output);
      return 1;
    }

    if (parsed.command === 'verify-run') {
      if (!parsed.options['run-id']) {
        throw new Error(`Missing value for option --run-id.\n\n${usage()}`);
      }

      const result = verifyRunFn({
        repoRoot,
        runId: parsed.options['run-id'],
        ...buildExecutionControlCliOptions(parsed.options),
      });

      stdout.write(
        `Verified run ${result.runId}: ${formatVerifyRunSummary(result)}.\n`,
      );
      return 0;
    }

    if (parsed.command === 'execute-run') {
      if (!parsed.options['run-id']) {
        throw new Error(`Missing value for option --run-id.\n\n${usage()}`);
      }

      const result = executeRunFn({
        repoRoot,
        runId: parsed.options['run-id'],
        ...buildExecutionControlCliOptions(parsed.options),
      });

      stdout.write(
        `Executed run ${result.runId} on ${result.project}: ${result.summary}\n`,
      );
      return 0;
    }

    if (parsed.command === 'advance-run') {
      if (!parsed.options['run-id']) {
        throw new Error(`Missing value for option --run-id.\n\n${usage()}`);
      }

      const result = advanceRunFn({
        repoRoot,
        runId: parsed.options['run-id'],
        adapter: parsed.options.adapter || 'external',
        ...buildExecutionControlCliOptions(parsed.options),
      });
      const output = formatAdvanceRunOperatorOutput(result);

      if (result.status === 'pass') {
        stdout.write(output);
        return 0;
      }

      stderr.write(output);
      return 1;
    }

    if (parsed.command === 'iterate-run') {
      if (!parsed.options['run-id']) {
        throw new Error(`Missing value for option --run-id.\n\n${usage()}`);
      }

      const result = iterateRunFn({
        repoRoot,
        runId: parsed.options['run-id'],
        adapter: parsed.options.adapter || 'external',
        ...buildExecutionControlCliOptions(parsed.options),
      });
      const output = formatBoundedIterationOperatorOutput('Iterated', result);

      if (result.status === 'pass') {
        stdout.write(output);
        return 0;
      }

      stderr.write(output);
      return 1;
    }

    if (parsed.command === 'loop-run') {
      if (!parsed.options['run-id']) {
        throw new Error(`Missing value for option --run-id.\n\n${usage()}`);
      }

      if (!parsed.options['max-iterations']) {
        throw new Error(`Missing value for option --max-iterations.\n\n${usage()}`);
      }

      const result = loopRunFn({
        repoRoot,
        runId: parsed.options['run-id'],
        maxIterations: parsePositiveIntegerOption(parsed.options['max-iterations'], '--max-iterations'),
        adapter: parsed.options.adapter || 'external',
        ...buildExecutionControlCliOptions(parsed.options),
      });
      const output = formatLoopRunOperatorOutput(result);

      if (result.status === 'completed' || result.status === 'budget-exhausted') {
        stdout.write(output);
        return 0;
      }

      stderr.write(output);
      return 1;
    }

    throw new Error(`Unknown command "${parsed.command}".\n\n${usage()}`);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

module.exports = {
  advanceRun,
  createRun,
  createRunId,
  doctor,
  executeRun,
  extractTemplatePlaceholders,
  findNextActionableProgressItem,
  findGeneratedSpecsForRun,
  formatDoctorOutput,
  getTemplatePlaceholders,
  iterateRun,
  loopRun,
  parseProgressItems,
  parseExportedStepCount,
  parseListedTestCount,
  parseCliArgs,
  clarifyPrepareRunRequest,
  planPreparedRunArtifacts,
  prepareRun,
  resolveProjectCliInvocation,
  resolveRunPaths,
  runCli,
  usage,
  validateRequestEnvelope,
  verifyRun,
};
