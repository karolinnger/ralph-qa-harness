'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    options[key] = value;
    index += 1;
  }

  return options;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findProgressItemBlock(progressContent, itemId) {
  const pattern = new RegExp(`- \\[[ x]\\] \`${escapeForRegExp(itemId)}\`[\\s\\S]*?(?=\\n- \\[[ x]\\] \`|\\n## |$)`);
  const match = progressContent.match(pattern);
  return match ? match[0] : '';
}

function readProgressItemOwner(progressContent, itemId) {
  const block = findProgressItemBlock(progressContent, itemId);
  const ownerMatch = block.match(/^\s*- Owner: `([^`]+)`/m);
  return ownerMatch ? ownerMatch[1].trim() : '';
}

function appendScenarioIfMissing(normalizedFeaturePath) {
  const content = readText(normalizedFeaturePath);
  const scenarioTitle = 'Scenario: Open the Playwright API class reference directly';

  if (content.includes(scenarioTitle)) {
    return scenarioTitle;
  }

  const scenarioBlock = [
    '',
    `  ${scenarioTitle}`,
    '    Given I open "/docs/api/class-playwright"',
    '    Then the title should contain "Playwright"',
    '    And the url should contain "/docs/api/class-playwright"',
    '    And I should see "getByRole(\'heading\', { name: \'Playwright\' })"',
    '',
  ].join('\n');

  const nextContent = content.endsWith('\n')
    ? `${content}${scenarioBlock}`
    : `${content}\n${scenarioBlock}`;
  writeText(normalizedFeaturePath, nextContent);
  return scenarioTitle;
}

function buildExplorerResponse() {
  return {
    status: 'pass',
    summary: 'identified one bounded API reference coverage gap',
    runtimeLayer: 'playwright-cli',
    coverageScope: 'homepage',
    observedGap: 'Playwright API class reference coverage is missing from normalized.feature',
    candidateScenario: 'open the Playwright API class reference directly',
    additionTarget: 'normalized.feature',
    evidence: ['normalized.feature'],
    gapCandidates: [
      {
        gap: 'Playwright API class reference coverage is missing',
        candidateScenario: 'open the Playwright API class reference directly',
        additionTarget: 'normalized.feature',
        evidence: ['normalized.feature'],
      },
    ],
  };
}

function buildScenarioAdditionResponse(normalizedFeaturePath) {
  const scenarioTitle = appendScenarioIfMissing(normalizedFeaturePath);

  return {
    status: 'pass',
    summary: 'appended one bounded scenario to normalized.feature',
    runtimeLayer: 'playwright-cli',
    addedScenarioOrOutline: scenarioTitle,
    targetArtifactPath: normalizedFeaturePath,
    evidence: ['normalized.feature'],
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const progressPath = path.resolve(options['progress-path']);
  const normalizedFeaturePath = path.resolve(options['normalized-feature-path']);
  const itemId = options['item-id'] || '';
  const progressContent = readText(progressPath);
  const owner = readProgressItemOwner(progressContent, itemId);

  let response;
  if (owner === 'qa-explorer') {
    response = buildExplorerResponse();
  } else if (itemId.startsWith('P-GAP-')) {
    response = buildScenarioAdditionResponse(normalizedFeaturePath);
  } else {
    response = {
      status: 'pass',
      summary: `demo runtime completed bounded item ${itemId || 'unknown-item'}`,
      runtimeLayer: 'playwright-cli',
      evidence: ['normalized.feature'],
    };
  }

  process.stdout.write(JSON.stringify(response));
}

main();
