'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createTempTargetProject(t, options = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-qa-harness-target-'));
  t.after(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'target-project',
      private: true,
    }, null, 2),
  );
  writeFile(
    path.join(repoRoot, 'playwright.config.ts'),
    [
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      "  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://playwright.dev' },",
      '});',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(repoRoot, 'Features', 'homepage.feature'),
    [
      'Feature: Homepage',
      '',
      '  Scenario: Open the homepage',
      '    Given the browser session is open',
      '    When I open "/"',
      '    Then the title should contain "Playwright"',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(repoRoot, 'Features', 'steps', 'fixtures.ts'),
    [
      "import { test as base, createBdd } from 'playwright-bdd';",
      '',
      'export const test = base;',
      'export const { Given, When, Then } = createBdd(test);',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(repoRoot, 'Features', 'steps', 'index.ts'),
    [
      "import { Given } from './fixtures';",
      '',
      "Given('the browser session is open', async () => {});",
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(repoRoot, 'node_modules', 'playwright', 'package.json'),
    JSON.stringify({ name: 'playwright', version: '1.59.1' }, null, 2),
  );
  writeFile(
    path.join(repoRoot, 'node_modules', 'playwright', 'cli.js'),
    [
      "'use strict';",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') {",
      "  process.stdout.write('Version 1.59.1\\n');",
      '  process.exit(0);',
      '}',
      "if (args[0] === 'install' && args[1] === '--list') {",
      "  const output = process.env.QA_HARNESS_TEST_PLAYWRIGHT_INSTALL_LIST || [",
      "    'Playwright version: 1.59.1',",
      "    '  Browsers:',",
      "    '    C:/ms-playwright/chromium-1217',",
      "    '    C:/ms-playwright/firefox-1511',",
      "    '    C:/ms-playwright/webkit-2272',",
      "    '  References:',",
      "    '    ' + process.cwd() + '/node_modules/playwright-core',",
      "    '',",
      "  ].join('\\n');",
      "  process.stdout.write(output);",
      "  process.exit(Number(process.env.QA_HARNESS_TEST_PLAYWRIGHT_INSTALL_STATUS || '0'));",
      '}',
      "process.stderr.write('Unsupported Playwright stub invocation: ' + args.join(' ') + '\\n');",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(repoRoot, 'node_modules', 'playwright-bdd', 'package.json'),
    JSON.stringify({ name: 'playwright-bdd', version: '8.5.0' }, null, 2),
  );
  writeFile(
    path.join(repoRoot, 'node_modules', 'playwright-bdd', 'dist', 'cli', 'index.js'),
    "'use strict';\nprocess.stdout.write('playwright-bdd stub\\n');\n",
  );
  fs.mkdirSync(path.join(repoRoot, 'node_modules', 'playwright-core', '.local-browsers', 'chromium-1217'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repoRoot, 'node_modules', 'playwright-core', '.local-browsers', 'firefox-1511'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repoRoot, 'node_modules', 'playwright-core', '.local-browsers', 'webkit-2272'), {
    recursive: true,
  });

  if (typeof options.mutate === 'function') {
    options.mutate(repoRoot, writeFile);
  }

  return repoRoot;
}

module.exports = {
  createTempTargetProject,
  writeFile,
};
