# Packaging Notes

This repository packages the QA harness as a standalone npm CLI with a narrow, explicit target-project contract.

## Included components

- `scripts/qa-harness.js`
- `scripts/qa-orchestrator.js`
- `scripts/qa-runtime-external-worker.js`
- `scripts/qa-runtime-mock-adapter.js`
- `examples/qa-runtime-demo-agent.js`
- `templates/qa-run/*`
- `docs/copilot-first-qa-ralph-harness.md`
- `tests/harness/qa-harness.test.js`

## Standalone-specific changes

- Package-owned templates resolve from this package instead of from the target project.
- The operator-facing CLI name is `ralph-qa-harness`.
- `doctor` and `preflight` validate the current supported target-project contract.
- Public docs focus on how to use the package from a compatible target project root.

## Intentionally out of scope

- Product code outside the harness runtime.
- Broad plugin systems or framework-agnostic abstractions.
- Pause/resume/background-worker autonomy.

## Remaining coupling

The current release still expects the target project to provide:

- `Features/**/*.feature`
- `Features/steps/**/*.ts`
- `playwright.config.*`
- local `@playwright/test`
- local `playwright-bdd`

Those assumptions are documented explicitly instead of being generalized away in v1.
