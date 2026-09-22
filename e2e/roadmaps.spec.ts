import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
for (const mode of ['sequential', 'parallel'] as const) {
  test(`builds and supervises a ${mode} roadmap through explicit merges`, async ({
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
      await expect(
        page.getByRole('heading', { name: 'Default workspace', exact: true }),
      ).toBeVisible();
      const navigate = async (name: string) => {
        if (info.project.name === 'mobile-chromium')
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
        await page.getByRole('link', { name, exact: true }).click();
      };
      await navigate('All workspaces');
      const create = page.getByRole('region', { name: 'New workspace' });
      const workspaceName = `Roadmaps ${mode} ${info.project.name}`;
      await create.getByLabel('Name', { exact: true }).fill(workspaceName);
      await create.getByRole('button', { name: 'Create workspace' }).click();
      await expect(page.getByRole('heading', { name: workspaceName, exact: true })).toBeVisible();
      await navigate('Import plan');
      await page.getByLabel('Project name').fill('Roadmap AQ');
      await page
        .getByLabel('Implementation plan')
        .setInputFiles(new URL('aq-cont-1-implementation-plan.md', FIXTURES).pathname);
      await page.getByLabel('Work breakdown').setInputFiles(
        mode === 'sequential'
          ? new URL('aq-cont-1-work-breakdown.yaml', FIXTURES).pathname
          : {
              name: 'parallel-fixture.yaml',
              mimeType: 'text/yaml',
              buffer: Buffer.from(
                readFileSync(new URL('aq-cont-1-work-breakdown.yaml', FIXTURES), 'utf8').replace(
                  /(- id: AQ-03[\s\S]*?depends_on:\n {2}- )AQ-02/,
                  '$1AQ-01',
                ),
              ),
            },
      );
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
      await editor.getByLabel('Roadmap name').fill(`AQ ${mode}`);
      await editor.getByLabel('Scheduling mode').selectOption(mode);
      if (mode === 'parallel')
        await expect(editor.getByText(/Save this draft, then configure capacity/)).toBeVisible();
      const sourceIds = mode === 'parallel' ? ['AQ-01', 'AQ-02', 'AQ-03'] : ['AQ-01', 'AQ-02'];
      for (const sourceId of sourceIds) {
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
      if (mode === 'parallel') {
        // Independent smoke files plus a shared README exercise conflict resolution after the first sibling merge.
        for (const item of await editor.locator('li.panel').all()) {
          const summary = item.getByText('Agents, models, and completion policy', { exact: true });
          if (!(await item.getByLabel('Instructions for every step').isVisible()))
            await summary.click();
          await item
            .getByLabel('Instructions for every step')
            .fill('PARALLEL-ROADMAP CONFLICT-RESOLUTION');
        }
        await editor.getByLabel('Exclusion groups (comma separated)').first().fill('setup');
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
      await page.screenshot({
        path: info.outputPath(`roadmap-${mode}-editor.png`),
        fullPage: true,
      });
      await editor.getByRole('button', { name: 'Save roadmap', exact: true }).click();
      const roadmap = page.getByRole('region', { name: `AQ ${mode}`, exact: true });
      await expect(roadmap.getByText('Draft', { exact: true })).toBeVisible();
      await expect(roadmap.getByText(/outside this roadmap/)).toHaveCount(0);
      if (mode === 'parallel') {
        await roadmap.getByRole('link', { name: 'Manage capacity', exact: true }).click();
        const capacity = page.getByRole('region', {
          name: 'Roadmap in-flight limits',
          exact: true,
        });
        await expect(capacity.getByRole('combobox', { name: 'Roadmap', exact: true })).toHaveValue(
          new URL(page.url()).searchParams.get('roadmap')!,
        );
        await capacity.getByRole('button', { name: 'Change roadmap limits' }).click();
        await capacity.getByLabel('Maximum in-flight items', { exact: true }).fill('3');
        await capacity.getByRole('button', { name: 'Save roadmap limits' }).click();
        await expect(capacity.getByRole('status')).toContainText('Roadmap limits saved.');
        await page.reload();
        await expect(capacity.getByText('0/3', { exact: true })).toBeVisible();
        await capacity
          .getByRole('link', { name: 'Open roadmap supervision and saved-plan acceptance' })
          .click();
      } else await page.reload();
      await expect(roadmap.getByText('Draft', { exact: true })).toBeVisible();
      await roadmap.getByRole('button', { name: 'Start roadmap', exact: true }).click();
      await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toBeVisible({
        timeout: 20000,
      });
      expect(git(['rev-parse', 'revision-roadmap'], repository)).toBe(initial);
      await page.screenshot({
        path: info.outputPath(`roadmap-${mode}-awaiting-merge.png`),
        fullPage: true,
      });
      for (const sourceId of sourceIds) {
        await roadmap.getByRole('link', { name: new RegExp(`^${sourceId} ·`) }).click();
        await expect(
          page.getByRole('heading', { name: new RegExp(`^${sourceId} ·`) }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Merge…', exact: true }).click();
        await page.getByRole('button', { name: 'Merge', exact: true }).click();
        await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({
          timeout: 15000,
        });
        await navigate('Roadmaps');
        if (mode === 'parallel' && sourceId === 'AQ-02') {
          await expect(roadmap.getByText('Needs attention', { exact: true })).toBeVisible({
            timeout: 15000,
          });
          await roadmap.getByRole('link', { name: /^AQ-03 ·/ }).click();
          const conflicts = page.getByRole('region', {
            name: 'Integration conflicts',
            exact: true,
          });
          await expect(conflicts.getByText('README.md', { exact: true })).toBeVisible();
          await page.reload();
          await conflicts
            .getByRole('button', { name: 'Resolve integration conflicts', exact: true })
            .click();
          await conflicts
            .getByLabel('Instructions for this run (optional)')
            .fill('Preserve both sibling behaviors and verify their combined state.');
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
            .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
          await conflicts.screenshot({
            path: info.outputPath('integration-conflict-resolution.png'),
          });
          const targetBefore = git(['rev-parse', 'revision-roadmap'], repository);
          await conflicts.getByRole('button', { name: 'Launch', exact: true }).click();
          await expect(
            page
              .getByRole('region', { name: 'Automated cycle', exact: true })
              .getByText('Awaiting merge approval', { exact: true }),
          ).toBeVisible({ timeout: 20000 });
          await expect(conflicts.getByText('completed', { exact: true })).toBeVisible();
          expect(git(['rev-parse', 'revision-roadmap'], repository)).toBe(targetBefore);
          await navigate('Roadmaps');
        }
        if (sourceId !== sourceIds.at(-1))
          await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toHaveCount(
            mode === 'parallel' && sourceId === 'AQ-01' ? 2 : 1,
            { timeout: 20000 },
          );
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
      await expect(roadmap.getByText(new RegExp(`Revision 1 · AQ ${mode}`))).toBeVisible();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
}
