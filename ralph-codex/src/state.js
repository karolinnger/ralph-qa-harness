'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_SCHEMA_VERSION = 1;

function resolveRalphPaths(repoRoot) {
  const rootDir = path.join(repoRoot, '.ralph');
  return {
    rootDir,
    prdPath: path.join(rootDir, 'PRD.md'),
    promptPath: path.join(rootDir, 'PROMPT.md'),
    planPath: path.join(rootDir, 'IMPLEMENTATION_PLAN.md'),
    progressPath: path.join(rootDir, 'progress.md'),
    configPath: path.join(rootDir, 'config.json'),
    statePath: path.join(rootDir, 'state.json'),
    runsDir: path.join(rootDir, 'runs'),
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function createRunId(date = new Date()) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z-ralph`;
}

function createDefaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeRunId: '',
    latestRunId: '',
    lastStopReason: '',
    lock: null,
  };
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    return createDefaultState();
  }
  return {
    ...createDefaultState(),
    ...JSON.parse(fs.readFileSync(statePath, 'utf8')),
  };
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ ...createDefaultState(), ...state }, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, statePath);
}

function acquireLock({ repoRoot, runId, command, force = false, now = new Date() }) {
  const paths = resolveRalphPaths(repoRoot);
  const state = readState(paths.statePath);
  if (state.lock && !force) {
    return { status: 'fail', reason: `Existing Ralph lock for run ${state.lock.runId}.`, state };
  }
  const lock = {
    runId,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: now.toISOString(),
    command,
  };
  const nextState = {
    ...state,
    activeRunId: runId,
    latestRunId: runId,
    lock,
  };
  writeState(paths.statePath, nextState);
  return { status: 'pass', lock, state: nextState };
}

function releaseLock({ repoRoot, runId, stopReason = '' }) {
  const paths = resolveRalphPaths(repoRoot);
  const state = readState(paths.statePath);
  if (state.lock && state.lock.runId !== runId) {
    return { status: 'skipped', state };
  }
  const nextState = {
    ...state,
    activeRunId: '',
    lastStopReason: stopReason || state.lastStopReason || '',
    lock: null,
  };
  writeState(paths.statePath, nextState);
  return { status: 'pass', state: nextState };
}

function createRunDirectories({ repoRoot, runId }) {
  const paths = resolveRalphPaths(repoRoot);
  const runDir = path.join(paths.runsDir, runId);
  const iterationsDir = path.join(runDir, 'iterations');
  fs.mkdirSync(iterationsDir, { recursive: true });
  return {
    runDir,
    iterationsDir,
    resultPath: path.join(runDir, 'result.json'),
    loopReportPath: path.join(runDir, 'loop-report.md'),
  };
}

function appendProgressEntry({ repoRoot, text, now = new Date() }) {
  const progressPath = resolveRalphPaths(repoRoot).progressPath;
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.appendFileSync(progressPath, `\n## ${now.toISOString()}\n\n${text.trim()}\n`, 'utf8');
}

module.exports = {
  STATE_SCHEMA_VERSION,
  resolveRalphPaths,
  createRunId,
  readState,
  writeState,
  createDefaultState,
  acquireLock,
  releaseLock,
  createRunDirectories,
  appendProgressEntry,
};
