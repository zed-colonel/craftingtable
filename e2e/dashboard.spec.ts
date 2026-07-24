import { expect, test } from '@playwright/test';

const USERNAME = 'e2e-admin';
const PASSWORD = 'correct horse battery staple';
const EVENT_ROUTE = '**/api/workspaces/*/events*';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Default workspace' })).toBeVisible();
}

test('authenticated snapshot, replay, outage recovery, and logout', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to CraftingTable' })).toBeVisible();

  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill('incorrect password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Sign-in failed');

  await signIn(page);
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);

  await page.route(EVENT_ROUTE, (route) => route.abort());
  await page.reload();
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText('Disconnected', { timeout: 10_000 });
  await expect(page.getByRole('alert')).toContainText(
    'last committed workspace state remains visible',
  );

  await page.unroute(EVENT_ROUTE);
  await expect(page.getByRole('status')).toHaveText('Live', { timeout: 10_000 });
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to CraftingTable' })).toBeVisible();
  const protectedStatus = await page.evaluate(async () => {
    const response = await fetch('/api/workspaces');
    return response.status;
  });
  expect(protectedStatus).toBe(401);
  expect(pageErrors).toEqual([]);
});
