'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readConfig } = require('./config');
const { requireGitRepo } = require('./git');
const { runProcess } = require('./process');
const { resolveRalphPaths } = require('./state');

function check(status, label, summary) {
  return { status, label, summary };
}

function doctor(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const env = options.env || process.env;
  const runProcessFn = options.runProcessFn || runProcess;
  const checks = [];
  let config = null;

  const gitVersion = runProcessFn({ command: 'git', args: ['--version'], cwd: repoRoot, env, timeoutMs: 5000 });
  checks.push(check(gitVersion.exitCode === 0 ? 'pass' : 'fail', 'git', gitVersion.exitCode === 0 ? gitVersion.stdout.trim() : gitVersion.stderr || 'git unavailable'));

  try {
    requireGitRepo(repoRoot);
    checks.push(check('pass', 'git-repo', repoRoot));
  } catch (error) {
    checks.push(check('fail', 'git-repo', error.message));
  }

  const paths = resolveRalphPaths(repoRoot);
  try {
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.accessSync(paths.rootDir, fs.constants.W_OK);
    checks.push(check('pass', 'state-path', `${paths.rootDir} is writable`));
  } catch (error) {
    checks.push(check('fail', 'state-path', error.message));
  }

  if (fs.existsSync(paths.configPath)) {
    try {
      config = readConfig(paths.configPath);
      checks.push(check('pass', 'config', 'config is valid'));
    } catch (error) {
      checks.push(check('fail', 'config', error.message));
    }
  } else {
    checks.push(check('fail', 'config', 'missing .ralph/config.json; run `ralph-codex init` first'));
  }

  if (config) {
    const codexVersion = runProcessFn({
      command: config.codex.command,
      args: [...(config.codex.args || []), '--version'],
      cwd: repoRoot,
      env,
      timeoutMs: 10000,
    });
    const combined = `${codexVersion.stdout}\n${codexVersion.stderr}`;
    if (codexVersion.exitCode === 0) {
      checks.push(check('pass', 'codex', combined.trim() || 'codex available'));
    } else if (/ps1 cannot be loaded|running scripts is disabled/iu.test(combined)) {
      checks.push(check('fail', 'codex', 'PowerShell blocked codex.ps1. Set codex.command to codex.cmd or the full codex.exe path in .ralph/config.json.'));
    } else {
      checks.push(check('fail', 'codex', combined.trim() || 'codex command unavailable'));
    }
    if (config.codex.sandbox === 'danger-full-access') {
      checks.push(check('warn', 'codex-sandbox', 'danger-full-access is configured.'));
    }
    try {
      readConfig(paths.configPath);
    } catch (error) {
      checks.push(check('fail', 'config-load', error.message));
    }
  }

  const failureCount = checks.filter((entry) => entry.status === 'fail').length;
  const warningCount = checks.filter((entry) => entry.status === 'warn').length;
  return {
    repoRoot,
    checks,
    failureCount,
    warningCount,
    status: failureCount > 0 ? 'fail' : 'pass',
  };
}

function formatDoctorOutput(result) {
  const header = result.status === 'pass'
    ? `Doctor passed${result.warningCount ? ` with ${result.warningCount} warning(s)` : ''}.`
    : `Doctor failed with ${result.failureCount} blocking issue(s).`;
  return [
    header,
    ...result.checks.map((entry) => `${entry.status.toUpperCase()} ${entry.label}: ${entry.summary}`),
    '',
  ].join('\n');
}

module.exports = {
  doctor,
  formatDoctorOutput,
};
