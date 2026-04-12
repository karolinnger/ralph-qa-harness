'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package metadata exposes the standalone CLI package shape', () => {
  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  assert.equal(pkg.name, 'ralph-qa-harness');
  assert.equal(pkg.main, './scripts/qa-harness.js');
  assert.equal(pkg.bin['ralph-qa-harness'], './bin/ralph-qa-harness.js');
  assert.match(pkg.scripts.test, /node --test/);
  assert.ok(pkg.files.includes('bin'));
  assert.ok(pkg.files.includes('scripts'));
  assert.ok(pkg.files.includes('templates'));
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ['@playwright/test', 'playwright-bdd']);
});

test('publishable repo placeholders are present', () => {
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'README.md')), true);
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', '.gitignore')), true);
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'LICENSE')), true);
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', '.env.example')), true);
});
