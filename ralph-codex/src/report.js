'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveRalphPaths, readState } = require('./state');
const { formatValidationSummary } = require('./validation');

function loadRunResult(repoRoot, runId = '') {
  const paths = resolveRalphPaths(repoRoot);
  const state = readState(paths.statePath);
  const selectedRunId = runId || state.latestRunId;
  if (!selectedRunId) {
    throw new Error('No Ralph run is available.');
  }
  const resultPath = path.join(paths.runsDir, selectedRunId, 'result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error(`No result.json is available for run ${selectedRunId}.`);
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
}

function formatStatus({ repoRoot, runId = '' }) {
  const result = loadRunResult(repoRoot, runId);
  return [
    `Run: ${result.runId}`,
    `Stop reason: ${result.stopReason}`,
    `Status: ${result.status}`,
    `Iterations: ${result.iterations}`,
    `Validation: ${result.validationStatus}`,
    `Changed files: ${(result.changedFiles || []).join(', ') || '(none)'}`,
    result.validationStatus === 'skipped' ? 'No deterministic validation commands configured.' : '',
  ].filter(Boolean).join('\n') + '\n';
}

function formatRunResult(result) {
  return [
    `Run: ${result.runId}`,
    `Stop reason: ${result.stopReason}`,
    `Status: ${result.status}`,
    `Iterations: ${result.iterations}`,
    `Validation: ${result.validationStatus}`,
    `Changed files: ${(result.changedFiles || []).join(', ') || '(none)'}`,
  ].join('\n') + '\n';
}

function writeLoopReport({ loopReportPath, runId, summaries, result }) {
  const content = [
    `# Ralph Loop Report: ${runId}`,
    '',
    `Status: ${result ? result.status : 'running'}`,
    `Stop reason: ${result ? result.stopReason : 'running'}`,
    '',
    '## Iterations',
    '',
    ...summaries.map((summary) => `- ${String(summary.iteration).padStart(3, '0')}: ${summary.classification} - ${summary.codex.footer.summary || '(no summary)'}`),
    '',
  ].join('\n');
  fs.writeFileSync(loopReportPath, content, 'utf8');
}

function formatVerifyResult(result) {
  const lines = [];
  lines.push(result.validation.status === 'pass' || result.validation.status === 'skipped' ? 'Verification passed.' : 'Verification failed.');
  lines.push(formatValidationSummary(result.validation));
  if (result.codexReview) {
    lines.push(`Codex review: ${result.codexReview.footer.status || 'unknown'}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  formatStatus,
  formatRunResult,
  writeLoopReport,
  formatVerifyResult,
  loadRunResult,
};
