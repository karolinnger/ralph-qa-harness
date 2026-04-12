'use strict';

process.env.QA_HARNESS_COMMAND_PREFIX = process.env.QA_HARNESS_COMMAND_PREFIX || 'npx ralph-qa-harness';

const { runCli } = require('./qa-harness');

process.exitCode = runCli(process.argv.slice(2));
