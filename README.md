# Ralph QA Harness

`ralph-qa-harness` is a lean npm CLI for supervised Playwright BDD work. It prepares one feature-backed work item, launches a fresh Copilot CLI process for each bounded worker iteration, verifies generated Playwright BDD output, and records durable evidence in the target project.

The product worker runtime is Copilot CLI. `ralph-codex` and Codex are only used to build this package; they are not the runtime used by `ralph-qa-harness`.

## Maturity

- Status: pilot / supervised use
- Intended users: operators running file-backed Playwright BDD QA workflows
- Stability goal: reproducible runs against target projects that match the supported layout
- Non-goals: generic framework support, hidden background autonomy, broad source intake, and multi-role worker topologies

## Prerequisites

- Node.js 20+
- npm
- git
- Copilot CLI available on `PATH`
- A target project with:
  - local `@playwright/test`
  - local `playwright-bdd`
  - `playwright.config.*`
  - `Features/**/*.feature`
  - `Features/steps/**/*.ts`

On Windows, the default product worker command is `copilot.cmd`. On non-Windows platforms, the default command is `copilot`. Operators may override the command in `.qa-harness/config.json` when their environment requires an explicit path or different executable name.

## Install From Source

Clone this repository, then choose one local development flow.

Use `npm link`:

```bash
cd /path/to/ralph-qa-harness
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

## Target Project Contract

The harness intentionally supports one narrow Playwright BDD layout:

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

Playwright is required for browser/test integration, and `playwright-bdd` is required for executable feature generation. The harness does not provide generic non-Playwright framework support.

## Quick Start

From the target project root:

```bash
npx ralph-qa-harness doctor
npx ralph-qa-harness prepare --from Features/homepage.feature
npx ralph-qa-harness run --max-iterations 2
npx ralph-qa-harness status
npx ralph-qa-harness verify
```

Review `.qa-harness/progress.md`, `.qa-harness/state.json`, and the latest `.qa-harness/runs/<run-id>/` artifacts between bounded runs.

## Commands

The operator-facing command surface is intentionally small:

```text
ralph-qa-harness doctor
ralph-qa-harness prepare --from <feature-path>
ralph-qa-harness run --max-iterations <positive-integer>
ralph-qa-harness status
ralph-qa-harness verify
```

### `doctor`

Checks the target project and reports each check separately as `pass` or `fail`:

- Node runtime
- npm availability
- git availability
- local Playwright package and CLI availability
- local `playwright-bdd` package and CLI availability
- supported `Features/` layout
- Copilot CLI availability through the configured command

`doctor` fails clearly when Copilot CLI is missing. On Windows it checks `copilot.cmd --help` by default; on non-Windows platforms it checks `copilot --help`.

### `prepare --from <feature-path>`

Creates or refreshes `.qa-harness/` for a selected `.feature` file:

- copies the selected feature exactly to `.qa-harness/normalized.feature`
- writes `.qa-harness/config.json`
- writes a concise `.qa-harness/PRD.md`
- writes one bounded unchecked item in `.qa-harness/progress.md`
- writes stable Copilot worker rules to `.qa-harness/PROMPT.md`
- records latest prepared state in `.qa-harness/state.json`
- ensures `.qa-harness/` and `.features-gen/.qa-harness/` are excluded through `.git/info/exclude`

`normalized.feature` is the execution truth for the harness run.

### `run --max-iterations <positive-integer>`

Runs a bounded supervisor loop. Each iteration:

- selects exactly one unchecked item from `.qa-harness/progress.md`
- builds a worker prompt from `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, and the selected item
- launches one fresh Copilot CLI process
- sends the prompt on stdin
- captures stdout, stderr, summary, validation, changed files, and diff evidence
- marks the selected item complete only when Copilot reports `RALPH_STATUS: pass` and supervisor verification passes

Worker output must end with:

```text
RALPH_STATUS: pass|blocked|fail
RALPH_SUMMARY: <one concise paragraph>
RALPH_VALIDATION: <commands run, or why not run>
RALPH_NEXT: <next recommended action, or none>
```

Missing or invalid footer output is a terminal worker failure.

### `status`

Reads `.qa-harness/state.json` and run artifacts to print the prepared feature, latest or active run id, terminal status, stop reason, and validation state. It also gives a useful no-run message before `prepare` has been run.

### `verify`

Runs list-time Playwright BDD validation from the target project root:

```bash
npx bddgen export
npx bddgen test
npx playwright test --list
```

Verification fails if any command exits nonzero, if `bddgen export` reports zero registered steps, if no generated spec can be found for the run-backed feature, or if Playwright lists zero tests. It does not run full browser execution as part of the lean contract.

When a run exists, `verify` writes structured output to `.qa-harness/runs/<run-id>/validation.json`.

## Artifact Layout

Durable runtime state lives under `.qa-harness/` in the target project:

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

Generated Playwright BDD output may live under `.features-gen/.qa-harness/`. That path is generated output only, not durable supervisor state.

The target project should exclude both runtime paths through `.git/info/exclude`:

```text
.qa-harness/
.features-gen/.qa-harness/
```

The harness must not add those entries to tracked `.gitignore`.

## Runtime Files

- `.qa-harness/config.json`
  Stores product-level configuration, including the Copilot command. It does not store Codex configuration.
- `.qa-harness/PRD.md`
  Stores the concise run objective generated from the selected feature path.
- `.qa-harness/progress.md`
  Stores bounded checkbox work and is the source used by `run` to select work.
- `.qa-harness/PROMPT.md`
  Stores stable Copilot worker rules, including the required footer and the no-stage/no-commit/no-push/no-PR rule.
- `.qa-harness/normalized.feature`
  Stores the exact selected feature content used as the execution truth.
- `.qa-harness/state.json`
  Stores prepared source path, normalized feature path, latest run id, active run id, terminal status, and enough data for `status`.
- `.qa-harness/runs/<run-id>/`
  Stores immutable-ish run evidence and per-iteration artifacts.

## Supervised Use Expectations

Use this tool as a supervised harness.

- Keep iteration budgets explicit and small.
- Review `.qa-harness/progress.md` and latest run artifacts between runs.
- Treat a worker `pass` as incomplete until supervisor `verify` passes.
- Do not stage, commit, push, or create pull requests from inside a harness run.

## Repository Contents

- `bin/`
  npm CLI entrypoint
- `scripts/`
  harness implementation
- `templates/`
  prompt and artifact templates owned by the package
- `docs/`
  target design and packaging notes
- `tests/`
  CLI, doctor, package, and harness tests

Additional notes:

- [docs/packaging-notes.md](docs/packaging-notes.md)
- [docs/copilot-first-qa-ralph-harness.md](docs/copilot-first-qa-ralph-harness.md)
