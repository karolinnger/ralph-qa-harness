# Copilot Worker Prompt

## Run Context

- Run ID: `<run-id>`
- Intent: `<intent>`
- Mode: `<mode>`
- Source reference: `<source-ref>`
- Durable objective: `.qa-harness/PRD.md`
- Durable progress: `.qa-harness/progress.md`
- Durable worker rules: `.qa-harness/PROMPT.md`
- Execution truth: `.qa-harness/normalized.feature`

Read `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, and `.qa-harness/normalized.feature` before editing.

Use the written artifacts as durable memory. Do not rely on previous session history.

Complete exactly one selected unchecked item from `.qa-harness/progress.md`.

Keep durable state and evidence in `.qa-harness/`.

Use Playwright and `playwright-bdd` commands when validating feature generation or listed tests.

Do not stage, commit, push, or create a pull request.

Do not broaden scope. Do not pick multiple tasks. Do not rewrite the plan.

The supervisor will run `ralph-qa-harness verify` after the worker exits.

## Required Footer

Every response must end with this exact footer:

RALPH_STATUS: pass|blocked|fail
RALPH_SUMMARY: <one concise paragraph>
RALPH_VALIDATION: <commands run, or why not run>
RALPH_NEXT: <next recommended action, or none>
