'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readConfig } = require('./config');
const { runCodexWorker } = require('./codex');
const { captureDiff, commitIterationChanges, getBaselineDirtyFiles, getChangedFiles, requireGitRepo } = require('./git');
const { allWorkComplete, selectNextAction } = require('./progress');
const { buildRolePrompt } = require('./prompt');
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
  if (footer.status === 'fail') {
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

function roleRequiresVerifier(role) {
  return ['executor', 'healer', 'explorer'].includes(role);
}

function iterationPassed(codexResult, validationResult) {
  return (
    !codexResult.timedOut
    && codexResult.exitCode === 0
    && codexResult.footer.status !== 'fail'
    && codexResult.footer.status !== 'blocked'
    && validationResult.status !== 'fail'
  );
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
  const runChangedFiles = new Set();
  let stallCount = 0;
  let result = null;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const config = readConfig(paths.configPath);
      if (typeof options.commitEachIteration === 'boolean') {
        config.loop.commitEachIteration = options.commitEachIteration;
      }
      const standingPrompt = readTextIfExists(paths.promptPath);
      const prd = readTextIfExists(paths.prdPath);
      const implementationPlan = readTextIfExists(paths.planPath);
      const progress = readTextIfExists(paths.progressPath);
      readState(paths.statePath);
      const action = selectNextAction({
        prd,
        prompt: standingPrompt,
        progress,
        implementationPlan,
      });
      if (!action) {
        const validation = runValidationCommands({
          repoRoot,
          validationCommands: config.validationCommands,
          timeoutMs: config.codex.timeoutMs,
          env: options.env || process.env,
        });
        result = createResult({
          runId,
          status: allWorkComplete({ progress, implementationPlan }) && ['pass', 'skipped'].includes(validation.status) ? 'completed' : 'budget-exhausted',
          iterations: iteration - 1,
          startedAt,
          finishedAt: new Date().toISOString(),
          changedFiles: Array.from(runChangedFiles).sort(),
          validationStatus: validation.status,
        });
        break;
      }

      const iterationDir = path.join(runPaths.iterationsDir, String(iteration).padStart(3, '0'));
      fs.mkdirSync(iterationDir, { recursive: true });
      const prompt = buildRolePrompt({
        role: action.role,
        standingPrompt,
        prd,
        implementationPlan,
        progress,
        selectedTask: action.task,
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
      const changedFiles = getChangedFiles(repoRoot);
      const meaningfulChangedFiles = changedFiles.filter((filePath) => !filePath.startsWith('.ralph/'));
      const iterationChangedFiles = selectIterationChangedFiles(repoRoot, meaningfulChangedFiles, baselineSnapshot);
      iterationChangedFiles.forEach((filePath) => runChangedFiles.add(filePath));
      const diff = captureDiff(repoRoot, { changedFiles: iterationChangedFiles });
      fs.writeFileSync(path.join(iterationDir, 'diff.patch'), diff, 'utf8');
      const planAfterIteration = readTextIfExists(paths.planPath);
      const progressAfterIteration = readTextIfExists(paths.progressPath);
      const successfulIteration = iterationPassed(codexResult, validationResult);
      const progressForCompletion = action.role === 'verifier' && successfulIteration && action.task
        ? `${progressAfterIteration}\nVerifier accepted: ${action.task.id}\n`
        : progressAfterIteration;
      const durableProgressChanged = planAfterIteration !== implementationPlan || progressAfterIteration !== progress;
      const noMeaningfulChanges = iterationChangedFiles.length === 0 && !durableProgressChanged;
      const candidateStallCount = noMeaningfulChanges ? stallCount + 1 : 0;
      const classification = classifyIteration({
        codexResult,
        validationResult,
        allTasksComplete: allWorkComplete({
          progress: progressForCompletion,
          implementationPlan: planAfterIteration,
        }),
        noMeaningfulChanges,
        stallCount: candidateStallCount,
        stalledNoChangeLimit: config.loop.stalledNoChangeLimit,
        iteration,
        maxIterations,
      });
      stallCount = classification.stallCount;

      let finalClassification = classification.classification;
      if (
        roleRequiresVerifier(action.role)
        && successfulIteration
        && (finalClassification === 'completed' || finalClassification === 'continue')
      ) {
        finalClassification = iteration >= maxIterations ? 'budget-exhausted' : 'continue';
      }
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
        role: action.role,
        roleReason: action.reason,
        task: action.task,
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
          `Role: ${action.role}`,
          action.task ? `Selected item: ${action.task.id}` : '',
          codexResult.footer.summary || 'No Codex summary provided.',
          `Validation: ${validationResult.status}`,
          roleRequiresVerifier(action.role) && successfulIteration && action.task ? `Pending verifier: ${action.task.id}` : '',
          action.role === 'verifier' && successfulIteration && action.task ? `Verifier accepted: ${action.task.id}` : '',
          commitResult.reason ? `Commit: ${commitResult.reason}` : '',
        ].filter(Boolean).join('\n\n'),
      });

      result = createResult({
        runId,
        status: finalClassification,
        iterations: iteration,
        startedAt,
        finishedAt: new Date().toISOString(),
        changedFiles: Array.from(runChangedFiles).sort(),
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
        changedFiles: Array.from(runChangedFiles).sort(),
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
