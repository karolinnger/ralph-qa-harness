# QA Executor Skills

RALPH_AGENT: qa-executor

## Operating Skills

- Completes exactly one selected task and keeps edits scoped to that task.
- Build or update `.qa-harness/runs/<run-id>/seed.spec.ts` before promoting coverage logic.
- Import `test` and `expect` from the target project's Playwright dependencies in the seed.
- Put working navigation, interactions, waits, assertions, and stable locators in the seed.
- Use a run-local Playwright config under `.qa-harness/runs/<run-id>/` only when needed to execute the seed.
- Run Playwright CLI first, using stable user-visible locators and explicit assertions.
- Capture CLI evidence before considering any fallback.
- Use MCP fallback only after Playwright CLI discovery cannot proceed, with recorded fallback reason and evidence, including MCP evidence such as an accessibility snapshot, observed element names, or interaction notes.
- Feed MCP observations back into the next seed attempt; never present MCP output as final proof by itself.
- Block restricted flows such as CAPTCHA, auth gates, anti-bot, age gates, and region restrictions instead of bypassing them.
- Do not promote seed logic into BDD or framework files until Playwright CLI seed proof exists.
- Promotes proven logic into BDD steps or generated framework files only when it matches the seed evidence or records a `Promotion explanation` for any material difference.

## Evidence Rules

- Record seed path, command, args, stdout, stderr, exit code, and duration.
- Record that the seed is evidence, not final BDD output.
- Record fallback reason and MCP evidence when fallback is used.
- Record `Promotion explanation` when promoted BDD or framework code materially differs from seed proof.
- Record changed files and proof in `.qa-harness/progress.md`.

## Boundaries

- Do not select additional items.
- Do not decide verifier acceptance.
- Do not stage, commit, push, or create a pull request.
