# Overnight Ralph Loop Handoff: Lean Copilot QA Harness

## Purpose

This document is the complete handoff for an unattended `ralph-codex` implementation run.

The target package is `ralph-qa-harness`, located at `C:\Users\kolos\IdeaProjects\Colossus`. There is no nested `ralph-qa-harness` subdirectory. Treat the repository root as the package root.

The intended product is a lean QA harness CLI that supervises Playwright BDD work by launching the standalone Copilot CLI once per worker iteration. The product must be simple, file-backed, and explicit. It must not preserve the existing broad backend architecture unless a specific piece is required by the lean contract below.

## Alignment With Original Idea

This plan exists to implement the original lean Copilot QA harness idea, not a broader framework rewrite.

- Keep: `ralph-codex` as the overnight builder loop.
- Keep: Codex as the implementation worker launched by `ralph-codex`.
- Keep: Copilot CLI as the product worker runtime launched by `ralph-qa-harness`.
- Keep: Playwright integration.
- Keep: `playwright-bdd` as the executable BDD layer.
- Keep: a small command surface shaped like the `ralph-codex` loop.
- Keep: durable product state under `.qa-harness/`.
- Keep: generated Playwright BDD output separate from durable product state.
- Remove: runtime adapter abstraction.
- Remove: clarifier, explorer, healer, and multi-role topology.
- Remove: plugin, MCP, and Jira architecture.
- Remove: planner handoff.
- Remove: promotion reports.
- Remove: scenario-addition machinery.
- Remove: long historical design notes.

If any implementation choice conflicts with this alignment section, this alignment section wins.

## Runtime Roles

- Builder supervisor: `ralph-codex`.
- Builder worker: Codex launched by `ralph-codex`.
- Product supervisor being built: `ralph-qa-harness`.
- Product worker being built: standalone Copilot CLI.
- Product worker command on Windows: `copilot.cmd`.
- Product worker command on non-Windows platforms: `copilot`.
- Product BDD layer: `playwright-bdd`.
- Product browser/test layer: Playwright.

Do not confuse the builder runtime with the product runtime. Codex implements the harness. The harness being implemented launches Copilot workers.

## Non-Negotiable Constraints

- Do not run `git clean`.
- Do not run `git reset --hard`.
- Do not run broad `git restore`, `git checkout -- .`, or any command that reverts user work.
- Do not stage files.
- Do not commit.
- Do not push.
- Do not create a pull request.
- Do not change branches unless the user explicitly asks.
- Do not assume an untracked or modified file is disposable.
- Do not fake tool availability. If `codex.cmd` or Copilot is missing, report the exact failure.
- Do not keep obsolete command surfaces for compatibility unless the checklist explicitly says to preserve one.
- Do not widen the scope into Jira, MCP, plugins, multiple agent roles, autonomous exploration, healing, promotion, or scenario addition.

## Overnight Loop Budget

Use bounded batches instead of one very large run.

- Run at most 40 iterations per `ralph-codex run` invocation.
- Run at most 120 iterations total for the overnight session.
- Count iterations across all resumed runs by inspecting `.ralph/runs/<run-id>/iterations/`.
- Stop immediately when total iterations reach 120, even if work remains.
- Stop immediately on any terminal status: `completed`, `failed`, `blocked`, `stalled`, or validation failure.
- Stop immediately on a doctor failure.
- Stop immediately on broad unexpected repo changes, especially changes outside files needed for the current checklist item.
- Stop immediately if `npm.cmd test` fails after a worker reports pass.

## Validation Rule

Every checked Ralph item must be a vertical slice. A vertical slice means:

- The item includes any required test changes.
- The item includes the minimal implementation needed for those tests.
- The item includes any required docs/template/package alignment for that behavior.
- `npm.cmd test` passes before the item is checked.
- The item does not leave the repository in an intentionally broken intermediate state.

If a behavior change requires tests, write or update the tests in the same checklist item. Do not split "add tests" and "make tests pass" into separate checked items unless the first item leaves `npm.cmd test` passing.

## Required Initial Inspection

Run these from `C:\Users\kolos\IdeaProjects\Colossus` before changing files:

```powershell
git -c safe.directory=C:/Users/kolos/IdeaProjects/Colossus status --short --branch
git -c safe.directory=C:/Users/kolos/IdeaProjects/Colossus diff --name-status
```

Record what is already dirty. Treat it as user work unless it is clearly produced by the current Ralph run.

## Ralph Initialization

Initialize `.ralph/` only if needed:

```powershell
node .\ralph-codex\bin\ralph-codex.js init
```

If initialization fails, stop and report:

- command run
- exit code
- stdout
- stderr
- whether `.ralph/config.json` exists

## Required `.ralph/config.json`

Configure `.ralph/config.json` to this exact schema. Preserve only additional fields that the current `ralph-codex` schema accepts.

```json
{
  "schemaVersion": 1,
  "codex": {
    "command": "codex.cmd",
    "args": [],
    "model": "",
    "sandbox": "workspace-write",
    "approvalPolicy": "never",
    "timeoutMs": 900000
  },
  "loop": {
    "maxIterations": 40,
    "stalledNoChangeLimit": 2,
    "commitEachIteration": false,
    "verificationPasses": 1
  },
  "validationCommands": [
    {
      "name": "test",
      "command": "npm.cmd",
      "args": ["test"]
    }
  ]
}
```

Do not use a `validation` property. The Ralph CLI expects `validationCommands`.

## Required Plan Import

Import this file as the Ralph implementation plan:

```powershell
node .\ralph-codex\bin\ralph-codex.js plan --from docs\superpowers\plans\2026-04-27-lean-copilot-qa-harness.md --force true
```

After import, verify `.ralph/IMPLEMENTATION_PLAN.md` contains the same checklist items.

## Required Doctor And Run Commands

Run doctor:

```powershell
node .\ralph-codex\bin\ralph-codex.js doctor
```

If doctor fails because `codex.cmd` is unavailable, stop. Do not substitute `codex.ps1`.

Start the first batch:

```powershell
node .\ralph-codex\bin\ralph-codex.js run --max-iterations 40
```

After each batch:

```powershell
node .\ralph-codex\bin\ralph-codex.js status
node .\ralph-codex\bin\ralph-codex.js verify
```

Resume only when all of these are true:

- status is `budget-exhausted`
- unchecked items remain
- total overnight iterations are less than 120
- the latest validation passed
- there is no `failed`, `blocked`, or `stalled` terminal condition
- changed files are understandable and scoped to the work

Resume command:

```powershell
node .\ralph-codex\bin\ralph-codex.js run --resume true --max-iterations 40
```

## End Of Run Report

At the end, inspect all run directories created during this overnight session, not only the latest one:

```text
.ralph/runs/<run-id>/result.json
.ralph/runs/<run-id>/loop-report.md
.ralph/runs/<run-id>/iterations/<nnn>/summary.json
.ralph/runs/<run-id>/iterations/<nnn>/validation.json
.ralph/runs/<run-id>/iterations/<nnn>/diff.patch
```

Final report must include:

- terminal status
- total iterations used
- validation status and command output summary
- changed files
- deleted files
- new files
- unresolved checklist items
- exact blocker or failure reason, if any
- confirmation that nothing was staged, committed, pushed, or PR-created

## Status Vocabulary

Use this vocabulary consistently:

- Copilot footer status values: `pass`, `blocked`, `fail`.
- Product run terminal status values: `completed`, `failed`, `blocked`, `stalled`, `budget-exhausted`.
- Ralph builder terminal status values are whatever `ralph-codex` reports; do not rename builder statuses in `.ralph` artifacts.

When Copilot returns `RALPH_STATUS: fail`, the product run status should become `failed`.
When Copilot returns `RALPH_STATUS: blocked`, the product run status should become `blocked`.
When the loop reaches `--max-iterations` with unchecked items and no failure, the product run status should become `budget-exhausted`.

## Product Command Contract

The final `ralph-qa-harness` CLI must expose only these operator commands:

```text
ralph-qa-harness doctor
ralph-qa-harness prepare --from <feature-path>
ralph-qa-harness run --max-iterations <positive-integer>
ralph-qa-harness status
ralph-qa-harness verify
```

No other command should appear in help output. Deleted command names should fail clearly as unknown commands.

Deleted command names include:

```text
create-run
prepare-run
verify-run
execute-run
advance-run
iterate-run
loop-run
preflight
```

The npm package bin entrypoint must remain:

```json
{
  "bin": {
    "ralph-qa-harness": "./bin/ralph-qa-harness.js"
  }
}
```

## Product Artifact Contract

Durable runtime state must live under `.qa-harness/`:

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

Generated Playwright BDD output may live under `.features-gen/.qa-harness/`. That path is generated output only. Do not treat it as durable state, do not store supervisor decisions there, and do not require the operator to inspect it for run status.

The target project must exclude these paths through `.git/info/exclude`:

```text
.qa-harness/
.features-gen/.qa-harness/
```

The product must not add those paths to tracked `.gitignore`.

## Product File Semantics

`.qa-harness/config.json`:

- Stores product-level configuration.
- Must include the Copilot command selected by platform.
- Must allow explicit override of the Copilot command.
- Must default to `copilot.cmd` on Windows.
- Must default to `copilot` on non-Windows platforms.
- Must not include Codex configuration. Codex belongs to `ralph-codex`, not the product harness.

`.qa-harness/PRD.md`:

- Stores the concise run objective generated from the selected feature.
- Must name the source feature path.
- Must state that `normalized.feature` is the execution truth.
- Must state that Playwright and `playwright-bdd` are required.
- Must not mention Jira, MCP, plugins, explorer, healer, planner handoff, promotion, or scenario addition.

`.qa-harness/progress.md`:

- Stores one or more checkbox items for the product harness run.
- Must begin with one bounded execution item after `prepare`.
- Must be the file the product `run` command uses to select work.
- Must only mark an item complete after Copilot reports pass and supervisor `verify` passes.

`.qa-harness/PROMPT.md`:

- Stores stable Copilot worker rules.
- Must require exactly one selected item per Copilot process.
- Must require Copilot to return the required Ralph footer.
- Must tell Copilot not to stage, commit, push, or create PRs.
- Must tell Copilot to keep durable state in `.qa-harness/`.

`.qa-harness/normalized.feature`:

- Must be copied from the path supplied to `prepare --from`.
- Must preserve the selected feature content exactly unless a later explicit run item changes it.
- Must be the feature file used by verification.

`.qa-harness/state.json`:

- Stores latest prepared source path.
- Stores latest run id.
- Stores active run id when a run is in progress.
- Stores terminal status after a run stops.
- Stores enough information for `status` to work without chat context.

`.qa-harness/runs/<run-id>/`:

- Stores immutable-ish evidence for each run.
- Must contain per-run result and report files.
- Must contain per-iteration prompt, stdout, stderr, summary, validation, and diff files.

## Product Verification Contract

`verify` must run these commands from the target project root:

```powershell
npx bddgen export
npx bddgen test
npx playwright test --list
```

On Windows, the implementation may use `npx.cmd` internally if needed for process spawning, but user-facing docs may say `npx`.

`verify` must fail when:

- `bddgen export` exits nonzero
- `bddgen export` reports zero registered steps
- `bddgen test` exits nonzero
- no generated spec can be found for the run-backed feature
- `playwright test --list` exits nonzero
- `playwright test --list` reports zero tests

`verify` must not run full browser execution as part of this lean contract. The original requirement is list-time proof against generated run-backed specs, not a full Playwright test execution pass.

`verify` must write a structured validation result when a run exists:

```text
.qa-harness/runs/<run-id>/validation.json
```

## Product Copilot Worker Contract

Each `run` iteration must launch one fresh Copilot process.

The worker prompt must be sent on stdin. Do not pass the entire prompt as a command-line argument.

The prompt must include:

- `.qa-harness/PRD.md`
- `.qa-harness/progress.md`
- `.qa-harness/PROMPT.md`
- the selected checkbox item
- the required footer format
- the no-stage/no-commit/no-push/no-PR rule

Required Copilot footer:

```text
RALPH_STATUS: pass|blocked|fail
RALPH_SUMMARY: <one concise paragraph>
RALPH_VALIDATION: <commands run, or why not run>
RALPH_NEXT: <next recommended action, or none>
```

Missing or invalid footer is a terminal worker failure.

`run` may mark an item complete only when:

- Copilot exits zero
- Copilot footer has `RALPH_STATUS: pass`
- the supervisor `verify` command passes after Copilot exits
- the selected item is the item being marked complete

## Implementation Plan

Use these Ralph checklist items. Each item includes explicit completion criteria so the worker does not infer missing requirements.

### Phase 1: Lean Design

- [ ] Rewrite `docs/copilot-first-qa-ralph-harness.md` as a concise lean target design.
  - Done when the document describes only the lean Copilot-first product described in this handoff.
  - Done when the document names `ralph-qa-harness` as the product CLI and Copilot CLI as the product worker runtime.
  - Done when the document states that `ralph-codex` and Codex are only the builder loop for this implementation effort.
  - Done when old historical phase logs, completed slice diaries, and broad future-roadmap noise are removed.
  - Done when `npm.cmd test` passes.

- [ ] Ensure the design says the worker runtime is `copilot.cmd` on Windows and `copilot` on non-Windows platforms.
  - Done when the platform default is stated in a dedicated runtime section.
  - Done when the design says `copilot.ps1` is not the default on Windows.
  - Done when the design says the Copilot command can be overridden in `.qa-harness/config.json`.
  - Done when no section implies Codex is the product worker runtime.
  - Done when `npm.cmd test` passes.

- [ ] Ensure the design keeps Playwright and `playwright-bdd` as required layers.
  - Done when the design states Playwright is required for browser/test execution.
  - Done when the design states `playwright-bdd` is required for executable feature generation.
  - Done when the design lists the expected target project layout: `playwright.config.*`, `Features/**/*.feature`, and `Features/steps/**/*.ts`.
  - Done when the design does not describe generic non-Playwright framework support.
  - Done when `npm.cmd test` passes.

- [ ] Remove design references to RequestEnvelope, RuntimeAdapter, ToolPolicy, MCP, plugins, Jira, explorer, healer, planner handoff, promotion, and scenario addition.
  - Done when `rg "RequestEnvelope|RuntimeAdapter|ToolPolicy|MCP|plugins|Jira|explorer|healer|planner handoff|promotion|scenario addition|scenario-addition" docs/copilot-first-qa-ralph-harness.md` returns no matches except a short explicit "removed concepts" list if needed.
  - Done when the document does not describe those concepts as active architecture.
  - Done when the document does not tell future workers to implement those concepts.
  - Done when `npm.cmd test` passes.

- [ ] Update `README.md` to describe the lean command surface, Copilot CLI requirement, and artifact layout.
  - Done when README quick start uses only `doctor`, `prepare`, `run`, `status`, and `verify`.
  - Done when README prerequisites include Copilot CLI.
  - Done when README states Windows uses `copilot.cmd` by default.
  - Done when README artifact layout matches the `.qa-harness/` contract in this handoff.
  - Done when README no longer documents deleted commands as supported commands.
  - Done when `npm.cmd test` passes.

### Phase 2: Lean CLI Contract

- [ ] Replace CLI help and dispatch with only `doctor`, `prepare`, `run`, `status`, and `verify`.
  - Done when `node .\bin\ralph-qa-harness.js --help` lists exactly those five commands.
  - Done when the command dispatcher has explicit handlers for exactly those five commands.
  - Done when unknown commands return exit code 1 and a clear message.
  - Done when deleted command handlers are removed or made unreachable.
  - Done when tests are updated in the same item.
  - Done when `npm.cmd test` passes.

- [ ] Add or update CLI help tests for only the lean command surface.
  - Done when tests assert help includes `doctor`, `prepare --from`, `run --max-iterations`, `status`, and `verify`.
  - Done when tests assert help does not include deleted commands.
  - Done when tests assert the help uses the package command prefix `npx ralph-qa-harness` or the configured prefix consistently.
  - Done when old help tests for deleted commands are removed or rewritten.
  - Done when `npm.cmd test` passes.

- [ ] Add CLI parsing tests and implementation for `prepare --from`, `run --max-iterations`, `status`, and `verify`.
  - Done when `prepare --from Features/x.feature` parses the path into an option named `from` or equivalent.
  - Done when `run --max-iterations 3` parses `3` as a positive integer.
  - Done when `run --max-iterations 0`, negative values, missing values, and non-numeric values fail clearly.
  - Done when `status` accepts no required options.
  - Done when `verify` accepts no required options.
  - Done when `npm.cmd test` passes.

- [ ] Keep the npm bin entrypoint `ralph-qa-harness` and prove it in package/bin tests.
  - Done when `package.json` still contains `"ralph-qa-harness": "./bin/ralph-qa-harness.js"`.
  - Done when `bin/ralph-qa-harness.js` still requires the harness implementation.
  - Done when tests assert the bin entrypoint exists and routes into the implementation.
  - Done when package metadata tests still pass.
  - Done when `npm.cmd test` passes.

### Phase 3: Artifact Model

- [ ] Define `.qa-harness/config.json`, `PRD.md`, `progress.md`, `PROMPT.md`, `normalized.feature`, `state.json`, and `runs/<run-id>/`.
  - Done when code has one path-resolution function or module for these paths.
  - Done when tests assert every expected path is under `.qa-harness/`.
  - Done when paths are created relative to the target project root, not the package installation directory.
  - Done when the code does not scatter string-built `.qa-harness` paths across unrelated functions.
  - Done when `npm.cmd test` passes.

- [ ] Implement path resolution that keeps durable runtime state under `.qa-harness/`.
  - Done when `prepare`, `run`, `status`, and `verify` use the same path resolver.
  - Done when no durable state is written under `.ralph/`, `.features-gen/`, `docs/`, `tests/`, or package source directories.
  - Done when generated run ids cannot escape `.qa-harness/runs/`.
  - Done when path traversal inputs such as `../outside.feature` cannot cause state writes outside `.qa-harness/`.
  - Done when `npm.cmd test` passes.

- [ ] Treat `.features-gen/.qa-harness/` only as generated Playwright BDD output, not durable harness state.
  - Done when the code may read generated spec locations from `.features-gen/.qa-harness/`.
  - Done when the code never writes supervisor state, progress, prompts, result summaries, or status files there.
  - Done when the design and README call it generated output.
  - Done when tests distinguish durable `.qa-harness/` state from generated `.features-gen/.qa-harness/` specs.
  - Done when `npm.cmd test` passes.

- [ ] Ensure `.qa-harness/` and `.features-gen/.qa-harness/` are excluded through `.git/info/exclude`, not tracked `.gitignore`.
  - Done when product code creates or updates `.git/info/exclude` in the target project.
  - Done when product code appends missing lines without duplicating existing lines.
  - Done when product code does not edit tracked `.gitignore` for these paths.
  - Done when tests create a fake git repo and assert `.git/info/exclude` receives the entries.
  - Done when tests assert tracked `.gitignore` is not created or changed for these entries.
  - Done when `npm.cmd test` passes.

- [ ] Update templates to the lean artifact model.
  - Done when templates only mention `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, and `.qa-harness/normalized.feature`.
  - Done when templates require Copilot footer output.
  - Done when templates remove legacy role names and deleted artifacts.
  - Done when template placeholder tests pass.
  - Done when `npm.cmd test` passes.

- [ ] Add tests that `prepare --from Features/x.feature` creates the expected artifacts.
  - Done when the test starts from a target project fixture with `Features/x.feature`.
  - Done when the test runs the real CLI or `runCli` path for `prepare --from`.
  - Done when the test asserts `.qa-harness/config.json`, `PRD.md`, `progress.md`, `PROMPT.md`, `normalized.feature`, and `state.json` exist.
  - Done when the test asserts `normalized.feature` equals the source feature content.
  - Done when the test asserts `.git/info/exclude` contains `.qa-harness/` and `.features-gen/.qa-harness/`.
  - Done when `npm.cmd test` passes.

### Phase 4: Doctor

- [ ] Implement `doctor` checks for Node/npm, git, local Playwright, local `playwright-bdd`, supported `Features/` layout, and Copilot CLI availability.
  - Done when doctor reports each check separately with `pass` or `fail`.
  - Done when doctor checks Node with `process.version` or equivalent.
  - Done when doctor checks npm availability.
  - Done when doctor checks `git --version`.
- Done when doctor checks local Playwright package and CLI availability in the target project.
- Done when doctor checks local `playwright-bdd` package and CLI availability in the target project.
  - Done when doctor checks for at least one `Features/**/*.feature` file.
  - Done when doctor checks for step files under `Features/steps/`.
- Done when doctor checks Copilot with the platform-specific command.
  - Done when doctor does not add a required Playwright browser-install check beyond the original Node/npm, git, local Playwright, local `playwright-bdd`, supported `Features/` layout, and Copilot CLI checks.
  - Done when `npm.cmd test` passes.

- [ ] On Windows, make `doctor` prefer `copilot.cmd --help`; on non-Windows platforms, use `copilot --help`.
  - Done when the command selection is platform-specific and unit tested.
  - Done when Windows tests assert `copilot.cmd` is attempted before any generic `copilot` or `copilot.ps1`.
  - Done when non-Windows tests assert `copilot` is attempted.
  - Done when a configured override in `.qa-harness/config.json` is honored.
  - Done when `npm.cmd test` passes.

- [ ] Add a passing doctor fixture with a fake `copilot.cmd` or `copilot` binary on PATH.
  - Done when the fixture creates a fake executable in a temp directory.
  - Done when the test prepends that directory to `PATH`.
  - Done when the fake command handles `--help` and exits 0.
  - Done when doctor reports the Copilot check as pass.
  - Done when the test does not depend on the developer machine's real Copilot install.
  - Done when `npm.cmd test` passes.

- [ ] Add a failing doctor test for missing Copilot CLI.
  - Done when the test uses a controlled `PATH` without Copilot.
  - Done when doctor reports the Copilot check as fail.
  - Done when the failure message says how to install or configure Copilot CLI, without pretending the harness can continue.
  - Done when doctor exits nonzero through the CLI path.
  - Done when `npm.cmd test` passes.

- [ ] Add a failing doctor test for missing Playwright BDD layout.
  - Done when the fixture omits `Features/` or `Features/steps/`.
  - Done when doctor reports exactly which required layout piece is missing.
  - Done when the test also covers missing local `playwright-bdd` package or CLI if that is a separate check.
  - Done when the CLI returns exit code 1 for this failure.
  - Done when `npm.cmd test` passes.

### Phase 5: Prepare

- [ ] Implement `prepare --from <feature>` to copy the feature into `.qa-harness/normalized.feature`.
  - Done when missing `--from` fails with a clear message.
  - Done when nonexistent feature paths fail with a clear message.
  - Done when non-`.feature` paths fail with a clear message.
  - Done when valid feature content is copied exactly.
  - Done when parent directories are created as needed.
  - Done when `npm.cmd test` passes.

- [ ] Generate a concise `.qa-harness/PRD.md` from the selected feature path.
  - Done when PRD names the source feature path.
  - Done when PRD includes the feature title if one exists.
  - Done when PRD includes the scenario count.
  - Done when PRD states the target is to execute or improve the selected feature through Copilot-supervised Playwright BDD.
  - Done when PRD avoids legacy architecture terms.
  - Done when `npm.cmd test` passes.

- [ ] Generate `.qa-harness/progress.md` with one bounded initial execution item.
  - Done when progress contains exactly one unchecked item after a fresh prepare.
  - Done when the item is specific to the selected feature.
  - Done when the item says what file is input, what output/evidence is expected, and what validation proves completion.
  - Done when the item does not require broad autonomous exploration.
  - Done when `npm.cmd test` passes.

- [ ] Generate `.qa-harness/PROMPT.md` with Copilot worker rules and required Ralph footer.
  - Done when PROMPT tells Copilot to complete exactly one selected item.
  - Done when PROMPT tells Copilot to use `.qa-harness/` files as durable memory.
  - Done when PROMPT includes the exact four-line footer format.
  - Done when PROMPT includes the no-stage/no-commit/no-push/no-PR rule.
  - Done when PROMPT states the supervisor will run `verify`.
  - Done when `npm.cmd test` passes.

- [ ] Record latest prepared state in `.qa-harness/state.json`.
  - Done when state records the source feature path.
  - Done when state records the normalized feature path.
  - Done when state records prepare timestamp.
  - Done when state records latest run id as empty or null before the first run.
  - Done when `status` can read this file.
  - Done when `npm.cmd test` passes.

### Phase 6: Verification

- [ ] Implement `verify` to run `npx bddgen export` and record output.
  - Done when stdout, stderr, exit code, command display, and duration are captured.
  - Done when nonzero exit fails verification.
  - Done when zero registered steps fails verification.
  - Done when the implementation maps to local `playwright-bdd` CLI where needed for reliable tests.
  - Done when tests cover pass and failure.
  - Done when `npm.cmd test` passes.

- [ ] Implement `verify` to run `npx bddgen test` and record output.
  - Done when the command runs only after export passes.
  - Done when stdout, stderr, exit code, command display, and duration are captured.
  - Done when nonzero exit fails verification.
  - Done when generated specs are discoverable after the command.
  - Done when tests cover pass and failure.
  - Done when `npm.cmd test` passes.

- [ ] Implement `verify` to run `npx playwright test --list` against generated run-backed specs.
  - Done when the command is scoped to generated specs for the prepared/run-backed feature where possible.
  - Done when stdout, stderr, exit code, command display, and duration are captured.
  - Done when nonzero exit fails verification.
  - Done when zero listed tests fails verification.
  - Done when tests cover no generated tests.
  - Done when `npm.cmd test` passes.

- [ ] Record verification output in `.qa-harness/runs/<run-id>/validation.json` when a run exists.
  - Done when validation JSON includes a top-level status.
  - Done when validation JSON includes every command result in order.
  - Done when validation JSON includes started/finished timestamps or durations.
  - Done when validation JSON is written for the latest active run.
  - Done when `verify` without a run still prints useful output and does not crash.
  - Done when `npm.cmd test` passes.

- [ ] Add tests for pass, bddgen failure, and no generated tests.
  - Done when tests use deterministic fake CLIs or injected command runners.
  - Done when one test proves full verification pass.
  - Done when one test proves `bddgen export` or `bddgen test` failure stops verification.
  - Done when one test proves missing or empty generated specs fails verification.
  - Done when tests assert operator-facing output is clear.
  - Done when `npm.cmd test` passes.

### Phase 7: Copilot Worker Loop

- [ ] Implement `run --max-iterations <n>` with one fresh Copilot process per iteration and a fake-Copilot test.
  - Done when `run` requires a positive integer max iteration value.
  - Done when each iteration calls the Copilot command through a new child process.
  - Done when tests count fake Copilot invocations and prove one process per iteration.
  - Done when the loop stops at the requested max iteration count.
  - Done when `npm.cmd test` passes.

- [ ] Build each worker prompt from `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, and the selected checkbox item.
  - Done when the prompt includes all three durable documents.
  - Done when the prompt includes exactly one selected unchecked item.
  - Done when checked items are not selected.
  - Done when the prompt includes the required footer.
  - Done when tests inspect the written `worker-prompt.md`.
  - Done when `npm.cmd test` passes.

- [ ] Pass the worker prompt to Copilot on stdin and prove stdin capture with a fake Copilot fixture.
  - Done when implementation uses child process stdin input, not a giant command-line argument.
  - Done when fake Copilot writes received stdin to a temp file.
  - Done when tests assert the captured stdin contains PRD, progress, PROMPT, and selected item text.
  - Done when tests assert the Copilot command line does not contain the full prompt.
  - Done when `npm.cmd test` passes.

- [ ] Capture stdout, stderr, exit code, duration, changed files, and diff patch per iteration.
  - Done when each iteration directory has `stdout.log`, `stderr.log`, `summary.json`, and `diff.patch`.
  - Done when `summary.json` includes exit code, duration, changed files, and parsed footer.
  - Done when changed files exclude pre-existing dirty files unless the current iteration actually changed them.
  - Done when binary or oversized diffs are handled without crashing.
  - Done when `npm.cmd test` passes.

- [ ] Parse required footer: `RALPH_STATUS`, `RALPH_SUMMARY`, `RALPH_VALIDATION`, `RALPH_NEXT`.
  - Done when parser accepts only `pass`, `blocked`, or `fail` for status.
  - Done when missing status fails the iteration.
  - Done when missing summary fails the iteration.
  - Done when missing validation fails the iteration.
  - Done when missing next action fails the iteration.
  - Done when tests cover valid footer, missing footer, and invalid status.
  - Done when `npm.cmd test` passes.

- [ ] Mark an item complete only when Copilot reports pass and supervisor `verify` passes.
  - Done when Copilot pass plus verify pass checks the selected item.
  - Done when Copilot pass plus verify fail leaves the item unchecked and records failure.
  - Done when Copilot fail leaves the item unchecked and stops.
  - Done when Copilot blocked leaves the item unchecked and stops blocked.
  - Done when tests cover each state.
  - Done when `npm.cmd test` passes.

- [ ] Stop clearly on missing footer, worker fail, validation fail, blocked, stalled, or budget exhausted.
  - Done when each stop reason maps to a stable terminal status.
  - Done when `result.json` records the stop reason.
  - Done when `loop-report.md` explains the stop reason in operator-readable text.
  - Done when CLI exit codes are nonzero for failed, blocked, stalled, and validation failure states.
  - Done when budget exhausted is clearly different from completed.
  - Done when `npm.cmd test` passes.

### Phase 8: Status and Reports

- [ ] Implement `status` for no-run, active/latest run, completed, blocked, failed, stalled, and budget-exhausted.
  - Done when no prepared state prints a useful no-run message.
  - Done when prepared-but-not-run state prints the selected feature and next command.
  - Done when active run state prints run id and current/last iteration.
  - Done when terminal states print status, stop reason, and validation state.
  - Done when tests cover every listed state.
  - Done when `npm.cmd test` passes.

- [ ] Write `result.json`, `loop-report.md`, `iterations/*/worker-prompt.md`, `summary.json`, `validation.json`, and `diff.patch`.
  - Done when files are written in `.qa-harness/runs/<run-id>/`.
  - Done when iteration numbering is stable and zero-padded.
  - Done when JSON files are valid JSON.
  - Done when Markdown reports are operator-readable.
  - Done when tests assert file existence and key content.
  - Done when `npm.cmd test` passes.

- [ ] Add tests for status and report artifacts.
  - Done when tests create a run through the public API or CLI path.
  - Done when tests assert `status` output for at least no-run, active/latest, completed, failed, blocked, stalled, and budget-exhausted.
  - Done when tests assert report files are created and contain the run id.
  - Done when tests assert validation output is linked or summarized.
  - Done when `npm.cmd test` passes.

- [ ] Ensure diffs only report changes from the current iteration, not pre-existing dirty work.
  - Done when the run captures a baseline dirty-file snapshot before launching Copilot.
  - Done when unchanged pre-existing dirty files are excluded from iteration diffs.
  - Done when pre-existing dirty files modified by the current iteration are included.
  - Done when untracked files created by the current iteration are included if text and reasonably small.
  - Done when tests cover pre-existing dirty files and new iteration files.
  - Done when `npm.cmd test` passes.

### Phase 9: Remove Complex Backend Logic

- [ ] Remove old runtime adapter and external worker code with tests updated or deleted in the same slice.
  - Done when no active product code references RuntimeAdapter or adapter names.
  - Done when obsolete external worker scripts are deleted if no longer used.
  - Done when package exports no longer expose old adapter helpers.
  - Done when tests that depended only on old adapters are removed or rewritten.
  - Done when `npm.cmd test` passes.

- [ ] Remove old tests that only validate deleted command surfaces or deleted backend behavior.
  - Done when tests no longer assert `create-run`, `prepare-run`, `verify-run`, `execute-run`, `advance-run`, `iterate-run`, or `loop-run` success paths.
  - Done when tests no longer assert explorer/healer/planner-handoff/promotion/scenario-addition behavior.
  - Done when remaining tests map to the lean CLI contract.
  - Done when test count can go down if behavior was intentionally deleted.
  - Done when `npm.cmd test` passes.

- [ ] Keep or rewrite only tests that prove the lean CLI, Playwright BDD validation, artifacts, and Copilot loop.
  - Done when test files are organized around `doctor`, `prepare`, `verify`, `run`, `status`, package/bin behavior, and path/artifact helpers.
  - Done when tests use target-project fixtures for Playwright BDD layout.
  - Done when tests use fake Copilot instead of real Copilot.
  - Done when tests do not require network access.
  - Done when `npm.cmd test` passes.

- [ ] Remove outdated examples that depend on the deleted backend architecture.
  - Done when examples no longer mention adapters, external workers, MCP, Jira, explorer, healer, planner handoff, promotion, or scenario addition.
  - Done when remaining examples show only the lean command flow.
  - Done when package `files` metadata does not include deleted examples.
  - Done when README links only to examples that still exist.
  - Done when `npm.cmd test` passes.

- [ ] Keep package metadata, bin entrypoint, templates, docs, and tests aligned with the lean product.
  - Done when `package.json` description and keywords match the lean Copilot-first harness.
  - Done when `README.md`, `docs/copilot-first-qa-ralph-harness.md`, templates, tests, and CLI help all describe the same five commands.
  - Done when no doc promises a feature the code no longer has.
  - Done when no test protects a feature the docs say was removed.
  - Done when `npm.cmd test` passes.

### Phase 10: Final Validation

- [ ] Run `npm.cmd test`.
  - Done when the command exits 0.
  - Done when the final report includes the number of passing tests.
  - Done when any failure is reported with exact failing test names and output summary.

- [ ] Run `node .\bin\ralph-qa-harness.js --help`.
  - Done when the command exits 0.
  - Done when help lists only `doctor`, `prepare`, `run`, `status`, and `verify`.
  - Done when help does not list deleted commands.

- [ ] Run doctor in a fixture or target project with a fake Copilot binary.
  - Done when the fake Copilot binary is first on `PATH`.
  - Done when doctor exits 0.
  - Done when doctor output includes a passing Copilot check.
  - Done when this validation does not rely on the machine's real Copilot installation.

- [ ] Run prepare/verify/status against a test fixture feature.
  - Done when `prepare --from Features/<fixture>.feature` creates `.qa-harness/` artifacts.
  - Done when `verify` runs and records validation.
  - Done when `status` prints the prepared/latest run state.
  - Done when output paths match the artifact contract.

- [ ] Review `git diff --stat` and `git diff --name-status`.
  - Done when the final report lists changed files.
  - Done when the final report calls out deleted files separately.
  - Done when the final report calls out untracked files separately.
  - Done when broad unexpected changes are treated as a blocker.

- [ ] Report final state and any remaining blocker without staging or pushing.
  - Done when the final report states whether anything remains unchecked.
  - Done when the final report states whether tests passed.
  - Done when the final report states whether any commands failed.
  - Done when the final report confirms no staging, commit, push, or PR happened.

## Acceptance Criteria

- `npm.cmd test` passes after every completed Ralph checkbox and at the end.
- The design doc is short, current, and Copilot-first.
- The package exposes only the lean command model: `doctor`, `prepare`, `run`, `status`, and `verify`.
- Playwright and `playwright-bdd` remain required layers.
- `doctor` fails clearly if Copilot CLI is missing.
- On Windows, the default Copilot command is `copilot.cmd`.
- On non-Windows platforms, the default Copilot command is `copilot`.
- The run loop uses a fresh Copilot process per iteration.
- Worker prompts are passed to Copilot on stdin.
- Durable runtime state stays in `.qa-harness/`.
- `.features-gen/.qa-harness/` is allowed only as generated Playwright BDD output.
- `.qa-harness/` and `.features-gen/.qa-harness/` are excluded through `.git/info/exclude`, not tracked `.gitignore`.
- Old backend complexity is removed from docs, code paths, tests, templates, examples, and package metadata.
- No files are staged.
- No commits are created.
- No branches are pushed.
- No pull request is created.

## Explicit Non-Assumptions

- Do not assume real Copilot is installed in CI or test environments. Use fake Copilot fixtures for tests.
- Do not add a Playwright browser-install prerequisite to `doctor`; the original doctor scope is Node/npm, git, local Playwright, local `playwright-bdd`, supported `Features/` layout, and Copilot CLI.
- Do not assume `.qa-harness/` already exists.
- Do not assume `.git/info/exclude` contains required entries.
- Do not assume the repository is clean at start.
- Do not assume deleted commands can remain as aliases.
- Do not assume legacy tests should be preserved if they only protect deleted behavior.
- Do not assume `.features-gen/` is durable state.
- Do not assume a Copilot pass is enough without supervisor verification.
- Do not assume `approvalPolicy: never` allows escalation. It means stop and report when blocked.
