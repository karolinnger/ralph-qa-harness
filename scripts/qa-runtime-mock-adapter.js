'use strict';

const RESULT_STATUSES = new Set(['pass', 'fail', 'blocked']);
const RUNTIME_LAYERS = new Set(['playwright-cli', 'playwright-test', 'mcp']);

function readMockStatus() {
  const rawStatus = typeof process.env.QA_HARNESS_MOCK_STATUS === 'string'
    ? process.env.QA_HARNESS_MOCK_STATUS.trim().toLowerCase()
    : '';

  return RESULT_STATUSES.has(rawStatus) ? rawStatus : 'pass';
}

function readOptionalRuntimeLayer() {
  const rawLayer = typeof process.env.QA_HARNESS_MOCK_RUNTIME_LAYER === 'string'
    ? process.env.QA_HARNESS_MOCK_RUNTIME_LAYER.trim().toLowerCase()
    : '';

  return RUNTIME_LAYERS.has(rawLayer) ? rawLayer : '';
}

function readMockBoolean(name) {
  const rawValue = typeof process.env[name] === 'string'
    ? process.env[name].trim().toLowerCase()
    : '';

  return rawValue === '1' || rawValue === 'true' || rawValue === 'yes';
}

function readMockJsonArray(name) {
  const rawValue = typeof process.env[name] === 'string' ? process.env[name].trim() : '';
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const status = readMockStatus();
const summary =
  typeof process.env.QA_HARNESS_MOCK_SUMMARY === 'string' && process.env.QA_HARNESS_MOCK_SUMMARY.trim()
    ? process.env.QA_HARNESS_MOCK_SUMMARY.trim()
    : `mock adapter ${status}`;
const runtimeLayer = readOptionalRuntimeLayer();
const requestPlaywrightBridge = readMockBoolean('QA_HARNESS_MOCK_REQUEST_BRIDGE');
const bridgeReason =
  typeof process.env.QA_HARNESS_MOCK_BRIDGE_REASON === 'string'
    ? process.env.QA_HARNESS_MOCK_BRIDGE_REASON.trim()
    : '';
const fallbackReason =
  typeof process.env.QA_HARNESS_MOCK_FALLBACK_REASON === 'string'
    ? process.env.QA_HARNESS_MOCK_FALLBACK_REASON.trim()
    : '';
const evidence = readMockJsonArray('QA_HARNESS_MOCK_EVIDENCE');
const gapCandidates = readMockJsonArray('QA_HARNESS_MOCK_GAP_CANDIDATES');
const coverageScope =
  typeof process.env.QA_HARNESS_MOCK_COVERAGE_SCOPE === 'string'
    ? process.env.QA_HARNESS_MOCK_COVERAGE_SCOPE.trim()
    : '';

process.stdout.write(
  JSON.stringify({
    status,
    summary,
    runtimeLayer,
    requestPlaywrightBridge,
    bridgeReason,
    fallbackReason,
    evidence,
    gapCandidates,
    coverageScope,
  }),
);
