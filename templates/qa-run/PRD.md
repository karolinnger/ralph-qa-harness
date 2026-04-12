# QA Run PRD

## Run Summary

- Run ID: `<run-id>`
- Intent: `<intent>`
- Mode: `<mode>`
- Source type: `<source-type>`
- Source reference: `<ticket, file, scenario, or run>`

## Objective

Describe the exact QA outcome this run must achieve.

## Normalized Execution Truth

- Feature file: `normalized.feature`
- Primary scenario scope: `<scenario or feature area>`

## Inputs

- Jira input: `<optional>`
- Feature input: `<optional>`
- Existing failing scenario: `<optional>`
- User guidance: `<optional>`

## Constraints

- Prefer Playwright CLI first.
- Use Playwright test/debug second.
- Use MCP only with explicit fallback reason recorded in `progress.md` and `logs/fallback.log`.
- Keep work atomic enough for one progress item per iteration.

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
