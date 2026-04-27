# QA Harness Four-Agent Ralph Loop Design

## Executive Summary

`ralph-qa-harness` owns the product Ralph loop internally. Product runs must not delegate to `ralph-codex`; `ralph-codex` remains a separate builder/supervisor tool for developing this package, not the runtime engine for the QA harness product.

The default `ralph-qa-harness run` budget is `10` iterations. Operators may override the budget with `ralph-qa-harness run --max-iterations <n>`, where `<n>` is a positive integer.

Every loop iteration starts a fresh worker context for the selected agent. Agents must not rely on previous chat/session context. Durable memory comes only from `.qa-harness/` artifacts and the current worker prompt, which preserves the original Ralph loop idea: supervisor-owned loop, fresh worker per iteration, file-backed memory, deterministic validation, and evidence before completion.

The system has exactly four agent entities:

- `qa-orchestrator`
- `qa-planner`
- `qa-executor`
- `qa-verifier`

`qa-explorer` and `qa-healer` are not separate agent entities. Exploration and healing are skills or modes inside `qa-executor`.

Coverage-building work must not stop at creating feature files or step definitions. A coverage run is only acceptable when locators and actions are proved through Playwright CLI execution first. MCP is a fallback only after Playwright CLI discovery cannot proceed, and the fallback reason must be recorded. Only after the seed flow is proven may the executor promote the code into BDD feature, step, and framework files.

## Current Problem Statement

The current harness flow can let a worker add BDD files without proving selectors against the real page. This creates false confidence: a `.feature` file and matching step definitions can compile or list while failing at runtime because locators, navigation timing, consent surfaces, or page state were guessed.

The existing `verify` behavior is necessary but not sufficient for coverage-building. `bddgen export`, `bddgen test`, and `playwright test --list` prove that steps are registered and generated tests are discoverable. They do not prove that a browser can execute the flow, that selectors are correct, or that a public visitor can complete the scenario.

The loop needs explicit role separation. Planning, execution, and verification cannot be blurred into one worker session. The planner owns task design, the executor owns implementation and Playwright discovery, and the verifier owns proof and final acceptance. The orchestrator owns routing and loop termination.

Requirements intake is currently too weak for coverage requests. The harness must not generate speculative coverage from an underspecified prompt. For coverage work, the orchestrator must ask for a Jira ticket link/text or pasted requirements and acceptance criteria before allowing planner or executor work to continue.

Default operator ergonomics should be simple. The normal command should be `ralph-qa-harness run`; operators should not have to provide `--max-iterations` every time. The default budget is `10`.

## Target Flow

```text
User
  -> qa-orchestrator: requirements, scope, Jira ticket/link or pasted acceptance criteria
qa-orchestrator
  -> validates intake
  -> blocks with follow-up questions if requirements are insufficient
  -> routes to qa-planner when intake is complete
qa-planner
  -> creates/refines PRD.md, progress.md, PROMPT.md
  -> creates bounded tasks
qa-orchestrator
  -> starts iteration loop, default max iterations 10
  -> selects next role/task from progress.md
qa-executor
  -> performs discovery and implementation for one bounded task
  -> for coverage: seed.spec.ts first, Playwright CLI first, MCP fallback only if needed
  -> promotes proven logic into BDD/framework files
qa-verifier
  -> checks proof
  -> runs required verification commands
  -> marks pass/fail/blocked
qa-orchestrator
  -> continues loop or returns final summary
```

The dashed loop in workflow diagrams belongs to `qa-orchestrator`. The planner does not own the loop. The executor does not own the loop. The verifier does not own the loop.

Every iteration handles exactly one selected role and one selected task. A single worker process must not continue to the next unchecked task after completing its selected task.

## Original Ralph Loop Invariants

The product harness must preserve the original Ralph loop model while adapting it to QA harness work.

Required invariants:

- The supervisor owns the loop. In this product, the supervisor is `qa-orchestrator` inside `ralph-qa-harness`.
- Each iteration starts a fresh worker process or equivalent fresh model context.
- The selected agent receives all required context through the current prompt.
- The selected agent must not depend on prior chat/session memory.
- Durable memory is stored in `.qa-harness/`, not in the worker process.
- The worker prompt is passed on stdin or an equivalent non-argument input channel.
- One iteration selects exactly one agent role.
- One iteration selects exactly one bounded task.
- The worker exits with the required Ralph footer.
- The supervisor records stdout, stderr, summary, validation, diff, and evidence for the iteration.
- The supervisor decides whether to continue, stop, route to verifier, route to healing, or exhaust budget.
- Completion requires verifier acceptance and supervisor verification, not executor self-approval.

Fresh-context requirements:

- Reusing the same long-running agent conversation across iterations is forbidden.
- Passing hidden previous messages into the next iteration is forbidden.
- If a worker needs prior state, that state must be written to `.qa-harness/` and explicitly included in the next prompt.
- A new iteration may read previous iteration artifacts only through files selected by the orchestrator.
- Iteration summaries must include enough evidence to audit what the fresh worker saw and changed.

Implementation implications:

- `run` must launch one new Copilot process or one isolated model execution per iteration.
- A role change from `qa-executor` to `qa-verifier` must always use a fresh context.
- A retry or healing attempt must also use a fresh context.
- The orchestrator may synthesize a new prompt from durable files, but must not keep an in-memory conversational transcript as agent memory.
- Tests must prove two iterations are two separate worker invocations with separate prompts.

## Agent Contracts

### `qa-orchestrator`

`qa-orchestrator` is the main loop controller.

Responsibilities:

- Own the internal product Ralph loop.
- Read `.qa-harness/PRD.md`, `.qa-harness/progress.md`, and `.qa-harness/PROMPT.md` before routing work.
- Validate coverage intake before planner work begins.
- Require target URL or app scope for coverage work.
- Require a Jira ticket link/text or pasted requirements for coverage work.
- Require acceptance criteria for coverage work.
- Create or update blocked intake state when required intake is missing.
- Ask concrete follow-up questions when intake is incomplete.
- Route to `qa-planner` only after intake is complete enough to plan.
- Select one role and one task per iteration.
- Enforce the iteration budget.
- Stop on `completed`, `failed`, `blocked`, `stalled`, or `budget-exhausted`.
- Produce the final user-facing summary from run evidence.

Must not:

- Implement test code.
- Create feature files from guessed requirements.
- Invent missing acceptance criteria.
- Bypass or weaken product constraints.
- Mark verifier-only completion.
- Let executor work begin when coverage intake is incomplete.

Routing rules:

- Missing or incomplete coverage intake routes to `qa-orchestrator` blocked follow-up.
- Missing or stale planning artifacts route to `qa-planner`.
- Actionable implementation tasks route to `qa-executor`.
- Executor `pass` or `needs-verification` evidence routes to `qa-verifier`.
- Verifier `fail` with retry budget remaining routes to `qa-executor` healing mode.
- Verifier `blocked` or exhausted retry budget stops the run as blocked.
- All required items verifier-passed stops the run as completed.

### `qa-planner`

`qa-planner` converts accepted requirements into durable run artifacts and bounded tasks.

Responsibilities:

- Convert requirements into `.qa-harness/PRD.md`.
- Convert acceptance criteria into bounded progress items in `.qa-harness/progress.md`.
- Refine `.qa-harness/PROMPT.md` with run-specific worker rules.
- Create acceptance-driven BDD intent.
- Define verification expectations for every progress item.
- Split work so each progress item can be completed and verified independently.
- Send incomplete requirements back to `qa-orchestrator`.

Must not:

- Run browser discovery.
- Write final locator code.
- Guess selectors.
- Mark tasks complete.
- Collapse discovery, implementation, and verification into one task.

Planner output requirements:

- Each progress item has an id, goal, input, output, verify command or proof requirement, owner, status, retry budget, result, and evidence field.
- Coverage progress must include seed proof requirements.
- Coverage progress must include full Playwright execution requirements.
- Planner-authored tasks must be small enough for one worker iteration.

### `qa-executor`

`qa-executor` performs implementation work for one selected task.

Responsibilities:

- Complete exactly one selected implementation task.
- Read the selected task and durable artifacts before editing.
- For coverage work, create run-local `seed.spec.ts` before writing final BDD/framework files.
- Run Playwright CLI first.
- Use stable user-visible locators where possible.
- Use MCP only after Playwright CLI discovery cannot proceed.
- Record the MCP fallback reason when MCP is used.
- Record MCP evidence when MCP is used.
- Promote proven actions and locators from `seed.spec.ts` into feature, step, and framework files.
- Run general Playwright tests for affected generated specs before handing off.
- Move the selected item to `needs-verification` when implementation evidence is ready.

Executor skill modes:

- Exploration mode: discover page state, interactions, user-visible locators, consent surfaces, and stable assertions.
- Implementation mode: write or update feature files, step definitions, page helpers, and framework logic from proven seed code.
- Healing mode: fix one failed task after verifier rejection, using the verifier's evidence and failure reason.

Must not:

- Treat feature generation as enough proof.
- Treat `playwright test --list` as runtime proof.
- Bypass CAPTCHA, consent, age gates, auth gates, region restrictions, or anti-bot controls.
- Mark final pass.
- Continue to another task after the selected task is ready for verification.
- Use MCP before trying Playwright CLI for coverage discovery.

### `qa-verifier`

`qa-verifier` owns proof review and final acceptance.

Responsibilities:

- Review evidence and changed files for the selected task.
- Run final verification commands.
- Check seed evidence for coverage tasks.
- Check that Playwright CLI was attempted before MCP fallback.
- Check MCP fallback reason and evidence when MCP was used.
- Mark the selected item `pass`, `fail`, or `blocked`.
- Write concise verifier evidence to durable artifacts.

Must require:

- `bddgen export`
- `bddgen test`
- `playwright test --list`
- Full `playwright test` for affected generated specs
- Seed evidence for coverage tasks

Must not:

- Modify implementation files except durable progress and evidence fields if needed.
- Accept coverage based only on generated feature files.
- Accept coverage based only on listed tests.
- Accept missing fallback reasons.
- Accept bypassed restricted flows.

Only `qa-verifier` may mark a selected item final `pass`.

## Agent Files

The package ships static role templates at these exact paths:

```text
templates/qa-agents/main-orchestrator/agent.md
templates/qa-agents/main-orchestrator/skills.md
templates/qa-agents/planner/agent.md
templates/qa-agents/planner/skills.md
templates/qa-agents/executor/agent.md
templates/qa-agents/executor/skills.md
templates/qa-agents/verifier/agent.md
templates/qa-agents/verifier/skills.md
```

Template ownership:

- Static agent templates stay in package templates.
- Run artifacts store resolved prompts and evidence.
- Run artifacts do not copy the static template source unless the resolved prompt naturally includes the selected template content.

Prompt rules:

- Every worker prompt includes only the selected role's `agent.md`.
- Every worker prompt includes only the selected role's `skills.md`.
- A `qa-executor` prompt may include executor skill-mode instructions selected by the orchestrator.
- A planner prompt must not include executor-only browser-discovery instructions.
- A verifier prompt must not include executor implementation instructions.
- Every worker prompt must include all durable context required for the fresh session to complete the selected task.
- Every iteration summary records selected role as `RALPH_AGENT`.

Valid `RALPH_AGENT` values:

```text
qa-orchestrator
qa-planner
qa-executor
qa-verifier
```

Invalid or missing `RALPH_AGENT` is a failed iteration unless the failure occurred before a worker prompt could be written.

Required footer remains:

```text
RALPH_STATUS: pass|blocked|fail
RALPH_SUMMARY: <one concise paragraph>
RALPH_VALIDATION: <commands run, or why not run>
RALPH_NEXT: <next recommended action, or none>
```

## CLI Design

`ralph-qa-harness run` defaults to `10` iterations.

Behavior:

- `ralph-qa-harness run` uses max iterations `10`.
- `ralph-qa-harness run --max-iterations 3` uses max iterations `3`.
- `ralph-qa-harness run --max-iterations 0` fails clearly.
- `ralph-qa-harness run --max-iterations -1` fails clearly.
- `ralph-qa-harness run --max-iterations abc` fails clearly.
- `ralph-qa-harness run --max-iterations` fails clearly.

`prepare --from <feature-path>` remains supported for feature-backed runs.

Request-backed coverage intake is added to `prepare`. The exact CLI shape may be implemented as `prepare --request <text>` or another compatible prepare mode, but it must remain under `prepare` and must not restore old deleted command names as the primary interface.

Coverage intake requires:

- Target URL or application scope.
- Jira ticket link/text or pasted requirements.
- Acceptance criteria.
- Constraints such as login/no-login, public/private, browser/project, consent handling, CAPTCHA, anti-bot, age gates, region restrictions, and other restricted flows.

If required intake is missing:

- Create or update blocked intake state.
- Record missing fields.
- Ask concrete follow-up questions.
- Do not generate speculative feature files.
- Do not dispatch `qa-planner`.
- Do not dispatch `qa-executor`.

Jira v1 scope:

- Jira API integration is out of scope for v1.
- The harness accepts Jira ticket link/text or pasted requirements.
- The harness may store the Jira link/text as source context.
- The harness must not require Jira credentials in v1.

## Coverage Workflow

Coverage executor sequence:

1. Create run-local `seed.spec.ts`.
2. Start with Playwright CLI discovery/execution.
3. Use stable user-visible locators where possible.
4. If CLI cannot discover state or locator, use MCP fallback.
5. Record fallback reason and MCP evidence.
6. Update `seed.spec.ts` until the flow runs.
7. Promote proven flow into BDD feature and step/framework files.
8. Run `bddgen export`.
9. Run `bddgen test`.
10. Run `playwright test --list` for affected generated specs.
11. Run full `playwright test` for affected generated specs.
12. Hand evidence to verifier.

Seed file rules:

- The seed file path is `.qa-harness/runs/<run-id>/seed.spec.ts`.
- The seed file imports Playwright test APIs from the target project dependencies.
- The seed file is run through Playwright CLI.
- If the target project's normal Playwright config cannot execute `.qa-harness/runs/<run-id>/seed.spec.ts`, the executor creates a run-local Playwright config under the run directory and records that config as evidence.
- The run-local config must not be tracked as project source.
- The seed must contain the working navigation, interactions, waits, assertions, and locators needed for the selected coverage flow.

Playwright CLI first means:

- The executor first tries Playwright CLI execution for the seed.
- The executor records command, args, stdout, stderr, exit code, and duration.
- The executor may iterate on `seed.spec.ts` based on real CLI failure output.
- The executor must not call MCP before this CLI attempt for coverage discovery.

MCP fallback means:

- MCP is used only when Playwright CLI cannot discover the required page state or stable locator.
- MCP use requires a fallback reason.
- MCP use requires evidence such as accessibility snapshot, observed element names, or interaction notes.
- MCP output informs the next seed iteration; MCP output is not itself final proof.

Promotion rules:

- BDD feature and step/framework files are updated only after seed proof exists.
- Final BDD steps must use proven locators/actions from seed evidence.
- Final assertions must avoid brittle exact titles, counts, ad surfaces, recommendation order, or layout positions unless the acceptance criteria require them.
- Restricted flows must be blocked, not bypassed.

## Artifact Model

Durable state stays under `.qa-harness/`.

Required artifact layout:

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

Artifact rules:

- `.qa-harness/config.json` stores product-level harness configuration, including default loop settings.
- `.qa-harness/PRD.md` stores requirements, accepted scope, constraints, and acceptance criteria.
- `.qa-harness/progress.md` stores progress items and durable status.
- `.qa-harness/PROMPT.md` stores stable run-level worker rules.
- `.qa-harness/normalized.feature` is present for feature-backed runs.
- `.qa-harness/state.json` stores current/latest run state.
- `.qa-harness/runs/<run-id>/seed.spec.ts` stores the proven seed for coverage work.
- `.qa-harness/runs/<run-id>/agents/resolved-prompts/` stores resolved prompts by role and iteration when useful for audit.
- `.qa-harness/runs/<run-id>/iterations/<nnn>/evidence/` stores screenshots, traces, MCP snapshots, CLI logs, or other bounded evidence.
- `.features-gen/.qa-harness/` remains generated Playwright BDD output only.
- Static agent templates remain under `templates/qa-agents/`.

## Progress Item Lifecycle

Allowed statuses:

- `todo`
- `doing`
- `needs-verification`
- `pass`
- `fail`
- `blocked`

Status rules:

- `qa-planner` creates `todo` items.
- `qa-orchestrator` may mark a selected item `doing` when dispatching it.
- `qa-executor` moves a selected item to `needs-verification` when implementation evidence is ready.
- `qa-verifier` moves a selected item to `pass`, `fail`, or `blocked`.
- `qa-orchestrator` chooses the next item based on status and retry budget.
- Completion requires every required item to be verifier-passed.

Retry rules:

- `fail` with retry budget remaining routes back to `qa-executor` healing mode.
- `fail` with no retry budget remaining stops or remains failed according to run policy.
- `blocked` stops the run unless the block is missing intake that the user can answer.
- `needs-verification` always routes to `qa-verifier`.
- `pass` items are not selected again.

## Verification Gate

A coverage task can pass only when all required proof exists:

- Requirements intake is complete.
- Seed proof exists.
- Playwright CLI execution was attempted first.
- MCP fallback, if used, has recorded reason.
- MCP fallback, if used, has recorded evidence.
- BDD/framework files are updated from proven seed.
- `bddgen export` passes.
- `bddgen test` passes.
- `playwright test --list` finds affected tests.
- Full `playwright test` passes for affected specs.
- `qa-verifier` writes final pass evidence.

Verification command order:

```text
npx bddgen export
npx bddgen test
npx playwright test --list <affected generated specs>
npx playwright test <affected generated specs>
```

The verifier must reject coverage when:

- No seed proof exists.
- The seed was not executed by Playwright CLI.
- MCP was used without a recorded fallback reason.
- BDD/framework code differs materially from the proven seed without explanation.
- Only list-time verification ran.
- Runtime Playwright execution failed.
- The flow bypassed a consent, CAPTCHA, auth, age, anti-bot, or region restriction.

## Development Checklist

- Add optional `--max-iterations` defaulting to `10`.
- Add config default for loop max iterations.
- Add static agent templates and package tests proving they exist.
- Add role prompt builder that injects selected agent files.
- Add `RALPH_AGENT` to worker prompts, summaries, and validation artifacts.
- Refactor run dispatch around orchestrator-selected roles.
- Enforce fresh worker context per iteration.
- Add iteration evidence proving each role invocation used a separate prompt and separate worker process or isolated execution.
- Add request-backed coverage intake.
- Add blocked intake behavior for missing Jira/requirements/AC.
- Add seed file workflow for coverage executor.
- Add Playwright CLI-first execution evidence.
- Add MCP fallback evidence and fallback reason.
- Add promotion from seed file into BDD/framework files.
- Add full Playwright execution to verifier requirements for coverage.
- Update README, design docs, examples, and tests.

Implementation order:

1. Update tests for `run` default budget and explicit override.
2. Implement `run` default budget.
3. Add agent template files.
4. Add package/template tests for agent files.
5. Add role prompt builder tests.
6. Implement role prompt builder.
7. Add orchestrator dispatch tests.
8. Refactor run dispatch.
9. Add fresh-context dispatch tests.
10. Enforce fresh worker invocation per iteration.
11. Add coverage intake tests.
12. Implement request-backed coverage intake and blocked intake state.
13. Add seed workflow tests with fake Playwright CLI runner.
14. Implement seed workflow artifact writing.
15. Add MCP fallback tests with fake MCP evidence.
16. Implement MCP fallback recording.
17. Add verifier gate tests for seed proof and full Playwright execution.
18. Implement verifier gate changes.
19. Update README, examples, and docs.
20. Run full package validation.

## Test Checklist

- CLI default run budget test.
- CLI explicit run budget override test.
- Invalid run budget tests.
- Agent template existence tests.
- Prompt includes selected agent only.
- Orchestrator blocks incomplete intake.
- Every iteration starts a fresh worker context.
- Role changes never reuse previous worker context.
- Planner writes bounded progress.
- Executor creates seed evidence.
- MCP fallback only after CLI failure.
- Verifier rejects coverage without seed proof.
- Verifier rejects coverage without full Playwright execution.
- Verifier pass marks completion.
- Existing package suite remains green.

Detailed expected test coverage:

- `run` with no `--max-iterations` dispatches at most `10` iterations.
- `run --max-iterations 3` dispatches at most `3` iterations.
- `run --max-iterations 0` exits nonzero with a clear message.
- `run --max-iterations -1` exits nonzero with a clear message.
- `run --max-iterations abc` exits nonzero with a clear message.
- Missing static agent template fails package/template validation.
- Worker prompt for `qa-planner` includes planner `agent.md` and planner `skills.md`.
- Worker prompt for `qa-planner` does not include executor or verifier role instructions.
- Two-iteration runs create two separate worker prompts and two separate worker invocations.
- Executor-to-verifier routing creates a fresh verifier invocation instead of continuing executor context.
- Healing retries create a fresh executor invocation instead of reusing failed executor context.
- Incomplete coverage intake records blocked state and follow-up questions.
- Complete coverage intake allows planner routing.
- Coverage executor writes `.qa-harness/runs/<run-id>/seed.spec.ts`.
- Coverage executor records the first Playwright CLI attempt.
- MCP fallback is rejected when no CLI attempt was recorded.
- MCP fallback is rejected when fallback reason is missing.
- Verifier rejects coverage when only `playwright test --list` passed.
- Verifier accepts coverage only after full Playwright execution passes.

## Acceptance Criteria

This design is complete when:

- It states exactly four agents.
- It states orchestrator owns the loop.
- It states default max iterations is `10`.
- It states every iteration uses a fresh worker context.
- It states durable memory is file-backed through `.qa-harness/`.
- It states Playwright CLI first, MCP fallback second.
- It states coverage cannot pass without real Playwright execution.
- It states Jira API is out of scope for v1.
- It gives exact artifact paths.
- It gives exact development checklist items.
- It gives exact test checklist items.
