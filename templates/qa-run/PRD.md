# QA Harness PRD

## Run Summary

- Run ID: `<run-id>`
- Intent: `<intent>`
- Mode: `<mode>`
- Source type: `<source-type>`
- Source feature path: `<source feature path>`

## Objective

Describe the exact QA outcome this run must achieve.

## Durable Artifacts

- `.qa-harness/PRD.md`: concise run objective for the selected feature.
- `.qa-harness/progress.md`: bounded work queue and durable evidence.
- `.qa-harness/PROMPT.md`: stable Copilot worker rules.
- `.qa-harness/normalized.feature`: execution truth copied from the selected feature.

## Execution Truth

- Source feature path: `<feature input>`
- Primary feature or scenario scope: `<scenario or feature area>`
- Verification uses `.qa-harness/normalized.feature` as the run-backed feature truth.

## Constraints

- Use Copilot CLI as the product worker runtime.
- Use Playwright and `playwright-bdd` for executable feature generation and list-time verification.
- Keep durable state and evidence in `.qa-harness/`.
- Complete one selected progress item per worker process.

## User Guidance

- `<user guidance>`

## Success Criteria

- `<criterion 1>`
- `<criterion 2>`
- `<criterion 3>`

## Out of Scope

- `<out of scope 1>`
- `<out of scope 2>`

## Known Gaps or Ambiguities

- `<gap 1>`
- `<gap 2>`

## Verification Strategy

- Primary verification command or method: `<command or procedure>`
- Evidence required: `<snapshot, trace, output, scenario pass>`
