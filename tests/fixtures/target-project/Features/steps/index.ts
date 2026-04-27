import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { Given, When, Then } from './fixtures';

type PageLike = Pick<Page, 'getByText' | 'locator'>;
type LocatorCandidate = {
  label: string;
  locator: Locator;
};

const YOUTUBE_HOME_URL = 'https://www.youtube.com/';
const HUMAN_VERIFICATION_PATTERN =
  /(?:unusual traffic|captcha|verify you are human|not a robot)/i;
const RESTRICTED_VIDEO_PATTERN =
  /(?:sign in to confirm your age|video unavailable|not available in your country|not available in your region)/i;

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

async function isVisible(locator: Locator, timeout = 1000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function firstVisible(candidates: LocatorCandidate[], timeout = 2500) {
  for (const candidate of candidates) {
    const locator = candidate.locator.first();
    if (await isVisible(locator, timeout)) {
      return locator;
    }
  }

  const labels = candidates.map((candidate) => candidate.label).join(', ');
  throw new Error(
    `None of these YouTube targets became visible: ${labels}`,
  );
}

async function handleYouTubeConsentIfVisible(page: Page) {
  const consentButtons: LocatorCandidate[] = [
    {
      label: 'Reject all consent button',
      locator: page.getByRole('button', { name: /^Reject all$/i }),
    },
    {
      label: 'Accept all consent button',
      locator: page.getByRole('button', { name: /^Accept all$/i }),
    },
    {
      label: 'I agree consent button',
      locator: page.getByRole('button', { name: /^I agree$/i }),
    },
    {
      label: 'Agree consent button',
      locator: page.getByRole('button', { name: /^Agree$/i }),
    },
  ];

  for (const candidate of consentButtons) {
    const button = candidate.locator.first();
    if (await isVisible(button, 1000)) {
      await button.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      return;
    }
  }
}

async function assertNoHumanVerificationGate(page: Page) {
  const challenge = page.getByText(HUMAN_VERIFICATION_PATTERN).first();

  if (await isVisible(challenge, 1000)) {
    throw new Error('YouTube displayed a human verification challenge; this suite must not bypass it.');
  }
}

async function assertNoRestrictedVideoGate(page: Page) {
  await assertNoHumanVerificationGate(page);

  const restrictedVideo = page.getByText(RESTRICTED_VIDEO_PATTERN).first();
  if (await isVisible(restrictedVideo, 1000)) {
    throw new Error('YouTube displayed an age, availability, or region gate; this suite must not bypass it.');
  }
}

async function getYouTubeSearchBox(page: Page) {
  return firstVisible([
    { label: 'search combobox', locator: page.getByRole('combobox', { name: /^Search$/i }) },
    { label: 'search textbox', locator: page.getByRole('textbox', { name: /^Search$/i }) },
    { label: 'search placeholder', locator: page.getByPlaceholder('Search') },
  ]);
}

async function getFirstVisibleWatchLink(page: Page) {
  const deadline = Date.now() + 15000;
  const links = page.getByRole('link').filter({ hasText: /\S/ });

  while (Date.now() < deadline) {
    const count = Math.min(await links.count(), 50);

    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      if (!(await isVisible(link, 250))) {
        continue;
      }

      const href = await link.getAttribute('href');
      if (!href) {
        continue;
      }

      const url = new URL(href, page.url());
      const isWatchUrl =
        url.hostname.endsWith('youtube.com') &&
        url.pathname === '/watch' &&
        url.searchParams.has('v');

      if (isWatchUrl) {
        return link;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error('No visible public YouTube video result link was found.');
}

function currentUrl(page: Page) {
  return new URL(page.url());
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

Given('I open YouTube as a public visitor', async ({ page }) => {
  await page.goto(YOUTUBE_HOME_URL, { waitUntil: 'domcontentloaded' });
  await handleYouTubeConsentIfVisible(page);
  await assertNoHumanVerificationGate(page);
});

When('I search YouTube for {string}', async ({ page }, query: string) => {
  await handleYouTubeConsentIfVisible(page);
  await assertNoHumanVerificationGate(page);

  const searchBox = await getYouTubeSearchBox(page);
  await searchBox.fill(query);
  await searchBox.press('Enter');
  await page.waitForURL(/\/results\?search_query=/, { timeout: 15000 });
  await handleYouTubeConsentIfVisible(page);
  await assertNoHumanVerificationGate(page);
});

When('I open the first public YouTube video result', async ({ page }) => {
  await assertNoHumanVerificationGate(page);

  const videoLink = await getFirstVisibleWatchLink(page);
  await videoLink.click();
  await page.waitForURL(/\/watch\?/, { timeout: 15000 });
  await handleYouTubeConsentIfVisible(page);
  await assertNoRestrictedVideoGate(page);
});

Then('the YouTube home page should be available', async ({ page }) => {
  await assertNoHumanVerificationGate(page);

  const url = currentUrl(page);
  expect(url.hostname).toMatch(/(^|\.)youtube\.com$/);
  await expect(await getYouTubeSearchBox(page)).toBeVisible();
});

Then('the YouTube search box should be visible', async ({ page }) => {
  await expect(await getYouTubeSearchBox(page)).toBeVisible();
});

Then('YouTube search results should be shown for {string}', async ({ page }, query: string) => {
  await assertNoHumanVerificationGate(page);
  await expect(page).toHaveURL(/\/results\?search_query=/);
  expect(currentUrl(page).searchParams.get('search_query')).toBe(query);
  await expect(await getFirstVisibleWatchLink(page)).toBeVisible();
});

Then('a public YouTube watch page should be open', async ({ page }) => {
  await assertNoRestrictedVideoGate(page);

  const url = currentUrl(page);
  expect(url.hostname).toMatch(/(^|\.)youtube\.com$/);
  expect(url.pathname).toBe('/watch');
  expect(url.searchParams.has('v')).toBe(true);
});

Then('the YouTube video player should be visible', async ({ page }) => {
  await assertNoRestrictedVideoGate(page);
  await expect(page.locator('video').first()).toBeVisible({ timeout: 20000 });
});
