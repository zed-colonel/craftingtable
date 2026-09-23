import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const FIXTURES = new URL('../fixtures/plan-bundles/aq-cont-1/', import.meta.url);
test.use({ actionTimeout: 15_000 });

const TARGET = 'revision/integration-with-a-long-branch-name-for-phone-layout-checks';

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
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

async function signIn(page: Page) {
  await page.getByLabel('Username').fill('e2e-admin');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
}

async function navigate(page: Page, name: string) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
}

async function fitsPhone(page: Page) {
  // Measure the root against the configured viewport: mobile browsers may enlarge
  // window.innerWidth when overflowing content forces a wider layout viewport.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
}

test('phone navigation, review findings, diff, and explicit merge approval', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const repository = mkdtempSync(join(tmpdir(), 'craftingtable-mobile-repo-'));
  try {
    git(['init', '--initial-branch=main', '.'], repository);
    writeFileSync(join(repository, 'README.md'), '# Mobile fixture\n');
    git(['add', '.'], repository);
    git(['commit', '--no-gpg-sign', '-m', 'initial'], repository);
    git(['branch', TARGET], repository);
    const initial = git(['rev-parse', TARGET], repository);

    await page.goto('/');
    await expect(page.getByLabel('Username')).toHaveCSS('font-size', '16px');
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Default workspace' })).toBeVisible();
    await fitsPhone(page);
    expect((await page.locator('main').boundingBox())?.y).toBeLessThan(100);
    await page.screenshot({ path: info.outputPath('phone-dashboard.png') });

    // The closed menu removes links from keyboard navigation. Escape restores focus.
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await menu.click();
    await page.getByRole('link', { name: 'Dashboard', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('link', { name: 'Dashboard', exact: true, includeHidden: true }),
    ).not.toBeFocused();

    await navigate(page, 'Dashboard');
    await expect(page.locator('main')).toBeFocused();
    await navigate(page, 'All workspaces');
    const createWorkspace = page.getByRole('region', { name: 'New workspace' });
    await createWorkspace.getByLabel('Name', { exact: true }).fill('Mobile test workspace');
    await createWorkspace.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Mobile test workspace' })).toBeVisible();
    await navigate(page, 'Import plan');
    await page.getByLabel('Project name').fill('Mobile ActionQueue');
    await page
      .getByLabel('Implementation plan')
      .setInputFiles(new URL('aq-cont-1-implementation-plan.md', FIXTURES).pathname);
    await page
      .getByLabel('Work breakdown')
      .setInputFiles(new URL('aq-cont-1-work-breakdown.yaml', FIXTURES).pathname);
    await page.getByRole('button', { name: 'Import plan bundle' }).click();
    await expect(page.getByRole('heading', { name: /Work items \(14\)/ })).toBeVisible();
    await fitsPhone(page);
    const itemTable = page.getByRole('table', { name: /Work items in this plan/ });
    const tableScroll = itemTable.locator('..');
    expect(await tableScroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await tableScroll.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    expect(await tableScroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await tableScroll.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.screenshot({ path: info.outputPath('phone-plan.png') });

    await navigate(page, 'Repositories');
    await page.getByLabel('Absolute path to the checkout').fill(repository);
    await page.getByLabel('Display name (optional)').fill('Mobile fixture repository');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText(repository, { exact: true })).toBeVisible();
    await fitsPhone(page);
    await navigate(page, 'Projects');
    await page.getByRole('button', { name: 'Mobile ActionQueue', exact: true }).click();
    const branches = page.getByRole('region', { name: 'Repository & branches', exact: true });
    await branches.getByRole('button', { name: 'Configure branches' }).click();
    await branches
      .getByRole('combobox', { name: 'Repository', exact: true })
      .selectOption({ label: 'Mobile fixture repository' });
    await branches
      .getByRole('combobox', { name: 'Integration branch', exact: true })
      .selectOption(TARGET);
    await fitsPhone(page);
    await branches.getByRole('button', { name: 'Save branch settings' }).click();
    await branches.getByRole('button', { name: 'Record repository policy', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Adopt repository policy', exact: true }),
    ).toBeDisabled();
    await fitsPhone(page);
    await page
      .getByRole('form', { name: 'Adopt repository policy' })
      .screenshot({ path: info.outputPath('phone-repository-policy.png') });
    await page
      .getByRole('checkbox', {
        name: 'I adopt this interpretation and the displayed freeze, where selected, for this plan.',
      })
      .check();
    await page.getByRole('button', { name: 'Adopt repository policy', exact: true }).click();
    await expect(page.getByText(/Adopted revision 1/)).toBeVisible();

    await expect(branches.getByText(TARGET, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'AQ-01', exact: true }).click();
    await page.getByRole('button', { name: 'Admit into agenda' }).click();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
    await fitsPhone(page);
    const itemUrl = page.url();
    // The manual supervision path remains usable alongside automation.
    await page.getByRole('button', { name: 'Launch implement run', exact: true }).click();
    const feed = page.getByTestId('run-feed');
    await expect(feed.getByText('fake agent finished turn 1', { exact: true })).toBeVisible();
    await fitsPhone(page);
    await page.getByLabel('Message to the agent').fill('Check the boundary behavior too.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(feed.getByText('fake agent finished turn 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
    const outcome = page.getByRole('region', { name: 'Run outcome' });
    await expect(outcome.getByRole('heading', { name: 'Final outcome' })).toBeVisible();
    await expect(outcome.locator('.run-outcome-prose')).toContainText('fake agent finished turn 2');
    await outcome.screenshot({ path: info.outputPath('phone-final-outcome.png') });
    await fitsPhone(page);
    await page.getByRole('button', { name: 'Work item', exact: true }).click();
    const cycle = page.getByRole('region', { name: 'Automated cycle', exact: true });
    await cycle.getByText('Set up a cycle', { exact: true }).click();
    await cycle.getByLabel('Allowed nits').fill('1');
    await cycle.getByLabel('Maximum remediation rounds').fill('0');
    await cycle.getByLabel(/Instructions/).fill('MOBILE-FINDINGS CYCLE-EXTRA-REMEDIATION');
    await fitsPhone(page);
    await cycle.getByRole('button', { name: 'Start automated cycle' }).click();
    await expect(cycle.getByRole('button', { name: 'Authorize more remediation' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(cycle.getByRole('button', { name: 'Resume automation' })).toHaveCount(0);
    await fitsPhone(page);
    await cycle.screenshot({ path: info.outputPath('phone-remediation-recovery.png') });
    await cycle
      .getByLabel('Guidance for the next run (optional)')
      .fill('E2E-AUTHORIZED-RECOVERY: Address the remaining regression.');
    await cycle.getByRole('button', { name: 'Authorize more remediation' }).click();

    await expect(cycle.getByText('Awaiting merge approval', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(git(['rev-parse', TARGET], repository)).toBe(initial);
    await fitsPhone(page);

    await cycle.getByRole('button', { name: 'Pause automation' }).click();
    await expect(cycle.getByText('Paused', { exact: true })).toBeVisible();
    await cycle.getByRole('button', { name: 'Resume automation' }).click();
    await expect(cycle.getByText('Awaiting merge approval', { exact: true })).toBeVisible();

    await cycle.getByRole('button', { name: 'Open current run' }).click();
    await expect(page.getByRole('heading', { name: 'Review run', exact: true })).toBeVisible();
    const findings = page.getByRole('group', { name: 'Review findings', exact: true });
    await findings.locator('summary').click();
    await expect(findings.getByText('F-001', { exact: true })).toBeVisible();
    await expect(findings.getByText(/integration-guide.md:12/)).toBeVisible();
    await fitsPhone(page);
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 844, height: 390 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await fitsPhone(page);
    }
    await findings.screenshot({ path: info.outputPath('phone-findings.png') });
    await page.getByRole('button', { name: 'View diff', exact: true }).click();
    const diff = page.getByTestId('diff-text');
    await expect(diff).toContainText('Long diff line');
    await fitsPhone(page);
    expect(await diff.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await diff.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    expect(await diff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await page
      .getByRole('region', { name: 'Worktree diff' })
      .screenshot({ path: info.outputPath('phone-diff.png') });

    // A notification URL must survive login and open the item with the menu closed.
    await navigate(page, 'Account · e2e-admin');
    await menu.click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.goto(itemUrl);
    await signIn(page);
    await expect(cycle.getByText('Awaiting merge approval', { exact: true })).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await fitsPhone(page);
    await page.getByRole('button', { name: 'Merge…', exact: true }).click();
    const merge = page.getByRole('form', { name: 'Merge target' });
    await expect(merge.getByLabel('Merge into')).toHaveValue(TARGET);
    await fitsPhone(page);
    expect(
      (await merge.getByRole('button', { name: 'Merge', exact: true }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(44);
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 844, height: 390 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await fitsPhone(page);
    }
    await merge.screenshot({ path: info.outputPath('phone-merge.png') });
    await merge.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(git(['rev-parse', TARGET], repository)).toBe(initial);
    await page.getByRole('button', { name: 'Merge…', exact: true }).click();
    await merge.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect(cycle.getByText(/Previous cycle: Completed/)).toBeVisible();
    expect(git(['rev-parse', TARGET], repository)).not.toBe(initial);
    expect(git(['branch', '--show-current'], repository)).toBe('main');

    await navigate(page, 'Runs');
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
    await fitsPhone(page);
    await navigate(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
    await fitsPhone(page);
    // Smaller phones, landscape, and switching back to the desktop rail.
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await fitsPhone(page);
    }
    await expect(menu).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await menu.click();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await fitsPhone(page);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
