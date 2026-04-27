'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
const DEFAULT_PRODUCT_MAX_ITERATIONS = 40;
const DEFAULT_HARNESS_COMMAND_PREFIX = 'npx ralph-qa-harness';
const QA_AGENT_ROLES = Object.freeze([
  'qa-orchestrator',
  'qa-planner',
  'qa-executor',
  'qa-verifier',
]);
const QA_AGENT_ROLE_SELECTION_ERROR_CODE = 'QA_AGENT_ROLE_SELECTION_ERROR';
const QA_AGENT_TEMPLATE_DIR_NAMES = Object.freeze({
  'qa-orchestrator': 'main-orchestrator',
  'qa-planner': 'planner',
  'qa-executor': 'executor',
  'qa-verifier': 'verifier',
});
const QA_AGENT_ROLE_SET = new Set(QA_AGENT_ROLES);
const PLANNER_PROGRESS_CONTRACT_REQUIRED_FIELDS = Object.freeze([
  'Input',
  'Output',
  'Verify',
  'Owner',
  'Status',
  'Retry budget',
  'Result',
  'Evidence',
]);
const HARNESS_DIR_NAME = '.qa-harness';
const GENERATED_FEATURES_DIR_NAME = '.features-gen';
const HARNESS_CONFIG_FILE = 'config.json';
const HARNESS_PRD_FILE = 'PRD.md';
const HARNESS_PROGRESS_FILE = 'progress.md';
const HARNESS_PROMPT_FILE = 'PROMPT.md';
const HARNESS_NORMALIZED_FEATURE_FILE = 'normalized.feature';
const HARNESS_STATE_FILE = 'state.json';
const HARNESS_RUNS_DIR = 'runs';
const HARNESS_RUN_RESULT_FILE = 'result.json';
const HARNESS_RUN_LOOP_REPORT_FILE = 'loop-report.md';
const HARNESS_RUN_VALIDATION_FILE = 'validation.json';
const HARNESS_RUN_DIFF_FILE = 'diff.patch';
const HARNESS_RUN_SEED_SPEC_FILE = 'seed.spec.ts';
const HARNESS_RUN_PLAYWRIGHT_CONFIG_FILE = 'playwright.config.ts';
const HARNESS_RUN_ITERATIONS_DIR = 'iterations';
const HARNESS_RUN_AGENTS_DIR = 'agents';
const HARNESS_RUN_RESOLVED_PROMPTS_DIR = 'resolved-prompts';
const HARNESS_ITERATION_WORKER_PROMPT_FILE = 'worker-prompt.md';
const HARNESS_ITERATION_STDOUT_FILE = 'stdout.log';
const HARNESS_ITERATION_STDERR_FILE = 'stderr.log';
const HARNESS_ITERATION_SUMMARY_FILE = 'summary.json';
const HARNESS_ITERATION_VALIDATION_FILE = 'validation.json';
const HARNESS_ITERATION_DIFF_FILE = 'diff.patch';
const HARNESS_ITERATION_EVIDENCE_DIR = 'evidence';
const HARNESS_COVERAGE_PLAYWRIGHT_CLI_EVIDENCE_FILE = 'playwright-cli-seed.json';
const HARNESS_ITERATION_DIFF_MAX_BYTES = 64 * 1024;
const HARNESS_GIT_EXCLUDE_ENTRIES = Object.freeze([
  `${HARNESS_DIR_NAME}/`,
  `${GENERATED_FEATURES_DIR_NAME}/${HARNESS_DIR_NAME}/`,
]);
const RALPH_FOOTER_DESCRIPTOR_PLACEHOLDERS = new Set([
  '<one concise paragraph>',
  '<commands run, or why not run>',
  '<next recommended action, or none>',
]);
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

const PROGRESS_LIFECYCLE_STATUSES = Object.freeze(['todo', 'doing', 'needs-verification', 'pass', 'fail', 'blocked']);
const PROGRESS_LIFECYCLE_STATUS_SET = new Set(PROGRESS_LIFECYCLE_STATUSES);
const ACTIONABLE_PROGRESS_STATUSES = new Set(
  PROGRESS_LIFECYCLE_STATUSES.filter((status) => ['todo', 'doing', 'needs-verification', 'fail'].includes(status)),
);
const TERMINAL_PROGRESS_STATUSES = new Set(
  PROGRESS_LIFECYCLE_STATUSES.filter((status) => ['pass', 'blocked'].includes(status)),
);
const COVERAGE_REQUEST_INTAKE_FIELDS = Object.freeze([
  {
    key: 'target',
    label: 'target URL or app scope',
    question: 'What target URL or explicit app scope should the coverage request cover?',
  },
  {
    key: 'sourceContext',
    label: 'Jira ticket link/text or pasted requirements',
    question: 'What Jira ticket link/text or pasted requirements should define the requested coverage?',
  },
  {
    key: 'acceptanceCriteria',
    label: 'Acceptance criteria',
    question: 'What acceptance criteria must the coverage work prove?',
  },
]);
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

function resolveQaAgentsTemplatesDir() {
  return path.join(resolvePackageRoot(), 'templates', 'qa-agents');
}

function assertValidQaAgentRole(role) {
  if (!QA_AGENT_ROLE_SET.has(role)) {
    throw new Error(`Invalid QA agent role "${String(role)}". Valid roles: ${QA_AGENT_ROLES.join(', ')}.`);
  }

  return role;
}

function normalizeQaAgentRoleForArtifact(role) {
  if (!hasMeaningfulString(role)) {
    return '';
  }

  return assertValidQaAgentRole(role.trim());
}

function createQaAgentRoleSelectionError(message, details = {}) {
  const error = new Error(message);
  error.code = QA_AGENT_ROLE_SELECTION_ERROR_CODE;
  Object.assign(error, details);
  return error;
}

function isQaAgentRoleSelectionError(error) {
  return Boolean(error && error.code === QA_AGENT_ROLE_SELECTION_ERROR_CODE);
}

function resolveQaAgentTemplatePaths(role) {
  const validRole = assertValidQaAgentRole(role);
  const templateDir = path.join(resolveQaAgentsTemplatesDir(), QA_AGENT_TEMPLATE_DIR_NAMES[validRole]);

  return {
    role: validRole,
    templateDir,
    agentPath: path.join(templateDir, 'agent.md'),
    skillsPath: path.join(templateDir, 'skills.md'),
  };
}

function resolveQaAgentRoleForProgressItem(selectedItem) {
  const itemId = selectedItem && hasMeaningfulString(selectedItem.id) ? selectedItem.id : 'selected item';
  const owner = selectedItem && hasMeaningfulString(selectedItem.owner) ? selectedItem.owner.trim() : '';

  if (!owner) {
    throw createQaAgentRoleSelectionError(
      `Selected progress item ${itemId} is missing a QA agent Owner field. Valid roles: ${QA_AGENT_ROLES.join(', ')}.`,
      { selectedItem, selectedOwner: '' },
    );
  }

  if (!QA_AGENT_ROLE_SET.has(owner)) {
    throw createQaAgentRoleSelectionError(
      `Invalid QA agent role "${owner}" on selected progress item ${itemId}. Valid roles: ${QA_AGENT_ROLES.join(', ')}.`,
      { selectedItem, selectedOwner: owner },
    );
  }

  return owner;
}

function buildQaPlanningArtifactRouteItem(missingArtifacts) {
  const missingList = Array.isArray(missingArtifacts) && missingArtifacts.length > 0
    ? missingArtifacts.join(', ')
    : 'required planning artifacts';
  const block = buildProgressItemBlock({
    itemId: 'PLAN-ARTIFACTS',
    goal: 'create or repair the durable QA planning artifacts.',
    input: `Missing artifacts: \`${sanitizeInlineCode(missingList)}\``,
    output: 'Updated `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`.',
    verify: 'inspect durable planning artifacts',
    owner: 'qa-planner',
    agent: 'qa-planner',
    mode: 'planning',
    status: 'todo',
    retryBudget: '1',
    resultText: '',
    evidence: '',
    fallbackReason: '',
  });

  return parseProgressItemBlock(block, {
    sectionTitle: 'Orchestrator Route',
  });
}

function buildQaProgressContractRepairRouteItem(contractIssue) {
  const item = contractIssue && contractIssue.item ? contractIssue.item : {};
  const itemId = hasMeaningfulString(item.id) ? item.id : 'unknown progress item';
  const issueSummary = contractIssue && Array.isArray(contractIssue.issues) && contractIssue.issues.length > 0
    ? contractIssue.issues.join(', ')
    : 'planner output contract fields';
  const block = buildProgressItemBlock({
    itemId: 'PLAN-PROGRESS-CONTRACT',
    goal: 'repair stale or incomplete planner-authored progress artifacts.',
    input: `Progress item \`${sanitizeInlineCode(itemId)}\` is missing or weakening: \`${sanitizeInlineCode(issueSummary)}\`.`,
    output: 'Updated `.qa-harness/progress.md` with bounded items that satisfy the planner output contract.',
    verify: 'inspect `.qa-harness/progress.md` for planner-authored items with required fields, seed proof, and full Playwright execution requirements',
    owner: 'qa-planner',
    agent: 'qa-planner',
    mode: 'planning',
    status: 'todo',
    retryBudget: '1',
    resultText: '',
    evidence: '',
    fallbackReason: '',
  });

  return parseProgressItemBlock(block, {
    sectionTitle: 'Orchestrator Route',
  });
}

function getMissingQaPlanningArtifacts(runPaths) {
  return [
    { path: runPaths.prdPath, displayPath: `${HARNESS_DIR_NAME}/${HARNESS_PRD_FILE}` },
    { path: runPaths.progressPath, displayPath: `${HARNESS_DIR_NAME}/${HARNESS_PROGRESS_FILE}` },
    { path: runPaths.promptPath, displayPath: `${HARNESS_DIR_NAME}/${HARNESS_PROMPT_FILE}` },
  ].filter((artifact) => !pathExists(artifact.path) || !fs.statSync(artifact.path).isFile())
    .map((artifact) => artifact.displayPath);
}

function collectProgressContractIssues(item) {
  const issues = [];

  if (!item || !hasMeaningfulString(item.id)) {
    issues.push('id');
  }

  if (!item || !hasMeaningfulString(item.goal)) {
    issues.push('goal');
  }

  for (const label of PLANNER_PROGRESS_CONTRACT_REQUIRED_FIELDS) {
    if (!item || !progressItemHasField(item.block || '', label)) {
      issues.push(label);
      continue;
    }

    if (label !== 'Result' && label !== 'Evidence' && !hasMeaningfulString(readProgressItemField(item.block, label))) {
      issues.push(label);
    }
  }

  return issues;
}

function findProgressContractIssue(items) {
  for (const item of items) {
    if (!item || !hasMeaningfulString(item.owner) || !QA_AGENT_ROLE_SET.has(item.owner)) {
      continue;
    }

    const issues = collectProgressContractIssues(item);
    if (issues.length > 0) {
      return { item, issues };
    }
  }

  return null;
}

function normalizeQaRouteMode(item, role, fallbackMode) {
  if (hasMeaningfulString(fallbackMode)) {
    return fallbackMode;
  }

  if (item && hasMeaningfulString(item.mode)) {
    return item.mode.trim();
  }

  if (role === 'qa-planner') {
    return 'planning';
  }

  if (role === 'qa-verifier') {
    return 'verification';
  }

  if (role === 'qa-orchestrator') {
    return 'routing';
  }

  return 'implementation';
}

function buildQaOrchestratorRoute(options) {
  const role = assertValidQaAgentRole(options.role || 'qa-orchestrator');
  return {
    status: options.status || 'run',
    stopReason: options.stopReason || null,
    role,
    mode: normalizeQaRouteMode(options.item, role, options.mode),
    item: options.item || null,
    reason: options.reason || '',
    missingArtifacts: Array.isArray(options.missingArtifacts) ? options.missingArtifacts : [],
  };
}

function selectQaOrchestratorRoute(runPaths) {
  const missingArtifacts = getMissingQaPlanningArtifacts(runPaths);
  if (missingArtifacts.length > 0) {
    return buildQaOrchestratorRoute({
      role: 'qa-planner',
      mode: 'planning',
      item: buildQaPlanningArtifactRouteItem(missingArtifacts),
      reason: `Missing planning artifacts: ${missingArtifacts.join(', ')}.`,
      missingArtifacts,
    });
  }

  const progressContent = readText(runPaths.progressPath);
  const parsedItems = parseProgressItems(progressContent);
  const activeItems = parsedItems.filter((item) => item.sectionTitle === 'Active Items');
  const items = activeItems.length > 0 ? activeItems : parsedItems;

  if (items.length === 0) {
    return buildQaOrchestratorRoute({
      role: 'qa-planner',
      mode: 'planning',
      item: buildQaPlanningArtifactRouteItem([`${HARNESS_DIR_NAME}/${HARNESS_PROGRESS_FILE}`]),
      reason: 'No bounded progress items exist in .qa-harness/progress.md.',
    });
  }

  const progressContractIssue = findProgressContractIssue(items);
  if (progressContractIssue) {
    return buildQaOrchestratorRoute({
      role: 'qa-planner',
      mode: 'planning',
      item: buildQaProgressContractRepairRouteItem(progressContractIssue),
      reason: `Progress item ${progressContractIssue.item.id} is missing required planner output contract fields: ${progressContractIssue.issues.join(', ')}.`,
    });
  }

  const invalidStatusItem = items.find((item) => !PROGRESS_LIFECYCLE_STATUS_SET.has(item.status));
  if (invalidStatusItem) {
    return buildQaOrchestratorRoute({
      status: 'failed',
      stopReason: 'invalid-progress-status',
      role: 'qa-orchestrator',
      mode: 'routing',
      item: invalidStatusItem,
      reason: `Unsupported progress status "${invalidStatusItem.status}" on progress item ${invalidStatusItem.id}.`,
    });
  }

  const blockedItem = items.find((item) => item.status === 'blocked');
  if (blockedItem) {
    return buildQaOrchestratorRoute({
      status: 'blocked',
      stopReason: 'blocked',
      role: 'qa-orchestrator',
      mode: 'routing',
      item: blockedItem,
      reason: `Progress item ${blockedItem.id} is blocked.`,
    });
  }

  if (items.every((item) => item.status === 'pass')) {
    return buildQaOrchestratorRoute({
      status: 'completed',
      stopReason: 'all-progress-passed',
      role: 'qa-orchestrator',
      mode: 'routing',
      reason: 'All progress items are verifier-passed.',
    });
  }

  const verificationItem = items.find((item) => item.status === 'needs-verification');
  if (verificationItem) {
    return buildQaOrchestratorRoute({
      role: 'qa-verifier',
      mode: 'verification',
      item: verificationItem,
      reason: `Progress item ${verificationItem.id} needs verifier review.`,
    });
  }

  const failedRetryItem = items.find((item) => item.status === 'fail' && parseRetryBudgetValue(item.retryBudget) > 0);
  if (failedRetryItem) {
    return buildQaOrchestratorRoute({
      role: 'qa-executor',
      mode: 'healing',
      item: failedRetryItem,
      reason: `Progress item ${failedRetryItem.id} failed verification with retry budget remaining.`,
    });
  }

  const failedExhaustedItem = items.find((item) => item.status === 'fail');
  if (failedExhaustedItem) {
    return buildQaOrchestratorRoute({
      status: 'failed',
      stopReason: 'retry-budget-exhausted',
      role: 'qa-orchestrator',
      mode: 'routing',
      item: failedExhaustedItem,
      reason: `Progress item ${failedExhaustedItem.id} failed and has no retry budget remaining.`,
    });
  }

  const runnableItem = items.find((item) => item.status === 'todo' || item.status === 'doing');
  if (runnableItem) {
    const role = resolveQaAgentRoleForProgressItem(runnableItem);
    return buildQaOrchestratorRoute({
      role,
      item: runnableItem,
      reason: `Progress item ${runnableItem.id} is ready for ${role}.`,
    });
  }

  return buildQaOrchestratorRoute({
    status: 'completed',
    stopReason: 'no-actionable-items',
    role: 'qa-orchestrator',
    mode: 'routing',
    reason: 'No actionable progress item remains.',
  });
}

function formatQaAgentTemplateDisplayPath(filePath) {
  return normalizeDisplayPath(path.relative(resolvePackageRoot(), filePath));
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

function isPathWithin(parentDir, targetPath) {
  const relativePath = path.relative(parentDir, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizeHarnessRunId(runId) {
  const value = hasMeaningfulString(runId) ? runId.trim() : '';
  if (!value) {
    return '';
  }

  if (
    value === '.'
    || value === '..'
    || path.isAbsolute(value)
    || value.includes('/')
    || value.includes('\\')
  ) {
    throw new Error('Run id must be a single path segment under .qa-harness/runs.');
  }

  return value;
}

function assertDurableHarnessPaths(paths) {
  const harnessDir = paths.harnessDir;
  for (const [key, value] of Object.entries(paths)) {
    if (key === 'repoRoot' || key === 'runId' || !hasMeaningfulString(value)) {
      continue;
    }

    if (!isPathWithin(harnessDir, value)) {
      throw new Error(`${key} must stay under ${HARNESS_DIR_NAME}.`);
    }
  }

  if (hasMeaningfulString(paths.runDir) && !isPathWithin(paths.runsDir, paths.runDir)) {
    throw new Error('Run id must be a single path segment under .qa-harness/runs.');
  }
}

function assertRunScopedHarnessPaths(paths) {
  if (!hasMeaningfulString(paths.runId) || !hasMeaningfulString(paths.runDir)) {
    return;
  }

  const runScopedKeys = [
    'resultPath',
    'loopReportPath',
    'validationPath',
    'diffPatchPath',
    'seedSpecPath',
    'playwrightConfigPath',
    'iterationsDir',
    'agentsDir',
    'resolvedPromptsDir',
  ];

  for (const key of runScopedKeys) {
    const value = paths[key];
    if (hasMeaningfulString(value) && !isPathWithin(paths.runDir, value)) {
      throw new Error(`${key} must stay under ${HARNESS_DIR_NAME}/${HARNESS_RUNS_DIR}/<run-id>.`);
    }
  }
}

function resolveHarnessPaths(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const harnessDir = path.join(root, HARNESS_DIR_NAME);
  const runsDir = path.join(harnessDir, HARNESS_RUNS_DIR);
  const runId = normalizeHarnessRunId(options.runId);
  const runDir = runId ? path.resolve(runsDir, runId) : '';
  const paths = {
    repoRoot: root,
    harnessDir,
    configPath: path.join(harnessDir, HARNESS_CONFIG_FILE),
    prdPath: path.join(harnessDir, HARNESS_PRD_FILE),
    progressPath: path.join(harnessDir, HARNESS_PROGRESS_FILE),
    promptPath: path.join(harnessDir, HARNESS_PROMPT_FILE),
    normalizedFeaturePath: path.join(harnessDir, HARNESS_NORMALIZED_FEATURE_FILE),
    statePath: path.join(harnessDir, HARNESS_STATE_FILE),
    runsDir,
  };
  assertDurableHarnessPaths(paths);

  if (!runId) {
    return paths;
  }

  const runPaths = {
    ...paths,
    runId,
    runDir,
    resultPath: path.join(runDir, HARNESS_RUN_RESULT_FILE),
    loopReportPath: path.join(runDir, HARNESS_RUN_LOOP_REPORT_FILE),
    validationPath: path.join(runDir, HARNESS_RUN_VALIDATION_FILE),
    diffPatchPath: path.join(runDir, HARNESS_RUN_DIFF_FILE),
    seedSpecPath: path.join(runDir, HARNESS_RUN_SEED_SPEC_FILE),
    playwrightConfigPath: path.join(runDir, HARNESS_RUN_PLAYWRIGHT_CONFIG_FILE),
    iterationsDir: path.join(runDir, HARNESS_RUN_ITERATIONS_DIR),
    agentsDir: path.join(runDir, HARNESS_RUN_AGENTS_DIR),
    resolvedPromptsDir: path.join(runDir, HARNESS_RUN_AGENTS_DIR, HARNESS_RUN_RESOLVED_PROMPTS_DIR),
  };

  assertDurableHarnessPaths(runPaths);
  assertRunScopedHarnessPaths(runPaths);
  return runPaths;
}

function resolveGeneratedHarnessPaths(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const generatedDir = path.join(root, GENERATED_FEATURES_DIR_NAME);
  const generatedHarnessDir = path.join(generatedDir, HARNESS_DIR_NAME);
  const generatedRunsDir = path.join(generatedHarnessDir, HARNESS_RUNS_DIR);
  const runId = normalizeHarnessRunId(options.runId);
  const paths = {
    repoRoot: root,
    generatedDir,
    generatedHarnessDir,
    generatedRunsDir,
  };

  if (!runId) {
    return paths;
  }

  const generatedRunDir = path.join(generatedRunsDir, runId);
  if (!isPathWithin(generatedRunsDir, generatedRunDir)) {
    throw new Error('Run id must be a single path segment under .qa-harness/runs.');
  }

  return {
    ...paths,
    runId,
    generatedRunDir,
  };
}

function formatVerifyRunSummary(result) {
  const executedSegment = Number.isInteger(result.executedTestCount)
    ? `, ${result.executedTestCount} executed tests`
    : '';
  return `${result.exportedStepCount} exported steps, ${result.listedTestCount} listed tests${executedSegment}`;
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

function normalizeCoverageRequestText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

function stripTerminalPunctuation(value) {
  return value.replace(/[),.;]+$/g, '').trim();
}

function readCoverageRequestSection(requestText, labelPatterns) {
  const lines = requestText.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const labelMatch = line.match(/^\s*([^:]{1,60}):\s*(.*)$/);
    if (!labelMatch) {
      continue;
    }

    const label = labelMatch[1].trim();
    if (!labelPatterns.some((pattern) => pattern.test(label))) {
      continue;
    }

    const values = [];
    if (labelMatch[2].trim()) {
      values.push(labelMatch[2].trim());
    }

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      if (/^\s*[^:]{1,60}:\s*/.test(nextLine)) {
        break;
      }
      if (nextLine.trim()) {
        values.push(nextLine.trim());
      }
    }

    return values.join('\n').trim();
  }

  return '';
}

function extractCoverageRequestUrls(value) {
  return Array.from(value.matchAll(/https?:\/\/[^\s"'`<>)]+/gi))
    .map((match) => stripTerminalPunctuation(match[0]))
    .filter(Boolean);
}

function isJiraReference(value) {
  return /\b[A-Z][A-Z0-9]+-\d+\b/u.test(value) || /(?:^|[./-])jira(?:[./-]|$)/i.test(value);
}

function parseCoverageAcceptanceCriteria(requestText) {
  const section = readCoverageRequestSection(requestText, [
    /^acceptance criteria$/i,
    /^acceptance$/i,
    /^criteria$/i,
  ]);

  const criteria = section
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean);

  if (criteria.length === 0) {
    throw new Error('prepare --request requires acceptance criteria.');
  }

  return criteria;
}

function parseCoverageRequestTarget(requestText) {
  const targetUrlSection = readCoverageRequestSection(requestText, [
    /^target url$/i,
    /^target$/i,
    /^url$/i,
  ]);
  const targetUrl = extractCoverageRequestUrls(targetUrlSection)[0];

  if (targetUrl) {
    return {
      type: 'url',
      value: targetUrl,
    };
  }

  const appScope = sanitizeInlineCode(readCoverageRequestSection(requestText, [
    /^app scope$/i,
    /^application scope$/i,
    /^scope$/i,
  ]));

  if (appScope) {
    return {
      type: 'app-scope',
      value: appScope,
    };
  }

  const requestUrl = extractCoverageRequestUrls(requestText).find((url) => !isJiraReference(url));
  if (requestUrl) {
    return {
      type: 'url',
      value: requestUrl,
    };
  }

  throw new Error('prepare --request requires a target URL or app scope.');
}

function parseCoverageRequestSourceContext(requestText, requirements) {
  const ticketSection = readCoverageRequestSection(requestText, [
    /^jira$/i,
    /^jira ticket$/i,
    /^ticket$/i,
    /^source$/i,
  ]);
  const jiraUrl = extractCoverageRequestUrls(ticketSection).find(isJiraReference);
  const jiraKeyMatch = ticketSection.match(/\b[A-Z][A-Z0-9]+-\d+\b/u);

  if (jiraUrl || jiraKeyMatch) {
    return {
      type: 'jira',
      value: jiraUrl || jiraKeyMatch[0],
    };
  }

  const firstJiraUrl = extractCoverageRequestUrls(requestText).find(isJiraReference);
  if (firstJiraUrl) {
    return {
      type: 'jira',
      value: firstJiraUrl,
    };
  }

  const firstJiraKey = requestText.match(/\b[A-Z][A-Z0-9]+-\d+\b/u);
  if (firstJiraKey) {
    return {
      type: 'jira',
      value: firstJiraKey[0],
    };
  }

  if (requirements) {
    return {
      type: 'requirements',
      value: requirements,
    };
  }

  throw new Error('prepare --request requires a Jira ticket link/text or pasted requirements.');
}

function parseCoverageRequestRequirements(requestText) {
  return sanitizeInlineCode(readCoverageRequestSection(requestText, [
    /^requirements?$/i,
    /^requirements? text$/i,
    /^pasted requirements?$/i,
  ]));
}

function getCoverageRequestIntakeField(key) {
  return COVERAGE_REQUEST_INTAKE_FIELDS.find((field) => field.key === key);
}

function describeCoverageRequestMissingFields(missingFields) {
  return missingFields
    .map((key) => {
      const field = getCoverageRequestIntakeField(key);
      return field ? field.label : key;
    });
}

function buildCoverageRequestFollowUpQuestions(missingFields) {
  return missingFields
    .map((key) => {
      const field = getCoverageRequestIntakeField(key);
      return field ? field.question : `What value should be used for ${key}?`;
    });
}

function isCoverageRequestMissingFieldError(error) {
  return error instanceof Error && /^prepare --request requires /i.test(error.message);
}

function readCoverageRequestIntakeField(key, readField) {
  try {
    return {
      value: readField(),
      missing: null,
    };
  } catch (error) {
    if (!isCoverageRequestMissingFieldError(error)) {
      throw error;
    }

    return {
      value: null,
      missing: key,
    };
  }
}

function normalizePrepareCoverageRequest(requestText, options = {}) {
  const normalizedRequestText = normalizeCoverageRequestText(requestText);

  if (!normalizedRequestText) {
    throw new Error('prepare --request requires non-empty request text.');
  }

  const requirements = parseCoverageRequestRequirements(normalizedRequestText);
  const target = readCoverageRequestIntakeField(
    'target',
    () => parseCoverageRequestTarget(normalizedRequestText),
  );
  const sourceContext = readCoverageRequestIntakeField(
    'sourceContext',
    () => parseCoverageRequestSourceContext(normalizedRequestText, requirements),
  );
  const acceptanceCriteria = readCoverageRequestIntakeField(
    'acceptanceCriteria',
    () => parseCoverageAcceptanceCriteria(normalizedRequestText),
  );
  const missingFields = [target.missing, sourceContext.missing, acceptanceCriteria.missing]
    .filter(Boolean);

  return {
    kind: 'coverage-request',
    requestText: normalizedRequestText,
    status: missingFields.length > 0 ? 'blocked' : 'accepted',
    complete: missingFields.length === 0,
    target: target.value,
    sourceContext: sourceContext.value,
    requirements,
    acceptanceCriteria: acceptanceCriteria.value || [],
    constraints: normalizeConstraintList(options.constraints),
    missingFields,
    followUpQuestions: buildCoverageRequestFollowUpQuestions(missingFields),
  };
}

function normalizePrepareCoverageRequestOption(request, options = {}) {
  if (request && typeof request === 'object' && request.kind === 'coverage-request') {
    return request;
  }

  if (request && typeof request === 'object' && hasMeaningfulString(request.request)) {
    return normalizePrepareCoverageRequest(request.request, {
      constraints: request.constraints || options.constraints,
    });
  }

  return normalizePrepareCoverageRequest(request, options);
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
  const harnessPaths = resolveHarnessPaths(repoRoot, { runId });
  const runDir = harnessPaths.runDir;
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

function ensureHarnessGitInfoExclude(repoRoot) {
  const gitDir = path.join(path.resolve(repoRoot), '.git');
  if (!pathExists(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    return {
      status: 'skipped',
      reason: '.git directory not found',
      entries: HARNESS_GIT_EXCLUDE_ENTRIES,
    };
  }

  const gitInfoDir = path.join(gitDir, 'info');
  const excludePath = path.join(gitInfoDir, 'exclude');
  const existingContent = pathExists(excludePath) ? readText(excludePath) : '';
  const existingEntries = new Set(
    existingContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missingEntries = HARNESS_GIT_EXCLUDE_ENTRIES.filter((entry) => !existingEntries.has(entry));

  if (missingEntries.length > 0) {
    fs.mkdirSync(gitInfoDir, { recursive: true });
    const separator = existingContent.length === 0 || existingContent.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludePath, `${separator}${missingEntries.join('\n')}\n`, 'utf8');
  }

  return {
    status: missingEntries.length > 0 ? 'updated' : 'unchanged',
    excludePath,
    entries: HARNESS_GIT_EXCLUDE_ENTRIES,
    addedEntries: missingEntries,
  };
}

function stampPrdTemplate(template, data) {
  let content = template;

  content = replaceOnce(content, '<run-id>', data.runId, 'PRD.md');
  content = replaceOnce(content, '<intent>', data.intent, 'PRD.md');
  content = replaceOnce(content, '<mode>', data.mode, 'PRD.md');
  content = replaceOnce(content, '<source-type>', data.sourceType, 'PRD.md');
  content = replaceOnce(content, '<source feature path>', data.sourceRefDisplay, 'PRD.md');
  content = replaceOnce(content, 'Describe the exact QA outcome this run must achieve.', data.objective, 'PRD.md');
  content = replaceOnce(content, '<feature input>', data.sourceRefDisplay, 'PRD.md');
  content = replaceOnce(content, '<scenario or feature area>', data.primaryScenarioScope, 'PRD.md');
  content = replaceOnce(content, '<user guidance>', data.userGuidance, 'PRD.md');
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
    const marker = '- Complete one selected progress item per worker process.';
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
  content = replaceOnce(content, '<small atomic goal>', 'one small, verifiable goal', 'progress.md');
  content = replaceOnce(content, '<single source>', 'one source artifact', 'progress.md');
  content = replaceOnce(content, '<single artifact or code change>', 'one artifact or code change', 'progress.md');
  content = replaceOnce(content, '<single proof step>', 'one proof step', 'progress.md');
  content = content.replace(/<owner role>/g, 'qa-executor');
  content = content.replace(/<agent role>/g, 'qa-executor');
  content = content.replace(/<mode>/g, 'implementation');
  content = replaceOnce(content, '<feature path>', data.sourceRefDisplay, 'progress.md');

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

  ensureHarnessGitInfoExclude(repoRoot);
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
    objective: `Prepare a feature-backed QA harness run for ${request.sourceRefDisplay} using .qa-harness/normalized.feature as the execution truth and supervisor verification as the completion proof.`,
    userGuidance: request.constraints.length > 0 ? request.constraints.join('; ') : 'not provided',
    successCriteria: [
      `.qa-harness/normalized.feature preserves the source feature from ${request.sourceRefDisplay}.`,
      'Copilot receives one selected item from .qa-harness/progress.md and returns the required Ralph footer.',
      'Supervisor verification succeeds via ralph-qa-harness verify without full browser execution.',
    ],
    outOfScope: [
      'Non-feature source intake is outside the lean template contract.',
      'Full browser execution is outside the lean verification contract.',
    ],
    knownGaps: [
      'Feature normalization is identity-only unless a later selected item changes it.',
      'Verification is list-time proof against generated run-backed specs.',
    ],
    verification: {
      command: 'ralph-qa-harness verify',
      evidence: 'structured validation output and listed generated tests',
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

function resolveDefaultCopilotCommand(platform = process.platform) {
  return platform === 'win32' ? 'copilot.cmd' : 'copilot';
}

function buildLeanPreparePrd(sourceDisplayPath, featureMetadata) {
  const featureTitle = featureMetadata.featureTitle || path.basename(sourceDisplayPath, '.feature');
  const scenarioCount = Number.isInteger(featureMetadata.scenarioCount) ? featureMetadata.scenarioCount : 0;
  const scenarioLabel = `${scenarioCount} scenario${scenarioCount === 1 ? '' : 's'}`;

  return [
    '# QA Harness PRD',
    '',
    `Source feature path: \`${sourceDisplayPath}\``,
    `Feature title: ${featureTitle}`,
    `Scenario count: ${scenarioLabel}`,
    '',
    '## Objective',
    '',
    'Execute or improve the selected feature through Copilot-supervised Playwright BDD.',
    '',
    '## Execution Truth',
    '',
    '`normalized.feature` is the execution truth for this harness run.',
    '',
    '## Required Layers',
    '',
    '- Playwright is required for browser/test execution.',
    '- `playwright-bdd` is required for executable feature generation.',
    '',
  ].join('\n');
}

function buildLeanPrepareProgress(sourceDisplayPath) {
  return [
    '# Ralph QA Harness Progress',
    '',
    '## Active Items',
    '',
    `- [ ] \`P-001\` Goal: execute \`${sourceDisplayPath}\` through Copilot-supervised Playwright BDD verification.`,
    `  - Input: \`${sourceDisplayPath}\` and \`.qa-harness/normalized.feature\``,
    '  - Output: Copilot evidence recorded in `.qa-harness/runs/<run-id>/iterations/<nnn>/` and `.qa-harness/progress.md`.',
    '  - Verify: `ralph-qa-harness verify` passes and lists generated run-backed tests.',
    '  - Owner: `qa-executor`',
    '  - Agent: `qa-executor`',
    '  - Mode: `implementation`',
    '  - Status: `todo`',
    '  - Retry budget: `1`',
    '  - Result: ``',
    '  - Evidence: ``',
    '',
  ].join('\n');
}

function buildLeanPreparePrompt() {
  return [
    '# Copilot Worker Rules',
    '',
    '- Complete exactly one selected unchecked item from `.qa-harness/progress.md` per Copilot process.',
    '- Use `.qa-harness/PRD.md` as the durable objective.',
    '- Use `.qa-harness/progress.md` as durable progress.',
    '- Use `.qa-harness/PROMPT.md` as durable worker rules.',
    '- Use `.qa-harness/normalized.feature` as execution truth.',
    '- Use `.qa-harness/` files as durable memory.',
    '- Do not stage, commit, push, or create a pull request.',
    '- Keep durable harness state in `.qa-harness/`.',
    '- The supervisor will run `ralph-qa-harness verify` after worker exit.',
    '',
    'Every response must end with this exact four-line Ralph footer:',
    '',
    'RALPH_STATUS: pass|blocked|fail',
    'RALPH_SUMMARY: <one concise paragraph>',
    'RALPH_VALIDATION: <commands run, or why not run>',
    'RALPH_NEXT: <next recommended action, or none>',
    '',
  ].join('\n');
}

function buildLeanPrepareConfig(platform) {
  return `${JSON.stringify({
    schemaVersion: 1,
    loop: {
      defaultMaxIterations: DEFAULT_PRODUCT_MAX_ITERATIONS,
    },
    copilot: {
      command: resolveDefaultCopilotCommand(platform || process.platform),
    },
  }, null, 2)}\n`;
}

function formatCoverageRequestIntakeValue(value, fallback = 'missing') {
  if (!value) {
    return fallback;
  }

  if (typeof value === 'string') {
    return hasMeaningfulString(value) ? value : fallback;
  }

  if (typeof value === 'object' && hasMeaningfulString(value.value)) {
    return `${value.type}: ${value.value}`;
  }

  return fallback;
}

function buildBlockedCoverageIntakePrd(coverageRequest) {
  const missingLabels = describeCoverageRequestMissingFields(coverageRequest.missingFields);
  const criteria = Array.isArray(coverageRequest.acceptanceCriteria)
    ? coverageRequest.acceptanceCriteria
    : [];
  const constraints = normalizeConstraintList(coverageRequest.constraints);

  return [
    '# QA Harness PRD',
    '',
    '## Blocked Coverage Intake',
    '',
    'Status: blocked',
    '',
    `Target: ${formatCoverageRequestIntakeValue(coverageRequest.target)}`,
    `Source context: ${formatCoverageRequestIntakeValue(coverageRequest.sourceContext)}`,
    `Requirements: ${formatCoverageRequestIntakeValue(coverageRequest.requirements)}`,
    '',
    'Acceptance criteria:',
    ...(criteria.length > 0 ? criteria.map((entry) => `- ${entry}`) : ['- missing']),
    '',
    'Constraints:',
    ...(constraints.length > 0 ? constraints.map((entry) => `- ${entry}`) : ['- none recorded']),
    '',
    'Missing fields:',
    ...missingLabels.map((label) => `- ${label}`),
    '',
    'Follow-up questions:',
    ...coverageRequest.followUpQuestions.map((question, index) => `${index + 1}. ${question}`),
    '',
    'Submitted request:',
    '',
    '```text',
    coverageRequest.requestText,
    '```',
    '',
    'No feature or BDD artifacts are generated until intake is complete.',
    '',
  ].join('\n');
}

function buildBlockedCoverageIntakeProgress(coverageRequest) {
  const missingLabels = describeCoverageRequestMissingFields(coverageRequest.missingFields);
  const missingKeys = coverageRequest.missingFields.join(', ');

  return [
    '# QA Harness Progress',
    '',
    '## Active Items',
    '',
    buildProgressItemBlock({
      itemId: 'INTAKE-001',
      goal: 'collect the missing coverage request intake before planning work.',
      input: 'Incomplete `prepare --request` intake recorded in `.qa-harness/PRD.md`.',
      output: 'Complete coverage intake with target scope, source context, and acceptance criteria.',
      verify: 'rerun `ralph-qa-harness prepare --request <text>` with the missing fields supplied',
      owner: 'qa-orchestrator',
      agent: 'qa-orchestrator',
      mode: 'intake',
      status: 'blocked',
      retryBudget: '0',
      resultText: 'blocked: coverage request intake is incomplete',
      evidence: `Missing fields: ${missingLabels.join('; ')}`,
      fallbackReason: '',
      blockReason: `Missing fields: ${missingKeys}`,
    }),
    '',
  ].join('\n');
}

function buildBlockedCoverageIntakeOutput(coverageRequest) {
  const missingLabels = describeCoverageRequestMissingFields(coverageRequest.missingFields);

  return [
    'Coverage request intake is blocked.',
    'Missing fields:',
    ...missingLabels.map((label) => `- ${label}`),
    'Follow-up questions:',
    ...coverageRequest.followUpQuestions.map((question, index) => `${index + 1}. ${question}`),
    '',
  ].join('\n');
}

function buildAcceptedCoverageRequestPrd(coverageRequest) {
  const criteria = Array.isArray(coverageRequest.acceptanceCriteria)
    ? coverageRequest.acceptanceCriteria
    : [];
  const constraints = normalizeConstraintList(coverageRequest.constraints);

  return [
    '# QA Harness PRD',
    '',
    '## Accepted Coverage Request',
    '',
    'Status: accepted',
    '',
    `Target: ${formatCoverageRequestIntakeValue(coverageRequest.target)}`,
    `Source context: ${formatCoverageRequestIntakeValue(coverageRequest.sourceContext)}`,
    `Requirements: ${formatCoverageRequestIntakeValue(coverageRequest.requirements, 'none recorded')}`,
    '',
    'Acceptance criteria:',
    ...criteria.map((entry) => `- ${entry}`),
    '',
    'Constraints:',
    ...(constraints.length > 0 ? constraints.map((entry) => `- ${entry}`) : ['- none recorded']),
    '',
    'Planning notes:',
    '- Convert the accepted scope, source context, constraints, and acceptance criteria into bounded QA progress items.',
    '- Keep durable planning memory in `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md`.',
    '- Do not create final BDD feature or step files during preparation.',
    '',
    'Submitted request:',
    '',
    '```text',
    coverageRequest.requestText,
    '```',
    '',
  ].join('\n');
}

function buildAcceptedCoverageRequestProgress(coverageRequest) {
  return [
    '# QA Harness Progress',
    '',
    '## Active Items',
    '',
    buildProgressItemBlock({
      itemId: 'PLAN-001',
      goal: 'convert the accepted coverage request into bounded QA coverage work.',
      input: 'Accepted coverage request in `.qa-harness/PRD.md` with scope, source context, constraints, and acceptance criteria.',
      output: 'Refined `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md` with bounded implementation and verification items that include seed proof and full Playwright execution requirements.',
      verify: 'inspect `.qa-harness/progress.md` for one worker iteration items with id, goal, input, output, verify command or proof requirement, owner, status, retry budget, result, and evidence fields plus seed proof and full Playwright execution requirements',
      owner: 'qa-planner',
      agent: 'qa-planner',
      mode: 'planning',
      status: 'todo',
      retryBudget: '1',
      resultText: '',
      evidence: '',
      fallbackReason: '',
    }),
    '',
  ].join('\n');
}

function buildAcceptedCoverageRequestPrompt() {
  return [
    '# Copilot Worker Rules',
    '',
    '- Complete exactly one selected unchecked item from `.qa-harness/progress.md` per Copilot process.',
    '- Use `.qa-harness/PRD.md` as the durable objective.',
    '- Use `.qa-harness/progress.md` as durable progress.',
    '- Use `.qa-harness/PROMPT.md` as durable worker rules.',
    '- Use `.qa-harness/` files as durable memory.',
    '- Keep accepted coverage request scope, source context, constraints, and acceptance criteria in `.qa-harness/` artifacts.',
    '- Planner output contract: every planner-authored progress item must include id, goal, input, output, verify command or proof requirement, owner, status, retry budget, result, and evidence fields.',
    '- Coverage tasks must be small enough for one worker iteration and must include seed proof plus full Playwright execution requirements before verifier pass.',
    '- Do not create final BDD feature or step files during preparation.',
    '- Do not stage, commit, push, or create a pull request.',
    '- Keep durable harness state in `.qa-harness/`.',
    '- The supervisor will run `ralph-qa-harness verify` after worker exit.',
    '',
    'Every response must end with this exact four-line Ralph footer:',
    '',
    'RALPH_STATUS: pass|blocked|fail',
    'RALPH_SUMMARY: <one concise paragraph>',
    'RALPH_VALIDATION: <commands run, or why not run>',
    'RALPH_NEXT: <next recommended action, or none>',
    '',
  ].join('\n');
}

function removeFileIfExists(filePath) {
  if (pathExists(filePath) && fs.statSync(filePath).isFile()) {
    fs.unlinkSync(filePath);
  }
}

function writeBlockedCoverageIntakeArtifacts(repoRoot, harnessPaths, coverageRequest, options = {}) {
  const preparedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();

  ensureHarnessGitInfoExclude(repoRoot);
  fs.mkdirSync(harnessPaths.harnessDir, { recursive: true });
  writeText(harnessPaths.configPath, buildLeanPrepareConfig(options.platform || process.platform));
  writeText(harnessPaths.prdPath, buildBlockedCoverageIntakePrd(coverageRequest));
  writeText(harnessPaths.progressPath, buildBlockedCoverageIntakeProgress(coverageRequest));
  writeText(harnessPaths.promptPath, buildLeanPreparePrompt());
  removeFileIfExists(harnessPaths.normalizedFeaturePath);
  writeText(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      intake: {
        kind: 'coverage-request',
        status: 'blocked',
        requestText: coverageRequest.requestText,
        target: coverageRequest.target,
        sourceContext: coverageRequest.sourceContext,
        requirements: coverageRequest.requirements,
        acceptanceCriteria: coverageRequest.acceptanceCriteria,
        constraints: coverageRequest.constraints,
        missingFields: coverageRequest.missingFields,
        followUpQuestions: coverageRequest.followUpQuestions,
      },
      preparedAt,
      latestRunId: null,
      activeRunId: null,
      terminalStatus: 'blocked',
    }, null, 2)}\n`,
  );
}

function writeAcceptedCoverageRequestArtifacts(repoRoot, harnessPaths, coverageRequest, options = {}) {
  const preparedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();

  ensureHarnessGitInfoExclude(repoRoot);
  fs.mkdirSync(harnessPaths.harnessDir, { recursive: true });
  writeText(harnessPaths.configPath, buildLeanPrepareConfig(options.platform || process.platform));
  writeText(harnessPaths.prdPath, buildAcceptedCoverageRequestPrd(coverageRequest));
  writeText(harnessPaths.progressPath, buildAcceptedCoverageRequestProgress(coverageRequest));
  writeText(harnessPaths.promptPath, buildAcceptedCoverageRequestPrompt());
  removeFileIfExists(harnessPaths.normalizedFeaturePath);
  writeText(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      intake: {
        kind: 'coverage-request',
        status: 'accepted',
        requestText: coverageRequest.requestText,
        target: coverageRequest.target,
        sourceContext: coverageRequest.sourceContext,
        requirements: coverageRequest.requirements,
        acceptanceCriteria: coverageRequest.acceptanceCriteria,
        constraints: coverageRequest.constraints,
      },
      preparedAt,
      latestRunId: null,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );
}

function prepare(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const harnessPaths = options.harnessPaths || resolveHarnessPaths(repoRoot);
  const sourceRef = hasMeaningfulString(options.from) ? options.from.trim() : '';
  const hasCoverageRequest = options.request != null;

  if (sourceRef && hasCoverageRequest) {
    throw new Error('prepare accepts either --from or --request, but not both.');
  }

  if (hasCoverageRequest) {
    const coverageRequest = normalizePrepareCoverageRequestOption(options.request, {
      constraints: options.constraints,
    });

    if (!coverageRequest.complete) {
      writeBlockedCoverageIntakeArtifacts(repoRoot, harnessPaths, coverageRequest, options);
      return {
        status: 'blocked',
        exitCode: 1,
        request: coverageRequest,
        output: buildBlockedCoverageIntakeOutput(coverageRequest),
      };
    }

    writeAcceptedCoverageRequestArtifacts(repoRoot, harnessPaths, coverageRequest, options);
    return {
      status: 'pass',
      request: coverageRequest,
      output: `Accepted coverage request for ${coverageRequest.target.value}.\n`,
    };
  }

  if (!sourceRef) {
    throw new Error('Missing required option --from or --request for prepare.');
  }

  const sourcePath = path.resolve(repoRoot, sourceRef);
  if (path.extname(sourcePath).toLowerCase() !== '.feature') {
    throw new Error(`prepare --from requires a .feature file: ${normalizeDisplayPath(sourceRef)}.`);
  }

  if (!pathExists(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Feature file not found: ${normalizeDisplayPath(sourceRef)}.`);
  }

  const sourceDisplayPath = resolveDisplayPath(repoRoot, sourcePath);
  const featureContent = readText(sourcePath);
  const featureMetadata = parseFeatureMetadata(featureContent, sourceDisplayPath);
  const preparedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();

  ensureHarnessGitInfoExclude(repoRoot);
  fs.mkdirSync(harnessPaths.harnessDir, { recursive: true });

  writeText(harnessPaths.configPath, buildLeanPrepareConfig(options.platform || process.platform));
  writeText(harnessPaths.prdPath, buildLeanPreparePrd(sourceDisplayPath, featureMetadata));
  writeText(harnessPaths.progressPath, buildLeanPrepareProgress(sourceDisplayPath));
  writeText(harnessPaths.promptPath, buildLeanPreparePrompt());
  writeText(harnessPaths.normalizedFeaturePath, featureContent);
  writeText(
    harnessPaths.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      sourceFeaturePath: sourceDisplayPath,
      normalizedFeaturePath: `${HARNESS_DIR_NAME}/${HARNESS_NORMALIZED_FEATURE_FILE}`,
      preparedAt,
      latestRunId: null,
      activeRunId: null,
      terminalStatus: null,
    }, null, 2)}\n`,
  );

  return {
    status: 'pass',
    sourceFeaturePath: sourceDisplayPath,
    output: `Prepared ${sourceDisplayPath} in ${HARNESS_DIR_NAME}.\n`,
  };
}

function readHarnessState(harnessPaths) {
  if (!pathExists(harnessPaths.statePath) || !fs.statSync(harnessPaths.statePath).isFile()) {
    return null;
  }

  try {
    return JSON.parse(readText(harnessPaths.statePath));
  } catch (error) {
    throw new Error(
      `Unable to read ${HARNESS_DIR_NAME}/${HARNESS_STATE_FILE}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeHarnessState(harnessPaths, state) {
  fs.mkdirSync(harnessPaths.harnessDir, { recursive: true });
  writeText(harnessPaths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function formatOptionalStateValue(value, fallback) {
  return hasMeaningfulString(value) ? value : fallback;
}

function readOptionalJsonFile(filePath, displayPath) {
  if (!pathExists(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    throw new Error(
      `Unable to read ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getLatestLeanIterationLabel(runPaths, result) {
  const iterationNumbers = [];

  if (result && Number.isInteger(result.iterationCount) && result.iterationCount > 0) {
    iterationNumbers.push(result.iterationCount);
  }

  if (pathExists(runPaths.iterationsDir) && fs.statSync(runPaths.iterationsDir).isDirectory()) {
    for (const entry of fs.readdirSync(runPaths.iterationsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
        iterationNumbers.push(Number(entry.name));
      }
    }
  }

  if (iterationNumbers.length === 0) {
    return 'none';
  }

  return String(Math.max(...iterationNumbers)).padStart(3, '0');
}

function readLeanStatusRunDetails(repoRoot, state) {
  const runId = hasMeaningfulString(state.activeRunId) ? state.activeRunId : state.latestRunId;
  if (!hasMeaningfulString(runId)) {
    return null;
  }

  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  const result = readOptionalJsonFile(
    runPaths.resultPath,
    `${HARNESS_DIR_NAME}/runs/${runId}/result.json`,
  );
  const validation = readOptionalJsonFile(
    runPaths.validationPath,
    `${HARNESS_DIR_NAME}/runs/${runId}/validation.json`,
  );
  const runStatus = hasMeaningfulString(state.activeRunId)
    ? 'active'
    : formatOptionalStateValue(result && result.status, formatOptionalStateValue(state.terminalStatus, 'not run'));

  return {
    runId,
    runStatus,
    stopReason: formatOptionalStateValue(result && result.stopReason, 'not recorded'),
    validationStatus: formatOptionalStateValue(validation && validation.status, 'not recorded'),
    validationPathDisplay: `${HARNESS_DIR_NAME}/runs/${runId}/validation.json`,
    iterationLabel: getLatestLeanIterationLabel(runPaths, result),
  };
}

function status(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const harnessPaths = options.harnessPaths || resolveHarnessPaths(repoRoot);
  const state = readHarnessState(harnessPaths);

  if (!state) {
    return {
      status: 'pass',
      output: [
        'Status: no-run',
        `No prepared QA harness state found at ${HARNESS_DIR_NAME}/${HARNESS_STATE_FILE}.`,
        `Next: ${getHarnessCommandPrefix()} prepare --from <feature-path>`,
        '',
      ].join('\n'),
    };
  }

  const runDetails = readLeanStatusRunDetails(repoRoot, state);
  const outputLines = [
    `Prepared feature: ${formatOptionalStateValue(state.sourceFeaturePath, 'unknown')}`,
    `Normalized feature: ${formatOptionalStateValue(state.normalizedFeaturePath, `${HARNESS_DIR_NAME}/${HARNESS_NORMALIZED_FEATURE_FILE}`)}`,
    `Prepared at: ${formatOptionalStateValue(state.preparedAt, 'unknown')}`,
    `Latest run: ${formatOptionalStateValue(state.latestRunId, 'none')}`,
    `Active run: ${formatOptionalStateValue(state.activeRunId, 'none')}`,
    `Terminal status: ${formatOptionalStateValue(state.terminalStatus, 'not run')}`,
  ];

  if (runDetails) {
    outputLines.push(
      `Run id: ${runDetails.runId}`,
      `Run status: ${runDetails.runStatus}`,
      `Current/last iteration: ${runDetails.iterationLabel}`,
      `Stop reason: ${runDetails.stopReason}`,
      `Validation status: ${runDetails.validationStatus}`,
      `Validation artifact: ${runDetails.validationPathDisplay}`,
    );
  }

  outputLines.push(`Next: ${getHarnessCommandPrefix()} run --max-iterations <positive-integer>`, '');

  return {
    status: 'pass',
    output: outputLines.join('\n'),
  };
}

function getLeanRunExitCode(status) {
  return ['failed', 'blocked', 'budget-exhausted', 'stalled'].includes(status) ? 1 : 0;
}

function buildLeanRunResultOutput(runId, iterationCount, status, stopReason) {
  return `Run ${runId} stopped after ${iterationCount} iterations: ${status}; stop reason: ${stopReason}.\n`;
}

function classifyLeanFooterStopReason(footerError) {
  if (/^Missing required footer field /i.test(footerError || '')) {
    return 'missing-footer';
  }

  return 'invalid-footer';
}

function describeLeanRunStop(status, stopReason) {
  const summaries = {
    'all-progress-passed': 'All required progress items are verifier-passed.',
    blocked: 'The Copilot worker reported RALPH_STATUS: blocked.',
    'budget-exhausted': 'Budget was exhausted before all progress items completed.',
    'coverage-cli-evidence-required': 'MCP fallback was reported before Playwright CLI seed evidence existed.',
    'coverage-mcp-fallback-evidence-required': 'MCP fallback was reported without durable MCP evidence.',
    'coverage-mcp-fallback-reason-required': 'MCP fallback was reported without a fallback reason.',
    'coverage-mcp-fallback-requires-failed-cli': 'MCP fallback was reported even though Playwright CLI seed discovery succeeded.',
    'coverage-promotion-explanation-required': 'Promoted BDD or framework code materially differed from seed proof without explanation.',
    'coverage-promotion-seed-proof-required': 'Promotion was reported before Playwright CLI seed proof existed.',
    'invalid-footer': 'The Copilot worker returned an invalid Ralph footer.',
    'invalid-agent-role': 'The selected progress item did not name a valid QA agent role.',
    'invalid-progress-status': 'A progress item used an unsupported lifecycle status.',
    'missing-footer': 'The Copilot worker did not return the required Ralph footer.',
    'no-actionable-items': 'No unchecked actionable progress item remains.',
    'retry-budget-exhausted': 'A failed progress item has no retry budget remaining.',
    'selected-item-not-completed': 'The selected progress item was not completed after a pass footer and supervisor verify pass.',
    'validation-failed': 'Supervisor verification failed after the worker reported pass.',
    'worker-exit-nonzero': 'The Copilot worker process exited nonzero.',
    'worker-failed': 'The Copilot worker reported RALPH_STATUS: fail.',
  };

  return summaries[stopReason] || `The run stopped with terminal status ${status}.`;
}

function buildLeanRunResultRecord(runId, status, stopReason, iterationCount, iterations) {
  return {
    schemaVersion: 1,
    runId,
    status,
    stopReason,
    exitCode: getLeanRunExitCode(status),
    iterationCount,
    iterations,
    finishedAt: new Date().toISOString(),
  };
}

function buildLeanLoopReport(result) {
  const lines = [
    '# QA Harness Loop Report',
    '',
    `Run id: ${result.runId}`,
    `Final status: ${result.status}`,
    `Stop reason: ${result.stopReason}`,
    `Iterations: ${result.iterationCount}`,
    `Exit code: ${result.exitCode}`,
    '',
    'Operator summary:',
    describeLeanRunStop(result.status, result.stopReason),
  ];
  const lastIteration = Array.isArray(result.iterations) && result.iterations.length > 0
    ? result.iterations[result.iterations.length - 1]
    : null;

  if (lastIteration) {
    lines.push('', 'Last iteration:');
    lines.push(`- Iteration: ${lastIteration.iteration}`);
    if (hasMeaningfulString(lastIteration.RALPH_AGENT)) {
      lines.push(`- RALPH_AGENT: ${lastIteration.RALPH_AGENT}`);
    }
    lines.push(`- Worker exit code: ${lastIteration.exitCode}`);
    if (hasMeaningfulString(lastIteration.roleError)) {
      lines.push(`- Role error: ${lastIteration.roleError}`);
    }
    if (lastIteration.footerError) {
      lines.push(`- Footer error: ${lastIteration.footerError}`);
    }
    if (lastIteration.footer && hasMeaningfulString(lastIteration.footer.status)) {
      lines.push(`- Footer status: ${lastIteration.footer.status}`);
    }
    if (lastIteration.footer && hasMeaningfulString(lastIteration.footer.summary)) {
      lines.push(`- Footer summary: ${lastIteration.footer.summary}`);
    }
  }

  if (Array.isArray(result.iterations) && result.iterations.length > 0) {
    lines.push('', 'Iteration roles:');
    for (const iteration of result.iterations) {
      lines.push(`- Iteration ${iteration.iteration}: RALPH_AGENT ${iteration.RALPH_AGENT || 'unknown'}`);
      if (hasMeaningfulString(iteration.roleError)) {
        lines.push(`  Role error: ${iteration.roleError}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeLeanRunTerminalArtifacts(repoRoot, runId, result) {
  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  fs.mkdirSync(runPaths.runDir, { recursive: true });
  writeText(runPaths.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  writeText(runPaths.loopReportPath, buildLeanLoopReport(result));
  writeText(runPaths.diffPatchPath, buildLeanRunDiffPatch(repoRoot, runId, result));
}

function normalizeWorkerCommandResult(result) {
  return {
    exitCode: normalizeCommandExitCode(result),
    stdout: result && typeof result.stdout === 'string' ? result.stdout : '',
    stderr: result && typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function resolveLeanIterationPaths(runPaths, iteration) {
  const iterationDirectoryName = String(parsePositiveIntegerOption(iteration, 'iteration')).padStart(3, '0');
  const iterationDir = path.join(runPaths.iterationsDir, iterationDirectoryName);
  return {
    iterationDirectoryName,
    iterationDir,
    workerPromptPath: path.join(iterationDir, HARNESS_ITERATION_WORKER_PROMPT_FILE),
    stdoutLogPath: path.join(iterationDir, HARNESS_ITERATION_STDOUT_FILE),
    stderrLogPath: path.join(iterationDir, HARNESS_ITERATION_STDERR_FILE),
    summaryPath: path.join(iterationDir, HARNESS_ITERATION_SUMMARY_FILE),
    validationPath: path.join(iterationDir, HARNESS_ITERATION_VALIDATION_FILE),
    diffPatchPath: path.join(iterationDir, HARNESS_ITERATION_DIFF_FILE),
    evidenceDir: path.join(iterationDir, HARNESS_ITERATION_EVIDENCE_DIR),
    coveragePlaywrightCliEvidencePath: path.join(
      iterationDir,
      HARNESS_ITERATION_EVIDENCE_DIR,
      HARNESS_COVERAGE_PLAYWRIGHT_CLI_EVIDENCE_FILE,
    ),
  };
}

function resolveLeanResolvedPromptAuditPath(runPaths, iterationPaths, role) {
  const selectedRole = assertValidQaAgentRole(role);
  const fileName = `${iterationPaths.iterationDirectoryName}-${selectedRole}.md`;
  const resolvedPromptPath = path.join(runPaths.resolvedPromptsDir, fileName);

  if (
    !isPathWithin(runPaths.runDir, resolvedPromptPath)
    || !isPathWithin(runPaths.runsDir, resolvedPromptPath)
  ) {
    throw new Error('Resolved prompt audit path must stay under .qa-harness/runs/<run-id>.');
  }

  return resolvedPromptPath;
}

function writeLeanResolvedPromptAuditCopy(runPaths, iterationPaths, role, workerPrompt) {
  const resolvedPromptPath = resolveLeanResolvedPromptAuditPath(runPaths, iterationPaths, role);
  fs.mkdirSync(path.dirname(resolvedPromptPath), { recursive: true });
  writeText(resolvedPromptPath, workerPrompt);
  return resolvedPromptPath;
}

function shouldSkipIterationSnapshotDirectory(repoRoot, directoryPath) {
  const relativePath = normalizeDisplayPath(path.relative(repoRoot, directoryPath));
  return (
    relativePath === '.git'
    || relativePath.startsWith('.git/')
    || relativePath === 'node_modules'
    || relativePath.startsWith('node_modules/')
    || relativePath === '.ralph'
    || relativePath.startsWith('.ralph/')
    || relativePath === `${HARNESS_DIR_NAME}/${HARNESS_RUNS_DIR}`
    || relativePath.startsWith(`${HARNESS_DIR_NAME}/${HARNESS_RUNS_DIR}/`)
  );
}

function readIterationSnapshotFile(repoRoot, filePath) {
  const stats = fs.statSync(filePath);
  const relativePath = normalizeDisplayPath(path.relative(repoRoot, filePath));
  const baseState = {
    path: relativePath,
    absolutePath: filePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };

  if (stats.size > HARNESS_ITERATION_DIFF_MAX_BYTES) {
    return {
      ...baseState,
      kind: 'oversized',
      signature: `oversized:${stats.size}:${stats.mtimeMs}`,
    };
  }

  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const isBinary = content.includes(0);
  return {
    ...baseState,
    kind: isBinary ? 'binary' : 'text',
    signature: hash,
    content: isBinary ? null : content.toString('utf8'),
  };
}

function captureIterationSnapshot(repoRoot) {
  const root = path.resolve(repoRoot);
  const snapshot = new Map();

  function visit(directoryPath) {
    if (!pathExists(directoryPath) || shouldSkipIterationSnapshotDirectory(root, directoryPath)) {
      return;
    }

    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        const fileState = readIterationSnapshotFile(root, entryPath);
        snapshot.set(fileState.path, fileState);
      }
    }
  }

  visit(root);
  return snapshot;
}

function compareIterationSnapshots(beforeSnapshot, afterSnapshot) {
  const paths = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);
  const changes = [];

  for (const filePath of [...paths].sort()) {
    const before = beforeSnapshot.get(filePath) || null;
    const after = afterSnapshot.get(filePath) || null;
    if (before && after && before.signature === after.signature) {
      continue;
    }

    const status = before && after ? 'modified' : before ? 'deleted' : 'added';
    changes.push({
      path: filePath,
      status,
      before,
      after,
    });
  }

  return changes;
}

function formatChangedFiles(changes) {
  return changes.map((change) => ({
    path: change.path,
    status: change.status,
    size: change.after ? change.after.size : 0,
  }));
}

function prefixDiffLines(prefix, content) {
  if (!content) {
    return [];
  }

  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line, index, lines) => index < lines.length - 1 || line.length > 0)
    .map((line) => `${prefix}${line}`);
}

function buildTextDiff(change) {
  const beforeContent = change.before && change.before.kind === 'text' ? change.before.content : '';
  const afterContent = change.after && change.after.kind === 'text' ? change.after.content : '';
  return [
    `diff --git a/${change.path} b/${change.path}`,
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    '@@',
    ...prefixDiffLines('-', beforeContent),
    ...prefixDiffLines('+', afterContent),
    '',
  ];
}

function buildOmittedDiff(change, reason) {
  return [
    `diff --git a/${change.path} b/${change.path}`,
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    `@@ ${reason}`,
    '',
  ];
}

function buildIterationDiffPatch(changes) {
  if (changes.length === 0) {
    return 'No worker file changes detected for this iteration.\n';
  }

  const lines = [];
  for (const change of changes) {
    const states = [change.before, change.after].filter(Boolean);
    if (states.some((state) => state.kind === 'binary')) {
      lines.push(...buildOmittedDiff(change, '[binary file omitted]'));
    } else if (states.some((state) => state.kind === 'oversized')) {
      lines.push(...buildOmittedDiff(
        change,
        `[diff omitted: file exceeds ${HARNESS_ITERATION_DIFF_MAX_BYTES} bytes]`,
      ));
    } else {
      lines.push(...buildTextDiff(change));
    }
  }

  return lines.join('\n');
}

function buildLeanRunDiffPatch(repoRoot, runId, result) {
  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  const iterationRecords = Array.isArray(result && result.iterations) ? result.iterations : [];
  if (iterationRecords.length === 0) {
    return 'No worker iterations ran for this run.\n';
  }

  const sections = [];
  for (const record of iterationRecords) {
    if (!record || !Number.isInteger(record.iteration)) {
      continue;
    }

    const iterationPaths = resolveLeanIterationPaths(runPaths, record.iteration);
    const agent = hasMeaningfulString(record.RALPH_AGENT) ? record.RALPH_AGENT : 'unknown';
    const diffPatch = pathExists(iterationPaths.diffPatchPath)
      ? readText(iterationPaths.diffPatchPath).trimEnd()
      : 'No iteration diff artifact was recorded.';
    sections.push([
      `# Iteration ${record.iteration}: RALPH_AGENT ${agent}`,
      '',
      diffPatch || 'No worker file changes detected for this iteration.',
      '',
    ].join('\n'));
  }

  if (sections.length === 0) {
    return 'No iteration diff artifacts were recorded for this run.\n';
  }

  return sections.join('\n');
}

function parseWorkerFooter(output) {
  const footer = {};
  const fields = [
    ['status', 'RALPH_STATUS', /^RALPH_STATUS:\s*(.*)$/m],
    ['summary', 'RALPH_SUMMARY', /^RALPH_SUMMARY:\s*(.*)$/m],
    ['validation', 'RALPH_VALIDATION', /^RALPH_VALIDATION:\s*(.*)$/m],
    ['next', 'RALPH_NEXT', /^RALPH_NEXT:\s*(.*)$/m],
  ];

  for (const [key, label, pattern] of fields) {
    const match = output.match(pattern);
    const value = match ? match[1].trim() : '';
    if (!value) {
      return {
        footer,
        error: `Missing required footer field ${label}.`,
      };
    }
    footer[key] = value;
  }

  if (!['pass', 'blocked', 'fail'].includes(footer.status)) {
    return {
      footer,
      error: `Invalid RALPH_STATUS "${footer.status}"; expected pass, blocked, or fail.`,
    };
  }

  return {
    footer,
    error: null,
  };
}

function writeLeanIterationArtifacts(iterationPaths, summary, diffPatch) {
  fs.mkdirSync(iterationPaths.evidenceDir, { recursive: true });
  writeText(iterationPaths.stdoutLogPath, summary.stdout);
  writeText(iterationPaths.stderrLogPath, summary.stderr);
  writeText(iterationPaths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeText(iterationPaths.diffPatchPath, diffPatch);
}

function writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, verifyResult, options = {}) {
  if (!iterationPaths) {
    return;
  }

  const agent = normalizeQaAgentRoleForArtifact(
    hasMeaningfulString(options.RALPH_AGENT)
      ? options.RALPH_AGENT
      : verifyResult && verifyResult.RALPH_AGENT,
  );
  const runId = hasMeaningfulString(verifyResult && verifyResult.runId)
    ? verifyResult.runId
    : hasMeaningfulString(options.runId)
      ? normalizeHarnessRunId(options.runId)
      : '';
  const baseRecord = verifyResult && hasMeaningfulString(verifyResult.status)
    ? buildLeanValidationRecord(repoRoot, {
      ...verifyResult,
      runId,
      RALPH_AGENT: agent,
    })
    : {
      status: 'skipped',
      runId,
      exitCode: null,
      exportedStepCount: null,
      listedTestCount: null,
      generatedSpecs: [],
      commands: [],
      reason: options.reason || 'Supervisor verification was not run for this iteration.',
    };
  const validationRecord = {
    ...baseRecord,
    iteration,
  };
  if (agent) {
    validationRecord.RALPH_AGENT = agent;
  }
  writeText(iterationPaths.validationPath, `${JSON.stringify(validationRecord, null, 2)}\n`);
}

function readRequiredLeanArtifact(filePath, displayPath) {
  if (!pathExists(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Required harness artifact is missing: ${displayPath}.`);
  }

  return readText(filePath);
}

function readLeanArtifactForWorkerPrompt(filePath, displayPath) {
  if (!pathExists(filePath) || !fs.statSync(filePath).isFile()) {
    return `Missing harness artifact: ${displayPath}.`;
  }

  return readText(filePath);
}

function replaceRunLocalSeedPlaceholders(content, seedSpecDisplayPath) {
  return content.replaceAll(
    `${HARNESS_DIR_NAME}/${HARNESS_RUNS_DIR}/<run-id>/${HARNESS_RUN_SEED_SPEC_FILE}`,
    seedSpecDisplayPath,
  );
}

function buildRunLocalCoverageArtifactPromptSection(options) {
  if (options.role !== 'qa-executor') {
    return [];
  }

  const repoRoot = options.repoRoot || process.cwd();
  const runId = hasMeaningfulString(options.runId) ? options.runId : '<run-id>';
  const seedSpecDisplayPath = hasMeaningfulString(options.seedSpecPath)
    ? resolveDisplayPath(repoRoot, options.seedSpecPath)
    : `${HARNESS_DIR_NAME}/${HARNESS_RUNS_DIR}/${runId}/${HARNESS_RUN_SEED_SPEC_FILE}`;
  const playwrightConfigDisplayPath = hasMeaningfulString(options.playwrightConfigPath)
    ? resolveDisplayPath(repoRoot, options.playwrightConfigPath)
    : `${HARNESS_DIR_NAME}/${HARNESS_RUNS_DIR}/${runId}/${HARNESS_RUN_PLAYWRIGHT_CONFIG_FILE}`;

  return [
    '## Run-Local Coverage Artifacts',
    '',
    `- Seed spec: \`${seedSpecDisplayPath}\``,
    `- Optional Playwright config: \`${playwrightConfigDisplayPath}\``,
    '- The seed spec is the first executable coverage proof for this run.',
    '- The seed spec imports Playwright test APIs from the target project dependencies.',
    '- The seed spec contains working navigation, interactions, waits, assertions, and locators for the selected coverage flow.',
    '- The seed is evidence, not final BDD output.',
    '',
  ];
}

function buildLeanWorkerPrompt(options) {
  const selectedItemBlock = options.selectedItem.block.trimEnd();
  const role = assertValidQaAgentRole(options.role || 'qa-planner');
  const templatePaths = resolveQaAgentTemplatePaths(role);
  const runLocalCoverageArtifactSection = buildRunLocalCoverageArtifactPromptSection({
    ...options,
    role,
  });
  const seedSpecDisplayPath = hasMeaningfulString(options.seedSpecPath)
    ? resolveDisplayPath(options.repoRoot || process.cwd(), options.seedSpecPath)
    : `${HARNESS_DIR_NAME}/${HARNESS_RUNS_DIR}/${hasMeaningfulString(options.runId) ? options.runId : '<run-id>'}/${HARNESS_RUN_SEED_SPEC_FILE}`;
  const roleAgentContent = replaceRunLocalSeedPlaceholders(readRequiredLeanArtifact(
    templatePaths.agentPath,
    formatQaAgentTemplateDisplayPath(templatePaths.agentPath),
  ).trimEnd(), seedSpecDisplayPath);
  const roleSkillsContent = replaceRunLocalSeedPlaceholders(readRequiredLeanArtifact(
    templatePaths.skillsPath,
    formatQaAgentTemplateDisplayPath(templatePaths.skillsPath),
  ).trimEnd(), seedSpecDisplayPath);

  return [
    '# Copilot Worker Prompt',
    '',
    `RALPH_AGENT: ${role}`,
    '',
    '## Orchestrator Route',
    '',
    `- Role: \`${role}\``,
    `- Mode: \`${sanitizeInlineCode(options.mode || normalizeQaRouteMode(options.selectedItem, role))}\``,
    `- Reason: ${sanitizeOptionalInlineCode(options.routeReason) || 'selected by orchestrator'}`,
    '',
    `## Role Agent Template: \`${formatQaAgentTemplateDisplayPath(templatePaths.agentPath)}\``,
    '',
    '```markdown',
    roleAgentContent,
    '```',
    '',
    `## Role Skills Template: \`${formatQaAgentTemplateDisplayPath(templatePaths.skillsPath)}\``,
    '',
    '```markdown',
    roleSkillsContent,
    '```',
    '',
    ...runLocalCoverageArtifactSection,
    '## Durable PRD: `.qa-harness/PRD.md`',
    '',
    '```markdown',
    options.prdContent.trimEnd(),
    '```',
    '',
    '## Durable Progress: `.qa-harness/progress.md`',
    '',
    '```markdown',
    options.progressContent.trimEnd(),
    '```',
    '',
    '## Durable Worker Rules: `.qa-harness/PROMPT.md`',
    '',
    '```markdown',
    options.promptContent.trimEnd(),
    '```',
    '',
    '## Selected Progress Item',
    '',
    '```markdown',
    selectedItemBlock,
    '```',
    '',
    '## Required Footer',
    '',
    'RALPH_STATUS: pass|blocked|fail',
    'RALPH_SUMMARY: <one concise paragraph>',
    'RALPH_VALIDATION: <commands run, or why not run>',
    'RALPH_NEXT: <next recommended action, or none>',
    '',
  ].join('\n');
}

function writeLeanWorkerPrompt(runPaths, iteration, route) {
  const prdContent = readLeanArtifactForWorkerPrompt(runPaths.prdPath, `${HARNESS_DIR_NAME}/${HARNESS_PRD_FILE}`);
  const progressContent = readLeanArtifactForWorkerPrompt(
    runPaths.progressPath,
    `${HARNESS_DIR_NAME}/${HARNESS_PROGRESS_FILE}`,
  );
  const promptContent = readLeanArtifactForWorkerPrompt(runPaths.promptPath, `${HARNESS_DIR_NAME}/${HARNESS_PROMPT_FILE}`);
  const selectedRoute = route || selectQaOrchestratorRoute(runPaths);
  const selectedItem = selectedRoute.item;

  if (!selectedItem) {
    throw new Error(`No unchecked actionable item found in ${HARNESS_DIR_NAME}/${HARNESS_PROGRESS_FILE}.`);
  }

  const iterationPaths = resolveLeanIterationPaths(runPaths, iteration);
  fs.mkdirSync(iterationPaths.iterationDir, { recursive: true });
  let selectedRole;
  try {
    selectedRole = assertValidQaAgentRole(selectedRoute.role);
  } catch (error) {
    if (isQaAgentRoleSelectionError(error)) {
      error.iterationPaths = iterationPaths;
      error.selectedItem = selectedItem;
    }
    throw error;
  }
  const workerPrompt = buildLeanWorkerPrompt({
    role: selectedRole,
    mode: selectedRoute.mode,
    routeReason: selectedRoute.reason,
    repoRoot: runPaths.repoRoot,
    runId: runPaths.runId,
    seedSpecPath: runPaths.seedSpecPath,
    playwrightConfigPath: runPaths.playwrightConfigPath,
    prdContent,
    progressContent,
    promptContent,
    selectedItem,
  });
  writeText(iterationPaths.workerPromptPath, workerPrompt);
  const resolvedPromptPath = writeLeanResolvedPromptAuditCopy(runPaths, iterationPaths, selectedRole, workerPrompt);

  return {
    ...iterationPaths,
    resolvedPromptPath,
    selectedItem,
    RALPH_AGENT: selectedRole,
    mode: selectedRoute.mode,
    workerPrompt,
  };
}

function hasLeanActionableProgressItem(runPaths) {
  const progressContent = readRequiredLeanArtifact(runPaths.progressPath, `${HARNESS_DIR_NAME}/${HARNESS_PROGRESS_FILE}`);
  return Boolean(findNextActionableProgressItem(progressContent));
}

function updateLeanSelectedProgressItem(runPaths, selectedItem, status, resultText) {
  if (!selectedItem || !selectedItem.id) {
    return;
  }

  upsertProgressItemResult(runPaths.progressPath, {
    itemId: selectedItem.id,
    status,
    resultText,
  });
}

function isLeanSelectedProgressItemCompleted(runPaths, selectedItem) {
  if (!selectedItem || !selectedItem.id) {
    return false;
  }

  const progressContent = readText(runPaths.progressPath);
  const item = findProgressItem(progressContent, (candidate) => candidate.id === selectedItem.id);
  return Boolean(item && item.checkboxChecked && item.status === 'pass');
}

function isLeanVerifierHandoffRoute(selectedAgent, selectedItem, route) {
  return selectedAgent === 'qa-executor'
    && selectedItem
    && hasMeaningfulString(selectedItem.id)
    && route
    && route.status === 'run'
    && route.role === 'qa-verifier'
    && route.item
    && route.item.id === selectedItem.id;
}

function isLeanVerifierHealingRoute(selectedAgent, selectedItem, route) {
  return selectedAgent === 'qa-verifier'
    && selectedItem
    && hasMeaningfulString(selectedItem.id)
    && route
    && route.status === 'run'
    && route.role === 'qa-executor'
    && route.mode === 'healing'
    && route.item
    && route.item.id === selectedItem.id;
}

function finishLeanRun(harnessPaths, startedState, status, iterationCount, runId, iterations, options = {}) {
  const stopReason = options.stopReason || status;
  const result = buildLeanRunResultRecord(runId, status, stopReason, iterationCount, iterations);
  writeHarnessState(harnessPaths, {
    ...startedState,
    activeRunId: null,
    terminalStatus: status,
  });
  writeLeanRunTerminalArtifacts(harnessPaths.repoRoot, runId, result);

  return {
    status,
    exitCode: result.exitCode,
    runId,
    iterationCount,
    iterations,
    stopReason,
    output: buildLeanRunResultOutput(runId, iterationCount, status, stopReason),
  };
}

function runLeanSupervisorVerify(verifyFn, options) {
  try {
    return verifyFn(options);
  } catch (error) {
    return {
      status: 'fail',
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function run(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const harnessPaths = options.harnessPaths || resolveHarnessPaths(repoRoot);
  const maxIterations = Object.prototype.hasOwnProperty.call(options, 'maxIterations')
    ? parsePositiveIntegerOption(options.maxIterations, 'maxIterations')
    : readConfiguredProductLoopDefaultMaxIterations(repoRoot) || DEFAULT_PRODUCT_MAX_ITERATIONS;
  const state = readHarnessState(harnessPaths);

  if (!state) {
    return {
      status: 'fail',
      exitCode: 1,
      output: [
        `No prepared QA harness state found at ${HARNESS_DIR_NAME}/${HARNESS_STATE_FILE}.`,
        `Next: ${getHarnessCommandPrefix()} prepare --from <feature-path>`,
        '',
      ].join('\n'),
    };
  }

  const runId = createRunId(options.now || new Date(), 'run', state.sourceFeaturePath || 'harness');
  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  const copilotCommand =
    readConfiguredCopilotCommand(repoRoot)
    || resolveDefaultCopilotCommand(options.platform || process.platform);
  const commandRunner = options.commandRunner || runCommand;
  const env = options.env || process.env;
  const verifyFn = options.verifyFn || verify;
  const startedState = {
    ...state,
    latestRunId: runId,
    activeRunId: runId,
    terminalStatus: null,
  };
  const iterations = [];

  fs.mkdirSync(runPaths.iterationsDir, { recursive: true });
  writeHarnessState(harnessPaths, startedState);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    let route;
    try {
      route = selectQaOrchestratorRoute(runPaths);
    } catch (error) {
      if (!isQaAgentRoleSelectionError(error)) {
        throw error;
      }

      route = null;
    }

    if (route && route.stopReason) {
      return finishLeanRun(
        harnessPaths,
        startedState,
        route.status,
        iterations.length,
        runId,
        iterations,
        { stopReason: route.stopReason },
      );
    }

    let commandResult;
    let iterationPrompt;
    let iterationPaths;
    let beforeSnapshot;
    let roleSelectionError = null;
    let selectedAgent = 'qa-orchestrator';
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    try {
      iterationPrompt = writeLeanWorkerPrompt(runPaths, iteration, route);
      iterationPaths = iterationPrompt;
      selectedAgent = iterationPrompt.RALPH_AGENT;
      beforeSnapshot = captureIterationSnapshot(repoRoot);
      commandResult = normalizeWorkerCommandResult(commandRunner(copilotCommand, [], repoRoot, {
        env,
        input: iterationPrompt.workerPrompt,
      }));
    } catch (error) {
      if (isQaAgentRoleSelectionError(error)) {
        roleSelectionError = error;
        iterationPaths = error.iterationPaths || resolveLeanIterationPaths(runPaths, iteration);
        fs.mkdirSync(iterationPaths.iterationDir, { recursive: true });
        iterationPrompt = {
          selectedItem: error.selectedItem,
          RALPH_AGENT: selectedAgent,
        };
      }
      commandResult = {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const afterSnapshot = beforeSnapshot ? captureIterationSnapshot(repoRoot) : new Map();
    const changes = beforeSnapshot ? compareIterationSnapshots(beforeSnapshot, afterSnapshot) : [];
    const changedFiles = formatChangedFiles(changes);
    const coverageEvidence = selectedAgent === 'qa-executor'
      ? recordCoveragePlaywrightCliSeedEvidence(repoRoot, runPaths, iterationPaths, iteration, {
        commandRunner,
        env,
      })
      : null;
    const currentProgressItem = readCurrentProgressItem(
      runPaths,
      iterationPrompt && iterationPrompt.selectedItem,
    );
    const coverageEvidenceFailure = selectedAgent === 'qa-executor'
      ? assessCoverageMcpFallbackUse(
        runPaths,
        coverageEvidence,
        currentProgressItem,
        `${commandResult.stdout}\n${commandResult.stderr}`,
        iterationPrompt && iterationPrompt.selectedItem,
      )
        || assessCoveragePromotionUse(
          runPaths,
          coverageEvidence,
          currentProgressItem,
          `${commandResult.stdout}\n${commandResult.stderr}`,
          iterationPrompt && iterationPrompt.selectedItem,
          changes,
        )
      : null;
    const coverageEvidenceError = coverageEvidenceFailure ? coverageEvidenceFailure.reason : null;
    const parsedFooter = roleSelectionError
      ? { footer: {}, error: null }
      : parseWorkerFooter(`${commandResult.stdout}\n${commandResult.stderr}`);
    const footer = parsedFooter.footer;
    const footerError = parsedFooter.error;
    const durationMs = Math.max(0, finishedAtMs - startedAtMs);
    const iterationSummary = {
      iteration,
      RALPH_AGENT: selectedAgent,
      command: copilotCommand,
      args: [],
      exitCode: commandResult.exitCode,
      durationMs,
      startedAt,
      finishedAt,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      changedFiles,
      coverageEvidence: coverageEvidence
        ? {
          path: coverageEvidence.path,
          commandDisplay: coverageEvidence.record.commandDisplay,
          exitCode: coverageEvidence.record.exitCode,
          durationMs: coverageEvidence.record.durationMs,
        }
        : null,
      coverageEvidenceError,
      footer,
      footerError,
      roleError: roleSelectionError ? roleSelectionError.message : null,
    };

    if (iterationPaths) {
      writeLeanIterationArtifacts(
        iterationPaths,
        iterationSummary,
        buildIterationDiffPatch(changes),
      );
    }

    iterations.push({
      iteration,
      command: copilotCommand,
      RALPH_AGENT: selectedAgent,
      exitCode: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      durationMs,
      changedFiles,
      coverageEvidence: coverageEvidence
        ? {
          path: coverageEvidence.path,
          commandDisplay: coverageEvidence.record.commandDisplay,
          exitCode: coverageEvidence.record.exitCode,
          durationMs: coverageEvidence.record.durationMs,
        }
        : null,
      coverageEvidenceError,
      footer,
      footerError,
      roleError: roleSelectionError ? roleSelectionError.message : null,
    });

    if (roleSelectionError) {
      writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, null, {
        runId,
        RALPH_AGENT: selectedAgent,
        reason: roleSelectionError.message,
      });
      return finishLeanRun(
        harnessPaths,
        startedState,
        'failed',
        iteration,
        runId,
        iterations,
        { stopReason: 'invalid-agent-role' },
      );
    }

    if (footerError) {
      writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, null, {
        runId,
        RALPH_AGENT: selectedAgent,
        reason: footerError,
      });
      return finishLeanRun(
        harnessPaths,
        startedState,
        'failed',
        iteration,
        runId,
        iterations,
        { stopReason: classifyLeanFooterStopReason(footerError) },
      );
    }

    if (commandResult.exitCode !== 0) {
      writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, null, {
        runId,
        RALPH_AGENT: selectedAgent,
        reason: `Worker exited nonzero before supervisor verification: ${commandResult.exitCode}.`,
      });
      return finishLeanRun(
        harnessPaths,
        startedState,
        'failed',
        iteration,
        runId,
        iterations,
        { stopReason: 'worker-exit-nonzero' },
      );
    }

    if (coverageEvidenceError) {
      writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, null, {
        runId,
        RALPH_AGENT: selectedAgent,
        reason: coverageEvidenceError,
      });
      updateLeanSelectedProgressItem(
        runPaths,
        iterationPrompt && iterationPrompt.selectedItem,
        'fail',
        `fail: ${coverageEvidenceError}`,
      );
      return finishLeanRun(
        harnessPaths,
        startedState,
        'failed',
        iteration,
        runId,
        iterations,
        { stopReason: coverageEvidenceFailure.stopReason },
      );
    }

    if (footer.status === 'fail') {
      writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, null, {
        runId,
        RALPH_AGENT: selectedAgent,
        reason: 'Worker reported RALPH_STATUS: fail, so supervisor verification was not run.',
      });
      updateLeanSelectedProgressItem(
        runPaths,
        iterationPrompt && iterationPrompt.selectedItem,
        'fail',
        `fail: ${footer.summary}`,
      );
      const postFailRoute = selectQaOrchestratorRoute(runPaths);
      if (isLeanVerifierHealingRoute(
        selectedAgent,
        iterationPrompt && iterationPrompt.selectedItem,
        postFailRoute,
      )) {
        continue;
      }

      if (selectedAgent === 'qa-verifier' && postFailRoute.stopReason) {
        return finishLeanRun(
          harnessPaths,
          startedState,
          postFailRoute.status,
          iteration,
          runId,
          iterations,
          { stopReason: postFailRoute.stopReason },
        );
      }

      return finishLeanRun(
        harnessPaths,
        startedState,
        'failed',
        iteration,
        runId,
        iterations,
        { stopReason: 'worker-failed' },
      );
    }

    if (footer.status === 'blocked') {
      writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, null, {
        runId,
        RALPH_AGENT: selectedAgent,
        reason: 'Worker reported RALPH_STATUS: blocked, so supervisor verification was not run.',
      });
      updateLeanSelectedProgressItem(
        runPaths,
        iterationPrompt && iterationPrompt.selectedItem,
        'blocked',
        `blocked: ${footer.summary}`,
      );
      return finishLeanRun(
        harnessPaths,
        startedState,
        'blocked',
        iteration,
        runId,
        iterations,
        { stopReason: 'blocked' },
      );
    }

    const verifyResult = runLeanSupervisorVerify(verifyFn, {
      repoRoot,
      harnessPaths,
      runId,
      commandRunner,
      env,
    });
    writeLeanIterationValidationArtifact(repoRoot, iterationPaths, iteration, verifyResult, {
      runId,
      RALPH_AGENT: selectedAgent,
    });

    if (!verifyResult || verifyResult.status !== 'pass') {
      updateLeanSelectedProgressItem(
        runPaths,
        iterationPrompt && iterationPrompt.selectedItem,
        'fail',
        `fail: ${footer.summary}; supervisor verify failed`,
      );
      const postValidationFailRoute = selectQaOrchestratorRoute(runPaths);
      if (isLeanVerifierHealingRoute(
        selectedAgent,
        iterationPrompt && iterationPrompt.selectedItem,
        postValidationFailRoute,
      )) {
        continue;
      }

      if (selectedAgent === 'qa-verifier' && postValidationFailRoute.stopReason) {
        return finishLeanRun(
          harnessPaths,
          startedState,
          postValidationFailRoute.status,
          iteration,
          runId,
          iterations,
          { stopReason: postValidationFailRoute.stopReason },
        );
      }

      return finishLeanRun(
        harnessPaths,
        startedState,
        'failed',
        iteration,
        runId,
        iterations,
        { stopReason: 'validation-failed' },
      );
    }

    const postVerifyRoute = selectQaOrchestratorRoute(runPaths);
    if (isLeanVerifierHandoffRoute(
      selectedAgent,
      iterationPrompt && iterationPrompt.selectedItem,
      postVerifyRoute,
    )) {
      continue;
    }

    if (selectedAgent === 'qa-executor') {
      updateLeanSelectedProgressItem(
        runPaths,
        iterationPrompt && iterationPrompt.selectedItem,
        'needs-verification',
        `needs-verification: ${footer.summary}; supervisor verify passed`,
      );
      const postExecutorPassRoute = selectQaOrchestratorRoute(runPaths);
      if (isLeanVerifierHandoffRoute(
        selectedAgent,
        iterationPrompt && iterationPrompt.selectedItem,
        postExecutorPassRoute,
      )) {
        continue;
      }

      if (postExecutorPassRoute.stopReason) {
        return finishLeanRun(
          harnessPaths,
          startedState,
          postExecutorPassRoute.status,
          iteration,
          runId,
          iterations,
          { stopReason: postExecutorPassRoute.stopReason },
        );
      }
    }

    updateLeanSelectedProgressItem(
      runPaths,
      iterationPrompt && iterationPrompt.selectedItem,
      'pass',
      `pass: ${footer.summary}; supervisor verify passed`,
    );
    const postPassRoute = selectQaOrchestratorRoute(runPaths);
    if (postPassRoute.stopReason) {
      return finishLeanRun(
        harnessPaths,
        startedState,
        postPassRoute.status,
        iteration,
        runId,
        iterations,
        { stopReason: postPassRoute.stopReason },
      );
    }

    if (!isLeanSelectedProgressItemCompleted(runPaths, iterationPrompt && iterationPrompt.selectedItem)) {
      return finishLeanRun(
        harnessPaths,
        startedState,
        'stalled',
        iteration,
        runId,
        iterations,
        { stopReason: 'selected-item-not-completed' },
      );
    }
  }

  return finishLeanRun(
    harnessPaths,
    startedState,
    'budget-exhausted',
    maxIterations,
    runId,
    iterations,
    { stopReason: 'budget-exhausted' },
  );
}

function normalizeCommandExitCode(result) {
  return Number.isInteger(result && result.status) ? result.status : 1;
}

function runCapturedValidationCommand(command, args, repoRoot, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    const result = commandRunner(command, args, repoRoot, { env: options.env || process.env });
    const finishedAtMs = Date.now();
    return {
      commandDisplay: result && result.commandDisplay
        ? result.commandDisplay
        : formatCommandDisplay(command, args),
      exitCode: normalizeCommandExitCode(result),
      stdout: result && typeof result.stdout === 'string' ? result.stdout : '',
      stderr: result && typeof result.stderr === 'string' ? result.stderr : '',
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    };
  } catch (error) {
    const finishedAtMs = Date.now();
    return {
      commandDisplay: formatCommandDisplay(command, args),
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    };
  }
}

function runCapturedEvidenceCommand(command, args, repoRoot, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    const result = commandRunner(command, args, repoRoot, { env: options.env || process.env });
    const finishedAtMs = Date.now();
    return {
      command,
      args: Array.isArray(args) ? [...args] : [],
      commandDisplay: result && result.commandDisplay
        ? result.commandDisplay
        : formatCommandDisplay(command, args),
      exitCode: normalizeCommandExitCode(result),
      stdout: result && typeof result.stdout === 'string' ? result.stdout : '',
      stderr: result && typeof result.stderr === 'string' ? result.stderr : '',
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    };
  } catch (error) {
    const finishedAtMs = Date.now();
    return {
      command,
      args: Array.isArray(args) ? [...args] : [],
      commandDisplay: formatCommandDisplay(command, args),
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    };
  }
}

function recordCoveragePlaywrightCliSeedEvidence(repoRoot, runPaths, iterationPaths, iteration, options = {}) {
  if (
    !runPaths
    || !iterationPaths
    || !hasMeaningfulString(runPaths.seedSpecPath)
    || !pathExists(runPaths.seedSpecPath)
  ) {
    return null;
  }

  const seedSpecDisplayPath = normalizeDisplayPath(path.relative(repoRoot, runPaths.seedSpecPath));
  const command = getNpxCommand();
  const args = ['playwright', 'test', seedSpecDisplayPath];
  const commandResult = runCapturedEvidenceCommand(command, args, repoRoot, {
    commandRunner: options.commandRunner,
    env: options.env,
  });
  const record = {
    type: 'playwright-cli-seed',
    RALPH_AGENT: 'qa-executor',
    runId: runPaths.runId,
    iteration,
    seedSpecPath: seedSpecDisplayPath,
    ...commandResult,
  };

  fs.mkdirSync(iterationPaths.evidenceDir, { recursive: true });
  writeText(iterationPaths.coveragePlaywrightCliEvidencePath, `${JSON.stringify(record, null, 2)}\n`);
  return {
    path: normalizeDisplayPath(path.relative(repoRoot, iterationPaths.coveragePlaywrightCliEvidencePath)),
    record,
  };
}

function hasRecordedCoveragePlaywrightCliEvidence(runPaths, currentEvidence) {
  if (currentEvidence) {
    return true;
  }

  if (!runPaths || !pathExists(runPaths.iterationsDir)) {
    return false;
  }

  for (const entry of fs.readdirSync(runPaths.iterationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const evidencePath = path.join(
      runPaths.iterationsDir,
      entry.name,
      HARNESS_ITERATION_EVIDENCE_DIR,
      HARNESS_COVERAGE_PLAYWRIGHT_CLI_EVIDENCE_FILE,
    );
    if (pathExists(evidencePath)) {
      return true;
    }
  }

  return false;
}

function readCoveragePlaywrightCliEvidenceRecords(runPaths, currentEvidence) {
  const records = [];

  if (currentEvidence && currentEvidence.record) {
    records.push(currentEvidence.record);
  }

  if (!runPaths || !pathExists(runPaths.iterationsDir)) {
    return records;
  }

  for (const entry of fs.readdirSync(runPaths.iterationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const evidencePath = path.join(
      runPaths.iterationsDir,
      entry.name,
      HARNESS_ITERATION_EVIDENCE_DIR,
      HARNESS_COVERAGE_PLAYWRIGHT_CLI_EVIDENCE_FILE,
    );
    if (!pathExists(evidencePath)) {
      continue;
    }

    try {
      records.push(JSON.parse(readText(evidencePath)));
    } catch (_error) {
      records.push({
        type: 'playwright-cli-seed',
        exitCode: 1,
        parseError: `Unable to parse ${HARNESS_COVERAGE_PLAYWRIGHT_CLI_EVIDENCE_FILE}.`,
      });
    }
  }

  return records;
}

function hasFailedCoveragePlaywrightCliEvidence(records) {
  return records.some((record) => Number(record && record.exitCode) !== 0);
}

function readCoverageVerificationProgressItems(harnessPaths) {
  if (!harnessPaths || !pathExists(harnessPaths.progressPath)) {
    return [];
  }

  return parseProgressItems(readText(harnessPaths.progressPath));
}

function progressItemLooksCoverageScoped(item) {
  const values = [
    item && item.goal,
    item && item.input,
    item && item.output,
    item && item.verify,
    item && item.result,
    item && item.evidence,
    item && item.fallbackReason,
  ];

  return values.some((value) =>
    /\b(?:coverage|seed proof|seed evidence|MCP fallback|full Playwright execution)\b/i.test(value || ''));
}

function isCoverageVerificationRequired(repoRoot, harnessPaths, runId) {
  if (!hasMeaningfulString(runId)) {
    return false;
  }

  const state = readHarnessState(harnessPaths);
  if (state && state.intake && state.intake.kind === 'coverage-request') {
    return true;
  }

  if (harnessPaths && pathExists(harnessPaths.prdPath)) {
    const prdContent = readText(harnessPaths.prdPath);
    if (/##\s+Accepted Coverage Request\b/i.test(prdContent) || parseRunIntent(prdContent) === 'coverage') {
      return true;
    }
  }

  return readCoverageVerificationProgressItems(harnessPaths).some(progressItemLooksCoverageScoped);
}

function isValidCoveragePlaywrightCliSeedEvidenceRecord(record, runId, seedSpecDisplayPath) {
  if (!record || typeof record !== 'object') {
    return false;
  }

  if (record.type !== 'playwright-cli-seed') {
    return false;
  }

  if (record.RALPH_AGENT !== 'qa-executor') {
    return false;
  }

  if (record.runId !== runId || record.seedSpecPath !== seedSpecDisplayPath) {
    return false;
  }

  const commandName = hasMeaningfulString(record.command) ? path.basename(record.command).toLowerCase() : '';
  if (commandName && commandName !== 'npx' && commandName !== 'npx.cmd') {
    return false;
  }

  if (!Array.isArray(record.args) || record.args.length !== 3) {
    return false;
  }

  const [tool, subcommand, seedPath] = record.args;
  return tool === 'playwright' && subcommand === 'test' && seedPath === seedSpecDisplayPath;
}

function buildCoverageProofStatus(overrides = {}) {
  return {
    required: true,
    seedProofStatus: overrides.seedProofStatus || 'unknown',
    mcpFallbackStatus: overrides.mcpFallbackStatus || 'not-used',
    fullExecutionStatus: overrides.fullExecutionStatus || 'pending',
    ...overrides,
  };
}

function assessCoverageVerifierPrerequisites(repoRoot, harnessPaths, runId) {
  if (!isCoverageVerificationRequired(repoRoot, harnessPaths, runId)) {
    return { required: false };
  }

  const runPaths = resolveHarnessPaths(repoRoot, { runId });
  const seedSpecDisplayPath = `.qa-harness/runs/${runId}/seed.spec.ts`;
  const records = readCoveragePlaywrightCliEvidenceRecords(runPaths, null);
  const proof = buildCoverageProofStatus({
    seedSpecPath: seedSpecDisplayPath,
    seedEvidenceCount: records.length,
  });

  if (!pathExists(runPaths.seedSpecPath) || records.length === 0) {
    proof.seedProofStatus = 'missing';
    return {
      proof,
      error: `Playwright CLI seed proof is required for coverage verification for run ${runId}.`,
    };
  }

  const validSeedRecord = records.find((record) =>
    isValidCoveragePlaywrightCliSeedEvidenceRecord(record, runId, seedSpecDisplayPath));
  if (!validSeedRecord) {
    proof.seedProofStatus = 'invalid-cli';
    return {
      proof,
      error: `Coverage seed proof must be executed by Playwright CLI for run ${runId}.`,
    };
  }

  proof.seedProofStatus = Number(validSeedRecord.exitCode) === 0 ? 'pass' : 'failed';
  proof.seedEvidenceExitCode = Number(validSeedRecord.exitCode);

  for (const progressItem of readCoverageVerificationProgressItems(harnessPaths)) {
    if (!hasMcpFallbackUse(progressItem, '')) {
      continue;
    }

    const fallbackFailure = assessCoverageMcpFallbackUse(runPaths, null, progressItem, '', progressItem);
    if (fallbackFailure) {
      proof.mcpFallbackStatus = 'fail';
      return {
        proof,
        error: fallbackFailure.reason,
      };
    }

    proof.mcpFallbackStatus = 'pass';
  }

  if (proof.seedProofStatus === 'failed' && proof.mcpFallbackStatus !== 'pass') {
    return {
      proof,
      error: `Playwright CLI seed proof failed before coverage verification for run ${runId}; record MCP fallback reason and evidence or rerun seed proof successfully.`,
    };
  }

  return { proof };
}

function readCurrentProgressItem(runPaths, selectedItem) {
  if (!runPaths || !selectedItem || !hasMeaningfulString(selectedItem.id) || !pathExists(runPaths.progressPath)) {
    return selectedItem || null;
  }

  const progressContent = readText(runPaths.progressPath);
  return findProgressItem(progressContent, (candidate) => candidate.id === selectedItem.id) || selectedItem;
}

function hasMcpFallbackUse(progressItem, workerOutput) {
  const values = [
    progressItem && progressItem.fallbackReason,
    progressItem && progressItem.evidence,
    workerOutput,
  ];

  return values.some((value) => /\bMCP\b/i.test(value || ''));
}

function hasMcpFallbackEvidence(progressItem) {
  const evidence = progressItem && progressItem.evidence;
  if (!hasMeaningfulString(evidence)) {
    return false;
  }

  return /\b(?:MCP|accessibility snapshot|observed element|observed name|element name|interaction notes?|interaction log|snapshot)\b/i
    .test(evidence);
}

function assessCoverageMcpFallbackUse(runPaths, currentEvidence, progressItem, workerOutput, selectedItem) {
  if (!hasMcpFallbackUse(progressItem, workerOutput)) {
    return null;
  }

  const itemId = selectedItem && selectedItem.id ? selectedItem.id : 'unknown';
  const evidenceRecords = readCoveragePlaywrightCliEvidenceRecords(runPaths, currentEvidence);
  if (evidenceRecords.length === 0) {
    return {
      stopReason: 'coverage-cli-evidence-required',
      reason: `Playwright CLI seed evidence is required before MCP fallback for progress item ${itemId}.`,
    };
  }

  if (!hasFailedCoveragePlaywrightCliEvidence(evidenceRecords)) {
    return {
      stopReason: 'coverage-mcp-fallback-requires-failed-cli',
      reason: `MCP fallback requires Playwright CLI seed evidence that could not proceed for progress item ${itemId}.`,
    };
  }

  if (!hasMeaningfulString(progressItem && progressItem.fallbackReason)) {
    return {
      stopReason: 'coverage-mcp-fallback-reason-required',
      reason: `MCP fallback requires a fallback reason for progress item ${itemId}.`,
    };
  }

  if (!hasMcpFallbackEvidence(progressItem)) {
    return {
      stopReason: 'coverage-mcp-fallback-evidence-required',
      reason: `MCP fallback requires MCP evidence for progress item ${itemId}.`,
    };
  }

  return null;
}

function isCoveragePromotionTargetPath(filePath) {
  return /^(?:Features\/.+\.feature|Features\/steps\/.+\.(?:js|jsx|ts|tsx))$/i.test(filePath || '');
}

function getCoveragePromotionTargetChanges(changes) {
  if (!Array.isArray(changes)) {
    return [];
  }

  return changes.filter((change) => isCoveragePromotionTargetPath(change && change.path));
}

function hasCoveragePromotionClaim(progressItem, workerOutput, targetChanges) {
  const values = [
    progressItem && progressItem.result,
    progressItem && progressItem.evidence,
    progressItem && progressItem.promotionExplanation,
    workerOutput,
  ];

  if (values.some((value) => /\bpromot(?:e|ed|es|ing|ion)\b/i.test(value || ''))) {
    return true;
  }

  return getCoveragePromotionTargetChanges(targetChanges).length > 0
    && values.some((value) => /\b(?:BDD|framework|steps?|feature file)\b/i.test(value || ''));
}

function extractQuotedPromotionValues(content) {
  const values = [];
  const pattern = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let match;

  while ((match = pattern.exec(content || '')) !== null) {
    const value = match[2].trim();
    if (
      value.length >= 3
      && !/^[@A-Za-z0-9_-]+(?:\/[@A-Za-z0-9_.-]+)+$/.test(value)
      && !/^(?:test|expect|Given|When|Then)$/i.test(value)
    ) {
      values.push(value.toLowerCase());
    }
  }

  return values;
}

function promotionEvidenceClaimsMaterialDifference(progressItem, workerOutput) {
  const values = [
    progressItem && progressItem.result,
    progressItem && progressItem.evidence,
    progressItem && progressItem.promotionExplanation,
    workerOutput,
  ];

  return values.some((value) => /\bmaterial(?:ly)? differ(?:s|ed|ent|ence)?\b|\bdiffer(?:s|ed)? from seed\b/i
    .test(value || ''));
}

function promotionTargetMateriallyDiffersFromSeed(runPaths, targetChanges, progressItem, workerOutput) {
  if (promotionEvidenceClaimsMaterialDifference(progressItem, workerOutput)) {
    return true;
  }

  if (!runPaths || !hasMeaningfulString(runPaths.seedSpecPath) || !pathExists(runPaths.seedSpecPath)) {
    return false;
  }

  const seedValues = extractQuotedPromotionValues(readText(runPaths.seedSpecPath));
  if (seedValues.length === 0) {
    return false;
  }

  return targetChanges.some((change) => {
    if (!change || !change.after || change.after.kind !== 'text') {
      return false;
    }

    const promotedValues = new Set(extractQuotedPromotionValues(change.after.content));
    return !seedValues.some((value) => promotedValues.has(value));
  });
}

function hasCoveragePromotionDifferenceExplanation(progressItem) {
  if (!progressItem) {
    return false;
  }

  const explicitExplanation = progressItem.promotionExplanation;
  if (hasMeaningfulString(explicitExplanation)) {
    return true;
  }

  const values = [
    progressItem.result,
    progressItem.evidence,
  ];

  return values.some((value) => /\b(?:promotion explanation|because|explained by|reason:)\b/i.test(value || ''));
}

function assessCoveragePromotionUse(runPaths, currentEvidence, progressItem, workerOutput, selectedItem, changes) {
  const targetChanges = getCoveragePromotionTargetChanges(changes);
  if (!hasCoveragePromotionClaim(progressItem, workerOutput, targetChanges)) {
    return null;
  }

  const itemId = selectedItem && selectedItem.id ? selectedItem.id : 'unknown';
  if (!hasRecordedCoveragePlaywrightCliEvidence(runPaths, currentEvidence)) {
    return {
      stopReason: 'coverage-promotion-seed-proof-required',
      reason: `Playwright CLI seed proof is required before promotion for progress item ${itemId}.`,
    };
  }

  if (
    targetChanges.length > 0
    && promotionTargetMateriallyDiffersFromSeed(runPaths, targetChanges, progressItem, workerOutput)
    && !hasCoveragePromotionDifferenceExplanation(progressItem)
  ) {
    return {
      stopReason: 'coverage-promotion-explanation-required',
      reason: `Promotion explanation is required when BDD or framework code materially differs from seed proof for progress item ${itemId}.`,
    };
  }

  return null;
}

function buildLeanVerifyOutput(status, summary, commandResults) {
  const results = Array.isArray(commandResults) ? commandResults : [commandResults];
  const lines = [
    `Verification ${status === 'pass' ? 'passed' : 'failed'}: ${summary}`,
  ];

  for (const commandResult of results) {
    lines.push(
      `Command: ${commandResult.commandDisplay}`,
      `Exit code: ${commandResult.exitCode}`,
      `Duration: ${commandResult.durationMs}ms`,
    );

    if (hasMeaningfulString(commandResult.stdout)) {
      lines.push(`Stdout: ${commandResult.stdout.trim()}`);
    }

    if (hasMeaningfulString(commandResult.stderr)) {
      lines.push(`Stderr: ${commandResult.stderr.trim()}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function resolveVerifyRunId(harnessPaths, options = {}) {
  if (hasMeaningfulString(options.runId)) {
    return normalizeHarnessRunId(options.runId);
  }

  const state = readHarnessState(harnessPaths);
  if (!state) {
    return '';
  }

  const runId = hasMeaningfulString(state.activeRunId) ? state.activeRunId : state.latestRunId;
  return hasMeaningfulString(runId) ? normalizeHarnessRunId(runId) : '';
}

function buildLeanValidationRecord(repoRoot, result) {
  const generatedSpecs = Array.isArray(result.generatedSpecs) ? result.generatedSpecs : [];
  const agent = normalizeQaAgentRoleForArtifact(result.RALPH_AGENT);
  const record = {
    status: result.status,
    runId: result.runId || '',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : result.status === 'pass' ? 0 : 1,
    exportedStepCount: Number.isInteger(result.exportedStepCount) ? result.exportedStepCount : null,
    listedTestCount: Number.isInteger(result.listedTestCount) ? result.listedTestCount : null,
    executedTestCount: Number.isInteger(result.executedTestCount) ? result.executedTestCount : null,
    generatedSpecs: generatedSpecs.map((generatedSpec) =>
      normalizeDisplayPath(path.relative(repoRoot, generatedSpec))),
    commands: Array.isArray(result.commands) ? result.commands : [],
  };

  if (agent) {
    record.RALPH_AGENT = agent;
  }

  if (result.coverageProof && result.coverageProof.required) {
    record.coverageProof = result.coverageProof;
  }

  if (hasMeaningfulString(result.coverageProofError)) {
    record.coverageProofError = result.coverageProofError;
  }

  return record;
}

function recordLeanValidationIfRunExists(repoRoot, result) {
  if (!hasMeaningfulString(result && result.runId)) {
    return result;
  }

  const runPaths = resolveHarnessPaths(repoRoot, { runId: result.runId });
  fs.mkdirSync(runPaths.runDir, { recursive: true });
  writeText(
    runPaths.validationPath,
    `${JSON.stringify(buildLeanValidationRecord(repoRoot, result), null, 2)}\n`,
  );
  return result;
}

function verify(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const harnessPaths = options.harnessPaths || resolveHarnessPaths(repoRoot);
  const runId = resolveVerifyRunId(harnessPaths, options);
  const coverageAssessment = assessCoverageVerifierPrerequisites(repoRoot, harnessPaths, runId);
  const coverageProof = coverageAssessment.proof || { required: false };
  const finish = (result) => {
    if (coverageProof.required && !result.coverageProof) {
      result.coverageProof = coverageProof;
    }
    return recordLeanValidationIfRunExists(repoRoot, result);
  };

  if (coverageAssessment.error) {
    return finish({
      status: 'fail',
      exitCode: 1,
      harnessPaths,
      commands: [],
      exportedStepCount: null,
      listedTestCount: null,
      executedTestCount: null,
      runId,
      generatedSpecs: [],
      coverageProof,
      coverageProofError: coverageAssessment.error,
      output: buildLeanVerifyOutput('fail', coverageAssessment.error, []),
    });
  }

  const exportCommand = runCapturedValidationCommand(getNpxCommand(), ['bddgen', 'export'], repoRoot, {
    commandRunner: options.commandRunner,
    env: options.env,
  });
  const commands = [exportCommand];
  const exportedStepCount = parseExportedStepCount(`${exportCommand.stdout}\n${exportCommand.stderr}`);

  if (exportCommand.exitCode !== 0) {
    const summary = `bddgen export failed with exit code ${exportCommand.exitCode}.`;
    return finish({
      status: 'fail',
      exitCode: 1,
      harnessPaths,
      commands,
      exportedStepCount,
      runId,
      generatedSpecs: [],
      output: buildLeanVerifyOutput('fail', summary, commands),
    });
  }

  if (exportedStepCount < 1) {
    const summary = 'bddgen export returned zero registered steps.';
    return finish({
      status: 'fail',
      exitCode: 1,
      harnessPaths,
      commands,
      exportedStepCount,
      runId,
      generatedSpecs: [],
      output: buildLeanVerifyOutput('fail', summary, commands),
    });
  }

  const testCommand = runCapturedValidationCommand(getNpxCommand(), ['bddgen', 'test'], repoRoot, {
    commandRunner: options.commandRunner,
    env: options.env,
  });
  commands.push(testCommand);

  if (testCommand.exitCode !== 0) {
    const summary = `bddgen test failed with exit code ${testCommand.exitCode}.`;
    return finish({
      status: 'fail',
      exitCode: 1,
      harnessPaths,
      commands,
      exportedStepCount,
      runId,
      generatedSpecs: [],
      output: buildLeanVerifyOutput('fail', summary, commands),
    });
  }

  const generatedSpecs = runId ? findGeneratedSpecsForRun(repoRoot, runId) : [];
  if (runId && generatedSpecs.length === 0) {
    const summary = `No generated Playwright specs were found for run ${runId}.`;
    return finish({
      status: 'fail',
      exitCode: 1,
      harnessPaths,
      commands,
      exportedStepCount,
      runId,
      generatedSpecs,
      output: buildLeanVerifyOutput('fail', summary, commands),
    });
  }

  let listedTestCount;
  let executedTestCount;
  if (runId && generatedSpecs.length > 0) {
    const generatedSpecArgs = generatedSpecs.map((generatedSpec) =>
      normalizeDisplayPath(path.relative(repoRoot, generatedSpec)));
    const listCommand = runCapturedValidationCommand(
      getNpxCommand(),
      ['playwright', 'test', '--list', ...generatedSpecArgs],
      repoRoot,
      {
        commandRunner: options.commandRunner,
        env: options.env,
      },
    );
    commands.push(listCommand);

    if (listCommand.exitCode !== 0) {
      const summary = `playwright test --list failed with exit code ${listCommand.exitCode}.`;
      return finish({
        status: 'fail',
        exitCode: 1,
        harnessPaths,
        commands,
        exportedStepCount,
        runId,
        generatedSpecs,
        output: buildLeanVerifyOutput('fail', summary, commands),
      });
    }

    listedTestCount = parseListedTestCount(`${listCommand.stdout}\n${listCommand.stderr}`);
    if (listedTestCount < 1) {
      const summary = `playwright test --list did not find generated tests for run ${runId}.`;
      return finish({
        status: 'fail',
        exitCode: 1,
        harnessPaths,
        commands,
        exportedStepCount,
        listedTestCount,
        runId,
        generatedSpecs,
        output: buildLeanVerifyOutput('fail', summary, commands),
      });
    }

    const executionCommand = runCapturedValidationCommand(
      getNpxCommand(),
      ['playwright', 'test', ...generatedSpecArgs],
      repoRoot,
      {
        commandRunner: options.commandRunner,
        env: options.env,
      },
    );
    commands.push(executionCommand);

    executedTestCount = parseExecutedTestCount(`${executionCommand.stdout}\n${executionCommand.stderr}`);
    if (executionCommand.exitCode !== 0) {
      if (coverageProof.required) {
        coverageProof.fullExecutionStatus = 'fail';
      }
      const summary = `playwright test failed with exit code ${executionCommand.exitCode}.`;
      return finish({
        status: 'fail',
        exitCode: 1,
        harnessPaths,
        commands,
        exportedStepCount,
        listedTestCount,
        executedTestCount,
        runId,
        generatedSpecs,
        output: buildLeanVerifyOutput('fail', summary, commands),
      });
    }

    if (coverageProof.required && executedTestCount < 1) {
      coverageProof.fullExecutionStatus = 'fail';
      const summary = `playwright test execution did not report executed tests for run ${runId}.`;
      return finish({
        status: 'fail',
        exitCode: 1,
        harnessPaths,
        commands,
        exportedStepCount,
        listedTestCount,
        executedTestCount,
        runId,
        generatedSpecs,
        coverageProof,
        coverageProofError: summary,
        output: buildLeanVerifyOutput('fail', summary, commands),
      });
    }

    if (executedTestCount < 1) {
      executedTestCount = listedTestCount;
    }

    if (coverageProof.required) {
      coverageProof.fullExecutionStatus = 'pass';
    }
  }

  const stepLabel = `${exportedStepCount} step${exportedStepCount === 1 ? '' : 's'}`;
  const specLabel = runId
    ? `${generatedSpecs.length} spec${generatedSpecs.length === 1 ? '' : 's'}`
    : 'spec discovery skipped because no run id exists';
  const listLabel = listedTestCount == null
    ? 'playwright test --list skipped because no run-backed specs exist'
    : `playwright test --list found ${listedTestCount} test${listedTestCount === 1 ? '' : 's'}`;
  const executionLabel = executedTestCount == null
    ? 'playwright test execution skipped because no run-backed specs exist'
    : `playwright test executed ${executedTestCount} test${executedTestCount === 1 ? '' : 's'}`;
  const summary = `bddgen export registered ${stepLabel}; bddgen test generated ${specLabel}; ${listLabel}; ${executionLabel}.`;
  return finish({
    status: 'pass',
    harnessPaths,
    commands,
    exportedStepCount,
    listedTestCount,
    executedTestCount,
    runId,
    generatedSpecs,
    output: buildLeanVerifyOutput('pass', summary, commands),
  });
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
  return (templateContent.match(/<[^>\r\n]+>/g) || [])
    .filter((placeholder) => !RALPH_FOOTER_DESCRIPTOR_PLACEHOLDERS.has(placeholder));
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

function isWindowsCommandShim(command) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

function quoteWindowsShellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function runProcess(command, args, cwd, options = {}) {
  const invocation = resolveProjectCliInvocation(command, args, cwd);
  const spawnOptions = {
    cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  };
  if (Object.prototype.hasOwnProperty.call(options, 'input')) {
    spawnOptions.input = options.input;
  }
  const result = isWindowsCommandShim(invocation.command)
    ? spawnSync(
      [invocation.command, ...invocation.args].map(quoteWindowsShellArg).join(' '),
      {
        ...spawnOptions,
        shell: true,
      },
    )
    : spawnSync(invocation.command, invocation.args, spawnOptions);

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

function parseExecutedTestCount(output) {
  const text = String(output || '');
  const statusPattern = /(\d+)\s+(?:passed|failed|flaky|skipped|timed out|interrupted)\b/gi;
  let total = 0;
  let match;

  while ((match = statusPattern.exec(text)) !== null) {
    total += Number.parseInt(match[1], 10);
  }

  if (total > 0) {
    return total;
  }

  const runningMatch = text.match(/Running\s+(\d+)\s+tests?/i);
  if (runningMatch) {
    return Number.parseInt(runningMatch[1], 10);
  }

  return 0;
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
  const { generatedRunDir } = resolveGeneratedHarnessPaths(repoRoot, { runId });
  return walkFiles(generatedRunDir).filter(
    (filePath) => /\.spec\.(c|m)?[jt]s$/i.test(filePath),
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

function progressItemHasField(block, label) {
  return new RegExp(`^  - ${escapeForRegExp(label)}:\\s*.*$`, 'm').test(block);
}

function stripProgressInlineCode(value) {
  return value.replace(/^`|`$/g, '');
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
    owner: stripProgressInlineCode(readProgressItemField(block, 'Owner')),
    agent: stripProgressInlineCode(readProgressItemField(block, 'Agent')),
    mode: stripProgressInlineCode(readProgressItemField(block, 'Mode')),
    status,
    retryBudget: stripProgressInlineCode(readProgressItemField(block, 'Retry budget')),
    result: stripProgressInlineCode(readProgressItemField(block, 'Result')),
    evidence: stripProgressInlineCode(readProgressItemField(block, 'Evidence')),
    fallbackReason: stripProgressInlineCode(readProgressItemField(block, 'Fallback reason')),
    promotionExplanation: stripProgressInlineCode(readProgressItemField(block, 'Promotion explanation')),
    blockReason: stripProgressInlineCode(readProgressItemField(block, 'Block reason')),
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

  if (Object.prototype.hasOwnProperty.call(options, 'evidence') && options.evidence !== undefined) {
    updated = upsertProgressItemField(
      updated,
      'Evidence',
      `\`${sanitizeOptionalInlineCode(options.evidence)}\``,
      { insertBeforeLabel: 'Fallback reason' },
    );
  }

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
    `  - Agent: \`${sanitizeOptionalInlineCode(options.agent || options.owner)}\``,
    `  - Mode: \`${sanitizeOptionalInlineCode(options.mode || 'standard')}\``,
    `  - Status: \`${options.status}\``,
    `  - Retry budget: \`${options.retryBudget}\``,
    `  - Result: \`${sanitizeInlineCode(options.resultText)}\``,
    `  - Evidence: \`${sanitizeOptionalInlineCode(options.evidence)}\``,
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
      evidence: options.evidence,
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
    agent: options.agent,
    mode: options.mode,
    status,
    retryBudget: options.retryBudget,
    resultText,
    evidence: options.evidence,
    fallbackReason: options.fallbackReason,
    blockReason: options.blockReason,
  });

  writeText(progressPath, appendProgressItem(content, options.sectionTitle, appendedBlock));
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

function getPlatformNpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getPlatformCopilotCommand(platform = process.platform) {
  return platform === 'win32' ? 'copilot.cmd' : 'copilot';
}

function readConfiguredCopilotCommand(repoRoot) {
  const configPath = path.join(repoRoot, HARNESS_DIR_NAME, HARNESS_CONFIG_FILE);
  if (!pathExists(configPath) || !fs.statSync(configPath).isFile()) {
    return '';
  }

  try {
    const parsedConfig = readJsonFile(configPath);
    const command = parsedConfig && parsedConfig.copilot && parsedConfig.copilot.command;
    return hasMeaningfulString(command) ? command.trim() : '';
  } catch {
    return '';
  }
}

function readConfiguredProductLoopDefaultMaxIterations(repoRoot) {
  const configPath = path.join(repoRoot, HARNESS_DIR_NAME, HARNESS_CONFIG_FILE);
  if (!pathExists(configPath) || !fs.statSync(configPath).isFile()) {
    return null;
  }

  try {
    const parsedConfig = readJsonFile(configPath);
    const configuredDefault =
      parsedConfig
      && parsedConfig.loop
      && parsedConfig.loop.defaultMaxIterations;

    if (configuredDefault === undefined || configuredDefault === null || configuredDefault === '') {
      return null;
    }

    return parsePositiveIntegerOption(configuredDefault, 'loop.defaultMaxIterations');
  } catch {
    return null;
  }
}

function resolveDoctorCopilotCommand(repoRoot, platform = process.platform) {
  return readConfiguredCopilotCommand(repoRoot) || getPlatformCopilotCommand(platform);
}

function firstCommandOutputLine(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return output ? sanitizeInlineCode(output) : '';
}

function appendDoctorFailureGuidance(label, summary) {
  if (label !== 'copilot') {
    return summary;
  }

  return `${summary}. Install Copilot CLI and ensure it is on PATH, or set copilot.command in .qa-harness/config.json`;
}

function runDoctorAvailabilityCheck(label, command, args, options) {
  const commandRunner = options.commandRunner || runCommand;

  try {
    const result = commandRunner(command, args, options.repoRoot, { env: options.env });
    if (result.status === 0) {
      const detail = firstCommandOutputLine(result);
      return createDoctorCheck(
        'pass',
        label,
        detail ? `${command} available (${detail})` : `${command} available`,
      );
    }

    const detail = firstCommandOutputLine(result);
    return createDoctorCheck(
      'fail',
      label,
      appendDoctorFailureGuidance(label, detail
        ? `${command} ${args.join(' ')} exited ${result.status}: ${detail}`
        : `${command} ${args.join(' ')} exited ${result.status}`),
    );
  } catch (error) {
    return createDoctorCheck(
      'fail',
      label,
      appendDoctorFailureGuidance(
        label,
        `${command} ${args.join(' ')} could not be run: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

function createLocalCliPackageCheck(label, packageName, packageJsonPath, cliPath, cliDisplayPath) {
  const missingParts = [];
  const version = readPackageVersion(packageJsonPath);

  if (!version) {
    missingParts.push(`${packageName} package metadata`);
  }

  if (!pathExists(cliPath) || !fs.statSync(cliPath).isFile()) {
    missingParts.push(`${packageName} CLI at ${cliDisplayPath}`);
  }

  if (missingParts.length > 0) {
    return createDoctorCheck('fail', label, `missing ${missingParts.join(', ')}`);
  }

  return createDoctorCheck('pass', label, `${packageName} ${version} with local CLI ${cliDisplayPath}`);
}

function validateOptionalCommandArgs(rawValue, envVarName) {
  parseEnvStringArray(rawValue, envVarName);
}

function doctor(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const commandRunner = options.commandRunner || runCommand;
  const checks = [];

  checks.push(createDoctorCheck('pass', 'node', `detected ${process.version}`));

  checks.push(
    runDoctorAvailabilityCheck('npm', getPlatformNpmCommand(platform), ['--version'], {
      repoRoot,
      env,
      commandRunner,
    }),
  );

  checks.push(
    runDoctorAvailabilityCheck('git', 'git', ['--version'], {
      repoRoot,
      env,
      commandRunner,
    }),
  );

  const featuresDir = path.join(repoRoot, 'Features');
  const stepsDir = path.join(featuresDir, 'steps');
  const featureFiles = collectFilesRecursively(featuresDir, (entryPath) => entryPath.toLowerCase().endsWith('.feature'));
  const stepFiles = collectFilesRecursively(stepsDir, (entryPath) => entryPath.toLowerCase().endsWith('.ts'));
  const playwrightConfigPath = resolvePlaywrightConfigPath(repoRoot);
  const missingLayoutParts = [];

  if (!playwrightConfigPath) {
    missingLayoutParts.push('playwright.config.* config file');
  }
  if (!pathExists(featuresDir) || !fs.statSync(featuresDir).isDirectory()) {
    missingLayoutParts.push('Features/ directory');
  }
  if (!pathExists(stepsDir) || !fs.statSync(stepsDir).isDirectory()) {
    missingLayoutParts.push('Features/steps/ directory');
  }
  if (featureFiles.length === 0) {
    missingLayoutParts.push('Features/**/*.feature feature files');
  }
  if (stepFiles.length === 0) {
    missingLayoutParts.push('Features/steps/**/*.ts step definitions');
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
  checks.push(createLocalCliPackageCheck(
    'playwright',
    'Playwright',
    path.join(repoRoot, 'node_modules', 'playwright', 'package.json'),
    playwrightCliPath,
    'node_modules/playwright/cli.js',
  ));

  checks.push(createLocalCliPackageCheck(
    'playwright-bdd',
    'playwright-bdd',
    path.join(repoRoot, 'node_modules', 'playwright-bdd', 'package.json'),
    playwrightBddCliPath,
    'node_modules/playwright-bdd/dist/cli/index.js',
  ));

  checks.push(
    runDoctorAvailabilityCheck('copilot', resolveDoctorCopilotCommand(repoRoot, platform), ['--help'], {
      repoRoot,
      env,
      commandRunner,
    }),
  );

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
  const commandPrefix = getHarnessCommandPrefix();
  return [
    'Usage:',
    `  ${commandPrefix} doctor`,
    `  ${commandPrefix} prepare --from <feature-path>`,
    `  ${commandPrefix} prepare --request <text> [--constraint <value>]`,
    `  ${commandPrefix} run [--max-iterations <positive-integer>]`,
    `  ${commandPrefix} status`,
    `  ${commandPrefix} verify`,
    '',
    'Four-agent product loop: qa-orchestrator routes qa-planner, qa-executor, and qa-verifier.',
    'Default run budget: 40 iterations unless --max-iterations is provided.',
    'Each iteration uses a fresh Copilot worker context and durable .qa-harness/ memory.',
    'Coverage proof is Playwright CLI first, MCP fallback second when CLI cannot proceed, and full Playwright execution before pass.',
    'Jira API integration is out of scope; prepare --request accepts Jira links or text as source context only.',
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

function commandNotImplemented(command) {
  throw new Error(`Command "${command}" is not implemented yet.`);
}

function writeLeanCommandResult(command, result, stdout, stderr) {
  const status = result && typeof result.status === 'string' ? result.status : '';
  const exitCode = result && Number.isInteger(result.exitCode)
    ? result.exitCode
    : ['fail', 'failed', 'stalled'].includes(status)
      ? 1
      : 0;
  const output =
    result && typeof result.output === 'string'
      ? result.output
      : result && typeof result.summary === 'string'
        ? `${result.summary}\n`
        : `${command} completed.\n`;
  const normalizedOutput = output.endsWith('\n') ? output : `${output}\n`;

  if (exitCode !== 0 || status === 'blocked') {
    stderr.write(normalizedOutput);
  } else {
    stdout.write(normalizedOutput);
  }

  return exitCode;
}

function findUnexpectedLeanCliOptions(cliOptions, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const unexpected = [];

  for (const [key, value] of Object.entries(cliOptions)) {
    if (key === 'constraint') {
      if (Array.isArray(value) && value.length > 0 && !allowed.has(key)) {
        unexpected.push(key);
      }
      continue;
    }

    if (!allowed.has(key)) {
      unexpected.push(key);
    }
  }

  return unexpected;
}

function assertLeanCliOptions(command, cliOptions, allowedKeys) {
  const unexpected = findUnexpectedLeanCliOptions(cliOptions, allowedKeys);
  if (unexpected.length > 0) {
    throw new Error(`${command} does not accept --${unexpected[0]}.\n\n${usage()}`);
  }
}

function buildLeanPrepareCliOptions(cliOptions) {
  assertLeanCliOptions('prepare', cliOptions, ['from', 'request', 'constraint']);
  const hasFrom = hasMeaningfulString(cliOptions.from);
  const hasRequest = hasMeaningfulString(cliOptions.request);

  if (hasFrom && hasRequest) {
    throw new Error(`prepare accepts either --from or --request, but not both.\n\n${usage()}`);
  }

  if (!hasFrom && !hasRequest) {
    throw new Error(`Missing required option --from or --request for prepare.\n\n${usage()}`);
  }

  if (hasRequest) {
    return {
      request: normalizePrepareCoverageRequest(cliOptions.request, {
        constraints: cliOptions.constraint,
      }),
    };
  }

  return {
    from: cliOptions.from,
  };
}

function buildLeanRunCliOptions(cliOptions, repoRoot) {
  assertLeanCliOptions('run', cliOptions, ['max-iterations']);

  return {
    maxIterations: Object.prototype.hasOwnProperty.call(cliOptions, 'max-iterations')
      ? parsePositiveIntegerOption(cliOptions['max-iterations'], '--max-iterations')
      : readConfiguredProductLoopDefaultMaxIterations(repoRoot) || DEFAULT_PRODUCT_MAX_ITERATIONS,
  };
}

function buildNoOptionLeanCliOptions(command, cliOptions) {
  assertLeanCliOptions(command, cliOptions, []);

  return {};
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
  const doctorFn = options.doctorFn || doctor;
  const prepareFn = options.prepareFn || prepare;
  const runFn = options.runFn || run;
  const statusFn = options.statusFn || status;
  const verifyFn = options.verifyFn || verify;

  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }

    const harnessPaths = resolveHarnessPaths(repoRoot);
    const commandHandlers = {
      doctor: () => {
        const result = doctorFn({
          repoRoot,
          env: options.env || process.env,
          commandRunner: options.commandRunner,
          platform: options.platform,
          ...buildDoctorCliOptions(parsed.options),
        });
        const output = formatDoctorOutput(result);

        if (result.status === 'pass') {
          stdout.write(output);
          return 0;
        }

        stderr.write(output);
        return 1;
      },
      prepare: () =>
        writeLeanCommandResult('prepare', prepareFn({
          repoRoot,
          harnessPaths,
          ...buildLeanPrepareCliOptions(parsed.options),
        }), stdout, stderr),
      run: () => {
        const runOptions = {
          repoRoot,
          harnessPaths,
          ...buildLeanRunCliOptions(parsed.options, repoRoot),
        };
        if (Object.prototype.hasOwnProperty.call(options, 'commandRunner')) {
          runOptions.commandRunner = options.commandRunner;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'env')) {
          runOptions.env = options.env;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'platform')) {
          runOptions.platform = options.platform;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'now')) {
          runOptions.now = options.now;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'verifyFn')) {
          runOptions.verifyFn = options.verifyFn;
        }
        return writeLeanCommandResult('run', runFn(runOptions), stdout, stderr);
      },
      status: () =>
        writeLeanCommandResult('status', statusFn({
          repoRoot,
          harnessPaths,
          ...buildNoOptionLeanCliOptions('status', parsed.options),
        }), stdout, stderr),
      verify: () => {
        const verifyOptions = {
          repoRoot,
          harnessPaths,
          ...buildNoOptionLeanCliOptions('verify', parsed.options),
        };
        if (Object.prototype.hasOwnProperty.call(options, 'commandRunner')) {
          verifyOptions.commandRunner = options.commandRunner;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'env')) {
          verifyOptions.env = options.env;
        }
        return writeLeanCommandResult('verify', verifyFn(verifyOptions), stdout, stderr);
      },
    };

    const commandHandler = commandHandlers[parsed.command];
    if (!commandHandler) {
      throw new Error(`Unknown command "${parsed.command}".\n\n${usage()}`);
    }

    return commandHandler();
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

module.exports = {
  QA_AGENT_ROLES,
  createRun,
  createRunId,
  doctor,
  extractTemplatePlaceholders,
  findNextActionableProgressItem,
  findGeneratedSpecsForRun,
  formatDoctorOutput,
  getTemplatePlaceholders,
  parseProgressItems,
  parseExportedStepCount,
  parseListedTestCount,
  parseCliArgs,
  clarifyPrepareRunRequest,
  planPreparedRunArtifacts,
  prepare,
  run,
  verify,
  prepareRun,
  resolveHarnessPaths,
  resolveGeneratedHarnessPaths,
  resolveQaAgentTemplatePaths,
  resolveProjectCliInvocation,
  resolveRunPaths,
  runCli,
  selectQaOrchestratorRoute,
  status,
  usage,
  validateRequestEnvelope,
  verifyRun,
};
