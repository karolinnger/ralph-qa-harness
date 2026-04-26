'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readConfig } = require('./config');
const { runCodexWorker } = require('./codex');
const { captureDiff, commitIterationChanges, getBaselineDirtyFiles, getChangedFiles, requireGitRepo } = require('./git');
const { allTasksComplete, selectNextTask } = require('./plan');
const { buildWorkerPrompt } = require('./prompt');
const { writeLoopReport } = require('./report');
const {
  acquireLock,
  appendProgressEntry,
  createRunDirectories,
  createRunId,
  releaseLock,
  resolveRalphPaths,
  readState,
  writeState,
} = require('./state');
const { runValidationCommands } = require('./validation');

const INTERACTIVE_BLOCK_PATTERNS = [
  /approval required/iu,
  /requires user approval/iu,
  /permission denied/iu,
  /missing credential/iu,
  /ambiguous requirement/iu,
  /please confirm/iu,
  /need your input/iu,
];

function classifyInteractiveBlock(text) {
  return INTERACTIVE_BLOCK_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

function classifyIteration(input) {
  const codexResult = input.codexResult || {};
  const footer = codexResult.footer || {};
  const validationResult = input.validationResult || {};
  if (codexResult.timedOut || codexResult.exitCode !== 0) {
    return { classification: 'fail', stallCount: input.stallCount || 0 };
  }
  if (
    footer.status === 'blocked'
    || classifyInteractiveBlock(`${codexResult.stdout || ''}\n${codexResult.stderr || ''}`)
  ) {
    return { classification: 'blocked', stallCount: input.stallCount || 0 };
  }
  if (validationResult.status === 'fail') {
    return { classification: 'fail', stallCount: input.stallCount || 0 };
  }
  if (input.allTasksComplete && ['pass', 'skipped'].includes(validationResult.status)) {
    return { classification: 'completed', stallCount: input.stallCount || 0 };
  }
  const nextStallCount = input.noMeaningfulChanges ? input.stallCount : 0;
  if (input.noMeaningfulChanges && nextStallCount >= input.stalledNoChangeLimit) {
    return { classification: 'stalled', stallCount: nextStallCount };
  }
  if (input.iteration >= input.maxIterations) {
    return { classification: 'budget-exhausted', stallCount: nextStallCount };
  }
  return { classification: 'continue', stallCount: nextStallCount };
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hashFileIfExists(repoRoot, filePath) {
  const absolutePath = path.join(repoRoot, filePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return '';
  }
  return fs.readFileSync(absolutePath).toString('base64');
}

function snapshotDirtyFiles(repoRoot, dirtyFiles) {
  const snapshot = new Map();
  for (const filePath of dirtyFiles) {
    snapshot.set(filePath, hashFileIfExists(repoRoot, filePath));
  }
  return snapshot;
}

function selectIterationChangedFiles(repoRoot, changedFiles, baselineSnapshot) {
  return changedFiles.filter((filePath) => {
    if (!baselineSnapshot.has(filePath)) {
      return true;
    }
    return baselineSnapshot.get(filePath) !== hashFileIfExists(repoRoot, filePath);
  });
}

function createResult({ runId, status, iterations, startedAt, finishedAt, changedFiles, validationStatus }) {
  return {
    schemaVersion: 1,
    runId,
    status,
    stopReason: status,
    iterations,
    startedAt,
    finishedAt,
    changedFiles,
    validationStatus,
  };
}

function runLoop(options) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  requireGitRepo(repoRoot);
  const paths = resolveRalphPaths(repoRoot);
  const initialConfig = readConfig(paths.configPath);
  const runId = options.runId || createRunId(options.now || new Date());
  const lock = acquireLock({
    repoRoot,
    runId,
    command: 'run',
    force: Boolean(options.forceUnlock),
    now: options.now || new Date(),
  });
  if (lock.status === 'fail') {
    throw new Error(`${lock.reason} Use --resume true or --force-unlock true.`);
  }

  const runPaths = createRunDirectories({ repoRoot, runId });
  const summaries = [];
  const startedAt = (options.now || new Date()).toISOString();
  const maxIterations = options.maxIterations || initialConfig.loop.maxIterations;
  const baselineDirtyFiles = getBaselineDirtyFiles(repoRoot);
  const baselineSnapshot = snapshotDirtyFiles(repoRoot, baselineDirtyFiles);
  let stallCount = 0;
  let result = null;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const config = readConfig(paths.configPath);
      if (typeof options.commitEachIteration === 'boolean') {
        config.loop.commitEachIteration = options.commitEachIteration;
      }
      const standingPrompt = readTextIfExists(paths.promptPath);
      const implementationPlan = readTextIfExists(paths.planPath);
      const progress = readTextIfExists(paths.progressPath);
      readState(paths.statePath);
      const selectedTask = selectNextTask(implementationPlan);
      if (!selectedTask) {
        const validation = runValidationCommands({
          repoRoot,
          validationCommands: config.validationCommands,
          timeoutMs: config.codex.timeoutMs,
          env: options.env || process.env,
        });
        result = createResult({
          runId,
          status: allTasksComplete(implementationPlan) && ['pass', 'skipped'].includes(validation.status) ? 'completed' : 'budget-exhausted',
          iterations: iteration - 1,
          startedAt,
          finishedAt: new Date().toISOString(),
          changedFiles: getChangedFiles(repoRoot),
          validationStatus: validation.status,
        });
        break;
      }

      const iterationDir = path.join(runPaths.iterationsDir, String(iteration).padStart(3, '0'));
      fs.mkdirSync(iterationDir, { recursive: true });
      const prompt = buildWorkerPrompt({
        standingPrompt,
        implementationPlan,
        progress,
        selectedTask,
        validationCommands: config.validationCommands,
      });
      fs.writeFileSync(path.join(iterationDir, 'worker-prompt.md'), prompt, 'utf8');
      const iterationStartedAt = new Date();
      const codexResult = runCodexWorker({
        repoRoot,
        config,
        prompt,
        env: options.env || process.env,
      });
      fs.writeFileSync(path.join(iterationDir, 'stdout.log'), codexResult.stdout, 'utf8');
      fs.writeFileSync(path.join(iterationDir, 'stderr.log'), codexResult.stderr, 'utf8');

      const validationResult = runValidationCommands({
        repoRoot,
        validationCommands: config.validationCommands,
        timeoutMs: config.codex.timeoutMs,
        env: options.env || process.env,
      });
      writeJson(path.join(iterationDir, 'validation.json'), validationResult);
      const diff = captureDiff(repoRoot);
      fs.writeFileSync(path.join(iterationDir, 'diff.patch'), diff, 'utf8');
      const changedFiles = getChangedFiles(repoRoot);
      const meaningfulChangedFiles = changedFiles.filter((filePath) => !filePath.startsWith('.ralph/'));
      const iterationChangedFiles = selectIterationChangedFiles(repoRoot, meaningfulChangedFiles, baselineSnapshot);
      const planAfterIteration = readTextIfExists(paths.planPath);
      const noMeaningfulChanges = iterationChangedFiles.length === 0;
      const candidateStallCount = noMeaningfulChanges ? stallCount + 1 : 0;
      const classification = classifyIteration({
        codexResult,
        validationResult,
        allTasksComplete: allTasksComplete(planAfterIteration),
        noMeaningfulChanges,
        stallCount: candidateStallCount,
        stalledNoChangeLimit: config.loop.stalledNoChangeLimit,
        iteration,
        maxIterations,
      });
      stallCount = classification.stallCount;

      let finalClassification = classification.classification;
      let commitResult = { status: 'skipped' };
      if (finalClassification === 'completed' || finalClassification === 'continue' || finalClassification === 'budget-exhausted') {
        commitResult = commitIterationChanges({
          repoRoot,
          enabled: config.loop.commitEachIteration,
          iteration,
          changedFiles: iterationChangedFiles,
          baselineDirtyFiles,
        });
        if (commitResult.status === 'blocked') {
          finalClassification = 'blocked';
        } else if (commitResult.status === 'fail') {
          finalClassification = 'fail';
        }
      }

      const summary = {
        schemaVersion: 1,
        runId,
        iteration,
        task: selectedTask,
        startedAt: iterationStartedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - iterationStartedAt.getTime(),
        codex: {
          exitCode: codexResult.exitCode,
          timedOut: codexResult.timedOut,
          footer: codexResult.footer,
        },
        changedFiles: iterationChangedFiles,
        validationStatus: validationResult.status,
        classification: finalClassification,
        commit: commitResult,
      };
      writeJson(path.join(iterationDir, 'summary.json'), summary);
      summaries.push(summary);
      appendProgressEntry({
        repoRoot,
        text: [
          `Iteration ${String(iteration).padStart(3, '0')}: ${finalClassification}`,
          codexResult.footer.summary || 'No Codex summary provided.',
          `Validation: ${validationResult.status}`,
          commitResult.reason ? `Commit: ${commitResult.reason}` : '',
        ].filter(Boolean).join('\n\n'),
      });

      result = createResult({
        runId,
        status: finalClassification,
        iterations: iteration,
        startedAt,
        finishedAt: new Date().toISOString(),
        changedFiles: getChangedFiles(repoRoot),
        validationStatus: validationResult.status,
      });
      writeLoopReport({ loopReportPath: runPaths.loopReportPath, runId, summaries, result });
      if (finalClassification !== 'continue') {
        break;
      }
    }

    if (!result) {
      result = createResult({
        runId,
        status: 'budget-exhausted',
        iterations: maxIterations,
        startedAt,
        finishedAt: new Date().toISOString(),
        changedFiles: getChangedFiles(repoRoot),
        validationStatus: 'skipped',
      });
    }
    writeJson(runPaths.resultPath, result);
    writeLoopReport({ loopReportPath: runPaths.loopReportPath, runId, summaries, result });
    const state = readState(paths.statePath);
    writeState(paths.statePath, { ...state, latestRunId: runId, activeRunId: '', lastStopReason: result.stopReason });
    return result;
  } finally {
    releaseLock({ repoRoot, runId, stopReason: result ? result.stopReason : 'fail' });
  }
}

module.exports = {
  classifyIteration,
  classifyInteractiveBlock,
  runLoop,
};
