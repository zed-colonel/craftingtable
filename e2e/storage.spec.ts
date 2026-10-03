import { expect, submitSignIn, test } from './support';

test('storage settings, cleanup preview and private backups work on desktop and phone', async ({
  page,
}, info) => {
  await page.goto('/');
  await submitSignIn(page);
  await expect(page.getByRole('region', { name: 'Work summary', exact: true })).toBeVisible();
  if (info.project.name.endsWith('mobile-chromium'))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const host = page.getByRole('region', { name: 'Execution capacity', exact: true });
  await expect(host.getByRole('button', { name: 'Change workstation capacity' })).toBeEnabled();
  await host.getByRole('button', { name: 'Change workstation capacity' }).click();
  const capacity = host.getByLabel('Concurrent verification/parent acceptance reviews');
  await capacity.fill('0');
  await expect(host.getByRole('button', { name: 'Save workstation capacity' })).toBeDisabled();
  await host.getByRole('button', { name: 'Refresh reservations' }).click();
  await expect(host.getByRole('status')).toContainText('Reservations and settings refreshed.');
  await expect(capacity).toHaveValue('0');
  await capacity.fill('2');
  await expect(host).toBeVisible();
  await host.getByRole('button', { name: 'Cancel capacity edit' }).click();
  const panel = page.getByRole('region', { name: 'Storage', exact: true });
  await expect(panel.getByText('Database and history', { exact: true })).toBeVisible();
  await panel.getByText('Locations and retention', { exact: true }).click();
  await panel.getByLabel('Other scratch files').selectOption('30');
  // Both viewport projects share one host policy. Exercise the supported reload path
  // when another owner's save or maintenance command wins the race.
  const command = async (name: string, expected: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            /\/storage(?:\/(?:scan|backup))?$/.test(new URL(response.url()).pathname),
        ),
        panel.getByRole('button', { name, exact: true }).click(),
      ]);
      if (response.status() !== 409) {
        expect(response.status(), await response.text()).toBe(200);
        await expect(panel.getByRole('status')).toContainText(expected);
        return;
      }
      await expect(panel.getByRole('alert')).toBeVisible();
      await panel.getByRole('button', { name: 'Reload storage settings', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Storage settings reloaded.');
    }
    throw new Error('Storage remained busy after three explicit reloads.');
  };
  await command('Save storage settings', 'Storage settings saved.');
  await command('Scan storage', 'Storage scan complete.');
  await expect(
    panel.getByRole('button', { name: 'Clean eligible files', exact: true }),
  ).toBeDisabled();
  await command('Back up database now', 'Consistent database backup created.');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await expect(panel).toBeVisible();
  await page.reload();
  await panel.getByText('Locations and retention', { exact: true }).click();
  await expect(panel.getByLabel('Other scratch files')).toHaveValue('30');
});
