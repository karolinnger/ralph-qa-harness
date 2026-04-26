'use strict';

const { runProcess } = require('./process');
const { parseRalphFooter } = require('./prompt');

function buildCodexExecArgs({ config, repoRoot, overrides = {} }) {
  const codex = {
    ...config.codex,
    ...overrides,
  };
  return [
    ...(Array.isArray(codex.args) ? codex.args : []),
    '--ask-for-approval',
    codex.approvalPolicy,
    'exec',
    '--cd',
    repoRoot,
    '--sandbox',
    codex.sandbox,
    '--color',
    'never',
    ...(codex.model ? ['--model', codex.model] : []),
    '-',
  ];
}

function runCodexWorker({ repoRoot, config, prompt, env }) {
  const result = runProcess({
    command: config.codex.command,
    args: buildCodexExecArgs({ config, repoRoot }),
    cwd: repoRoot,
    input: prompt,
    timeoutMs: config.codex.timeoutMs,
    env: env || process.env,
  });
  return {
    ...result,
    footer: parseRalphFooter(`${result.stdout}\n${result.stderr}`),
  };
}

function runCodexVerifier({ repoRoot, config, prompt, env }) {
  const verifierConfig = {
    ...config,
    codex: {
      ...config.codex,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    },
  };
  const result = runProcess({
    command: verifierConfig.codex.command,
    args: buildCodexExecArgs({ config: verifierConfig, repoRoot }),
    cwd: repoRoot,
    input: prompt,
    timeoutMs: verifierConfig.codex.timeoutMs,
    env: env || process.env,
  });
  return {
    ...result,
    footer: parseRalphFooter(`${result.stdout}\n${result.stderr}`),
  };
}

module.exports = {
  buildCodexExecArgs,
  runCodexWorker,
  runCodexVerifier,
};
