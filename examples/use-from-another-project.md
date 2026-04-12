# Example Workflow From Another Project

Assumption: the target project uses the supported Playwright BDD layout described in this package README.

## 1. Install the harness

From the target project root:

```bash
npm install --save-dev ../ralph-qa-harness
```

Or after publishing:

```bash
npm install --save-dev ralph-qa-harness
```

## 2. Ensure Playwright is ready

```bash
npm install --save-dev @playwright/test playwright-bdd
npx playwright install
```

## 3. Validate the target project

```bash
npx ralph-qa-harness doctor --project chromium
```

## 4. Prepare a run

```bash
npx ralph-qa-harness prepare-run --intent coverage --source-type feature --source-ref Features/homepage.feature --mode guided-exploratory --scope single-feature --constraint "feature: homepage" --constraint "risk area: alternate navigation path" --constraint "iteration budget: 1"
```

## 5. Verify and advance the run

```bash
npx ralph-qa-harness verify-run --run-id <run-id> --project chromium
npx ralph-qa-harness advance-run --run-id <run-id> --adapter external --project chromium
```

## 6. Loop only under supervision

```bash
npx ralph-qa-harness loop-run --run-id <run-id> --max-iterations 2 --adapter external --project chromium
```

Review `progress.md`, `logs/*.log`, and `outputs/*.md` between iterations.
