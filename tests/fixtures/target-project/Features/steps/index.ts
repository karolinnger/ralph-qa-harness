import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { Given, When, Then } from './fixtures';

type PageLike = Pick<Page, 'getByText' | 'locator'>;

export function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isLocatorExpression(target: string) {
  return (
    /^page\./.test(target) ||
    /^getBy[A-Z]/.test(target) ||
    /^locator\(/.test(target)
  );
}

export function isSelectorLike(target: string) {
  return /^(css=|xpath=|text=|id=|data-test=|data-testid=|\/\/|#|\.|\[)/.test(target);
}

export function evaluateLocator(page: Page, target: string): Locator {
  try {
    if (/^page\./.test(target)) {
      return new Function('page', `return ${target};`)(page) as Locator;
    }

    return new Function('page', `return page.${target};`)(page) as Locator;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to resolve locator expression "${target}": ${message}`);
  }
}

export function resolveActionTarget(page: Page, target: string): Locator {
  if (isLocatorExpression(target)) {
    return evaluateLocator(page, target);
  }

  return page.locator(target);
}

export function resolveVisibilityTarget(page: PageLike, target: string): Locator {
  if (isLocatorExpression(target) || isSelectorLike(target)) {
    return resolveActionTarget(page as Page, target);
  }

  return page.getByText(target, { exact: false }) as Locator;
}

export function resolveNavigableUrl(target: string, baseURL?: string, currentUrl?: string) {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target)) {
    return target;
  }

  const fallbackBaseUrl =
    baseURL || (currentUrl && currentUrl !== 'about:blank' ? currentUrl : undefined);

  if (!fallbackBaseUrl) {
    throw new Error(
      `Relative path "${target}" requires Playwright baseURL to be configured or an existing page URL.`,
    );
  }

  return new URL(target, fallbackBaseUrl).toString();
}

Given('the browser session is open', async () => {
  // The Playwright page fixture creates the browser session for each scenario.
});

Given('I open {string}', async ({ page, baseURL }, target: string) => {
  await page.goto(resolveNavigableUrl(target, baseURL, page.url()));
});

When('I click {string}', async ({ page }, target: string) => {
  await resolveActionTarget(page, target).click();
});

When('I fill {string} with {string}', async ({ page }, target: string, value: string) => {
  await resolveActionTarget(page, target).fill(value);
});

When('I press {string}', async ({ page }, key: string) => {
  await page.keyboard.press(key);
});

Then('the title should contain {string}', async ({ page }, text: string) => {
  await expect(page).toHaveTitle(new RegExp(escapeForRegExp(text)));
});

Then('the url should contain {string}', async ({ page }, text: string) => {
  await expect(page).toHaveURL(new RegExp(escapeForRegExp(text)));
});

Then('I should see {string}', async ({ page }, target: string) => {
  await expect(resolveVisibilityTarget(page, target)).toBeVisible();
});

Then('{string} should have value {string}', async ({ page }, target: string, value: string) => {
  await expect(resolveActionTarget(page, target)).toHaveValue(value);
});
