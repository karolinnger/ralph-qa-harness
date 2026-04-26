'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package metadata exposes the standalone ralph-codex CLI package', () => {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

  assert.equal(pkg.name, 'ralph-codex');
  assert.equal(pkg.type, 'commonjs');
  assert.equal(pkg.main, './src/cli.js');
  assert.equal(pkg.bin['ralph-codex'], './bin/ralph-codex.js');
  assert.match(pkg.scripts.test, /^node --test --test-isolation=none /);
  assert.match(pkg.scripts.test, /tests\/unit\/\*\.test\.js/);
  assert.match(pkg.scripts.test, /tests\/integration\/\*\.test\.js/);
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(Object.hasOwn(pkg, 'dependencies'), false);
});

test('README documents operational safety defaults', () => {
  const readmePath = path.resolve(__dirname, '..', '..', 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');

  assert.match(readme, /\.ralph\//);
  assert.match(readme, /codex\.cmd/);
  assert.match(readme, /commitEachIteration/);
  assert.match(readme, /fresh Codex process/);
});
