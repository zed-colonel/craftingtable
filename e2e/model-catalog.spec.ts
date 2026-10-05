import { expect, openOwnWorkspace, test } from './support';

/**
 * Model pickers from each CLI's own catalog (R-G15, LIVE-34). The e2e daemon reads only the
 * fixture catalogs: Claude Code's from its own CLAUDE_CONFIG_DIR, Codex's from the fake
 * app-server's `model/list` (fixtures/model-catalogs).
 */
test("offers each CLI's catalog by section and name, and catches a typed display name", async ({
  page,
}, testInfo) => {
  await openOwnWorkspace(page, `Model catalogs ${testInfo.project.name}`);

  // The tool status names where each list came from; "Refresh models" reads them again.
  await page.getByRole('link', { name: 'Repositories' }).click();
  const catalogs = page.getByLabel('Model catalogs');
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/execution-status/refresh-models') &&
      response.ok(),
  );
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await refreshed;
  await expect(catalogs.getByText(/^\d+ from its catalog, read /)).toHaveCount(2);

  await page.getByRole('link', { name: 'Settings' }).click();
  const profiles = page.getByRole('region', { name: 'Agent profiles' });
  await profiles.getByRole('button', { name: 'Edit workspace defaults' }).click();
  const design = profiles.getByRole('group', { name: 'Design', exact: true });
  const model = design.getByRole('combobox', { name: 'Model', exact: true });
  // Claude Code: the aliases, then the catalog's sections, by display name.
  await expect(model.locator('optgroup')).toHaveCount(3);
  await expect(model.locator('optgroup[label="More models"] option')).toHaveText(['Opus 5']);
  await model.selectOption({ label: 'Opus 5.5' });
  await expect(model).toHaveValue('claude-opus-5-5');

  // Codex: LIVE-34's display name, typed under Other…, is offered the catalog's id.
  await design.getByRole('combobox', { name: /^Agent/ }).selectOption('codex');
  await expect(model.getByRole('option', { name: 'GPT-6.1-Sol' })).toHaveCount(1);
  await model.selectOption('__custom__');
  await design.getByLabel('Model id', { exact: true }).fill('GPT-6.1-Sol');
  const warning = design.getByRole('alert');
  await expect(warning).toContainText('gpt-6.1-sol');
  await warning.getByRole('button', { name: 'Use gpt-6.1-sol' }).click();
  await expect(model).toHaveValue('gpt-6.1-sol');
  await profiles.getByRole('button', { name: 'Save workspace defaults' }).click();
  await expect(profiles.getByRole('status')).toHaveText('Profiles saved.');
  await expect(profiles.getByRole('row', { name: /^Design/ })).toContainText('gpt-6.1-sol');
});
