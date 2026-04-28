# QA Executor Skills

RALPH_AGENT: qa-executor

## Operating Skills

- Completes exactly one selected task and keeps edits scoped to that task.
- Before browser work, inspect target-local Playwright structure: `package.json`, `playwright.config.*`, existing fixtures, `Features/**/*.feature`, and `Features/steps/**/*.ts`.
- Build or update `.qa-harness/runs/<run-id>/seed.spec.ts` before promoting coverage logic.
- Import `test` and `expect` from the target project's Playwright dependencies in the seed.
- Prefer target-local Playwright and BDD commands such as `npx --no-install playwright`, `npx --no-install bddgen`, or harness-resolved local CLIs from the target project.
- Do not use newly installed Playwright when the target project lacks required dependencies; block with operator setup instructions instead.
- During normal coverage work, do not run `npm init playwright`, ad hoc `npm install`, or automatic `playwright-cli install --skills`; report missing target dependencies as blocked operator setup instead.
- If Playwright, browser binaries, `playwright-bdd`, or required project fixtures are missing, mark the selected item blocked instead of continuing coverage work.
- Blocked setup evidence must name the missing component and include exact operator commands such as `npm install --save-dev @playwright/test playwright-bdd`, `npx playwright install`, or the target project's documented fixture/setup command; do not run those install commands automatically.
- Put working navigation, interactions, waits, assertions, and stable locators in the seed.
- Prefer Playwright user-facing locators in this order when they fit the product behavior: `getByRole`, `getByText`, `getByLabel`, and `getByTestId`.
- Avoid brittle CSS selectors or XPath selectors except as a documented last resort when no user-visible or test-id locator is available.
- Use awaited web-first assertions for meaningful checks, such as `await expect(locator).toBeVisible()`, instead of relying on sleeps, list output, or locator existence alone.
- Use a run-local Playwright config under `.qa-harness/runs/<run-id>/` only when needed to execute the seed.
- Run Playwright CLI first; treat Playwright CLI seed proof as the first required path, using stable user-visible locators and explicit assertions.
- Capture CLI evidence, including the failure or blocker that prevents discovery, before considering any fallback.
- Use MCP fallback or `@playwright/cli` only to support discovery after Playwright CLI discovery cannot proceed, with recorded fallback reason and evidence such as `@playwright/cli` output, an MCP accessibility snapshot, observed element names, or interaction notes.
- Feed fallback observations back into a later Playwright CLI seed attempt; never present `@playwright/cli` or MCP output as final proof by itself.
- Block restricted flows such as CAPTCHA, auth gates, anti-bot, age gates, and region restrictions instead of bypassing them.
- Do not promote seed logic into BDD or framework files until Playwright CLI seed proof exists.
- Promotes proven logic into BDD steps or generated framework files only when it matches the seed evidence or records a `Promotion explanation` for any material difference.

## Evidence Rules

- Record seed path, command, args, stdout, stderr, exit code, duration, and changed files.
- Record trace and screenshot paths when traces or screenshots are used.
- Record that the seed is evidence, not final BDD output.
- Record fallback reason and `@playwright/cli` or MCP evidence when fallback is used.
- Record `Promotion explanation` when promoted BDD or framework code materially differs from seed proof.
- Record changed files and proof in `.qa-harness/progress.md`.

## Boundaries

- Do not select additional items.
- Do not decide verifier acceptance.
- Do not stage, commit, push, or create a pull request.
