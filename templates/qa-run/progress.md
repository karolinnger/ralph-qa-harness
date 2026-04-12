# QA Run Progress

## Rules

- Complete exactly one atomic item per iteration.
- Do not mark an item `pass` until verification succeeds.
- Record MCP fallback reasons in the selected item and `logs/fallback.log` when used.
- Treat `PRD.md`, `progress.md`, `PROMPT.md`, and `normalized.feature` as the run artifact set.

## Item Template

- [ ] `P-001` Goal: `<small atomic goal>`
  - Input: `<single source>`
  - Output: `<single artifact or code change>`
  - Verify: `<single proof step>`
  - Owner: `<agent>`
  - Status: `todo`
  - Retry budget: `2`
  - Result: ``
  - Fallback reason: ``

## Active Items

- [ ] `P-001` Goal: verify the stamped run artifacts and generated BDD specs
  - Input: `<jira ticket or feature path>`, `PRD.md`, `progress.md`, `PROMPT.md`, `normalized.feature`
  - Output: verifier proof recorded in `logs/verifier.log`
  - Verify: `npm run qa:orchestrator -- verify-run --run-id <run-id>`
  - Owner: `qa-verifier`
  - Status: `todo`
  - Retry budget: `1`
  - Result: ``
  - Fallback reason: ``

- [ ] `P-002` Goal: execute the generated run-backed scenario on Chromium
  - Input: `normalized.feature`
  - Output: runtime proof recorded in `logs/runtime.log`
  - Verify: `npm run qa:orchestrator -- execute-run --run-id <run-id> --project chromium`
  - Owner: `qa-executor`
  - Status: `todo`
  - Retry budget: `2`
  - Result: ``
  - Fallback reason: ``
