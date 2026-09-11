import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
const FIXTURES = new URL('../fixtures/plan-bundles/aq-cont-1/', import.meta.url);
function git(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();
}
test('builds and supervises a sequential roadmap through two explicit merges', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const repository = mkdtempSync(join(tmpdir(), 'craftingtable-roadmap-e2e-'));
  try {
    git(['init', '--initial-branch=main', '.'], repository);
    writeFileSync(join(repository, 'README.md'), '# Roadmap fixture\n');
    git(['add', '.'], repository);
    git(['commit', '-m', 'initial'], repository);
    git(['branch', 'revision-roadmap'], repository);
    const initial = git(['rev-parse', 'revision-roadmap'], repository);
    await page.goto('/');
    await page.getByLabel('Username').fill('e2e-admin');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const navigate = async (name: string) => {
      if (info.project.name === 'mobile-chromium')
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('link', { name, exact: true }).click();
    };
    await navigate('All workspaces');
    const create = page.getByRole('region', { name: 'New workspace' });
    const workspaceName = `Roadmaps ${info.project.name}`;
    await create.getByLabel('Name', { exact: true }).fill(workspaceName);
    await create.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: workspaceName, exact: true })).toBeVisible();
    await navigate('Import plan');
    await page.getByLabel('Project name').fill('Roadmap AQ');
    await page
      .getByLabel('Implementation plan')
      .setInputFiles(new URL('aq-cont-1-implementation-plan.md', FIXTURES).pathname);
    await page
      .getByLabel('Work breakdown')
      .setInputFiles(new URL('aq-cont-1-work-breakdown.yaml', FIXTURES).pathname);
    await page.getByRole('button', { name: 'Import plan bundle' }).click();
    await expect(page.getByRole('heading', { name: /Work items \(14\)/ })).toBeVisible();
    await navigate('Repositories');
    await page.getByLabel('Absolute path to the checkout').fill(repository);
    await page.getByLabel('Display name (optional)').fill('Roadmap repository');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText(repository, { exact: true })).toBeVisible();
    await navigate('Projects');
    await page.getByRole('button', { name: 'Roadmap AQ', exact: true }).click();
    const branches = page.getByRole('region', { name: 'Repository & branches', exact: true });
    await branches.getByRole('button', { name: 'Configure branches' }).click();
    await branches
      .getByRole('combobox', { name: 'Integration branch', exact: true })
      .selectOption('revision-roadmap');
    await branches.getByRole('button', { name: 'Save branch settings' }).click();
    await expect(branches.getByText('revision-roadmap', { exact: true })).toBeVisible();
    await navigate('Roadmaps');
    await page.getByRole('button', { name: 'New roadmap', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Roadmap editor' });
    await editor.getByLabel('Roadmap name').fill('AQ sequential');
    for (const sourceId of ['AQ-01', 'AQ-02']) {
      const option = await editor
        .getByLabel('Add work item')
        .locator('option')
        .filter({ hasText: ` · ${sourceId} · ` })
        .getAttribute('value');
      await editor.getByLabel('Add work item').selectOption(option as string);
      await editor.getByRole('button', { name: 'Add to sequence' }).click();
    }
    await editor
      .getByText('Agents, models, and completion policy', { exact: true })
      .first()
      .click();
    await editor.getByLabel('Allowed nits').first().fill('1');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    await page.screenshot({ path: info.outputPath('roadmap-editor.png'), fullPage: true });
    await editor.getByRole('button', { name: 'Save roadmap', exact: true }).click();
    const roadmap = page.getByRole('region', { name: 'AQ sequential', exact: true });
    await expect(roadmap.getByText('Draft', { exact: true })).toBeVisible();
    await expect(roadmap.getByText(/outside this roadmap/)).toHaveCount(0);
    await page.reload();
    await expect(roadmap.getByText('Draft', { exact: true })).toBeVisible();
    await roadmap.getByRole('button', { name: 'Start roadmap', exact: true }).click();
    await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toBeVisible({
      timeout: 20000,
    });
    expect(git(['rev-parse', 'revision-roadmap'], repository)).toBe(initial);
    await page.screenshot({ path: info.outputPath('roadmap-awaiting-merge.png'), fullPage: true });
    for (const sourceId of ['AQ-01', 'AQ-02']) {
      await roadmap.getByRole('link', { name: new RegExp(`^${sourceId} ·`) }).click();
      await expect(page.getByRole('heading', { name: new RegExp(`^${sourceId} ·`) })).toBeVisible();
      await page.getByRole('button', { name: 'Merge…', exact: true }).click();
      await page.getByRole('button', { name: 'Merge', exact: true }).click();
      await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({
        timeout: 15000,
      });
      await navigate('Roadmaps');
      if (sourceId === 'AQ-01')
        await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toBeVisible({
          timeout: 20000,
        });
    }
    await expect(
      roadmap.getByText('All roadmap entries are completed.', { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    expect(git(['rev-parse', 'revision-roadmap'], repository)).not.toBe(initial);
    expect(git(['rev-parse', 'main'], repository)).toBe(initial);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    await roadmap.getByRole('button', { name: 'View revisions' }).click();
    await expect(roadmap.getByText(/Revision 1 · AQ sequential/)).toBeVisible();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
