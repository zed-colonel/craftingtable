import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  adoptRepositoryChecks,
  E2E_PASSWORD,
  expect,
  git,
  proposeRepositoryChecks,
  test,
} from './support';

/**
 * The README's screenshots: `pnpm docs:screenshots` seeds one workspace on the e2e daemon and
 * writes four viewport-sized images into `docs/images/readme/`, the only images the repository
 * keeps. The seeding drives real controller flows with `e2e/readme-agent.mjs`, a stand-in whose
 * output reads like a real session, over the Lantern fixture plan: four manual cycles that stop
 * for the operator in four different ways, a manual run waiting for its next instruction, and a
 * parallel roadmap with one item merged and two awaiting approval.
 *
 * The gate does not rehearse it (the walkthrough covers the same flows); re-run it after a UI
 * change that the images show.
 */

const FIXTURES = new URL('../fixtures/plan-bundles/lantern/', import.meta.url);
const OUTPUT = fileURLToPath(new URL('../docs/images/readme/', import.meta.url));
/** The username `playwright.config.ts` bootstraps for this project. */
const OPERATOR = 'keith';
const PROJECT = 'Lantern';

/** The cycles whose stops fill Needs you; `readme-agent.mjs` takes each down its own path. */
const STOPS = [
  { item: 'LN-01', reaches: 'Awaiting merge approval' },
  { item: 'LN-02', reaches: 'decision' },
  { item: 'LN-03', reaches: 'decision' },
  { item: 'LN-04', reaches: 'decision' },
] as const;

/** Rail links carry a live count in their name ("Runs 1"), so match the label prefix. */
async function navigate(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary', exact: true })
    .getByRole('link', { name: new RegExp(`^${name}( \\d+)?$`) })
    .click();
}

/** The page has rendered its data, and fonts and layout have settled. */
async function photograph(page: Page, name: string): Promise<void> {
  await expect(page.getByText(/^(Loading|Checking session|Opening your workspace)/)).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUTPUT, `${name}.png`) });
}

function lanternRepository(): string {
  const path = mkdtempSync(join(tmpdir(), 'lantern-'));
  const files: Record<string, string> = {
    'README.md': '# Lantern\n\nFast, field-aware search over local log files.\n',
    'src/lib.rs': 'pub mod record;\npub mod segment;\n',
    'docs/plan.md': '# Lantern 0.1 Implementation Plan\n',
  };
  git(['init', '--initial-branch=main', '.'], path);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), content);
  }
  git(['add', '.'], path);
  git(['commit', '--no-gpg-sign', '-m', 'Start Lantern'], path);
  proposeRepositoryChecks(path);
  git(['branch', 'develop'], path);
  return path;
}

async function openItem(page: Page, item: string): Promise<void> {
  await navigate(page, 'Projects');
  await page.getByRole('button', { name: PROJECT, exact: true }).click();
  await page.getByRole('button', { name: item, exact: true }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`^${item} ·`) })).toBeVisible();
}

test('captures the README screenshots', async ({ page }) => {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(OUTPUT, { recursive: true });
  const repository = lanternRepository();
  try {
    await page.goto('/');
    await page.getByLabel('Username').fill(OPERATOR);
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/workspaces\/[^/]+$/);

    await navigate(page, 'Workspaces');
    const create = page.getByRole('region', { name: 'New workspace' });
    await create.getByLabel('Name', { exact: true }).fill('Home');
    await create.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();

    await navigate(page, 'Import plan');
    await page.getByLabel('Project name').fill(PROJECT);
    await page
      .getByLabel('Implementation plan')
      .setInputFiles(new URL('lantern-implementation-plan.md', FIXTURES).pathname);
    await page
      .getByLabel('Work breakdown')
      .setInputFiles(new URL('lantern-work-breakdown.yaml', FIXTURES).pathname);
    await page.getByRole('button', { name: 'Import plan bundle' }).click();
    await expect(page.getByRole('heading', { name: /Work items \(9\)/ })).toBeVisible();

    await navigate(page, 'Repositories');
    await page.getByLabel('Absolute path to the checkout').fill(repository);
    await page.getByLabel('Display name (optional)').fill('lantern');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText(repository, { exact: true })).toBeVisible();
    await adoptRepositoryChecks(page, 'lantern');

    await navigate(page, 'Projects');
    await page.getByRole('button', { name: PROJECT, exact: true }).click();
    const branches = page.getByRole('region', { name: 'Repository & branches', exact: true });
    await branches.getByRole('button', { name: 'Configure branches' }).click();
    await branches
      .getByRole('combobox', { name: 'Integration branch', exact: true })
      .selectOption('develop');
    await branches.getByRole('button', { name: 'Save branch settings' }).click();
    await expect(branches.getByText('develop', { exact: true })).toBeVisible();

    // ---- Four cycles, each stopped for the operator ---------------------------------------
    for (const stop of STOPS) {
      await openItem(page, stop.item);
      await page.getByRole('button', { name: 'Admit into agenda' }).click();
      await page.getByRole('button', { name: 'Create worktree' }).click();
      await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
      const cycle = page.getByRole('region', { name: 'Automated cycle', exact: true });
      await cycle.getByText('Set up a cycle', { exact: true }).click();
      await cycle.getByLabel('Allowed nits').fill('1');
      await cycle.getByLabel('Maximum remediation rounds').fill('0');
      await cycle.getByRole('button', { name: 'Start automated cycle' }).click();
      await expect(
        stop.reaches === 'decision'
          ? cycle.getByRole('link', { name: 'Open the decision', exact: true })
          : cycle.getByText(stop.reaches, { exact: true }),
      ).toBeVisible();
    }

    // ---- A manual run waiting for its next instruction ------------------------------------
    await openItem(page, 'LN-05');
    await page.getByRole('button', { name: 'Admit into agenda' }).click();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
    await page
      .getByLabel(/Instructions for this run/)
      .fill('Add `lantern index` and `lantern search`. Keep the output plain unless asked.');
    await page.getByRole('button', { name: /Launch implement run/ }).click();
    await expect(page.getByRole('heading', { name: /Implement run/ })).toBeVisible();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    const liveRun = page.url();

    // ---- A parallel roadmap: one item merged, two awaiting approval -----------------------
    await navigate(page, 'Roadmaps');
    await page.getByRole('button', { name: 'New roadmap', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Roadmap editor' });
    await editor.getByLabel('Roadmap name').fill('Search pipeline');
    await editor.getByLabel('Scheduling mode').selectOption('parallel');
    for (const item of ['LN-06', 'LN-07', 'LN-08', 'LN-09']) {
      const option = await editor
        .getByLabel('Add work item')
        .locator('option')
        .filter({ hasText: ` · ${item} · ` })
        .getAttribute('value');
      await editor.getByLabel('Add work item').selectOption(option as string);
      await editor.getByRole('button', { name: 'Add to sequence' }).click();
    }
    await editor.getByRole('button', { name: 'Save roadmap', exact: true }).click();
    const roadmap = page.getByRole('region', { name: 'Search pipeline', exact: true });
    await expect(roadmap.getByText('Draft', { exact: true })).toBeVisible();
    await roadmap.getByRole('link', { name: 'Manage capacity', exact: true }).click();
    const capacity = page.getByRole('region', { name: 'Roadmap in-flight limits', exact: true });
    await capacity.getByRole('button', { name: 'Change roadmap limits' }).click();
    // The workstation's two development slots, so the board warns of no shortfall.
    await capacity.getByLabel('Maximum in-flight items', { exact: true }).fill('2');
    // The repository already holds the five worktrees above.
    await capacity.getByLabel('Maximum in-flight items per repository', { exact: true }).fill('8');
    await capacity.getByRole('button', { name: 'Save roadmap limits' }).click();
    await expect(capacity.getByRole('status')).toContainText('Roadmap limits saved.');
    await capacity
      .getByRole('link', { name: 'Open roadmap supervision and saved-plan acceptance' })
      .click();
    await roadmap.getByRole('button', { name: 'Start roadmap', exact: true }).click();
    await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toBeVisible();
    const board = page.url();
    await navigate(page, 'Needs you');
    await page
      .getByRole('region', { name: 'Open items' })
      .getByRole('listitem')
      .filter({ hasText: 'LN-06' })
      .getByRole('link', { name: 'Merge approval', exact: true })
      .click();
    const decision = page.getByRole('region', { name: 'Decision' });
    await decision.getByRole('button', { name: 'Merge…', exact: true }).click();
    await decision
      .getByRole('form', { name: 'Merge target' })
      .getByRole('button', { name: 'Merge', exact: true })
      .click();
    await expect(page.getByText('This item is resolved.')).toBeVisible();
    await page.goto(board);
    await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toHaveCount(2);

    // ---- The images -------------------------------------------------------------------------
    await navigate(page, 'Dashboard');
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    await photograph(page, 'dashboard');

    await navigate(page, 'Needs you');
    const open = page.getByRole('region', { name: 'Open items' });
    await expect(open.locator('.attention-title')).toHaveCount(STOPS.length + 2);
    // The item open above the list: a design question shows what a stop asks of the operator.
    await open.getByRole('link', { name: 'Design questions', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Decision' })).toBeVisible();
    await photograph(page, 'needs-you');

    // The run and the board are taller than a laptop screen; show each whole.
    await page.setViewportSize({ width: 1440, height: 1150 });
    await page.goto(liveRun);
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    // The sandbox notice names the e2e daemon's scratch paths.
    await page.getByRole('button', { name: /^Notices/ }).click();
    await photograph(page, 'live-run');

    await page.goto(board);
    await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toHaveCount(2);
    await photograph(page, 'roadmap-board');
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
