'use strict';

const { allTasksComplete, parsePlanCheckboxes, selectNextTask } = require('./plan');

const HEALER_STATUSES = new Set(['fail', 'failed', 'blocked']);
const EXECUTOR_STATUSES = new Set(['todo', 'doing', '']);
const VERIFY_STATUSES = new Set(['needs-verification', 'verify', 'pending-verifier']);

function normalizeStatus(value, checked) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (status) {
    return status.replace(/^`|`$/gu, '');
  }
  return checked ? 'pass' : 'todo';
}

function parseProgressItems(markdown) {
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
      const statusMatch = lineText.match(/^\s+-\s+Status:\s*(.+?)\s*$/iu);
      if (statusMatch && items.length > 0) {
        items[items.length - 1].status = normalizeStatus(statusMatch[1], items[items.length - 1].checked);
      }
      return;
    }

    const checked = checkboxMatch[2].toLowerCase() === 'x';
    const rawText = checkboxMatch[3].trim();
    const idMatch = rawText.match(/^`([^`]+)`\s+(.+)$/u);
    const line = index + 1;
    items.push({
      id: idMatch ? idMatch[1].trim() : `L${line}`,
      line,
      checked,
      text: idMatch ? idMatch[2].trim() : rawText,
      heading: currentHeading,
      status: normalizeStatus('', checked),
    });
  });
  return items;
}

function hasMeaningfulArtifact(markdown) {
  return String(markdown || '').trim().length > 0;
}

function parseEventIds(progress, label) {
  const ids = [];
  const pattern = new RegExp(`^${label}:\\s*(\\S+)\\s*$`, 'gimu');
  let match = pattern.exec(String(progress || ''));
  while (match) {
    ids.push(match[1].trim());
    match = pattern.exec(String(progress || ''));
  }
  return ids;
}

function findPendingVerifierItem(progress, items) {
  const pendingIds = parseEventIds(progress, 'Pending verifier');
  const acceptedIds = new Set(parseEventIds(progress, 'Verifier accepted'));
  for (let index = pendingIds.length - 1; index >= 0; index -= 1) {
    const id = pendingIds[index];
    if (!acceptedIds.has(id)) {
      return items.find((item) => item.id === id) || {
        id,
        line: 0,
        checked: false,
        text: id,
        heading: '',
        status: 'needs-verification',
      };
    }
  }
  return items.find((item) => VERIFY_STATUSES.has(item.status)) || null;
}

function convertPlanTaskToProgressTask(task) {
  if (!task) {
    return null;
  }
  return {
    ...task,
    status: task.checked ? 'pass' : 'todo',
  };
}

function selectNextAction({ prd, prompt, progress, implementationPlan }) {
  const items = parseProgressItems(progress);
  const nextPlanTask = convertPlanTaskToProgressTask(selectNextTask(implementationPlan));
  if (items.length === 0 && nextPlanTask && hasMeaningfulArtifact(prd)) {
    return {
      role: 'executor',
      reason: 'legacy implementation plan item',
      task: nextPlanTask,
    };
  }

  if (!hasMeaningfulArtifact(prd) || items.length === 0) {
    return {
      role: 'planner',
      reason: 'missing or empty PRD/progress artifacts',
      task: null,
    };
  }

  const pendingVerifier = findPendingVerifierItem(progress, items);
  if (pendingVerifier) {
    return {
      role: 'verifier',
      reason: 'pending verifier review',
      task: pendingVerifier,
    };
  }

  const failedItem = items.find((item) => !item.checked && HEALER_STATUSES.has(item.status));
  if (failedItem) {
    return {
      role: 'healer',
      reason: 'failed or blocked progress item',
      task: failedItem,
    };
  }

  const nextProgressItem = items.find((item) => !item.checked && EXECUTOR_STATUSES.has(item.status));
  if (nextProgressItem) {
    return {
      role: 'executor',
      reason: 'next actionable progress item',
      task: nextProgressItem,
    };
  }

  if (nextPlanTask) {
    return {
      role: 'executor',
      reason: 'legacy implementation plan item',
      task: nextPlanTask,
    };
  }

  return null;
}

function allProgressItemsComplete(progress) {
  const items = parseProgressItems(progress);
  if (items.length === 0) {
    return false;
  }
  const acceptedIds = new Set(parseEventIds(progress, 'Verifier accepted'));
  return items.every((item) => item.checked || item.status === 'pass' || acceptedIds.has(item.id));
}

function allWorkComplete({ progress, implementationPlan }) {
  if (allProgressItemsComplete(progress)) {
    return true;
  }
  return parseProgressItems(progress).length === 0 && allTasksComplete(implementationPlan);
}

module.exports = {
  allProgressItemsComplete,
  allWorkComplete,
  parseProgressItems,
  selectNextAction,
};
