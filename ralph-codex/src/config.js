'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  codex: {
    command: 'codex',
    args: [],
    model: '',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-failure',
    timeoutMs: 900000,
  },
  loop: {
    maxIterations: 10,
    stalledNoChangeLimit: 2,
    commitEachIteration: false,
    verificationPasses: 1,
  },
  validationCommands: [
    {
      name: 'test',
      command: 'npm',
      args: ['test'],
    },
  ],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultConfig() {
  return clone(DEFAULT_CONFIG);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateCommandDefinition(commandDefinition, label, errors) {
  if (!isPlainObject(commandDefinition)) {
    errors.push(`${label} must be a JSON object.`);
    return;
  }
  if (typeof commandDefinition.command !== 'string' || commandDefinition.command.trim() === '') {
    errors.push(`${label}.command must be a non-empty string.`);
  }
  if (!Array.isArray(commandDefinition.args)) {
    errors.push(`${label}.args must be an array of strings.`);
  } else {
    commandDefinition.args.forEach((arg, index) => {
      if (typeof arg !== 'string') {
        errors.push(`${label}.args[${index}] must be a string.`);
      }
    });
  }
}

function validateConfig(rawConfig) {
  const errors = [];
  if (!isPlainObject(rawConfig)) {
    return { status: 'fail', errors: ['config must be a JSON object.'] };
  }

  const config = {
    ...createDefaultConfig(),
    ...rawConfig,
    codex: { ...createDefaultConfig().codex, ...(rawConfig.codex || {}) },
    loop: { ...createDefaultConfig().loop, ...(rawConfig.loop || {}) },
    validationCommands: Array.isArray(rawConfig.validationCommands)
      ? rawConfig.validationCommands
      : createDefaultConfig().validationCommands,
  };

  validateCommandDefinition(config.codex, 'codex', errors);
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(config.codex.sandbox)) {
    errors.push('codex.sandbox must be read-only, workspace-write, or danger-full-access.');
  }
  if (!['untrusted', 'on-failure', 'on-request', 'never'].includes(config.codex.approvalPolicy)) {
    errors.push('codex.approvalPolicy must be untrusted, on-failure, on-request, or never.');
  }
  if (!Number.isInteger(config.codex.timeoutMs) || config.codex.timeoutMs < 1) {
    errors.push('codex.timeoutMs must be a positive integer.');
  }
  for (const [key, min] of [
    ['maxIterations', 1],
    ['stalledNoChangeLimit', 1],
    ['verificationPasses', 0],
  ]) {
    if (!Number.isInteger(config.loop[key]) || config.loop[key] < min) {
      errors.push(`loop.${key} must be an integer >= ${min}.`);
    }
  }
  if (typeof config.loop.commitEachIteration !== 'boolean') {
    errors.push('loop.commitEachIteration must be a boolean.');
  }
  if (!Array.isArray(rawConfig.validationCommands || config.validationCommands)) {
    errors.push('validationCommands must be an array.');
  } else {
    config.validationCommands.forEach((commandDefinition, index) => {
      validateCommandDefinition(commandDefinition, `validationCommands[${index}]`, errors);
    });
  }

  return errors.length > 0 ? { status: 'fail', errors } : { status: 'pass', config };
}

function readConfig(configPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''));
  const validation = validateConfig(parsed);
  if (validation.status === 'fail') {
    throw new Error(`Invalid config at ${configPath}: ${validation.errors.join('; ')}`);
  }
  return validation.config;
}

function writeDefaultConfig(configPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(createDefaultConfig(), null, 2)}\n`, 'utf8');
}

module.exports = {
  DEFAULT_CONFIG,
  createDefaultConfig,
  validateConfig,
  readConfig,
  writeDefaultConfig,
};
