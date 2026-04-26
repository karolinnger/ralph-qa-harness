'use strict';

const mode = process.env.RALPH_FAKE_VALIDATION_MODE || process.argv[2] || 'pass';

if (mode === 'timeout') {
  setTimeout(() => {}, 60_000);
} else if (mode === 'fail') {
  process.stderr.write('fake validation failed\n');
  process.exitCode = 3;
} else {
  process.stdout.write('fake validation passed\n');
}
