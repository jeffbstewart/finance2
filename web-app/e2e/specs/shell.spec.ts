// E2E spec for the app Shell (docs/design/ui-testing.md, inventory
// "Shell"): the six-section nav rail and its active marking, the
// redirects into it, the toolbar user menu, and logout.
//
// Logout revokes the session server-side, and every other spec shares
// one storageState cookie - so the sign-out test drives a throwaway
// browser context holding its own freshly minted session instead.
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { ensureSession, E2E_USER } from '../support/api';
import { seedPortfolio } from '../support/material';

const SECTIONS = [
  { label: 'Securities', href: '/app/securities' },
  { label: 'Brokers', href: '/app/brokers' },
  { label: 'Positions', href: '/app/positions' },
  { label: 'Allocation', href: '/app/allocation' },
  { label: 'Tax', href: '/app/tax' },
  { label: 'Imports', href: '/app/imports' },
];

function navLink(page: Page, href: string) {
  return page.locator(`mat-nav-list a[href="${href}"]`);
}

test.beforeEach(async () => {
  await seedPortfolio();
});

test('renders the title, the signed-in user, and the six sections', async ({ page }) => {
  await page.goto('/app/brokers');
  await expect(page.locator('.shell-title')).toHaveText('Portfolio Manager');
  await expect(page.getByRole('button', { name: E2E_USER.displayName })).toBeVisible();

  const links = page.locator('mat-nav-list a');
  await expect(links).toHaveCount(SECTIONS.length);
  await expect(page.locator('mat-nav-list a [matListItemTitle]')).toHaveText(
    SECTIONS.map((section) => section.label),
  );
  expect(await links.evaluateAll((all) => all.map((a) => a.getAttribute('href')))).toEqual(
    SECTIONS.map((section) => section.href),
  );
});

test('every section link routes and marks itself active', async ({ page }) => {
  await page.goto('/app/brokers');
  await expect(navLink(page, '/app/brokers')).toHaveClass(/active-link/);

  for (const section of SECTIONS) {
    await navLink(page, section.href).click();
    await expect(page).toHaveURL(`${BASE_URL}${section.href}`);
    await expect(navLink(page, section.href)).toHaveClass(/active-link/);
    const others = SECTIONS.filter((other) => other.href !== section.href);
    for (const other of others) {
      await expect(navLink(page, other.href)).not.toHaveClass(/active-link/);
    }
  }
});

test('the section stays marked on a child route', async ({ page }) => {
  await page.goto('/app/brokers');
  await page.getByRole('link', { name: 'Vanguard' }).click();
  await expect(page).toHaveURL(/\/app\/brokers\/\d+$/);
  await expect(navLink(page, '/app/brokers')).toHaveClass(/active-link/);
});

test('redirects the app root and unknown routes into Brokers', async ({ page }) => {
  await page.goto('/app/');
  await expect(page).toHaveURL(`${BASE_URL}/app/brokers`);

  await page.goto('/app/no-such-page');
  await expect(page).toHaveURL(`${BASE_URL}/app/brokers`);
  await expect(navLink(page, '/app/brokers')).toHaveClass(/active-link/);
});

test('the user menu shows the account line and a Logout item', async ({ page }) => {
  await page.goto('/app/brokers');
  await page.getByRole('button', { name: E2E_USER.displayName }).click();
  const menu = page.locator('.mat-mdc-menu-panel');
  await expect(menu).toContainText(`${E2E_USER.displayName} (${E2E_USER.username})`);
  await expect(menu.getByRole('menuitem', { name: 'Logout' })).toBeVisible();

  // Dismissing leaves the session alone.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: E2E_USER.displayName })).toBeVisible();
});

test('logout revokes the session and lands on the welcome page', async ({ browser }) => {
  // A second, independent session token: signing this one out leaves
  // the run's shared storageState session usable by the other specs.
  const cookie = await ensureSession();
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState: {
      cookies: [
        {
          name: 'finance_session',
          value: cookie,
          domain: 'localhost',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    },
  });
  const page = await context.newPage();
  try {
    await page.goto('/app/brokers');
    await page.getByRole('button', { name: E2E_USER.displayName }).click();
    await page.getByRole('menuitem', { name: 'Logout' }).click();

    await expect(page).toHaveURL(`${BASE_URL}/app/welcome`);
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(page.locator('mat-toolbar')).toHaveCount(0);
    await expect(page.locator('mat-nav-list')).toHaveCount(0);

    // The server session is really gone: a fresh load of a guarded URL
    // bounces to the welcome page with the attempted URL remembered.
    await page.goto('/app/tax');
    await expect(page).toHaveURL(/\/app\/welcome\?return=/);
    expect(new URL(page.url()).searchParams.get('return')).toBe('/tax');
  } finally {
    await context.close();
  }
});

test('the content pane scrolls all the way to the last control', async ({ page }) => {
  // The allocation page is taller than any viewport; its Trading
  // Plans button is the last thing on it. The pane used to overhang
  // the sidenav container by its own padding (48px), so the bottom
  // of every page was clipped off and unreachable.
  await page.goto('/app/allocation');
  const door = page.locator('mat-card-actions a');
  await door.scrollIntoViewIfNeeded();
  await expect(door).toBeInViewport({ ratio: 1 });
  const overhang = await page.evaluate(() => {
    const content = document.querySelector('.shell-content')!.getBoundingClientRect();
    return content.bottom - window.innerHeight;
  });
  expect(overhang).toBeLessThanOrEqual(0);
});
