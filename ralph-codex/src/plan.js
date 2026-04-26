'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveRalphPaths } = require('./state');

function parsePlanCheckboxes(markdown) {
  const lines = String(markdown || '').split(/\r?\n/u);
  let currentHeading = '';
  const items = [];
  lines.forEach((lineText, index) => {
    const headingMatch = lineText.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (headingMatch) {
      currentHeading = headingMatch[1].trim();
    }
    const checkboxMatch = lineText.match(/^(\s*)-\s+\[([ xX])\]\s+(.+)$/u);
    if (!checkboxMatch) {
      return;
    }
    const line = index + 1;
    items.push({
      id: `L${line}`,
      line,
      checked: checkboxMatch[2].toLowerCase() === 'x',
      text: checkboxMatch[3].trim(),
      heading: currentHeading,
    });
  });
  return items;
}

function selectNextTask(markdown) {
  return parsePlanCheckboxes(markdown).find((item) => !item.checked) || null;
}

function allTasksComplete(markdown) {
  const items = parsePlanCheckboxes(markdown);
  return items.length > 0 && items.every((item) => item.checked);
}

function importPlan({ repoRoot, sourcePath, force = false }) {
  const paths = resolveRalphPaths(repoRoot);
  if (!fs.existsSync(paths.configPath)) {
    throw new Error('Run `ralph-codex init` first; .ralph/config.json is missing.');
  }
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`Plan source does not exist: ${sourcePath || '(missing)'}`);
  }
  if (fs.existsSync(paths.planPath) && !force) {
    const existing = fs.readFileSync(paths.planPath, 'utf8');
    if (existing.trim() && !/^# Implementation Plan\s*- \[ \] Add implementation plan items\./u.test(existing.trim())) {
      throw new Error('Refusing to overwrite .ralph/IMPLEMENTATION_PLAN.md without --force true.');
    }
  }
  fs.mkdirSync(path.dirname(paths.planPath), { recursive: true });
  fs.copyFileSync(sourcePath, paths.planPath);
  return { sourcePath, targetPath: paths.planPath };
}

module.exports = {
  parsePlanCheckboxes,
  selectNextTask,
  allTasksComplete,
  importPlan,
};
