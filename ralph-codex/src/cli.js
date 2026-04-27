'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildVerifierPrompt } = require('./prompt');
const { createDefaultConfig, readConfig, writeDefaultConfig } = require('./config');
const { runCodexVerifier } = require('./codex');
const { doctor, formatDoctorOutput } = require('./doctor');
const { requireGitRepo } = require('./git');
const { runLoop } = require('./loop');
const { importPlan } = require('./plan');
const { formatRunResult, formatStatus, formatVerifyResult } = require('./report');
const { createDefaultState, resolveRalphPaths, writeState } = require('./state');
const { runValidationCommands } = require('./validation');

function usage() {
  return [
    'Usage:',
    '  ralph-codex init [--force true]',
    '  ralph-codex plan --from <path> [--force true]',
    '  ralph-codex run [--max-iterations <n>] [--resume true] [--force-unlock true] [--commit-each-iteration true]',
    '  ralph-codex status [--run-id <id>]',
    '  ralph-codex verify [--run-id <id>] [--codex-review true]',
    '  ralph-codex doctor',
  ].join('\n');
}

function parseCliArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".\n\n${usage()}`);
    }
    const raw = token.slice(2);
    if (raw.includes('=')) {
      const [key, ...valueParts] = raw.split('=');
      options[key] = valueParts.join('=');
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      options[raw] = next;
      index += 1;
    } else {
      options[raw] = 'true';
    }
  }
  return { command, options };
}

function parseBoolean(value, defaultValue = false) {
  if (value == null) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (/^(true|1|yes)$/iu.test(String(value))) {
    return true;
  }
  if (/^(false|0|no)$/iu.test(String(value))) {
    return false;
  }
  throw new Error(`Expected boolean option value, received ${value}.`);
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function writeFileUnlessExists(filePath, content, force) {
  if (fs.existsSync(filePath) && !force) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function ensureLocalGitExclude(repoRoot) {
  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (!/(?:^|\r?\n)\.ralph\/(?:\r?\n|$)/u.test(current)) {
    fs.appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}.ralph/\n`, 'utf8');
  }
}

function initRalphWorkspace({ repoRoot, force = false }) {
  requireGitRepo(repoRoot);
  const paths = resolveRalphPaths(repoRoot);
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  writeFileUnlessExists(paths.prdPath, [
    '# Ralph PRD',
    '',
    'Describe the target outcome, constraints, and success criteria for this Ralph run.',
    '',
  ].join('\n'), force);
  writeFileUnlessExists(paths.promptPath, [
    '# Ralph Standing Prompt',
    '',
    'You are a Codex worker running inside a Ralph loop.',
    'Use durable files and git state as memory. Work on one bounded task per iteration.',
    '',
  ].join('\n'), force);
  writeFileUnlessExists(paths.planPath, '# Implementation Plan\n\n- [ ] Add implementation plan items.\n', force);
  writeFileUnlessExists(paths.progressPath, '# Ralph Progress\n', force);
  if (!fs.existsSync(paths.configPath) || force) {
    writeDefaultConfig(paths.configPath);
  }
  if (!fs.existsSync(paths.statePath) || force) {
    writeState(paths.statePath, createDefaultState());
  }
  ensureLocalGitExclude(repoRoot);
  return { paths };
}

function verifyRun({ repoRoot, codexReview = false, runId = '', env = process.env }) {
  const paths = resolveRalphPaths(repoRoot);
  const config = readConfig(paths.configPath);
  const validation = runValidationCommands({
    repoRoot,
    validationCommands: config.validationCommands,
    timeoutMs: config.codex.timeoutMs,
    env,
  });
  let codexReviewResult = null;
  if (codexReview) {
    const resultPath = runId
      ? path.join(paths.runsDir, runId, 'result.json')
      : '';
    const prompt = buildVerifierPrompt({
      implementationPlan: fs.existsSync(paths.planPath) ? fs.readFileSync(paths.planPath, 'utf8') : '',
      progress: fs.existsSync(paths.progressPath) ? fs.readFileSync(paths.progressPath, 'utf8') : '',
      diff: resultPath && fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '',
      validationLog: JSON.stringify(validation, null, 2),
    });
    codexReviewResult = runCodexVerifier({ repoRoot, config, prompt, env });
  }
  return {
    validation,
    codexReview: codexReviewResult,
    status: validation.status === 'fail' || (codexReviewResult && codexReviewResult.footer.status === 'fail') ? 'fail' : 'pass',
  };
}

function runCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    if (parsed.command === 'init') {
      initRalphWorkspace({ repoRoot, force: parseBoolean(parsed.options.force, false) });
      stdout.write(`Initialized Ralph workspace at ${path.join(repoRoot, '.ralph')}\n`);
      return 0;
    }
    if (parsed.command === 'plan') {
      if (!parsed.options.from) {
        throw new Error(`Missing --from <path>.\n\n${usage()}`);
      }
      const result = importPlan({
        repoRoot,
        sourcePath: path.resolve(repoRoot, parsed.options.from),
        force: parseBoolean(parsed.options.force, false),
      });
      stdout.write(`Imported implementation plan to ${result.targetPath}\n`);
      return 0;
    }
    if (parsed.command === 'run') {
      const result = runLoop({
        repoRoot,
        maxIterations: parsed.options['max-iterations']
          ? parsePositiveInteger(parsed.options['max-iterations'], '--max-iterations')
          : undefined,
        resume: parseBoolean(parsed.options.resume, false),
        forceUnlock: parseBoolean(parsed.options['force-unlock'], false),
        commitEachIteration: Object.hasOwn(parsed.options, 'commit-each-iteration')
          ? parseBoolean(parsed.options['commit-each-iteration'])
          : undefined,
        env: options.env || process.env,
      });
      const output = formatRunResult(result);
      if (result.status === 'completed' || result.status === 'budget-exhausted') {
        stdout.write(output);
        return 0;
      }
      stderr.write(output);
      return 1;
    }
    if (parsed.command === 'status') {
      stdout.write(formatStatus({ repoRoot, runId: parsed.options['run-id'] || '' }));
      return 0;
    }
    if (parsed.command === 'verify') {
      const result = verifyRun({
        repoRoot,
        runId: parsed.options['run-id'] || '',
        codexReview: parseBoolean(parsed.options['codex-review'], false),
        env: options.env || process.env,
      });
      const output = formatVerifyResult(result);
      if (result.status === 'pass') {
        stdout.write(output);
        return 0;
      }
      stderr.write(output);
      return 1;
    }
    if (parsed.command === 'doctor') {
      const result = doctor({ repoRoot, env: options.env || process.env });
      const output = formatDoctorOutput(result);
      if (result.status === 'pass') {
        stdout.write(output);
        return 0;
      }
      stderr.write(output);
      return 1;
    }
    throw new Error(`Unknown command "${parsed.command}".\n\n${usage()}`);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

module.exports = {
  initRalphWorkspace,
  parseCliArgs,
  runCli,
  usage,
  verifyRun,
};
