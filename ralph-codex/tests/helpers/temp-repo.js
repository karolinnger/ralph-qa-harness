'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function createTempRepo(t, options = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-codex-target-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.name', 'Ralph Test']);
  runGit(repoRoot, ['config', 'user.email', 'ralph@example.test']);

  writeFile(path.join(repoRoot, 'README.md'), '# Target Repo\n');
  writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: 'target-repo',
    private: true,
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  runGit(repoRoot, ['add', 'README.md', 'package.json']);
  runGit(repoRoot, ['commit', '-m', 'init']);

  if (typeof options.mutate === 'function') {
    options.mutate(repoRoot, writeFile);
  }

  return repoRoot;
}

module.exports = {
  createTempRepo,
  runGit,
  writeFile,
};
