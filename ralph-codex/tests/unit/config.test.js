'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_CONFIG,
  createDefaultConfig,
  readConfig,
  validateConfig,
  writeDefaultConfig,
} = require('../../src/config');
const { createTempRepo } = require('../helpers/temp-repo');

test('createDefaultConfig returns the v1 safe default config', () => {
  const config = createDefaultConfig();

  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.notEqual(config, DEFAULT_CONFIG);
  assert.equal(config.codex.sandbox, 'workspace-write');
  assert.equal(config.codex.approvalPolicy, 'on-failure');
  assert.equal(config.loop.commitEachIteration, false);
  assert.deepEqual(config.validationCommands[0], { name: 'test', command: 'npm', args: ['test'] });
});

test('validateConfig accepts structured command definitions', () => {
  const result = validateConfig(createDefaultConfig());

  assert.equal(result.status, 'pass');
  assert.equal(result.config.codex.command, 'codex');
});

test('validateConfig reports invalid commands without throwing', () => {
  const invalid = createDefaultConfig();
  invalid.validationCommands = [
    { name: 'missing command', args: [] },
    { name: 'bad args', command: 'npm', args: 'test' },
    { name: 'bad arg value', command: 'npm', args: ['test', 1] },
  ];

  const result = validateConfig(invalid);

  assert.equal(result.status, 'fail');
  assert.match(result.errors.join('\n'), /validationCommands\[0\]\.command/);
  assert.match(result.errors.join('\n'), /validationCommands\[1\]\.args/);
  assert.match(result.errors.join('\n'), /validationCommands\[2\]\.args\[1\]/);
});

test('writeDefaultConfig and readConfig round-trip config JSON', (t) => {
  const repoRoot = createTempRepo(t);
  const configPath = path.join(repoRoot, '.ralph', 'config.json');

  writeDefaultConfig(configPath);
  const config = readConfig(configPath);

  assert.equal(fs.existsSync(configPath), true);
  assert.equal(config.codex.command, 'codex');
});

test('readConfig accepts UTF-8 BOM files written by Windows PowerShell', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-codex-config-'));
  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(configPath, `\uFEFF${JSON.stringify(createDefaultConfig(), null, 2)}\n`, 'utf8');

  const config = readConfig(configPath);

  assert.equal(config.codex.command, 'codex');
  fs.rmSync(tempDir, { recursive: true, force: true });
});
