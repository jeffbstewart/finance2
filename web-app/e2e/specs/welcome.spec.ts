// E2E spec for the Welcome page and the auth guard redirect
// (docs/design/ui-testing.md, inventory "Welcome"). The signed-out
// cases drop the shared storageState so the guard really fires and the
// real Login RPC really sets the session cookie; the signed-in cases
// keep it, to pin the auto-enter path.
//
// Setup mode is not reachable here - global setup has already created
// the single user, and the server closes registration for good once a
// user exists - so the create-first-user card is a unit-lane concern.
import { expect, test, type Page } from '@playwright/test';
import { E2E_USER } from '../support/api';
import { expectSnackbar, seedPortfolio } from '../support/material';

/** Signed-out browsing: no cookie at all. */
const NO_SESSION = { cookies: [], origins: [] };

// Password inputs have no `textbox` role, so the shared `fillField`
// helper cannot reach them - see "Shared-infrastructure gaps".
async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

test.beforeEach(async () => {
  await seedPortfolio();
});

test.describe('already signed in', () => {
  test('the welcome page enters the app at /brokers', async ({ page }) => {
    await page.goto('/app/welcome');
    await expect(page).toHaveURL(/\/app\/brokers$/);
    await expect(page.getByRole('link', { name: 'Vanguard' })).toBeVisible();
  });

  test('the welcome page honors the return query param', async ({ page }) => {
    await page.goto('/app/welcome?return=/tax');
    await expect(page).toHaveURL(/\/app\/tax$/);
    await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  });
});

test.describe('signed out', () => {
  test.use({ storageState: NO_SESSION });

  test('the guard bounces a deep link to the welcome page', async ({ page }) => {
    await page.goto('/app/tax');
    await expect(page.getByText('Please log in')).toBeVisible();
    const url = new URL(page.url());
    expect(url.pathname).toBe('/app/welcome');
    expect(url.searchParams.get('return')).toBe('/tax');
    // Registration is closed once the user exists: sign-in card only.
    await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });

  test('signing in returns to the remembered page', async ({ page }) => {
    await page.goto('/app/tax');
    await signIn(page, E2E_USER.username, E2E_USER.password);
    await expect(page).toHaveURL(/\/app\/tax$/);
    await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  });

  test('signing in from a bare welcome page lands on /brokers', async ({ page }) => {
    await page.goto('/app/welcome');
    await expect(page.getByText('Please log in')).toBeVisible();
    await signIn(page, E2E_USER.username, E2E_USER.password);
    await expect(page).toHaveURL(/\/app\/brokers$/);
    await expect(page.getByRole('link', { name: 'Vanguard' })).toBeVisible();
  });

  test('a wrong password reports the server error and stays on the card', async ({ page }) => {
    await page.goto('/app/welcome');
    await signIn(page, E2E_USER.username, 'not-the-password');
    await expectSnackbar(page, 'invalid username or password');
    await expect(page).toHaveURL(/\/app\/welcome$/);
    // busy() released, so the visitor can try again.
    await expect(page.getByRole('button', { name: 'Log in' })).toBeEnabled();
  });
});
