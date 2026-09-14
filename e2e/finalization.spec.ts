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
test('automates integration and performs plan finalization with explicit final approval', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  const repository = mkdtempSync(join(tmpdir(), 'craftingtable-finalization-e2e-'));
  try {
    git(['init', '--initial-branch=main', '.'], repository);
    writeFileSync(join(repository, 'README.md'), '# Finalization fixture\n');
    git(['add', '.'], repository);
    git(['commit', '-m', 'initial'], repository);
    git(['branch', 'revision'], repository);
    const main = git(['rev-parse', 'main'], repository);
    await page.goto('/');
    await page.getByLabel('Username').fill('e2e-admin');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
    const name = `Finalization ${info.project.name}`;
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
    await finalization.getByLabel('Improvement rounds').fill('1');
    await finalization.getByLabel('Additional remediation rounds', { exact: true }).fill('0');
    await finalization
      .getByLabel('Round focus')
      .fill('Conformance and simplification, preserve the public behavior.');
    await finalization
      .getByLabel('Conformance and polish instructions')
      .fill('Review the complete plan and improve clarity. FINALIZATION-REMEDIATION-LIMIT');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    await page.screenshot({ path: info.outputPath('finalization-setup.png'), fullPage: true });
    await finalization.getByRole('button', { name: 'Start finalization', exact: true }).click();
    const recovery = finalization.getByRole('form', { name: 'Authorize more remediation' });
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
    await expect(
      recovery.getByLabel('Additional remediation attempts', { exact: true }),
    ).toHaveValue('1');
    await recovery
      .getByLabel('Guidance for the next remediation (optional)')
      .fill('Clarify the example. E2E-EXTRA-REMEDIATION');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    await recovery.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath('finalization-remediation-authorization.png'),
      fullPage: true,
    });
    const request = page.waitForRequest(
      (r) =>
        r.method() === 'POST' &&
        r.url().endsWith('/control') &&
        r.postDataJSON()?.action === 'authorize-remediation',
    );
    await recovery.getByRole('button', { name: 'Authorize more remediation', exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({
      action: 'authorize-remediation',
      additionalRounds: 1,
      instructions: 'Clarify the example. E2E-EXTRA-REMEDIATION',
    });

    await expect(
      finalization.getByRole('button', { name: 'Review final merge approval' }),
    ).toBeVisible({ timeout: 30000 });
    await expect(finalization.getByText('final-review', { exact: false }).first()).toBeVisible();
    expect(git(['rev-parse', 'main'], repository)).toBe(main);
    await expect(
      finalization.getByText(
        '1 of 1 additional remediation attempts used across this finalization.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(git(['rev-parse', 'revision'], repository)).toBe(integration);
    await page.reload();
    await expect(
      finalization.getByRole('button', { name: 'Review final merge approval' }),
    ).toBeVisible();
    await finalization.getByRole('button', { name: 'Open current run', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Run outcome', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Plan finalization', exact: true }).click();
    await finalization.getByRole('button', { name: 'View complete candidate diff' }).click();
    await expect(finalization.getByText('POLISH-1.md', { exact: false }).first()).toBeVisible();
    await finalization.getByRole('button', { name: 'Review final merge approval' }).click();
    await expect(
      finalization.getByRole('group', { name: 'Approve final promotion' }),
    ).toBeVisible();
    expect(git(['rev-parse', 'main'], repository)).toBe(main);
    await page.screenshot({ path: info.outputPath('finalization-approval.png'), fullPage: true });
    await finalization
      .getByRole('button', { name: 'Approve merge into main', exact: true })
      .click();
    await expect(finalization.getByText('Promoted by operator', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    expect(git(['rev-parse', 'main'], repository)).not.toBe(main);
    expect(git(['rev-parse', 'revision'], repository)).toBe(integration);
    expect(readFileSync(join(repository, 'POLISH-1.md'), 'utf8')).toContain('Plan finalization');
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
