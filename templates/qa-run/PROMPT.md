# Ralph Iteration Prompt

## Run Context

- Run ID: `<run-id>`
- Intent: `<intent>`
- Mode: `<mode>`
- Source reference: `<source-ref>`
- Execution truth: `normalized.feature`

Study `PRD.md` thoroughly.

Study `progress.md` thoroughly.

Study `normalized.feature` thoroughly.

Use the written artifacts as the source of truth. Do not rely on previous session history.

If the orchestrator provides a selected progress item through the runtime adapter, work only on that item.

Otherwise, pick the highest-leverage unchecked progress item that can be completed safely in one iteration.

Complete exactly one atomic task.

Use this tool order:

1. Playwright CLI
2. Playwright test or debug bridge
3. MCP only after Playwright CLI and the Playwright test/debug bridge are exhausted

If Playwright CLI is insufficient, request the Playwright test/debug bridge before considering MCP.

If MCP is used, record the exact fallback reason in `progress.md` and `logs/fallback.log`.

After implementation, run an unbiased verification step.

Only mark the task complete if verification passes.

If verification fails, mark the task `fail` or `blocked` and record the cause.

Do not broaden scope. Do not pick multiple tasks. Do not rewrite the plan.
