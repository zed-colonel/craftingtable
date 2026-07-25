import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * CT03-A61, A63, A64, A65, and the browser-refresh half of A50.
 *
 * Drives the real AQ-CONT-1 fixture through the real daemon: import, inspect,
 * admit, and reload.
 */

const USERNAME = 'e2e-admin';
const PASSWORD = 'correct horse battery staple';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/plan-bundles/${name}`, import.meta.url));

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Default workspace' })).toBeVisible();
}

async function importAqBundle(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Import plan' }).click();
  await expect(page.getByRole('heading', { name: 'Import a plan bundle' })).toBeVisible();
  await page.getByLabel('Project name').fill('ActionQueue — AQ-CONT-1');
  await page
    .getByLabel('Implementation plan (required)')
    .setInputFiles(fixture('aq-cont-1/aq-cont-1-implementation-plan.md'));
  await page
    .getByLabel('Work breakdown (required)')
    .setInputFiles(fixture('aq-cont-1/aq-cont-1-work-breakdown.yaml'));
  await page
    .getByLabel('Checksum manifest (optional)')
    .setInputFiles(fixture('aq-cont-1/aq-cont-1-implementation-plan.sha256'));
  await page.getByRole('button', { name: 'Import plan bundle' }).click();
}

test('imports AQ-CONT-1, admits AQ-01, and survives a refresh', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await signIn(page);
  await importAqBundle(page);

  // The project page opens on a successful import (CT03-A61).
  await expect(page.getByRole('heading', { name: 'ActionQueue — AQ-CONT-1' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Plan versions' })).toContainText('v1');
  await expect(page.getByRole('region', { name: 'Risk distribution' })).toContainText(
    'Critical: 6',
  );
  await expect(page.getByRole('region', { name: 'Risk distribution' })).toContainText('High: 7');
  await expect(page.getByRole('region', { name: 'Risk distribution' })).toContainText('Medium: 1');
  await expect(page.getByRole('heading', { name: 'Work items (14)' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Source artifacts' })).toContainText(
    'aq-cont-1-work-breakdown.yaml',
  );

  const items = page.getByRole('region', { name: 'Work items' });
  await expect(items.getByText('Ready for admission')).toHaveCount(1);
  await expect(items.getByText('Dependency-blocked')).toHaveCount(13);

  // Source artifacts render as escaped text (CT03-A65).
  await page
    .getByRole('region', { name: 'Source artifacts' })
    .getByRole('button', { name: 'aq-cont-1-work-breakdown.yaml' })
    .click();
  const source = page.getByTestId('source-text');
  await expect(source).toContainText('pull_requests:');
  await expect(source).toContainText('id: AQ-01');

  // Work-item detail (CT03-A62).
  await page.getByRole('button', { name: 'AQ-01', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /AQ-01 · Freeze evidence/ })).toBeVisible();
  await expect(page.getByText('Ready for admission')).toBeVisible();
  await expect(page.getByText('No unfinished required predecessors.')).toBeVisible();

  // Admission produces a visibly non-executable draft (CT03-A63).
  await page.getByRole('button', { name: 'Admit into agenda' }).click();
  const draft = page.getByRole('region', { name: 'Work contract draft' });
  await expect(draft).toBeVisible();
  await expect(draft).toContainText('Draft — not executable.');
  await expect(draft).toContainText('Unresolved (7)');
  await expect(draft).toContainText('Registered repository');
  await expect(draft).toContainText('Execution environment');
  await expect(draft).toContainText('Human authorization required');
  await expect(page.getByRole('button', { name: /approve/i })).toHaveCount(0);

  // A refresh reconstructs the admitted state from SQLite (CT03-A50).
  await page.reload();
  await expect(page.getByRole('heading', { name: /AQ-01 · Freeze evidence/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Work contract draft' })).toBeVisible();
  await expect(page.getByText('Admitted', { exact: true }).first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('distinguishes duplicate and failed import outcomes', async ({ page }) => {
  await signIn(page);
  await importAqBundle(page);
  await expect(page.getByRole('heading', { name: 'ActionQueue — AQ-CONT-1' })).toBeVisible();

  // Re-importing the identical bytes is recognised, not duplicated (CT03-A64).
  await importAqBundle(page);
  const duplicate = page.getByRole('region', { name: 'Import result' });
  await expect(duplicate).toContainText('Identical to an existing plan version');

  // A cyclic plan fails with an actionable, persisted diagnostic.
  await page.getByRole('link', { name: 'Import plan' }).click();
  await page.getByLabel('Project name').fill('Broken plan');
  await page
    .getByLabel('Implementation plan (required)')
    .setInputFiles(fixture('aq-cont-1/aq-cont-1-implementation-plan.md'));
  await page
    .getByLabel('Work breakdown (required)')
    .setInputFiles(fixture('invalid/two-node-cycle.yaml'));
  await page.getByRole('button', { name: 'Import plan bundle' }).click();

  const failure = page.getByRole('region', { name: 'Import result' });
  await expect(failure).toContainText('Import failed validation');
  await expect(failure).toContainText('No project, plan version, or work item was created.');
  await expect(failure).toContainText('required-dependency-cycle');
  await expect(failure).toContainText('WI-01 → WI-02 → WI-01');
});

test('renders hostile source content as text without executing it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Import plan' }).click();
  await page.getByLabel('Project name').fill('Injection probe');
  await page
    .getByLabel('Implementation plan (required)')
    .setInputFiles(fixture('aq-cont-1/aq-cont-1-implementation-plan.md'));
  await page
    .getByLabel('Work breakdown (required)')
    .setInputFiles(fixture('invalid/script-injection.yaml'));
  await page.getByRole('button', { name: 'Import plan bundle' }).click();

  await expect(page.getByRole('heading', { name: 'Injection probe' })).toBeVisible();
  await page
    .getByRole('region', { name: 'Source artifacts' })
    .getByRole('button', { name: 'script-injection.yaml' })
    .click();

  const source = page.getByTestId('source-text');
  await expect(source).toContainText('<script>window.__pwned = true</script>');
  // The markup is text: it created no element and ran no script.
  expect(await page.locator('pre script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBe(
    undefined,
  );
});
