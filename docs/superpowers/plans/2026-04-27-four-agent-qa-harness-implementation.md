# Four-Agent QA Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or the Ralph loop task discipline to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Complete exactly one unchecked checkbox per Ralph iteration.

**Goal:** Upgrade `ralph-qa-harness` so its product runtime owns a four-agent, file-backed Ralph loop for QA coverage work.

**Architecture:** Keep `ralph-codex` strictly as the builder supervisor for this repository. The product package remains rooted at the `ralph-qa-harness` checkout; `ralph-qa-harness` must own its internal product loop, launch a fresh product worker process or isolated execution for every product iteration, and store durable product memory only under `.qa-harness/`. The product loop has exactly four roles: `qa-orchestrator`, `qa-planner`, `qa-executor`, and `qa-verifier`.

**Tech Stack:** Node.js CommonJS CLI, `node:test`, Playwright, `playwright-bdd`, static Markdown templates, durable JSON and Markdown artifacts under `.qa-harness/`.

---

## Non-Negotiable Instructions

Run all commands from the `ralph-qa-harness` checkout root.

Do not stage, commit, push, create a PR, reset, clean, restore, or change branches. Existing dirty and untracked files are user work unless clearly produced by the current Ralph run. Known pre-existing work at plan creation time:

- Modified `.gitignore`
- Modified `tests/fixtures/target-project/Features/steps/index.ts`
- Untracked `docs/qa-harness-four-agent-ralph-loop-design.md`
- Untracked `docs/superpowers/`
- Untracked `tests/fixtures/target-project/Features/youtube-public-visitor.feature`

If a task must touch a known dirty file, read the current file and merge deliberately. Never overwrite it wholesale.

The design document says the product default budget is `10`, but the user-level requirement for this run says the product default max iterations must be `40`. The user instruction wins. Implement `ralph-qa-harness run` with a product default max iteration budget of `40`.

Preserve the boundary between builder and product runtimes:

- `ralph-codex` supervises this implementation work.
- `ralph-qa-harness` must not delegate product runs to `ralph-codex`.
- Product workers remain standalone worker processes or isolated executions launched by `ralph-qa-harness`.

Every implementation checkbox must leave `npm.cmd test` passing before it is marked complete.

## Existing Code Map

Primary product implementation:

- Modify `scripts/qa-harness.js` for CLI parsing, durable path resolution, role routing, prompt building, worker dispatch, progress parsing, validation, and artifact writing.
- Modify `bin/ralph-qa-harness.js` only if the package entrypoint or command prefix needs alignment.

Product templates:

- Modify existing lean run templates in `templates/qa-run/PRD.md`, `templates/qa-run/progress.md`, and `templates/qa-run/PROMPT.md`.
- Create static role templates under:
  - `templates/qa-agents/main-orchestrator/agent.md`
  - `templates/qa-agents/main-orchestrator/skills.md`
  - `templates/qa-agents/planner/agent.md`
  - `templates/qa-agents/planner/skills.md`
  - `templates/qa-agents/executor/agent.md`
  - `templates/qa-agents/executor/skills.md`
  - `templates/qa-agents/verifier/agent.md`
  - `templates/qa-agents/verifier/skills.md`

Tests:

- Modify `tests/harness/qa-harness.test.js` for most behavioral tests.
- Modify `tests/package.test.js` for packaging, docs, and template existence checks.
- Modify `tests/bin.test.js` for CLI help and bin behavior.
- Modify `tests/doctor.test.js` only if doctor expectations need to reflect config or runtime changes.
- Use `tests/helpers/target-project.js` and `tests/fixtures/target-project/` carefully because `tests/fixtures/target-project/Features/steps/index.ts` is already dirty user work.

Docs:

- Update `README.md`, `examples/use-from-another-project.md`, and `docs/copilot-first-qa-ralph-harness.md` after behavior is implemented.
- Do not edit `docs/qa-harness-four-agent-ralph-loop-design.md` unless a test explicitly needs a docs reference update.

## Required Artifact Contract

The final product artifact model must include:

```text
.qa-harness/
  config.json
  PRD.md
  progress.md
  PROMPT.md
  normalized.feature
  state.json
  runs/<run-id>/
    result.json
    loop-report.md
    validation.json
    diff.patch
    seed.spec.ts
    agents/
      resolved-prompts/
    iterations/<nnn>/
      worker-prompt.md
      stdout.log
      stderr.log
      summary.json
      validation.json
      diff.patch
      evidence/
```

Summary and validation artifacts must include `RALPH_AGENT` with one of:

```text
qa-orchestrator
qa-planner
qa-executor
qa-verifier
```

Missing or invalid `RALPH_AGENT` is a failed product iteration unless the failure occurs before a worker prompt can be written.

## Implementation Checklist

- [ ] Inspect the current worktree, record dirty files in `.ralph/progress.md`, and confirm no implementation file is changed before this checkbox starts. Run `git status --short --branch`, `git diff --name-status`, and `npm.cmd test`. Done when the progress log records the baseline and tests either pass or the exact pre-existing failure is documented without code changes.

  Implementation details:
  - This is an inspection-only task.
  - Do not modify source files for this checkbox.
  - If `npm.cmd test` fails before implementation, stop with `RALPH_STATUS: blocked` and include the failing test names and output summary.

- [ ] Add product run default budget tests and implement `ralph-qa-harness run` defaulting to `40` iterations. Done when `run` with no `--max-iterations` dispatches with `maxIterations: 40`, explicit `--max-iterations 3` still overrides to `3`, invalid values still fail clearly, CLI help shows `run [--max-iterations <positive-integer>]`, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `tests/bin.test.js` and `tests/package.test.js` if help text or docs expectations assert the old required option.
  - Modify `README.md` only if a test requires immediate docs alignment; broader docs have a later checkbox.

  Implementation details:
  - Add a constant like `DEFAULT_PRODUCT_MAX_ITERATIONS = 40`.
  - In `run(options = {})`, use the default when `options.maxIterations` is absent.
  - In `buildLeanRunCliOptions`, allow omitted `--max-iterations` and return the default.
  - Keep `run --max-iterations`, `run --max-iterations 0`, `run --max-iterations -1`, and `run --max-iterations abc` errors clear.
  - Do not add compatibility for deleted commands.

- [ ] Persist the product default loop budget in `.qa-harness/config.json` during `prepare --from` and verify the value is read where appropriate. Done when prepare-created config includes a loop default of `40`, tests assert it, existing configured worker command behavior is preserved, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-run/PRD.md` or `templates/qa-run/PROMPT.md` only if template expectations need to mention the default budget.

  Implementation details:
  - Keep `.qa-harness/config.json` product-focused; do not introduce `.ralph/` concepts.
  - Preserve product worker command defaults (`copilot.cmd` on Windows, `copilot` elsewhere) unless a test proves a mismatch.
  - Do not delegate product loop execution to `ralph-codex`.

- [ ] Add the eight static role template files under `templates/qa-agents/` and package tests proving they ship. Done when each template exists, contains the correct role name, states role-specific responsibilities, avoids instructions from other roles, the package `files` coverage still includes templates, and `npm.cmd test` passes.

  Files:
  - Create `templates/qa-agents/main-orchestrator/agent.md`.
  - Create `templates/qa-agents/main-orchestrator/skills.md`.
  - Create `templates/qa-agents/planner/agent.md`.
  - Create `templates/qa-agents/planner/skills.md`.
  - Create `templates/qa-agents/executor/agent.md`.
  - Create `templates/qa-agents/executor/skills.md`.
  - Create `templates/qa-agents/verifier/agent.md`.
  - Create `templates/qa-agents/verifier/skills.md`.
  - Modify `tests/package.test.js`.
  - Modify `tests/harness/qa-harness.test.js` if template validation currently scans only `templates/qa-run`.

  Required content:
  - Orchestrator template: owns loop, validates intake, routes roles, does not implement test code.
  - Planner template: creates/refines `PRD.md`, `progress.md`, and `PROMPT.md`, splits bounded items, does not run browser discovery.
  - Executor template: completes one task, uses `seed.spec.ts`, Playwright CLI first, MCP fallback only with reason/evidence, promotes proven logic.
  - Verifier template: reviews proof, requires `bddgen export`, `bddgen test`, `playwright test --list`, and full `playwright test` for affected specs.

- [ ] Define four-agent constants and role/template path resolution in `scripts/qa-harness.js`. Done when valid roles are exactly `qa-orchestrator`, `qa-planner`, `qa-executor`, and `qa-verifier`; invalid roles fail clearly; role path resolution maps `qa-orchestrator` to `templates/qa-agents/main-orchestrator`; and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - Add an immutable role list and validation helper.
  - Do not keep `qa-explorer` or `qa-healer` as product roles. Exploration and healing are executor modes only.
  - Export only helpers needed by tests; avoid expanding public surface unnecessarily.

- [ ] Build role-scoped worker prompts that include only the selected role templates and durable context. Done when tests prove a planner prompt includes only planner `agent.md` and `skills.md`, does not include executor/verifier instructions, includes `RALPH_AGENT: qa-planner`, includes the selected progress item, includes `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - Replace or wrap `buildLeanWorkerPrompt` with a role-aware prompt builder.
  - Prompt sections should be explicit:
    - `RALPH_AGENT: <role>`
    - selected role `agent.md`
    - selected role `skills.md`
    - durable PRD
    - durable progress
    - durable worker rules
    - selected progress item
    - required footer
  - For `qa-executor`, include the selected executor mode when the orchestrator routes exploration, implementation, or healing.

- [ ] Add `RALPH_AGENT` to iteration summaries, validation artifacts, loop reports, and terminal result records. Done when each iteration `summary.json` and `validation.json` records the selected role as `RALPH_AGENT`, loop report lists role per iteration, invalid or missing selected role fails the iteration before worker execution when possible, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - Preserve existing footer parsing for `RALPH_STATUS`, `RALPH_SUMMARY`, `RALPH_VALIDATION`, and `RALPH_NEXT`.
  - Do not require the worker footer to add a fifth line unless tests and prompt wording are updated consistently.
  - The supervisor-selected role is authoritative for artifact `RALPH_AGENT`.

- [ ] Extend progress parsing and writing to support four-agent lifecycle statuses. Done when parsed statuses include `todo`, `doing`, `needs-verification`, `pass`, `fail`, and `blocked`; parser reads `Owner`, `Agent`, `Mode`, `Evidence`, `Fallback reason`, and `Block reason` fields; progress updates preserve existing user-authored fields; and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-run/progress.md`.

  Implementation details:
  - The planner creates `todo`.
  - The orchestrator may set `doing`.
  - The executor moves implementation work to `needs-verification`.
  - The verifier moves work to `pass`, `fail`, or `blocked`.
  - Completion requires required items to be verifier-passed.
  - `fail` with retry budget remaining routes back to `qa-executor` healing mode.
  - `pass` items must not be selected again.

- [ ] Add orchestrator routing tests and implement role selection for one role and one bounded task per product iteration. Done when tests cover missing planning artifacts route to `qa-planner`, `todo` implementation items route to `qa-executor`, `needs-verification` route to `qa-verifier`, verifier `fail` with retry budget routes to `qa-executor` healing mode, `blocked` stops the run, all pass completes the run, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - Add an orchestrator selector function that reads durable files and returns `{ role, item, mode, stopReason }`.
  - The run loop must call that selector each iteration.
  - The selected worker must handle exactly one selected progress item.
  - Do not let planner, executor, or verifier own the outer loop.

- [ ] Refactor product `run` dispatch to use the orchestrator-selected role while keeping one fresh worker invocation per iteration. Done when fake worker tests prove each iteration launches a new command call with stdin prompt input, role changes create fresh prompts, executor-to-verifier never reuses the executor context, retries create a fresh executor invocation, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - Keep product worker prompt passed via stdin or equivalent non-argument input channel.
  - Keep worker args empty unless existing product worker configuration explicitly requires args.
  - Record stdout, stderr, summary, validation, diff, and evidence for every iteration.
  - Create `.qa-harness/runs/<run-id>/iterations/<nnn>/evidence/` for each iteration.

- [ ] Add resolved prompt audit artifacts under `.qa-harness/runs/<run-id>/agents/resolved-prompts/`. Done when each iteration writes a role-named resolved prompt copy when useful for audit, the artifact path is under the run directory, tests prove no path can escape `.qa-harness/runs/`, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - Use stable filenames like `001-qa-planner.md`.
  - The canonical per-iteration prompt remains `iterations/<nnn>/worker-prompt.md`.
  - Do not copy all static templates separately unless naturally included in the resolved prompt.

- [ ] Add primary `prepare --request <text>` coverage intake parsing under the existing `prepare` command. Done when `prepare --request` accepts target URL or app scope, Jira ticket link/text or pasted requirements, acceptance criteria, and constraints; `prepare --from <feature-path>` still works; deleted old command names are not restored; and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `tests/bin.test.js` for help if needed.

  Implementation details:
  - Keep Jira API integration out of scope.
  - Accept Jira link/text as source context without credentials.
  - The exact parse can be simple and deterministic. A request is complete only when it contains:
    - target URL or explicit app scope
    - Jira link/text or requirements text
    - acceptance criteria
  - Support repeated `--constraint <value>` if existing parser already accepts it, but do not break `prepare --from`.

- [ ] Implement blocked intake behavior for incomplete coverage requests. Done when incomplete `prepare --request` creates or updates `.qa-harness/` blocked intake state, records missing fields, asks concrete follow-up questions, does not generate speculative feature files, does not dispatch planner/executor work, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-run/PRD.md`, `progress.md`, or `PROMPT.md` only if blocked-state templates are needed.

  Implementation details:
  - Record blocked status in `.qa-harness/state.json`.
  - Record missing fields in `.qa-harness/PRD.md` or a clearly named blocked intake section.
  - Progress should have an orchestrator-owned blocked item, not an executor item.
  - Follow-up questions must mention the specific missing fields.

- [ ] Implement complete coverage request preparation that routes first to `qa-planner`. Done when a complete coverage request writes `.qa-harness/PRD.md`, `.qa-harness/progress.md`, `.qa-harness/PROMPT.md`, `.qa-harness/config.json`, and `.qa-harness/state.json`; the initial actionable item is owned by `qa-planner`; durable files include accepted scope, source context, constraints, and acceptance criteria; and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-run/PRD.md`, `progress.md`, and `PROMPT.md`.

  Implementation details:
  - Do not create final BDD feature or step files during preparation.
  - The planner item should ask the planner to convert accepted requirements into bounded progress items.
  - Prompt rules must say durable memory is file-backed through `.qa-harness/`.

- [ ] Add planner output contract tests and implement planner-compatible artifact updates. Done when planner-authored progress items have id, goal, input, output, verify command or proof requirement, owner, status, retry budget, result, and evidence fields; coverage tasks include seed proof and full Playwright execution requirements; tasks are small enough for one worker iteration; and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-agents/planner/agent.md`.
  - Modify `templates/qa-agents/planner/skills.md`.

  Implementation details:
  - This may be implemented through planner prompt requirements and progress parsing helpers; do not simulate full planner intelligence in product code.
  - The orchestrator must reject or reroute stale/missing planner artifacts.

- [ ] Add executor seed workflow artifact support. Done when coverage executor prompts and run paths always provide `.qa-harness/runs/<run-id>/seed.spec.ts`, tests prove the seed path is run-local and under `.qa-harness/runs/`, a run-local Playwright config path is allowed under the run directory when needed, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-agents/executor/agent.md`.
  - Modify `templates/qa-agents/executor/skills.md`.

  Implementation details:
  - The seed file imports Playwright test APIs from the target project dependencies.
  - The seed contains working navigation, interactions, waits, assertions, and locators needed for the selected coverage flow.
  - The seed is evidence, not final BDD output.

- [ ] Add Playwright CLI-first evidence recording for coverage executor work. Done when tests with a fake command runner prove the first coverage discovery attempt is a Playwright CLI execution of `seed.spec.ts`, records command, args, stdout, stderr, exit code, and duration, rejects MCP use before CLI evidence exists, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-agents/executor/skills.md`.

  Implementation details:
  - Evidence can be recorded in iteration `validation.json`, iteration `evidence/`, or a structured coverage proof file under the run directory.
  - Use deterministic fake runners in tests; do not require real browser execution in unit tests.
  - The prompt must instruct the executor to prefer stable user-visible locators.

- [ ] Add MCP fallback reason and evidence handling for coverage work. Done when tests prove MCP fallback is accepted only after Playwright CLI discovery cannot proceed, fallback reason is required, MCP evidence is required, missing reason/evidence fails verification, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-agents/executor/agent.md`.
  - Modify `templates/qa-agents/verifier/agent.md`.

  Implementation details:
  - MCP fallback evidence may include accessibility snapshot, observed element names, or interaction notes.
  - MCP output informs the next seed iteration; MCP output is never final proof by itself.
  - Restricted flows such as CAPTCHA, auth gates, anti-bot, age gates, and region restrictions must be blocked, not bypassed.

- [ ] Add promotion contract tests and prompt support for promoting proven seed logic into BDD/framework files. Done when executor prompts require promotion only after seed proof exists, tests reject promotion evidence when BDD code materially differs from seed without explanation, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-agents/executor/skills.md`.
  - Modify `templates/qa-agents/verifier/skills.md`.

  Implementation details:
  - Final BDD steps must use proven locators/actions from seed evidence.
  - Assertions should avoid brittle exact titles, counts, ad surfaces, recommendation order, or layout positions unless acceptance criteria require them.
  - Do not edit the existing dirty fixture step file without reading and merging user changes first.

- [ ] Extend product `verify` to require full Playwright execution for affected generated specs. Done when command order is `npx bddgen export`, `npx bddgen test`, `npx playwright test --list <affected generated specs>`, then `npx playwright test <affected generated specs>`; full execution failure fails verification; validation artifacts record all commands; existing list-time tests are updated; and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `README.md` only if current package tests assert verification docs.

  Implementation details:
  - Keep affected spec scoping when `runId` is known.
  - If no run id exists, maintain useful behavior without crashing, but coverage verifier pass requires run-backed specs.
  - Parse and summarize full Playwright output similarly to list output.

- [ ] Add coverage verifier gate checks for seed proof, CLI-first evidence, MCP fallback evidence, and full Playwright execution. Done when verifier rejects coverage with no seed proof, rejects seed not executed by Playwright CLI, rejects MCP fallback without reason/evidence, rejects list-only proof, rejects failed runtime execution, accepts only complete proof, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.
  - Modify `templates/qa-agents/verifier/agent.md`.
  - Modify `templates/qa-agents/verifier/skills.md`.

  Implementation details:
  - Scope these stricter proof checks to coverage runs or coverage progress items so feature-backed non-coverage verification remains deterministic where appropriate.
  - The final pass must be written by `qa-verifier`, not by `qa-executor`.

- [ ] Update run terminal state handling for verifier acceptance and supervisor verification. Done when executor `pass` or `needs-verification` routes to verifier, verifier `pass` plus supervisor verification completes the selected item, verifier `fail` routes to executor healing mode if retry budget remains, exhausted retries stop blocked/failed with evidence, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - The executor must not mark final `pass`.
  - Only `qa-verifier` may mark a selected item final `pass`.
  - The orchestrator owns loop termination and final user-facing summary.

- [ ] Update artifact model tests for the complete four-agent layout. Done when tests assert `.qa-harness/runs/<run-id>/seed.spec.ts`, `agents/resolved-prompts/`, iteration `evidence/`, run `validation.json`, run `diff.patch`, and existing artifacts are created or handled according to the contract, and `npm.cmd test` passes.

  Files:
  - Modify `scripts/qa-harness.js`.
  - Modify `tests/harness/qa-harness.test.js`.

  Implementation details:
  - Maintain generated Playwright BDD output under `.features-gen/.qa-harness/` only.
  - Durable supervisor state must stay under `.qa-harness/`.
  - Ensure `.qa-harness/` and `.features-gen/.qa-harness/` remain excluded via `.git/info/exclude`, not tracked `.gitignore`.

- [ ] Update public CLI help, README, examples, and docs for the four-agent product loop. Done when docs state exactly four agents, orchestrator-owned loop, default `run` budget `40`, fresh worker context per iteration, `.qa-harness/` durable memory, Playwright CLI first, MCP fallback second, Jira API out of scope, and full Playwright execution before coverage pass; docs no longer claim verification is list-only; package docs tests pass; and `npm.cmd test` passes.

  Files:
  - Modify `README.md`.
  - Modify `examples/use-from-another-project.md`.
  - Modify `docs/copilot-first-qa-ralph-harness.md`.
  - Modify `tests/package.test.js`.
  - Modify `tests/bin.test.js` if help assertions need alignment.

  Implementation details:
  - Use `ralph-qa-harness run` as the normal command.
  - Document `ralph-qa-harness run --max-iterations <positive-integer>` as an override.
  - Do not document deleted command names as primary interfaces.

- [ ] Run final package validation and inspect implementation evidence. Done when `npm.cmd test` passes, `node .\bin\ralph-qa-harness.js --help` shows the expected command surface, representative `prepare --from` and `run --max-iterations 1` fake-worker tests are covered by the automated suite, git status is inspected, changed files are summarized, and no files are staged.

  Commands:
  - `npm.cmd test`
  - `node .\bin\ralph-qa-harness.js --help`
  - `git status --short --branch`
  - `git diff --name-status`

  Completion evidence:
  - Record final validation in `.ralph/progress.md`.
  - Do not stage or commit.
