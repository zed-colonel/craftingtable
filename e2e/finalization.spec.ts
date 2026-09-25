import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { git, submitSignIn } from './support';

const FIXTURES = new URL('../fixtures/plan-bundles/aq-cont-1/', import.meta.url);
// New finalizations are staged (R-B10). 'remediate' exhausts the correctness stage's budget
// and authorizes focused remediation; 'staged' selects an optional simplification batch.
for (const decision of ['remediate', 'staged'] as const) {
  test(`automates integration and performs plan finalization with explicit final approval (${decision})`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(15000);
    // The one file each variant's implementation run adds to the candidate.
    const candidateFile = decision === 'staged' ? 'POLISH-1.md' : 'REMEDIATED.md';
    const repository = mkdtempSync(join(tmpdir(), 'craftingtable-finalization-e2e-'));
    try {
      git(['init', '--initial-branch=main', '.'], repository);
      writeFileSync(join(repository, 'README.md'), '# Finalization fixture\n');
      git(['add', '.'], repository);
      git(['commit', '-m', 'initial'], repository);
      git(['branch', 'revision'], repository);
      const main = git(['rev-parse', 'main'], repository);
      await page.goto('/');
      await submitSignIn(page);
      await expect(
        page.getByRole('heading', { name: 'Default workspace', exact: true }),
      ).toBeVisible();
      const navigate = async (name: string) => {
        if (info.project.name === 'mobile-chromium')
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
        await page.getByRole('link', { name, exact: true }).click();
      };
      await navigate('Workspaces');
      const create = page.getByRole('region', { name: 'New workspace' });
      const name = `Finalization ${info.project.name} ${decision}`;
      await create.getByLabel('Name', { exact: true }).fill(name);
      await create.getByRole('button', { name: 'Create workspace' }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await navigate('Import plan');
      await page.getByLabel('Project name').fill('Finalization AQ');
      await page
        .getByLabel('Implementation plan')
        .setInputFiles(new URL('aq-cont-1-implementation-plan.md', FIXTURES).pathname);
      await page.getByLabel('Work breakdown').setInputFiles({
        name: 'finalization-fixture.yaml',
        mimeType: 'text/yaml',
        buffer: Buffer.from(
          readFileSync(new URL('aq-cont-1-work-breakdown.yaml', FIXTURES), 'utf8').split(
            '- id: AQ-03',
          )[0] as string,
        ),
      });
      await page.getByRole('button', { name: 'Import plan bundle' }).click();
      await expect(page.getByRole('heading', { name: /Work items \(2\)/ })).toBeVisible();
      await navigate('Repositories');
      await page.getByLabel('Absolute path to the checkout').fill(repository);
      await page.getByLabel('Display name (optional)').fill('Finalization repository');
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      await expect(page.getByText(repository, { exact: true })).toBeVisible();
      await navigate('Projects');
      await page.getByRole('button', { name: 'Finalization AQ', exact: true }).click();
      const branches = page.getByRole('region', { name: 'Repository & branches', exact: true });
      await branches.getByRole('button', { name: 'Configure branches' }).click();
      await branches
        .getByRole('combobox', { name: 'Integration branch', exact: true })
        .selectOption('revision');
      await branches.getByRole('button', { name: 'Save branch settings' }).click();
      await expect(branches.getByText('revision', { exact: true })).toBeVisible();
      await navigate('Roadmaps');
      await page.getByRole('button', { name: 'New roadmap', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Roadmap editor' });
      await editor.getByLabel('Roadmap name').fill('Unattended integration');
      await editor
        .getByRole('combobox', { name: 'Integration merge', exact: true })
        .selectOption('automatic');
      await editor
        .getByRole('combobox', { name: 'Integration conflicts', exact: true })
        .selectOption('automatic');
      for (const id of ['AQ-01', 'AQ-02']) {
        const value = await editor
          .getByLabel('Add work item')
          .locator('option')
          .filter({ hasText: ` · ${id} · ` })
          .getAttribute('value');
        await editor.getByLabel('Add work item').selectOption(value as string);
        await editor.getByRole('button', { name: 'Add to sequence' }).click();
      }
      await editor.getByRole('button', { name: 'Save roadmap', exact: true }).click();
      const roadmap = page.getByRole('region', { name: 'Unattended integration', exact: true });
      await roadmap.getByRole('button', { name: 'Start roadmap', exact: true }).click();
      await expect(roadmap.getByText('2/2 completed', { exact: false })).toBeVisible({
        timeout: 30000,
      });
      expect(git(['rev-parse', 'main'], repository)).toBe(main);
      const integration = git(['rev-parse', 'revision'], repository);
      expect(integration).not.toBe(main);
      await navigate('Projects');
      await page.getByRole('button', { name: 'Finalization AQ', exact: true }).click();
      await page.getByRole('button', { name: 'v1', exact: true }).click();
      const finalization = page.getByRole('region', { name: 'Finalize integration', exact: true });
      await finalization.getByRole('button', { name: 'Set up finalization' }).click();
      await expect(
        finalization.getByRole('region', { name: 'Finalization stage setup' }),
      ).toBeVisible();
      await expect(finalization.getByLabel('Finalization workflow')).toHaveCount(0);
      if (decision === 'staged') {
        await finalization.getByText('1. Correctness · whole plan', { exact: true }).click();
        await finalization
          .getByRole('button', { name: 'Add correctness slice before whole-plan check' })
          .click();
        const slice = finalization
          .locator('details')
          .filter({ has: page.locator('summary', { hasText: 'Correctness subsystem slice' }) });
        await slice.locator('summary').click();
        await slice.getByLabel('Work-item source IDs', { exact: false }).fill('AQ-01');
        await slice
          .getByLabel('Stage instructions')
          .fill('Verify the first contract before the whole-plan check.');
        await slice.locator('summary').click();
        const simplification = finalization
          .locator('details')
          .filter({ has: page.locator('summary', { hasText: '4. Simplification' }) });
        await simplification.locator('summary').click();
        await simplification.getByLabel('Stage remediation budget').fill('0');
        await simplification.locator('summary').click();
        await finalization
          .getByLabel('Common finalization instructions')
          .fill('Verify the complete candidate with focused stage selection.');
      } else {
        const correctness = finalization
          .locator('details')
          .filter({ has: page.locator('summary', { hasText: '1. Correctness' }) });
        await correctness.locator('summary').click();
        await correctness.getByLabel('Stage remediation budget').fill('0');
        await correctness.locator('summary').click();
        await finalization
          .getByLabel('Common finalization instructions')
          .fill('Review the complete plan and improve clarity. FINALIZATION-REMEDIATION-LIMIT');
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
      await finalization.getByRole('button', { name: 'Start finalization', exact: true }).click();
      if (decision === 'staged') {
        const selection = finalization.getByRole('form', { name: 'Finalization next step' });
        await expect(selection).toBeVisible({ timeout: 30000 });
        await expect(
          finalization.getByRole('heading', { name: 'Stage 4 of 6: Simplification', exact: true }),
        ).toBeVisible();
        await selection.getByRole('checkbox', { name: /S-1/ }).check();
        await selection
          .getByLabel('Disposition rationale (required)')
          .fill('Select the first improvement and keep the rest as follow-up.');
        await selection.getByLabel('Additional stage attempts').fill('2');
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
        await selection.scrollIntoViewIfNeeded();
        await selection.getByRole('button', { name: 'Authorize selected stage batch' }).click();
      } else {
        const recovery = finalization.getByRole('form', { name: 'Finalization next step' });
        await expect(recovery).toBeVisible({ timeout: 30000 });
        await finalization.getByText('Review findings', { exact: true }).click();
        await expect(
          finalization.getByRole('heading', { name: /Clarify the finalization example/ }),
        ).toBeVisible();
        await expect(
          finalization.getByRole('button', { name: 'Resume finalization', exact: true }),
        ).toHaveCount(0);
        await page.reload();
        await expect(recovery).toBeVisible();
        await expect(finalization.getByRole('form')).toHaveCount(1);
        await expect(
          finalization.getByRole('button', { name: 'Authorize more remediation', exact: true }),
        ).toHaveCount(0);
        await recovery.getByLabel('Next action').selectOption('remediate-findings');
        await expect(recovery.getByText('Select at least one finding to continue.')).toBeVisible();
        await recovery.getByRole('checkbox', { name: /F-001/ }).check();
        await expect(
          recovery.getByRole('button', { name: 'Authorize focused remediation' }),
        ).toBeDisabled();
        await expect(
          recovery.getByText('Enter a disposition rationale to continue.'),
        ).toBeVisible();
        await recovery
          .getByLabel('Disposition rationale (required)')
          .fill('Address the selected documentation issue.');
        await expect(
          recovery.getByLabel('Additional focused attempts', { exact: true }),
        ).toHaveValue('1');
        await recovery.getByLabel('Additional focused attempts', { exact: true }).fill('2');
        await expect(
          recovery.getByText(
            'Used: 0. Current allowance: 0. New allowance: 2; 2 attempts available.',
            { exact: true },
          ),
        ).toBeVisible();
        await recovery
          .getByLabel('Answers and guidance (optional)')
          .fill('Clarify the example. E2E-EXTRA-REMEDIATION');
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
        await recovery.getByLabel('Agent settings').selectOption('switch');
        await recovery.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex');
        await recovery
          .getByRole('combobox', { name: 'Model', exact: true })
          .selectOption('__custom__');
        await recovery.getByLabel('Model id', { exact: true }).fill('astra-fixture');
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
        await recovery.scrollIntoViewIfNeeded();
        const request = page.waitForRequest(
          (r) =>
            r.method() === 'POST' &&
            r.url().endsWith('/control') &&
            r.postDataJSON()?.action === 'remediate-findings',
        );
        await recovery
          .getByRole('button', { name: 'Authorize focused remediation', exact: true })
          .click();
        expect((await request).postDataJSON()).toMatchObject({
          action: 'remediate-findings',
          agentOverride: { backend: 'codex', model: 'astra-fixture' },
          findingIds: ['F-001'],
          rationale: 'Address the selected documentation issue.',
          additionalRounds: 2,
          instructions: 'Clarify the example. E2E-EXTRA-REMEDIATION',
        });
      }
      await expect(
        finalization.getByRole('button', { name: 'Review final merge approval' }),
      ).toBeVisible({ timeout: 30000 });
      expect(git(['rev-parse', 'main'], repository)).toBe(main);
      if (decision === 'remediate') {
        await expect(
          finalization.getByText('Remaining finalization runs: Codex · astra-fixture.', {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          finalization.getByRole('heading', {
            name: 'Stage 5 of 5: Final independent review',
            exact: true,
          }),
        ).toBeVisible();
        await expect(finalization.getByText(/Lifetime total: 1\./)).toBeVisible();
      } else {
        await expect(
          finalization.getByRole('heading', {
            name: 'Stage 6 of 6: Final independent review',
            exact: true,
          }),
        ).toBeVisible();
        await finalization.getByText('Optional follow-up work (2)', { exact: true }).click();
        await expect(
          finalization.getByRole('heading', { name: /S-3.*A new optional suggestion/ }),
        ).toBeVisible();
        await finalization
          .getByText('Plan obligations and evidence (2 of 2 current)', { exact: true })
          .click();
      }
      expect(git(['rev-parse', 'revision'], repository)).toBe(integration);
      await page.reload();
      await expect(
        finalization.getByRole('button', { name: 'Review final merge approval' }),
      ).toBeVisible();
      await finalization.getByRole('button', { name: 'Open current run', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Run outcome', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Plan finalization', exact: true }).click();
      await finalization.getByRole('button', { name: 'View complete candidate diff' }).click();
      await expect(finalization.getByText(candidateFile, { exact: false }).first()).toBeVisible();
      await finalization.getByRole('button', { name: 'Review final merge approval' }).click();
      await expect(
        finalization.getByRole('group', { name: 'Approve final promotion' }),
      ).toBeVisible();
      expect(git(['rev-parse', 'main'], repository)).toBe(main);
      const removeIntegration = finalization.getByRole('checkbox', {
        name: 'Remove local integration branch revision after successful promotion',
      });
      await expect(removeIntegration).not.toBeChecked();
      if (decision === 'remediate') await removeIntegration.check();
      await finalization
        .getByRole('button', { name: 'Approve merge into main', exact: true })
        .click();
      await expect(finalization.getByText('Promoted by operator', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      const promoted = git(['rev-parse', 'main'], repository);
      expect(promoted).not.toBe(main);
      await expect(page.getByText('Plan completed', { exact: true }).first()).toBeVisible();
      const cleanup = finalization.getByRole('group', { name: 'Integration branch cleanup' });
      if (decision === 'staged') {
        expect(git(['rev-parse', 'revision'], repository)).toBe(integration);
        await expect(cleanup).toBeVisible();
        await cleanup
          .getByRole('button', { name: 'Remove integration branch revision', exact: true })
          .click();
      }
      await expect(
        cleanup.getByText('removed. Merged commits and plan history are retained.', {
          exact: false,
        }),
      ).toBeVisible();
      expect(git(['branch', '--list', 'revision'], repository).trim()).toBe('');
      expect(git(['rev-parse', 'main'], repository)).toBe(promoted);
      await page.reload();
      await expect(page.getByText('Plan completed', { exact: true }).first()).toBeVisible();
      await expect(
        page.getByText('Integration branch removed after final promotion.', { exact: false }),
      ).toBeVisible();
      expect(readFileSync(join(repository, candidateFile), 'utf8')).toContain(
        decision === 'staged' ? 'Plan finalization' : 'Selected explanation completed by Codex',
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
}
