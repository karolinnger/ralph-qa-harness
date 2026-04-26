# Standalone Codex Ralph CLI Design

Status: Approved design direction; awaiting user review of written spec
Date: 2026-04-26

## Summary

Build a standalone CLI supervisor for running Ralph-style loops with OpenAI Codex. The CLI owns the loop, state, validation, and stop conditions. Codex is invoked as a fresh worker process for each bounded iteration.

The design keeps the original Ralph property intact: progress lives in files and git history, not in an accumulating chat thread. Each iteration starts with a clean Codex context, reloads the current plan and progress from disk, performs one bounded slice, records evidence, and exits.

## Goals

- Provide a general-purpose Codex Ralph loop that can run in any git repository.
- Keep all durable run memory in `.ralph/` files.
- Invoke a fresh Codex process for every iteration.
- Support small, verifiable implementation-plan tasks.
- Record iteration logs, summaries, validation results, and stop reasons.
- Make supervised use easy first, with safe defaults for autonomous use.
- Keep v1 simple enough to inspect and modify.

## Non-Goals

- Do not build a QA-specific Playwright harness in this package.
- Do not implement a Codex-native skill as the primary loop mechanism.
- Do not add dashboards, notifications, PR creation, or parallel workers in v1.
- Do not auto-commit by default.
- Do not require Docker or worktrees for the first version.

## Operator Experience

The package exposes a CLI tentatively named `ralph-codex`.

```text
ralph-codex init
ralph-codex plan --from docs/my-spec.md
ralph-codex run --max-iterations 10
ralph-codex status
ralph-codex verify
ralph-codex doctor
```

`init` creates the `.ralph/` workspace. `plan` creates or imports the implementation plan. `run` starts the supervised loop. `status` reports the active or latest run. `verify` reruns configured validation and optional fresh-context review. `doctor` checks Codex availability, git availability, config validity, and writable state paths.

## Artifact Model

The CLI creates repo-local state under `.ralph/`:

```text
.ralph/
  PROMPT.md
  IMPLEMENTATION_PLAN.md
  progress.md
  config.json
  state.json
  runs/
    <run-id>/
      result.json
      loop-report.md
      iterations/
        001/
          worker-prompt.md
          stdout.log
          stderr.log
          summary.json
          validation.json
          diff.patch
        002/
          worker-prompt.md
          stdout.log
          stderr.log
          summary.json
          validation.json
          diff.patch
```

`PROMPT.md` contains standing instructions. `IMPLEMENTATION_PLAN.md` contains the checked task list. `progress.md` is append-only run memory for decisions, completed work, blocked reasons, and concise failure notes. `config.json` stores Codex command settings, validation commands, iteration budgets, and safety defaults. `state.json` records active run metadata and lock state.

`.ralph/` should be added to `.git/info/exclude` by default so transient run state does not dirty tracked project files. The CLI must not edit tracked `.gitignore` unless the operator asks.

## Configuration

`config.json` uses structured command definitions so Windows, macOS, and Linux can run without shell-specific parsing:

```json
{
  "codex": {
    "command": "codex",
    "args": [],
    "model": "",
    "sandbox": "workspace-write",
    "approvalPolicy": "on-failure",
    "timeoutMs": 900000
  },
  "loop": {
    "maxIterations": 10,
    "stalledNoChangeLimit": 2,
    "commitEachIteration": false,
    "verificationPasses": 1
  },
  "validationCommands": [
    {
      "name": "test",
      "command": "npm",
      "args": ["test"]
    }
  ]
}
```

Empty `model` means use the local Codex default. `workspace-write` and `on-failure` are the default safety posture. `danger-full-access` is allowed only through explicit config or CLI flags and must be shown in `doctor` and `run` output.

## Loop Flow

Each `run` does the following:

1. Acquire a `.ralph/state.json` lock for the repo.
2. Create a new timestamped run directory.
3. Reload `PROMPT.md`, `IMPLEMENTATION_PLAN.md`, `progress.md`, and `config.json`.
4. Find the highest-priority unchecked task.
5. Build a worker prompt that instructs Codex to work on one bounded task only.
6. Launch a fresh Codex process.
7. Capture stdout, stderr, exit status, duration, changed files, and git diff.
8. Run configured validation commands.
9. Update `progress.md`, iteration `summary.json`, and `loop-report.md`.
10. Stop or continue based on the classified result.

The supervisor re-reads artifacts from disk before every iteration. It never assumes in-memory state is authoritative.

## Worker Prompt Contract

Every worker prompt includes:

- The standing instruction from `.ralph/PROMPT.md`.
- The current implementation plan.
- The current progress log.
- The selected task id or exact checklist item.
- A one-task write boundary.
- Validation commands the worker should run before exiting when practical.
- Required final structured footer.

The footer is plain text so it works with normal Codex output:

```text
RALPH_STATUS: pass|blocked|fail
RALPH_SUMMARY: <one concise paragraph>
RALPH_VALIDATION: <commands run, or why not run>
RALPH_NEXT: <next recommended action, or none>
```

The supervisor treats this footer as a hint, not proof. Validation commands and changed files decide whether the iteration can be marked complete.

## Stop Conditions

The loop stops with one of these terminal states:

- `completed`: all checklist tasks are complete and verification passes.
- `blocked`: Codex reports a missing decision, missing credential, unsafe permission, or ambiguous requirement.
- `fail`: Codex exits unsuccessfully or validation fails in a non-recoverable way.
- `stalled`: repeated iterations produce no meaningful file, plan, or progress changes.
- `budget-exhausted`: `maxIterations` is reached while actionable work remains.

The CLI prints the stop reason and writes it to `.ralph/runs/<run-id>/result.json`.

## Verification

Verification has two layers:

1. Deterministic validation commands from `config.json`.
2. Optional fresh-context Codex review in read-only mode.

V1 should require deterministic validation before accepting `completed` when validation commands are configured. If no validation command is configured, the CLI may complete only when all tasks are checked and the operator has not requested verifier passes. The status output must make the absence of deterministic validation explicit.

The optional Codex verifier is launched as a separate fresh process with write access disabled. It reviews the plan, progress, diff, and validation logs, then reports `pass`, `blocked`, or `fail`.

## Git Behavior

The CLI requires a git repository for diff and history inspection. It does not require a clean working tree, but it warns when unrelated changes exist before the run.

Default behavior:

- Do not stage files.
- Do not commit files.
- Save per-iteration `diff.patch`.
- Show changed files in status output.

Optional behavior:

- `--commit-each-iteration` creates one commit after a passing iteration.
- The commit includes only files changed by that iteration when they can be identified safely.
- If unrelated pre-existing changes overlap with the iteration diff, the CLI refuses to auto-commit and records `blocked`.

## Error Handling

- Missing `codex`: `doctor` fails with install/config guidance.
- Invalid config: command exits before modifying state.
- Existing lock: command exits unless `--resume` or `--force-unlock` is supplied.
- Codex timeout: iteration is marked `fail` and logs are preserved.
- Codex asks an interactive question: iteration is marked `blocked`.
- Validation failure: task remains unchecked and the failure summary is appended to `progress.md`.
- No changed files for repeated iterations: stop as `stalled`.
- Permission denial or sandbox escalation: stop as `blocked` unless approval policy permits retry.

All failures preserve `.ralph/` state for inspection and resume.

## Source Layout

Implementation should live in a contained package directory:

```text
ralph-codex/
  package.json
  bin/
    ralph-codex.js
  src/
    cli.js
    config.js
    doctor.js
    git.js
    loop.js
    plan.js
    prompt.js
    state.js
    validation.js
  tests/
    unit/
    integration/
    fixtures/
```

This avoids mixing the general loop with the existing `ralph-qa-harness/` package.

## Testing Strategy

Unit tests cover:

- config defaults and validation
- implementation-plan checkbox parsing
- selected-task detection
- worker prompt generation
- stop-condition classification
- lock acquisition and release
- validation command result parsing
- git diff snapshot handling

Integration tests use a fake Codex executable that writes predictable files and structured footers. Test fixtures should cover pass, blocked, fail, timeout, no-change stall, validation failure, and budget exhaustion.

A smoke test should run `ralph-codex init`, create a tiny plan, execute one fake iteration, and assert that `.ralph/runs/<run-id>/result.json`, logs, and `progress.md` are written correctly.

## Design Rationale

The design follows the Ralph first-principles pattern from the reviewed video: fresh sessions, file-backed memory, concise specs, bounded tasks, and validation backpressure. It also borrows useful ideas from existing public tools without adopting their full scope:

- Open Ralph Wiggum shows multi-agent CLI wrapping and status surfaces.
- `ralph-for-codex` shows Codex-local `.ralph/` working memory, but this design keeps the loop outside the Codex session.
- `ralphex` shows structured plan execution and review phases, but this v1 avoids multi-agent review and dashboards.
- `loop-until-done` shows repeated verification before trusting an agent's done signal.

## Acceptance Criteria

- A user can initialize `.ralph/` in an arbitrary git repo.
- A user can import or write an implementation plan with checkboxes.
- `ralph-codex run` invokes a fresh Codex process per iteration.
- The loop records logs, diff, validation result, and terminal status for every iteration.
- The loop stops correctly for completed, blocked, fail, stalled, and budget-exhausted states.
- The CLI works on Windows PowerShell without Bash-specific assumptions.
- Auto-commit is disabled by default.
- Tests cover core state transitions using a fake Codex executable.
