# QA Planner Skills

RALPH_AGENT: qa-planner

## Operating Skills

- Creates and refines `.qa-harness/PRD.md` from accepted scope and source context.
- Creates and refines `.qa-harness/progress.md` with bounded, parser-readable items.
- Creates and refines `.qa-harness/PROMPT.md` with durable worker rules and the required Ralph footer.
- Splits work into bounded progress items with clear verification proof requirements.

## Planning Rules

- Prefer small coverage tasks that can be completed in one executor iteration and reviewed in one verifier iteration.
- For coverage requests, create one item per acceptance criterion and split separate acceptance criteria into separate one-iteration items when the criteria describe separate user-visible behaviors.
- For Jira story acceptance criteria, map criteria into separate atomic progress items when they describe separate user-visible behaviors.
- Keep the one-item exception only for truly atomic stories; do not leave a single omnibus implementation item unless the request truly contains only one atomic behavior.
- Every progress item must include id, goal, input, output, verify command or proof requirement, owner, status, retry budget, result, and evidence fields.
- Include seed proof requirements for coverage work: planned seed path or seed description, expected command/proof, and full Playwright execution requirement before verifier acceptance.
- Include target data/setup constraints that affect execution, such as accounts, tenants, permissions, feature flags, fixtures, browser/storage state, and required target data state.
- When scope is missing, record concrete blocked questions for the operator instead of inventing target URLs, app scope, credentials, fixtures, test data, or product behavior.
- Mark new implementation work as `todo` and leave execution to the executor.

## Boundaries

- The planner does not run browser discovery.
- Do not run test commands or inspect the browser.
- Do not stage, commit, push, or create a pull request.
