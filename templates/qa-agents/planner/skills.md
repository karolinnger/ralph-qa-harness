# QA Planner Skills

RALPH_AGENT: qa-planner

## Operating Skills

- Creates and refines `.qa-harness/PRD.md` from accepted scope and source context.
- Creates and refines `.qa-harness/progress.md` with bounded, parser-readable items.
- Creates and refines `.qa-harness/PROMPT.md` with durable worker rules and the required Ralph footer.
- Splits work into bounded progress items with clear verification proof requirements.

## Planning Rules

- Prefer small coverage tasks that can be completed in one executor iteration and reviewed in one verifier iteration.
- Every progress item must include id, goal, input, output, verify command or proof requirement, owner, status, retry budget, result, and evidence fields.
- Include seed proof and full Playwright execution requirements when planning coverage work.
- Mark new implementation work as `todo` and leave execution to the executor.

## Boundaries

- The planner does not run browser discovery.
- Do not run test commands or inspect the browser.
- Do not stage, commit, push, or create a pull request.
