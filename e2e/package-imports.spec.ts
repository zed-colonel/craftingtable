import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';

const test = base.extend<{ upstreamRepository: string }>({
  upstreamRepository: async ({ browserName }, use) => {
    const path = mkdtempSync(join(tmpdir(), `craftingtable-upstream-${browserName}-e2e-`));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, {
          cwd: path,
          stdio: 'pipe',
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        });
      git(['init', '--initial-branch=main', '.']);
      writeFileSync(
        join(path, 'Cargo.toml'),
        '[package]\nname="aq_e2e_pin"\nversion="0.2.0"\nedition="2021"\n[lib]\npath="lib.rs"\n',
      );
      writeFileSync(join(path, 'lib.rs'), 'pub fn fixture(){}\n');
      git(['add', '.']);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'Upstream fixture',
      ]);
      await use(path);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  },
});

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/concurrency/${name}`, import.meta.url));
test('imports WI/EXO planning ZIPs and binds an inactive cross-project roadmap on desktop and phone', async ({
  page,
  upstreamRepository,
}, info) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.getByLabel('Username').fill('e2e-admin');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Default workspace', exact: true })).toBeVisible();
  const navigate = async (name: string) => {
    if (info.project.name === 'mobile-chromium')
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('link', { name, exact: true }).click();
  };
  await navigate('All workspaces');
  const create = page.getByRole('region', { name: 'New workspace' });
  const workspaceName = `Package imports ${info.project.name}`;
  await create.getByLabel('Name', { exact: true }).fill(workspaceName);
  await create.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: workspaceName, exact: true })).toBeVisible();
  // Seed an earlier version so ZIP replacement exercises the existing-project path.
  await navigate('Import plan');
  await page.getByLabel('Project name').fill('WorldInterface');
  await page
    .getByLabel('Implementation plan (required)')
    .setInputFiles(
      fileURLToPath(
        new URL(
          '../fixtures/plan-bundles/aq-cont-1/aq-cont-1-implementation-plan.md',
          import.meta.url,
        ),
      ),
    );
  await page
    .getByLabel('Work breakdown (required)')
    .setInputFiles(
      fileURLToPath(
        new URL(
          '../fixtures/plan-bundles/aq-cont-1/aq-cont-1-work-breakdown.yaml',
          import.meta.url,
        ),
      ),
    );
  await page.getByRole('button', { name: 'Import plan bundle' }).click();
  await expect(page.getByRole('heading', { name: 'WorldInterface', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'AQ-01', exact: true }).first().click();
  await page.getByRole('button', { name: 'Admit into agenda', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove from agenda', exact: true })).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await page.screenshot({ path: info.outputPath('agenda-removal.png') });
  await page.getByRole('button', { name: 'Remove from agenda', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Admit into agenda', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Admit into agenda', exact: true })).toBeVisible();
  for (const [file, name, count] of [
    ['wi-fabric-2-foundational-package-r5-aq-baseline-alignment.zip', 'WorldInterface', 14],
    ['exo-v3-comprehensive-design-package-r6-aq-baseline-alignment.zip', 'Exoskeleton', 19],
  ] as const) {
    await navigate('Import plan');
    await page.getByRole('button', { name: 'Import ZIP archive', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Import plan ZIP' });
    await panel.getByLabel('Planning ZIP (up to 8 MiB)').setInputFiles(fixture(file));
    await panel.getByRole('button', { name: 'Preview ZIP', exact: true }).click();
    await expect(
      panel.getByText(`Plan validated: ${count} work items`, { exact: false }),
    ).toBeVisible();
    if (name === 'WorldInterface') {
      await panel
        .getByLabel('Target project', { exact: true })
        .selectOption({ label: 'WorldInterface · 1 existing version(s)' });
      await expect(panel.getByLabel('Make this the active plan after import')).toBeChecked();
    } else await panel.getByLabel('New project name').fill(name);
    await panel.getByRole('button', { name: 'Import reviewed plan ZIP' }).click();
    await expect(panel.getByText('Import: succeeded', { exact: true })).toBeVisible();
    const version = name === 'WorldInterface' ? 2 : 1;
    await panel
      .getByRole('link', {
        name: `Open plan version ${version} and configure Repository & branches`,
      })
      .click();
    await expect(
      page.getByRole('heading', { name: `Plan version ${version}`, exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Active plan version', { exact: false }).first()).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Original planning archives' }).getByRole('link'),
    ).toHaveCount(1);
  }
  await navigate('Repositories');
  await page.getByLabel('Absolute path to the checkout').fill(upstreamRepository);
  await page.getByLabel('Display name (optional)').fill('ActionQueue upstream');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByText(upstreamRepository, { exact: true })).toBeVisible();
  await navigate('Roadmaps');
  const maps = page.getByRole('region', { name: 'Cross-project roadmap imports' });
  await maps.getByText('Import concurrency map', { exact: true }).click();
  await maps
    .getByLabel('Concurrency map ZIP (up to 8 MiB)')
    .setInputFiles(fixture('cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip'));
  await maps.getByRole('button', { name: 'Import map ZIP', exact: true }).click();
  await expect(
    maps.getByText('Imported definition · explicit delegation required', { exact: true }),
  ).toBeVisible();
  const aq = maps
    .locator('article.import-binding')
    .filter({ has: page.getByLabel('aq upstream repository') });
  await aq.getByLabel('aq upstream repository').selectOption({ label: 'ActionQueue upstream' });
  await expect(aq.getByText('Unsaved selection — use Save exact bindings below.')).toBeVisible();
  for (const alias of ['wi', 'exo']) {
    const select = maps.getByLabel(`${alias} plan version`, { exact: true });
    const value = await select
      .locator('option')
      .filter({ hasText: 'exact source match' })
      .getAttribute('value');
    expect(value).toBeTruthy();
    await select.selectOption(value as string);
  }
  await maps.getByRole('button', { name: 'Save exact bindings', exact: true }).click();
  await expect(maps.getByText('Recorded binding revision: 1.', { exact: false })).toBeVisible();
  const runtime = maps.getByRole('region', { name: 'Dependency environments and evidence' });
  await runtime
    .getByText('Configure pinned dependencies and environments', { exact: true })
    .click();
  await runtime.getByLabel('aq · branch or commit', { exact: true }).fill('main');
  await runtime.getByRole('button', { name: 'Inspect aq', exact: true }).click();
  await expect(runtime.getByText(/Supplied crates: aq_e2e_pin/)).toBeVisible();
  await runtime.getByLabel('Conformance revision', { exact: true }).fill('16');
  // Consumer plans have not bound repositories yet; this saves baseline configuration only.
  await runtime.getByRole('button', { name: 'Add environment', exact: true }).click();
  await runtime.getByLabel('Environment name', { exact: true }).fill('external-native-fixture');
  await runtime
    .getByRole('combobox', { name: 'Kind', exact: true })
    .selectOption('external-native');
  await runtime.getByLabel('Environment SHA-256', { exact: true }).fill('1'.repeat(64));
  await runtime.getByLabel('Fixture SHA-256', { exact: true }).fill('2'.repeat(64));
  await runtime.getByLabel('Toolchain SHA-256', { exact: true }).fill('3'.repeat(64));
  await runtime
    .getByLabel('Authorization and scope', { exact: true })
    .fill('Isolated test fixture only.');
  await runtime.getByRole('button', { name: 'Save dependency environment', exact: true }).click();
  await expect(runtime.getByText('Generation 1 · binding 1', { exact: true })).toBeVisible();
  await runtime.getByText('Submit qualification or checkpoint evidence', { exact: true }).click();
  await runtime
    .getByRole('combobox', { name: 'Evidence subject', exact: true })
    .selectOption('checkpoint:AQ-BASELINE-ACCEPTED');
  await runtime.getByRole('button', { name: 'Prepare evidence template', exact: true }).click();
  await expect(runtime.getByRole('textbox', { name: 'Evidence package', exact: true })).toHaveValue(
    /AQ-BASELINE-ACCEPTED/,
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await runtime.screenshot({ path: info.outputPath('runtime-evidence.png') });

  await expect(maps.getByText('Recorded binding revision: 1.', { exact: false })).toBeVisible();
  await expect(aq.getByText('Repository selection saved.', { exact: true })).toBeVisible();
  await expect(aq.getByText('Needs resolution', { exact: false })).toHaveCount(0);
  await expect(
    aq.getByText('Saving the repository binding does not pass those checkpoints.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(maps.getByRole('button', { name: /start|approve|adopt/i })).toHaveCount(0);
  const supervisor = maps.getByRole('region', {
    name: 'Create cross-project roadmap',
    exact: true,
  });
  await expect(
    supervisor.getByRole('combobox', { name: 'Planning target', exact: true }),
  ).toHaveValue('');
  await supervisor
    .getByRole('combobox', { name: 'Planning target', exact: true })
    .selectOption('WI-EMBEDDED-WORKER-PROOF-1');
  await expect(supervisor.getByText(/selected milestones/)).toBeVisible();
  const lanes = supervisor.locator('.cross-map-lanes');
  await expect(lanes.getByRole('heading', { name: 'WI', exact: true })).toBeVisible();
  await expect(lanes.getByRole('heading', { name: 'EXO', exact: true })).toHaveCount(0);
  await supervisor
    .getByRole('combobox', { name: 'Selection mode', exact: true })
    .selectOption('prioritize-full');
  await expect(lanes.getByRole('heading', { name: 'EXO', exact: true })).toBeVisible();
  await supervisor
    .getByRole('combobox', { name: 'Selection mode', exact: true })
    .selectOption('target-only');
  await expect(lanes.getByRole('heading', { name: 'EXO', exact: true })).toHaveCount(0);
  await supervisor
    .getByRole('combobox', { name: 'Focused dependency view', exact: true })
    .selectOption('checkpoint:WI-EMBEDDED-WORKER-PROOF-1:passed');
  await expect(
    supervisor
      .locator('.cross-map-focus')
      .getByRole('link', { name: 'Submit or review checkpoint evidence' })
      .first(),
  ).toBeVisible();
  await supervisor.getByText(/Map decision adoption ·/).click();
  await expect(
    supervisor.getByRole('button', { name: 'Adopt map decisions', exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await supervisor.screenshot({ path: info.outputPath('cross-project-supervision.png') });

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await maps.screenshot({ path: info.outputPath('cross-project-import.png') });
  await page.reload();
  const select = page.getByLabel('Imported roadmap draft');
  await select.selectOption({
    label: 'EXO-STACK-CONCURRENCY-DRAFT-1 · 0.3.0 · 33 parents / 69 slices',
  });
  await expect(maps.getByText('Recorded binding revision: 1.', { exact: false })).toBeVisible();
  await expect(aq.getByText('Repository selection saved.', { exact: true })).toBeVisible();
  await expect(aq.getByText('Needs resolution', { exact: false })).toHaveCount(0);
  await expect(
    aq.getByText('Saving the repository binding does not pass those checkpoints.', {
      exact: false,
    }),
  ).toBeVisible();
  await maps.getByText('Work items, slices and checkpoint requirements', { exact: true }).click();
  await maps.getByLabel('Filter map nodes').fill('WI-02/domain');
  await expect(
    maps.locator('summary').filter({ hasText: 'wi/WI-02/domain · slice' }),
  ).toBeVisible();
  await navigate('Projects');
  await page.getByRole('button', { name: 'WorldInterface', exact: true }).click();
  await page.getByRole('button', { name: 'WI-01', exact: true }).first().click();
  const scopes = page.getByRole('region', { name: 'Execution slices and parent acceptance' });
  await expect(scopes.getByRole('heading', { name: /wi\/WI-01/ }).first()).toBeVisible();
  await expect(scopes.getByText('wi must use an exact aq upstream pin.').first()).toBeVisible();
  for (const button of await scopes.getByRole('button').all()) await expect(button).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await expect(
    scopes.getByRole('heading', { name: 'Start development', exact: true }).first(),
  ).toBeVisible();
  await expect(
    scopes.getByRole('heading', { name: 'Merge into integration', exact: true }).first(),
  ).toBeVisible();
  await expect(
    scopes.getByRole('heading', { name: 'Verify merged slice', exact: true }).first(),
  ).toBeVisible();
  await expect(
    scopes.getByText(/controlled-native-test-host needs a qualified environment/).first(),
  ).toBeVisible();
  await scopes.screenshot({ path: info.outputPath('execution-scopes.png') });
  await navigate('Roadmaps');
  await page.getByRole('button', { name: 'New roadmap', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Roadmap editor' });
  const itemOption = await editor
    .getByLabel('Add work item')
    .locator('option')
    .filter({ hasText: ' · WI-01 · ' })
    .getAttribute('value');
  await editor.getByLabel('Add work item').selectOption(itemOption!);
  const scopePicker = editor.getByRole('combobox', { name: 'Execution scope', exact: true });
  await expect(scopePicker).toBeVisible();
  const scopeOption = await scopePicker.locator('option').nth(1).getAttribute('value');
  await scopePicker.selectOption(scopeOption!);
  await editor.getByRole('button', { name: 'Add to sequence', exact: true }).click();
  await expect(editor.getByRole('heading', { name: /wi\/WI-01/ }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
