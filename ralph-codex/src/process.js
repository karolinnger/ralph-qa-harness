'use strict';

const { spawnSync } = require('node:child_process');

function quoteForDisplay(value) {
  if (value === '') {
    return '""';
  }
  return /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
}

function buildCommandLineForDisplay({ command, args = [] }) {
  return [command, ...args].map(quoteForDisplay).join(' ');
}

function requiresCmdShim(command, platform = process.platform) {
  return platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command);
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/gu, '\\"')}"`;
}

function buildSpawnCommand(command, args, platform) {
  if (!requiresCmdShim(command, platform)) {
    return { command, args };
  }
  const line = [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ');
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', line],
  };
}

function runProcess(options) {
  const startedAt = Date.now();
  const command = options.command;
  const args = Array.isArray(options.args) ? options.args : [];
  const spawnCommand = buildSpawnCommand(command, args, options.platform || process.platform);
  let result;
  try {
    result = spawnSync(spawnCommand.command, spawnCommand.args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      input: options.input || '',
      encoding: 'utf8',
      shell: false,
      timeout: options.timeoutMs || 0,
      windowsHide: true,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    });
  } catch (error) {
    return {
      command,
      args,
      displayCommand: buildCommandLineForDisplay({ command, args }),
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      durationMs: Date.now() - startedAt,
      error,
    };
  }

  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  return {
    command,
    args,
    displayCommand: buildCommandLineForDisplay({ command, args }),
    exitCode: typeof result.status === 'number' ? result.status : timedOut ? 124 : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error && !timedOut ? result.error.message : ''),
    timedOut,
    durationMs: Date.now() - startedAt,
    error: result.error || null,
  };
}

module.exports = {
  buildCommandLineForDisplay,
  requiresCmdShim,
  runProcess,
};
