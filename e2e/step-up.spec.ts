import { E2E_PASSWORD, expect, openOwnWorkspace, test } from './support';

/**
 * Step-up (R-G9): a command that lets an agent run unrestricted needs the operator's password
 * again. The browser asks for it, says when it does not match, and sends the command again once
 * it does; the daemon then accepts such commands from the session for 10 minutes.
 */
test('asks for the password again before saving unrestricted agent defaults', async ({
  page,
  browserErrors,
}, testInfo) => {
  await openOwnWorkspace(page, `Step-up ${testInfo.project.name}`);
  await page.getByRole('link', { name: 'Settings' }).click();
  const profiles = page.getByRole('region', { name: 'Agent profiles' });
  await profiles.getByRole('button', { name: 'Edit workspace defaults' }).click();
  await profiles.getByText('Permissions for new work').click();
  await profiles.getByLabel('Design permissions').selectOption('unrestricted');
  // The save is refused until the password is given again, and so is a wrong password.
  const refusedSave = browserErrors.expectFailure({
    method: 'POST',
    path: /^\/api\/workspaces\/[^/]+\/run-profiles$/,
    status: 403,
  });
  const refusedPassword = browserErrors.expectFailure({
    method: 'POST',
    path: '/api/auth/step-up',
    status: 403,
  });
  await profiles.getByRole('button', { name: 'Save workspace defaults' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm your password' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill('not the password');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('That password did not match.');
  await dialog.getByLabel('Password').fill(E2E_PASSWORD);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(profiles.getByRole('status')).toHaveText('Profiles saved.');
  refusedSave();
  refusedPassword();

  // Within the 10 minutes the next such save is not asked about.
  await profiles.getByRole('button', { name: 'Edit workspace defaults' }).click();
  await profiles.getByRole('button', { name: 'Save workspace defaults' }).click();
  await expect(profiles.getByRole('status')).toHaveText('Profiles saved.');
  await expect(dialog).toHaveCount(0);
});
