# QA Harness Progress

## Rules

- Complete exactly one selected checkbox item per Copilot process.
- Use `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, and `.qa-harness/normalized.feature` as durable memory.
- Do not stage, commit, push, or create a pull request.
- Mark an item complete only after Copilot returns `RALPH_STATUS: pass` and supervisor `ralph-qa-harness verify` passes.

## Item Template

- [ ] `P-001` Goal: `<small atomic goal>`
  - Input: `<single source>`
  - Output: `<single artifact or code change>`
  - Verify: `<single proof step>`
  - Owner: `<owner role>`
  - Agent: `<agent role>`
  - Mode: `<planning|implementation|verification|healing|routing>`
  - Status: `todo`
  - Retry budget: `1`
  - Result: ``
  - Evidence: ``
  - Fallback reason: ``
  - Block reason: ``

## Active Items

- [ ] `P-001` Goal: execute the selected feature through Copilot-supervised Playwright BDD verification
  - Input: `<feature path>`, `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, `.qa-harness/normalized.feature`
  - Output: evidence recorded in `.qa-harness/progress.md`
  - Verify: `ralph-qa-harness verify` passes for run `<run-id>`
  - Owner: `<owner role>`
  - Agent: `<agent role>`
  - Mode: `<mode>`
  - Status: `todo`
  - Retry budget: `1`
  - Result: ``
  - Evidence: ``
  - Fallback reason: ``
  - Block reason: ``
