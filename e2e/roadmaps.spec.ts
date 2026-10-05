import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  expectSignedIn,
  git,
  openMergeDecision,
  openRoadmap,
  sendCommand,
  submitSignIn,
  test,
} from './support';

const FIXTURES = new URL('../fixtures/plan-bundles/aq-cont-1/', import.meta.url);
for (const mode of ['sequential', 'parallel'] as const) {
  test(`builds and supervises a ${mode} roadmap through explicit merges`, async ({
    page,
  }, info) => {
    const repository = mkdtempSync(join(tmpdir(), 'craftingtable-roadmap-e2e-'));
    try {
      git(['init', '--initial-branch=main', '.'], repository);
      writeFileSync(join(repository, 'README.md'), '# Roadmap fixture\n');
      git(['add', '.'], repository);
      git(['commit', '-m', 'initial'], repository);
      git(['branch', 'revision-roadmap'], repository);
      const initial = git(['rev-parse', 'revision-roadmap'], repository);
      await page.goto('/');
      await submitSignIn(page);
      await expectSignedIn(page);
      const navigate = async (name: string) => {
        if (info.project.name === 'mobile-chromium')
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
        await page.getByRole('link', { name, exact: true }).click();
      };
      await navigate('Workspaces');
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
      } else {
        await navigate('Settings');
        const agents = page.getByRole('region', { name: 'Roadmap agent profiles', exact: true });
        await agents
          .getByRole('combobox', { name: 'Roadmap', exact: true })
          .selectOption({ label: `AQ ${mode}` });
        await agents.getByRole('button', { name: 'Edit future run profiles' }).click();
        const remediation = agents.getByRole('group', { name: 'Remediation', exact: true });
        await remediation
          .getByRole('combobox', { name: 'Agent', exact: true })
          .selectOption('codex');
        await remediation
          .getByRole('combobox', { name: 'Model', exact: true })
          .selectOption('gpt-6-luna');
        await remediation
          .getByRole('combobox', { name: 'Reasoning effort', exact: true })
          .selectOption('medium');
        await agents.getByRole('button', { name: 'Apply to future runs' }).click();
        await expect(agents.getByRole('status')).toContainText('Applied to future runs');
        await page.reload();
        await expect(agents.getByText(/Remediation: gpt-6-luna/)).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
        await expect(agents).toBeVisible();
        await navigate('Roadmaps');
        await openRoadmap(page, `AQ ${mode}`);
      }
      await expect(roadmap.getByText('Draft', { exact: true })).toBeVisible();
      await roadmap.getByRole('button', { name: 'Start roadmap', exact: true }).click();
      await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toBeVisible();
      expect(git(['rev-parse', 'revision-roadmap'], repository)).toBe(initial);
      for (const sourceId of sourceIds) {
        await roadmap.getByRole('link', { name: new RegExp(`^${sourceId} ·`) }).click();
        await expect(
          page.getByRole('heading', { name: new RegExp(`^${sourceId} ·`) }),
        ).toBeVisible();
        const itemPage = page.url();
        const form = await openMergeDecision(page);
        await form.getByRole('button', { name: 'Merge', exact: true }).click();
        await expect(page.getByText('This item is resolved.')).toBeVisible();
        await page.goto(itemPage);
        await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
        await navigate('Roadmaps');
        await openRoadmap(page, `AQ ${mode}`);
        if (mode === 'parallel' && sourceId === 'AQ-02') {
          // The entry's own state label; the status list repeats the state beside its reason.
          await expect(
            roadmap.getByRole('strong').filter({ hasText: /^Needs attention$/ }),
          ).toBeVisible();
          await roadmap.getByRole('link', { name: /^AQ-03 ·/ }).click();
          const workItemPage = page.url();
          // The page's own cycle reads are fresh, but its decision link comes from Needs you,
          // which re-reads a moment after the stop: until then it names the resolved merge
          // approval. Follow it once Needs you lists the conflict (TS-M1).
          await expect(
            page
              .getByRole('region', { name: 'Needs you', exact: true })
              .getByRole('listitem')
              .filter({ hasText: 'AQ-03' })
              .getByRole('link', { name: 'Integration conflict', exact: true }),
          ).toBeVisible();
          // The conflict is decided in its inbox item; the work item links there (R-A6).
          await page
            .getByRole('region', { name: 'Automated cycle', exact: true })
            .getByRole('link', { name: 'Open the decision', exact: true })
            .click();
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
          await expect(conflicts).toBeVisible();
          const targetBefore = git(['rev-parse', 'revision-roadmap'], repository);
          await sendCommand(page, conflicts.getByRole('button', { name: 'Launch', exact: true }));
          await page.goto(workItemPage);
          await expect(
            page
              .getByRole('region', { name: 'Automated cycle', exact: true })
              .getByText('Awaiting merge approval', { exact: true }),
          ).toBeVisible();
          await expect(conflicts.getByText('completed', { exact: true })).toBeVisible();
          expect(git(['rev-parse', 'revision-roadmap'], repository)).toBe(targetBefore);
          await navigate('Roadmaps');
          await openRoadmap(page, `AQ ${mode}`);
        }
        if (sourceId !== sourceIds.at(-1))
          await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toHaveCount(
            mode === 'parallel' && sourceId === 'AQ-01' ? 2 : 1,
          );
      }
      await expect(
        roadmap.getByText('All roadmap entries are completed.', { exact: true }),
      ).toBeVisible();
      expect(git(['rev-parse', 'revision-roadmap'], repository)).not.toBe(initial);
      expect(git(['rev-parse', 'main'], repository)).toBe(initial);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
      await roadmap
        .getByRole('navigation', { name: 'Roadmap pages', exact: true })
        .getByRole('link', { name: 'History', exact: true })
        .click();
      await expect(roadmap.getByText(new RegExp(`Revision 1 · AQ ${mode}`))).toBeVisible();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
}
