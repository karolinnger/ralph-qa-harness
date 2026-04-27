'use strict';

const { runProcess } = require('./process');

function runValidationCommands({ repoRoot, validationCommands, timeoutMs = 900000, env = process.env }) {
  const commands = Array.isArray(validationCommands) ? validationCommands : [];
  if (commands.length === 0) {
    return {
      status: 'skipped',
      results: [],
      summary: 'No deterministic validation commands configured.',
    };
  }
  const results = commands.map((commandDefinition) => {
    const result = runProcess({
      command: commandDefinition.command,
      args: commandDefinition.args || [],
      cwd: repoRoot,
      timeoutMs: commandDefinition.timeoutMs || timeoutMs,
      env,
    });
    return {
      name: commandDefinition.name,
      command: commandDefinition.command,
      args: commandDefinition.args || [],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
  const status = results.every((result) => result.exitCode === 0 && !result.timedOut) ? 'pass' : 'fail';
  return {
    status,
    results,
    summary: status === 'pass' ? 'All deterministic validation commands passed.' : 'One or more deterministic validation commands failed.',
  };
}

function formatValidationSummary(result) {
  if (!result || result.status === 'skipped') {
    return 'No deterministic validation commands configured.';
  }
  return result.results.map((entry) => `${entry.name}: ${entry.timedOut ? 'timeout' : `exit ${entry.exitCode}`}`).join('; ');
}

module.exports = {
  runValidationCommands,
  formatValidationSummary,
};
