# Lean Workflow From Another Project

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

Each iteration launches one fresh Copilot process, sends the worker prompt on stdin, and records run evidence under `.qa-harness/runs/<run-id>/`.

## 6. Inspect status and validation

```bash
npx ralph-qa-harness status
npx ralph-qa-harness verify
```

`verify` runs list-time Playwright BDD validation with `bddgen export`, `bddgen test`, and `playwright test --list`. Generated Playwright BDD output may appear under `.features-gen/.qa-harness/`; durable harness decisions remain under `.qa-harness/`.
