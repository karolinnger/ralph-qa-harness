# Four-Agent Workflow From Another Project

This example assumes the target project already has the supported Playwright BDD layout:

```text
playwright.config.ts
Features/homepage.feature
Features/steps/homepage.steps.ts
```

## 1. Install the harness

Run this from the target project root:

```bash
npm install --save-dev ralph-qa-harness
```

For local package development, install from the package checkout instead:

```bash
npm install --save-dev ../ralph-qa-harness
```

## 2. Install the required test layers

```bash
npm install --save-dev @playwright/test playwright-bdd
```

## 3. Check the target project

```bash
npx ralph-qa-harness doctor
```

## 4. Prepare a feature-backed run

```bash
npx ralph-qa-harness prepare --from Features/homepage.feature
```

The command creates durable state under `.qa-harness/`, copies the selected feature to `.qa-harness/normalized.feature`, and records one bounded progress item.

## 5. Run a bounded worker loop

```bash
npx ralph-qa-harness run --max-iterations 2
```

The product loop has exactly four agents: `qa-orchestrator`, `qa-planner`, `qa-executor`, and `qa-verifier`. The orchestrator owns the loop, chooses one role and one bounded task, launches one fresh Copilot process with a role-scoped prompt on stdin, and records durable run evidence under `.qa-harness/runs/<run-id>/`. Without `--max-iterations`, `run` defaults to a budget of 40 iterations.

## 6. Inspect status and validation

```bash
npx ralph-qa-harness status
npx ralph-qa-harness verify
```

Coverage work uses Playwright CLI first for run-local seed evidence. MCP fallback is allowed second only when CLI discovery cannot proceed and the worker records a fallback reason plus durable evidence. Jira API integration is out of scope; `prepare --request` may record a Jira link or ticket text as source context, but it does not fetch Jira data.

`verify` runs `bddgen export`, `bddgen test`, `playwright test --list <affected generated specs>`, and full `playwright test <affected generated specs>`. Full Playwright execution is required before coverage pass; coverage cannot pass on list-only proof. Generated Playwright BDD output may appear under `.features-gen/.qa-harness/`; durable harness decisions remain under `.qa-harness/`.
