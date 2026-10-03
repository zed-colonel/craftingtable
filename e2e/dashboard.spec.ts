import { expect, expectSignedIn, openWorkspaceNamed, submitSignIn, test } from './support';

const EVENT_ROUTE = '**/api/workspaces/*/events*';

/** This spec is about the bootstrap's own workspace, which no other spec uses (R-I9). */
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await submitSignIn(page);
  await expectSignedIn(page);
  await openWorkspaceNamed(page, 'Default workspace');
}

test('authenticated snapshot, replay, outage recovery, and logout', async ({
  page,
  browserErrors,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to CraftingTable' })).toBeVisible();

  const refusedSignIn = browserErrors.expectFailure({
    method: 'POST',
    path: '/api/auth/login',
    status: 401,
  });
  await submitSignIn(page, 'incorrect password');
  await expect(page.getByRole('alert')).toContainText('Sign-in failed');
  refusedSignIn();

  await signIn(page);
  await expect(page.getByRole('status')).toHaveText('Live');
  // Activity and audit are collapsed by default; the content is still there.
  await page.getByText('Activity', { exact: true }).click();
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);
  await page.getByText('Audit', { exact: true }).click();
  await expect(page.getByText('workspace.created')).toBeVisible();

  // Sessions live on the account page now.
  await page.getByRole('link', { name: /Account/ }).click();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText('This session')).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard' }).click();

  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.getByRole('heading', { name: 'Default workspace' })).toBeVisible();
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);

  const abortedStream = browserErrors.expectFailure({
    method: 'GET',
    path: /^\/api\/workspaces\/[^/]+\/events$/,
    status: 'dropped',
  });
  await page.route(EVENT_ROUTE, (route) => route.abort());
  await page.reload();
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText('Disconnected');
  await expect(page.getByRole('alert')).toContainText(
    'last committed workspace state remains visible',
  );

  await page.unroute(EVENT_ROUTE);
  await expect(page.getByRole('status')).toHaveText('Live');
  abortedStream();
  await expect(page.getByText('Workspace created: Default workspace')).toHaveCount(1);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to CraftingTable' })).toBeVisible();
  // Signed out, the daemon refuses the read: a 401 after a logout needs no declaration.
  const protectedStatus = await page.evaluate(async () => {
    const response = await fetch('/api/workspaces');
    return response.status;
  });
  expect(protectedStatus).toBe(401);
});
