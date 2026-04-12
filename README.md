# Ralph QA Harness

`ralph-qa-harness` is a standalone npm CLI package for artifact-first browser QA workflows.

It runs an artifact-first QA workflow for Playwright + `playwright-bdd` projects that use the supported layout documented below. The harness keeps the current command surface, keeps verifier review as the boundary before reported `pass`, preserves the runtime worker JSON contract, and keeps append-only logs and reports under `.qa-harness/runs/<run-id>/`.

## Maturity

This is a pragmatic first standalone release, not a broad framework product.

- Status: pilot / supervised use
- Intended users: operators running supervised Playwright BDD QA workflows
- Stability goal: reproducible runs against target projects that match the supported Playwright BDD setup
- Non-goal for v0.1: framework-agnostic abstractions, background autonomy, or broad source-intake redesign

## Prerequisites

- Node.js 20+
- npm
- A target project with:
  - local `@playwright/test`
  - local `playwright-bdd`
  - a `playwright.config.*`
  - `Features/**/*.feature`
  - `Features/steps/**/*.ts`
- Playwright browsers installed for the target project

This package assumes the target project root matches the supported Playwright BDD layout below. That narrow assumption is intentional in v1.

## Install From Source

Clone this repository, then choose one of these local-dev flows.

Use `npm link`:

```bash
cd ralph-qa-harness
npm link
cd /path/to/target-project
ralph-qa-harness doctor
```

Use the bin script directly from a target project root:

```bash
node /path/to/ralph-qa-harness/bin/ralph-qa-harness.js doctor
```

Use a local package install in the target project:

```bash
cd /path/to/target-project
npm install --save-dev /path/to/ralph-qa-harness
npx ralph-qa-harness doctor
```

## Install As An npm CLI

Once published:

```bash
npm install --save-dev ralph-qa-harness
```

Then run it from the target project root:

```bash
npx ralph-qa-harness doctor
```

## Playwright Setup

From the target project root:

```bash
npm install --save-dev @playwright/test playwright-bdd
npx playwright install
```

If the target project already has those dependencies, only the browser install step may still be required.

## Target Project Contract

This package does not try to discover or support arbitrary project structures in v1.

Expected target-project layout:

```text
package.json
playwright.config.ts|js|mts|cts|mjs|cjs
Features/
  *.feature
  **/*.feature
  steps/
    *.ts
    **/*.ts
```

Expected behavior assumptions:

- `playwright-bdd` generates specs from `Features/**/*.feature` and `.qa-harness/runs/**/*.feature`
- Playwright runs from the target project root
- Canonical features live under `Features/`
- Canonical reusable steps live under `Features/steps/`

## Quick Start

From the target project root:

```bash
npx ralph-qa-harness doctor --project chromium
npx ralph-qa-harness prepare-run --intent coverage --source-type feature --source-ref Features/homepage.feature --mode guided-exploratory --scope single-feature --constraint "feature: homepage" --constraint "risk area: alternate navigation path" --constraint "iteration budget: 1"
npx ralph-qa-harness verify-run --run-id <run-id> --project chromium
npx ralph-qa-harness advance-run --run-id <run-id> --adapter external --project chromium
```

If you want bounded supervisory looping:

```bash
npx ralph-qa-harness loop-run --run-id <run-id> --max-iterations 2 --adapter external --project chromium
```

Review the run artifacts between iterations.

## Doctor / Preflight

`doctor` and `preflight` are aliases.

They validate:

- Node/npm availability
- local Playwright CLI availability
- local `playwright-bdd` CLI availability
- installed Playwright browsers
- target-project layout
- optional external runtime override env vars
- optional Playwright bridge env vars when requested
- optional base URL / target environment inputs

Examples:

```bash
npx ralph-qa-harness doctor
npx ralph-qa-harness doctor --project chromium
npx ralph-qa-harness preflight --require-bridge true
npx ralph-qa-harness doctor --adapter external --base-url https://staging.example.com --target-env staging
```

## Command Reference

The operator-facing commands are unchanged:

- `create-run`
- `prepare-run`
- `verify-run`
- `execute-run`
- `advance-run`
- `iterate-run`
- `loop-run`

Examples:

```bash
npx ralph-qa-harness prepare-run --intent plan --source-type feature --source-ref Features/homepage.feature
npx ralph-qa-harness prepare-run --request "coverage for Features/homepage.feature in guided-exploratory mode"
npx ralph-qa-harness prepare-run --run-id <run-id>
npx ralph-qa-harness verify-run --run-id <run-id> --project chromium
npx ralph-qa-harness execute-run --run-id <run-id> --project chromium --headed true
npx ralph-qa-harness advance-run --run-id <run-id> --adapter external --project chromium
npx ralph-qa-harness iterate-run --run-id <run-id> --adapter mock
npx ralph-qa-harness loop-run --run-id <run-id> --max-iterations 3 --adapter external --project chromium
```

## Execution Controls

Supported additive execution-control flags:

- `--project <project>`
- `--headed <true|false>`
- `--debug <true|false>`
- `--base-url <url>`
- `--target-env <name>`
- `--trace <mode>`
- `--video <mode>`
- `--screenshot <mode>`

These controls are recorded in the run artifacts and reused across later verifier/executor flows within the same run.

## Artifact Layout

Each run writes to the target project:

```text
.qa-harness/
  runs/
    <run-id>/
      PRD.md
      progress.md
      PROMPT.md
      normalized.feature
      evidence/
        screenshots/
        snapshots/
        traces/
        videos/
      logs/
        runtime.log
        verifier.log
        fallback.log
      outputs/
        gap-analysis.md
        planner-handoff.md
        promotion-report.md
        scenario-addition.md
        heal-report.md
        loop-report.md
```

History is append-only where the current harness already treats it as history:

- `logs/*.log`
- structured reports under `outputs/*.md`

## Env Vars

User-facing env vars:

- `PLAYWRIGHT_BASE_URL`
  Optional default base URL for execution.
- `QA_HARNESS_TARGET_ENV`
  Optional environment label recorded in run artifacts.
- `QA_HARNESS_EXTERNAL_RUNTIME_CMD`
  Optional override for the external runtime command. Leave unset to use the bundled external worker.
- `QA_HARNESS_EXTERNAL_RUNTIME_ARGS`
  Optional JSON array of extra args for the external runtime command.
- `QA_HARNESS_PLAYWRIGHT_BRIDGE_CMD`
  Optional command for the Playwright test/debug bridge.
- `QA_HARNESS_PLAYWRIGHT_BRIDGE_ARGS`
  Optional JSON array of extra args for the bridge command.

Examples live in [.env.example](.env.example).

## Canonical Promotion

Canonical promotion is preserved in this standalone package under the same target-project setup.

What stays true:

- scenario addition remains bounded and artifact-backed
- verifier review remains the boundary before `advance-run` reports `pass`
- promotion only targets canonical `Features/*.feature` content under the target project
- reusable promotion step generation remains bounded to `Features/steps/promotion-generated.ts`
- promotion still fails or blocks on ambiguity, drift, conflict markers, or unverifiable step coverage

This package does not silently weaken verifier/runtime boundaries.

## Current Limitations

- Target projects must match the supported Playwright BDD layout documented in this README.
- Source intake is still intentionally narrow.
- The harness is still fresh-session and artifact-first; it does not keep hidden conversational state.
- No pause/resume/background-worker autonomy is included in this slice.
- `doctor` validates the current supported contract; it is not a generic framework detector.
- The design doc is still shaped around the current harness contract rather than a broader framework abstraction.

## Supervised Use Expectations

Use this tool as a supervised harness, not as an unsupervised agent runner.

- Review `progress.md`, `logs/runtime.log`, `logs/verifier.log`, and relevant `outputs/*.md` after each bounded step.
- Treat reported `pass` as valid only after verifier-backed review.
- Review canonical promotion outcomes before merging promoted feature changes.
- Keep loop budgets explicit and small during pilot use.

## Roadmap / Next Steps

- Harden portability and burn-in on clean laptops and CI.
- Add more integration coverage around the real external worker path.
- Improve operator lifecycle controls without widening autonomy.
- Revisit broader source intake only after the current target-project contract is stable.
- Consider broader framework support only after this narrow Playwright BDD package is trusted.

## Repository Contents

- `bin/`
  npm CLI entrypoint
- `scripts/`
  extracted harness core and runtime adapters
- `templates/`
  run artifact templates owned by the package
- `docs/`
  design doc plus standalone packaging notes
- `examples/`
  example runtime/demo assets and usage workflow
- `tests/`
  extracted harness tests plus package-specific CLI and doctor coverage

Additional notes:

- [examples/use-from-another-project.md](examples/use-from-another-project.md)
- [docs/packaging-notes.md](docs/packaging-notes.md)
- [docs/copilot-first-qa-ralph-harness.md](docs/copilot-first-qa-ralph-harness.md)
