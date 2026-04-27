# ralph-codex

`ralph-codex` is a standalone Ralph loop supervisor for OpenAI Codex. The CLI owns the loop and starts a fresh Codex process for every iteration, while durable run memory lives in `.ralph/` inside the target repository.

The v1 loop is lean multi-agent orchestration. It dispatches lightweight role prompts for `planner`, `executor`, `verifier`, and `healer` against three durable files:

- `.ralph/PRD.md`
- `.ralph/progress.md`
- `.ralph/PROMPT.md`

Roles are prompt modes, not separate runtimes. The supervisor stays sequential, records each iteration, runs deterministic validation, and treats verifier acceptance as the final-pass boundary.

## Quick Start

From a target git repository:

```powershell
Set-Location C:\path\to\target-repo
node C:\Users\kolos\IdeaProjects\Colossus\ralph-codex\bin\ralph-codex.js init
node C:\Users\kolos\IdeaProjects\Colossus\ralph-codex\bin\ralph-codex.js plan --from docs\implementation-plan.md
node C:\Users\kolos\IdeaProjects\Colossus\ralph-codex\bin\ralph-codex.js doctor
node C:\Users\kolos\IdeaProjects\Colossus\ralph-codex\bin\ralph-codex.js run --max-iterations 10
```

`init` creates `.ralph/`, including `PRD.md`, `progress.md`, and `PROMPT.md`, and adds `.ralph/` to `.git/info/exclude`. It does not edit tracked `.gitignore`.

## Configuration

Edit `.ralph/config.json` after initialization. Windows PowerShell may block the `codex.ps1` shim; set `"command": "codex.cmd"` or use the full `codex.exe` path if `doctor` reports that scripts are disabled.

Auto-commit is disabled by default with `"commitEachIteration": false`. Enable it only when you want passing iterations committed automatically and the working tree baseline is safe.

## Commands

```text
ralph-codex init [--force true]
ralph-codex plan --from <path> [--force true]
ralph-codex run [--max-iterations <n>] [--resume true] [--force-unlock true] [--commit-each-iteration true]
ralph-codex status [--run-id <id>]
ralph-codex verify [--run-id <id>] [--codex-review true]
ralph-codex doctor
```

Every `run` iteration invokes a fresh Codex process with `codex exec` and passes the role prompt on stdin.
