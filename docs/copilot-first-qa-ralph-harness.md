# Copilot-First QA Ralph Harness

Status: Lean target design
Last updated: 2026-04-27

## Purpose

`ralph-qa-harness` is a lean command-line harness for supervised Playwright BDD work. It prepares one feature-backed work item, launches one fresh Copilot CLI process per run iteration, verifies generated Playwright BDD output, and records durable evidence on disk.

The product worker runtime is Copilot CLI. `ralph-codex` and Codex are only the builder loop used to implement this package; they are not the runtime used by `ralph-qa-harness` after the package is built.

The harness is intentionally file-backed and explicit. Operators should be able to understand the current objective, selected work, latest status, and validation result by inspecting `.qa-harness/` without relying on chat history.

## Goals

- Expose one small product CLI named `ralph-qa-harness`.
- Keep the operator command surface to `doctor`, `prepare`, `run`, `status`, and `verify`.
- Use Copilot CLI as the only product worker runtime.
- Use Playwright and `playwright-bdd` as required execution layers.
- Keep durable product state under `.qa-harness/`.
- Keep generated Playwright BDD output separate from durable product state.
- Run one bounded item per fresh Copilot process.
- Mark work complete only after Copilot reports `pass` and supervisor verification passes.

## Non-Goals

- The product harness is not a general automation framework.
- The product harness does not keep long-lived worker sessions.
- The product harness does not run full browser execution during `verify`; it proves generated specs and listed tests.
- The product harness does not store durable supervisor decisions in generated output directories.
- The product harness does not stage, commit, push, or open pull requests.

## Runtime Roles

The implementation effort and the product runtime are separate:

| Layer | Tool | Responsibility |
| --- | --- | --- |
| Builder supervisor | `ralph-codex` | Drives implementation iterations for this repository. |
| Builder worker | Codex | Edits this package during the build effort. |
| Product supervisor | `ralph-qa-harness` | Prepares work, launches workers, verifies results, and records evidence. |
| Product worker | Copilot CLI | Executes exactly one selected harness item per process. |
| BDD generator | `playwright-bdd` | Generates executable Playwright specs from feature files. |
| Test layer | Playwright | Lists generated tests and supplies browser/test infrastructure. |

## Command Surface

The final CLI exposes only these commands:

```text
ralph-qa-harness doctor
ralph-qa-harness prepare --from <feature-path>
ralph-qa-harness run --max-iterations <positive-integer>
ralph-qa-harness status
ralph-qa-harness verify
```

Unknown commands fail with exit code `1` and a clear message. Help output should list only the five commands above.

The npm package bin entrypoint remains:

```json
{
  "bin": {
    "ralph-qa-harness": "./bin/ralph-qa-harness.js"
  }
}
```

## Target Project Requirements

`ralph-qa-harness` works against a target project that has local Playwright BDD support. Playwright is required for browser/test execution, and `playwright-bdd` is required for executable feature generation from the selected feature file.

The supported target layout is:

- `playwright.config.*`
- `Features/**/*.feature`
- `Features/steps/**/*.ts`
- local Playwright package and CLI availability
- local `playwright-bdd` package and CLI availability

Generic non-Playwright framework support is outside this lean contract.

## Copilot Runtime Configuration

`.qa-harness/config.json` stores product-level harness configuration. It includes the Copilot command and no Codex configuration.

Platform defaults:

- Windows: `copilot.cmd`
- Non-Windows: `copilot`

`copilot.ps1` is not the Windows default. Operators may override the Copilot command in `.qa-harness/config.json` when their environment requires a different executable path.

## Artifact Layout

Durable product state lives under `.qa-harness/` in the target project:

```text
.qa-harness/
  config.json
  PRD.md
  progress.md
  PROMPT.md
  normalized.feature
  state.json
  runs/
    <run-id>/
      result.json
      loop-report.md
      validation.json
      diff.patch
      iterations/
        <nnn>/
          worker-prompt.md
          stdout.log
          stderr.log
          summary.json
          validation.json
          diff.patch
```

Generated Playwright BDD output may live under `.features-gen/.qa-harness/`. That path is generated output only. It must not contain supervisor decisions, durable progress, prompts, status files, or run reports.

The target project excludes both paths through `.git/info/exclude`:

```text
.qa-harness/
.features-gen/.qa-harness/
```

The product harness does not add those entries to tracked `.gitignore`.

## Artifact Semantics

### `.qa-harness/PRD.md`

`PRD.md` is the concise run objective generated from the selected feature. It names the source feature path, records the feature title when one exists, records the scenario count, states that `normalized.feature` is the execution truth, and states that Playwright plus `playwright-bdd` are required.

### `.qa-harness/progress.md`

`progress.md` is the work queue. A fresh `prepare` creates exactly one unchecked bounded execution item. The `run` command selects from this file and checks an item only after Copilot reports `pass` and supervisor `verify` passes.

### `.qa-harness/PROMPT.md`

`PROMPT.md` is the stable Copilot worker rule set. It requires one selected item per Copilot process, tells the worker to keep durable state in `.qa-harness/`, forbids staging, committing, pushing, and pull request creation, and requires the Ralph footer:

```text
RALPH_STATUS: pass|blocked|fail
RALPH_SUMMARY: <one concise paragraph>
RALPH_VALIDATION: <commands run, or why not run>
RALPH_NEXT: <next recommended action, or none>
```

### `.qa-harness/normalized.feature`

`normalized.feature` is copied from the path supplied to `prepare --from`. It preserves the selected feature content exactly unless a later explicit run item changes it. Verification uses this file as the run-backed feature truth.

### `.qa-harness/state.json`

`state.json` stores the latest prepared source path, normalized feature path, prepare timestamp, latest run id, active run id when a run is in progress, terminal status after a run stops, and enough information for `status` to work without chat context.

### `.qa-harness/runs/<run-id>/`

Each run directory records immutable-ish evidence for the run. Per-run files summarize the terminal result, latest verification, aggregate diff, and operator-readable report. Per-iteration files capture the exact worker prompt, stdout, stderr, parsed footer, command duration, changed files, validation result, and iteration diff.

## `doctor`

`doctor` checks the target project and reports each check separately as `pass` or `fail`:

- Node availability through the current process.
- npm availability.
- `git --version`.
- local Playwright package and CLI availability.
- local `playwright-bdd` package and CLI availability.
- at least one `Features/**/*.feature` file.
- step files under `Features/steps/`.
- Copilot CLI availability through the configured command.

On Windows, the default Copilot check is `copilot.cmd --help`. On non-Windows platforms, it is `copilot --help`. A configured override in `.qa-harness/config.json` takes precedence.

`doctor` fails clearly when Copilot is missing and tells the operator to install Copilot CLI or configure the command. The harness does not pretend it can continue without the product worker runtime.

## `prepare --from <feature-path>`

`prepare` creates or refreshes the durable harness artifacts for one selected feature:

1. Validate that `--from` is present.
2. Validate that the source exists and ends in `.feature`.
3. Create parent directories under `.qa-harness/`.
4. Copy the feature exactly to `.qa-harness/normalized.feature`.
5. Write `.qa-harness/config.json` if needed.
6. Generate concise `PRD.md`, `progress.md`, and `PROMPT.md`.
7. Record latest prepared state in `state.json`.
8. Ensure `.qa-harness/` and `.features-gen/.qa-harness/` are present in `.git/info/exclude`.

The initial progress file contains one unchecked item specific to the selected feature. The item states its input, expected output or evidence, and the validation that proves completion.

## `verify`

`verify` runs deterministic list-time checks from the target project root:

```text
npx bddgen export
npx bddgen test
npx playwright test --list
```

On Windows, the implementation may spawn `npx.cmd` internally.

Verification fails when:

- `bddgen export` exits nonzero.
- `bddgen export` reports zero registered steps.
- `bddgen test` exits nonzero.
- no generated spec can be found for the run-backed feature.
- `playwright test --list` exits nonzero.
- `playwright test --list` reports zero tests.

When a run exists, `verify` writes structured validation output to `.qa-harness/runs/<run-id>/validation.json`. `verify` without a run still prints useful output and does not crash.

## `run --max-iterations <positive-integer>`

`run` requires a prepared state and a positive integer iteration budget. Each iteration:

1. Selects exactly one unchecked item from `.qa-harness/progress.md`.
2. Builds a worker prompt from `PRD.md`, `progress.md`, `PROMPT.md`, and the selected item.
3. Writes the prompt to `.qa-harness/runs/<run-id>/iterations/<nnn>/worker-prompt.md`.
4. Launches one fresh Copilot process.
5. Sends the prompt on stdin.
6. Captures stdout, stderr, exit code, duration, changed files, parsed footer, and diff.
7. Stops immediately on missing footer, invalid footer, worker `fail`, worker `blocked`, validation failure, stalled progress, or budget exhaustion.
8. Runs supervisor `verify` after a worker `pass`.
9. Checks the selected item only when the worker passed and verification passed.

The required footer status values are `pass`, `blocked`, and `fail`.

Terminal run status values are:

- `completed`
- `failed`
- `blocked`
- `stalled`
- `budget-exhausted`

`budget-exhausted` means the requested iteration limit was reached while unchecked items remain and no terminal failure occurred.

## `status`

`status` reads `.qa-harness/state.json` and run artifacts. It covers:

- no prepared state
- prepared but not run
- active run
- latest completed run
- blocked run
- failed run
- stalled run
- budget-exhausted run

Output includes the selected feature, latest run id when present, terminal status when present, stop reason, validation state, and the next useful command.

## Reports and Diffs

The harness writes:

- `.qa-harness/runs/<run-id>/result.json`
- `.qa-harness/runs/<run-id>/loop-report.md`
- `.qa-harness/runs/<run-id>/validation.json`
- `.qa-harness/runs/<run-id>/diff.patch`
- `.qa-harness/runs/<run-id>/iterations/<nnn>/summary.json`
- `.qa-harness/runs/<run-id>/iterations/<nnn>/validation.json`
- `.qa-harness/runs/<run-id>/iterations/<nnn>/diff.patch`

Iteration diffs should describe only changes from the current iteration. Pre-existing dirty files are excluded unless the current iteration actually changes them. New text files created during the iteration are included when reasonably small; oversized or binary diffs are summarized without crashing.

## Completion Rule

An item in `.qa-harness/progress.md` is complete only when all of these are true:

- Copilot exits zero.
- The Copilot footer is present and valid.
- `RALPH_STATUS` is `pass`.
- Supervisor `verify` passes after Copilot exits.
- The selected item is the item being marked complete.

Any weaker outcome leaves the item unchecked and records the stop reason in run artifacts.

## Acceptance Summary

The lean harness is acceptable when it exposes the five-command CLI, uses Copilot CLI as the product worker, uses Playwright plus `playwright-bdd` for executable BDD validation, keeps durable state under `.qa-harness/`, treats `.features-gen/.qa-harness/` only as generated output, excludes runtime paths through `.git/info/exclude`, launches one fresh Copilot process per iteration through stdin, records evidence per run and iteration, and never stages, commits, pushes, or creates pull requests.
