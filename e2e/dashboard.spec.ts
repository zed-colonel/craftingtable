import { expect, test } from '@playwright/test';

test('dashboard loads, connects, and shows the fake agent run', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(String(error));
  });

  await page.goto('/');

  // Shell renders with the workspace header and the simulated-data label.
  await expect(page.getByRole('heading', { name: 'Demo workspace' })).toBeVisible();
  await expect(page.getByText('Simulated data')).toBeVisible();

  // Future dashboard regions are visually suggested.
  for (const label of ['Needs attention', 'Active', 'Ready', 'Blocked']) {
    await expect(page.getByRole('heading', { name: label })).toBeVisible();
  }

  // SSE connects and the normalized fake event appears.
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.getByText(/Run started: /)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('run-started', { exact: true })).toBeVisible();

  // A normal refresh reconnects and replays the simulated run.
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.getByText(/Run started: /)).toBeVisible({ timeout: 10_000 });

  expect(consoleErrors).toEqual([]);
});
