import { expect, test } from '@playwright/test';
import { submitSignIn } from './support';

test('owners configure write-only Pushover credentials and test delivery on desktop and phone', async ({
  page,
}, info) => {
  await page.goto('/');
  await submitSignIn(page);
  // Wait for the initial redirect before opening the mobile navigation menu.
  await expect(page.getByRole('heading', { name: 'Default workspace', exact: true })).toBeVisible();
  const navigate = async (name: string) => {
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (info.project.name === 'mobile-chromium') {
      await expect(menu).toBeVisible();
      await menu.click();
    }
    await page.getByRole('link', { name, exact: true }).click();
  };
  await navigate('Workspaces');
  const create = page.getByRole('region', { name: 'New workspace' });
  const name = `Notifications ${info.project.name}`;
  await create.getByLabel('Name', { exact: true }).fill(name);
  await create.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await navigate('Settings');
  const panel = page.getByRole('region', { name: 'Pushover notifications' });
  await expect(panel.getByLabel('Reminder timezone')).toHaveValue('America/Los_Angeles');
  await expect(panel.getByLabel('Daily reminder time')).toHaveValue('21:00');
  await panel.getByLabel('Application API token').fill('a'.repeat(30));
  await panel.getByLabel('Pushover user key').fill('u'.repeat(30));
  await panel.getByLabel('Enable notifications').check();
  await panel.getByRole('button', { name: 'Save notifications', exact: true }).click();
  await expect(panel.getByText('Notification settings saved.', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Application API token')).toHaveValue('');
  await expect(panel.getByLabel('Pushover user key')).toHaveValue('');
  await panel.getByRole('button', { name: 'Send test notification', exact: true }).click();
  await expect(panel.getByText('Test accepted by Pushover', { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  // Delivery polling must preserve edits not yet saved.
  await panel.getByLabel('Device name (optional)').fill('iphone');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await panel.scrollIntoViewIfNeeded();
  await panel.getByRole('button', { name: 'Save notifications', exact: true }).click();
  await page.reload();
  await expect(panel.getByLabel('Device name (optional)')).toHaveValue('iphone');
  await expect(panel.getByLabel('Enable notifications')).toBeChecked();
  await expect(panel.getByLabel('Application API token')).toHaveValue('');
  await panel.getByRole('button', { name: 'Clear credentials', exact: true }).click();
  await expect(
    panel.getByText('Credentials cleared; notifications disabled.', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByLabel('Enable notifications')).not.toBeChecked();
  await expect(
    panel.getByRole('button', { name: 'Send test notification', exact: true }),
  ).toBeDisabled();
});
