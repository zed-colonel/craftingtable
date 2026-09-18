import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, devices, expect, type Page, test } from '@playwright/test';

/**
 * The UI walkthrough: seed one workspace with every kind of state the app can
 * show, then photograph each page on a desktop and a phone viewport.
 *
 * It is not a test of behavior (the other specs are); it is a record of how the
 * UI looked. `pnpm ui:walkthrough` writes one dated directory under
 * `docs/ui-walkthrough/` so later UI work can be compared against earlier
 * captures. Each capture is labeled by `WALKTHROUGH_LABEL` or the commit.
 */

const FIXTURES = new URL('../fixtures/plan-bundles/aq-cont-1/', import.meta.url);
const CONCURRENCY = new URL('../fixtures/concurrency/', import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_ROOT = join(REPOSITORY_ROOT, 'docs', 'ui-walkthrough');
const USERNAME = 'e2e-admin';
const PASSWORD = 'correct horse battery staple';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

function captureDirectory(): { label: string; directory: string; commit: string } {
  const commit = git(['rev-parse', '--short', 'HEAD'], REPOSITORY_ROOT);
  const date = new Date().toISOString().slice(0, 10);
  const label = `${date}-${process.env.WALKTHROUGH_LABEL ?? commit}`;
  return { label, directory: join(OUTPUT_ROOT, label), commit };
}

interface Shot {
  readonly file: string;
  readonly title: string;
  readonly path: string;
  readonly viewports: 'both' | 'phone';
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Default workspace', exact: true })).toBeVisible();
}

/** Rail links carry a live count in their name ("Runs 1"), so match the label prefix. */
async function navigate(page: Page, name: string): Promise<void> {
  const label = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('link', { name: new RegExp(`^${label}( \\d+)?$`) }).click();
}

function initRepository(prefix: string, files: Readonly<Record<string, string>>): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  git(['init', '--initial-branch=main', '.'], path);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  git(['add', '.'], path);
  git(['commit', '--no-gpg-sign', '-m', 'initial'], path);
  return path;
}

async function newPhonePage(browser: Browser): Promise<Page> {
  const { defaultBrowserType: _browser, ...phone } = devices[
    'iPhone 13'
  ] as (typeof devices)[string];
  // 1× keeps a capture small enough to keep many in git; WALKTHROUGH_SCALE=2 for crisp review.
  const deviceScaleFactor = process.env.WALKTHROUGH_SCALE === '2' ? 2 : 1;
  const context = await browser.newContext({ ...phone, deviceScaleFactor });
  context.setDefaultTimeout(20_000);
  return context.newPage();
}

/**
 * One scene, photographed on both viewports. `setup` reproduces any transient
 * UI state (an opened form, an expanded disclosure) from the page URL, so the
 * phone capture shows the same scene the desktop one does; the daemon holds
 * everything else.
 */
class Walkthrough {
  readonly shots: Shot[] = [];
  private ordinal = 0;

  constructor(
    readonly desktop: Page,
    readonly phone: Page,
    readonly directory: string,
  ) {
    mkdirSync(join(directory, 'desktop'), { recursive: true });
    mkdirSync(join(directory, 'phone'), { recursive: true });
  }

  private nextFile(name: string): string {
    const file = `${String(this.ordinal).padStart(2, '0')}-${name}.png`;
    this.ordinal += 1;
    return file;
  }

  async capture(name: string, title: string, setup?: (page: Page) => Promise<void>): Promise<void> {
    const file = this.nextFile(name);
    const url = this.desktop.url();
    if (setup) await setup(this.desktop);
    await settled(this.desktop);
    await this.desktop.screenshot({ path: join(this.directory, 'desktop', file), fullPage: true });
    await this.phone.goto(url);
    await settled(this.phone);
    if (setup) await setup(this.phone);
    await this.phone.screenshot({ path: join(this.directory, 'phone', file), fullPage: true });
    this.shots.push({ file, title, path: pathOf(url), viewports: 'both' });
  }

  /** A scene that only exists on the phone layout, photographed as it stands. */
  async capturePhoneOnly(name: string, title: string): Promise<void> {
    const file = this.nextFile(name);
    await this.phone.screenshot({ path: join(this.directory, 'phone', file), fullPage: true });
    this.shots.push({ file, title, path: pathOf(this.phone.url()), viewports: 'phone' });
  }

  writeIndex(label: string, commit: string): void {
    const sections = this.shots.map((shot) => {
      const desktop =
        shot.viewports === 'both'
          ? `![${shot.title} on desktop](desktop/${shot.file})`
          : '(phone only)';
      return (
        `## ${shot.title}\n\n\`${shot.path}\`\n\n` +
        `| Desktop 1440 wide | Phone 390 wide |\n| --- | --- |\n` +
        `| ${desktop} | ![${shot.title} on a phone](phone/${shot.file}) |\n`
      );
    });
    writeFileSync(
      join(this.directory, 'README.md'),
      `# UI walkthrough · ${label}\n\n` +
        `Captured from commit \`${commit}\` on ${new Date().toISOString().slice(0, 10)} ` +
        'by `pnpm ui:walkthrough` (`e2e/walkthrough.spec.ts`). ' +
        'Desktop captures are 1440×900; phone captures are iPhone 13 emulation (390×844) ' +
        `at ${process.env.WALKTHROUGH_SCALE === '2' ? '2×' : '1×'}. Every capture is the full page.\n\n` +
        `${sections.join('\n')}`,
    );
  }
}

/**
 * The page has rendered its data. The event stream keeps a connection open for
 * the life of the page, so "network idle" never arrives; wait for the loading
 * placeholders to leave instead, then a beat for fonts and layout.
 */
async function settled(page: Page): Promise<void> {
  await expect(page.getByText(/^(Loading|Checking session|Opening your workspace)/)).toHaveCount(0);
  await page.waitForTimeout(400);
}

function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

test('captures every page of the app on desktop and phone viewports', async ({ page, browser }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(20_000);
  const { label, directory, commit } = captureDirectory();
  rmSync(directory, { recursive: true, force: true });
  const repository = initRepository('craftingtable-walkthrough-repo-', {
    'README.md': '# Walkthrough fixture\n',
  });
  const upstream = initRepository('craftingtable-walkthrough-upstream-', {
    'Cargo.toml':
      '[package]\nname="aq_walkthrough_pin"\nversion="0.2.0"\nedition="2021"\n[lib]\npath="lib.rs"\n',
    'lib.rs': 'pub fn fixture(){}\n',
  });
  const applicationRepositories: string[] = [];
  const phone = await newPhonePage(browser);
  try {
    // ---- Sign-in on both viewports ---------------------------------------------------
    await page.goto('/');
    await expect(page.getByLabel('Username')).toBeVisible();
    await phone.goto('/');
    await expect(phone.getByLabel('Username')).toBeVisible();
    const walk = new Walkthrough(page, phone, directory);
    await walk.capture('login', 'Sign in');
    await signIn(page);
    await signIn(phone);

    // ---- Workspace -------------------------------------------------------------------
    await navigate(page, 'All workspaces');
    const create = page.getByRole('region', { name: 'New workspace' });
    await create.getByLabel('Name', { exact: true }).fill('Walkthrough');
    await create.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Walkthrough', exact: true })).toBeVisible();
    await walk.capture('dashboard-empty', 'Dashboard of a new workspace');

    // ---- Import a plan bundle -------------------------------------------------------------
    await navigate(page, 'Import plan');
    await walk.capture('import-plan', 'Import a plan bundle');
    await page.getByLabel('Project name').fill('ActionQueue');
    await page
      .getByLabel('Implementation plan')
      .setInputFiles(new URL('aq-cont-1-implementation-plan.md', FIXTURES).pathname);
    await page
      .getByLabel('Work breakdown')
      .setInputFiles(new URL('aq-cont-1-work-breakdown.yaml', FIXTURES).pathname);
    await page.getByRole('button', { name: 'Import plan bundle' }).click();
    await expect(page.getByRole('heading', { name: /Work items \(14\)/ })).toBeVisible();
    await walk.capture('project-imported', 'Project after import');

    // ---- Repositories and branch settings -------------------------------------------------
    await navigate(page, 'Repositories');
    await page.getByLabel('Absolute path to the checkout').fill(repository);
    await page.getByLabel('Display name (optional)').fill('Walkthrough repository');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText(repository, { exact: true })).toBeVisible();
    await page.getByLabel('Absolute path to the checkout').fill(upstream);
    await page.getByLabel('Display name (optional)').fill('ActionQueue upstream');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText(upstream, { exact: true })).toBeVisible();
    await walk.capture('repositories', 'Repositories');

    await navigate(page, 'Projects');
    await walk.capture('projects', 'Projects');
    await page.getByRole('button', { name: 'ActionQueue', exact: true }).click();
    const branches = page.getByRole('region', { name: 'Repository & branches', exact: true });
    await walk.capture('project-branch-form', 'Project · configure branches', async (p) => {
      const region = p.getByRole('region', { name: 'Repository & branches', exact: true });
      await region.getByRole('button', { name: 'Configure branches' }).click();
      await region
        .getByRole('combobox', { name: 'Repository', exact: true })
        .selectOption({ label: 'Walkthrough repository' });
      await region
        .getByRole('combobox', { name: 'Branch action', exact: true })
        .selectOption('create');
      await region.getByLabel('Integration branch', { exact: true }).fill('revision');
      await region.getByRole('combobox', { name: 'Create from branch' }).selectOption('main');
    });
    await branches.getByRole('button', { name: 'Save branch settings' }).click();
    await expect(branches.getByText('revision', { exact: true })).toBeVisible();
    await walk.capture('repository-policy-form', 'Project · adopt repository policy', async (p) => {
      await p.getByRole('button', { name: 'Record repository policy', exact: true }).click();
      await expect(p.getByRole('form', { name: 'Adopt repository policy' })).toBeVisible();
    });
    await page
      .getByRole('checkbox', {
        name: 'I adopt this interpretation and the displayed freeze, where selected, for this plan.',
      })
      .check();
    await page.getByRole('button', { name: 'Adopt repository policy', exact: true }).click();
    await expect(page.getByText(/Adopted revision 1/)).toBeVisible();
    await walk.capture('project', 'Project with branches configured');

    // ---- Plan version and finalization setup ---------------------------------------------
    await page.getByRole('button', { name: 'v1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Plan version 1', exact: true })).toBeVisible();
    await walk.capture('plan-version', 'Plan version');
    await walk.capture(
      'plan-version-finalization-setup',
      'Plan version · finalization setup',
      async (p) => {
        await p
          .getByRole('region', { name: 'Finalize integration', exact: true })
          .getByRole('button', { name: 'Set up finalization' })
          .click();
        await expect(p.getByLabel('Finalization workflow')).toBeVisible();
      },
    );

    // ---- Work item: admit, worktree, manual run --------------------------------------------
    await navigate(page, 'Projects');
    await page.getByRole('button', { name: 'ActionQueue', exact: true }).click();
    await page.getByRole('button', { name: 'AQ-01', exact: true }).click();
    await expect(page.getByRole('heading', { name: /AQ-01 ·/ })).toBeVisible();
    await walk.capture('work-item-proposed', 'Work item · proposed');
    await page.getByRole('button', { name: 'Admit into agenda' }).click();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
    await walk.capture('work-item-worktree', 'Work item · worktree ready to delegate');
    await page.getByLabel(/Instructions for this run/).fill('Walkthrough smoke run');
    await page.getByRole('button', { name: /Launch implement run/ }).click();
    await expect(page.getByRole('heading', { name: /Implement run/ })).toBeVisible();
    const feed = page.getByTestId('run-feed');
    await expect(feed.getByText('fake agent finished turn 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    await walk.capture('run-waiting', 'Run · waiting for the operator');
    await page.getByLabel('Message to the agent').fill('Check the boundary behavior too.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(feed.getByText('fake agent finished turn 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: 'Run outcome' })
        .getByRole('heading', { name: 'Final outcome' }),
    ).toBeVisible();
    await walk.capture('run-finished', 'Run · finished with an outcome');
    await walk.capture('run-diff', 'Run · diff', async (p) => {
      await p.getByRole('button', { name: 'View diff', exact: true }).click();
      await expect(p.getByTestId('diff-text')).toBeVisible();
    });

    // ---- Work item: automated cycle to merge approval ---------------------------------------
    await page.getByRole('button', { name: 'Work item', exact: true }).click();
    const cycle = page.getByRole('region', { name: 'Automated cycle', exact: true });
    await walk.capture('work-item-cycle-setup', 'Work item · cycle setup', async (p) => {
      const region = p.getByRole('region', { name: 'Automated cycle', exact: true });
      await region.getByText('Set up a cycle', { exact: true }).click();
      await expect(region.getByLabel('Allowed nits')).toBeVisible();
    });
    await cycle.getByLabel('Allowed nits').fill('1');
    await cycle.getByLabel('Maximum remediation rounds').fill('0');
    await cycle
      .getByLabel(/Instructions/)
      .fill('MOBILE-FINDINGS DESIGN-QUESTIONS CYCLE-EXTRA-REMEDIATION');
    await cycle.getByRole('button', { name: 'Start automated cycle' }).click();
    await expect(
      cycle.getByRole('button', { name: 'Resolve design questions', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await walk.capture('work-item-design-questions', 'Work item · design needs answers');
    await walk.capture(
      'work-item-design-recovery',
      'Work item · design recovery and evidence',
      async (p) => {
        await p.getByRole('button', { name: 'Resolve design questions', exact: true }).click();
        await expect(p.getByLabel('Answers and guidance')).toBeVisible();
      },
    );
    await walk.capture(
      'work-item-baseline-preparation',
      'Work item · historical sources and explicit baseline preparation',
      async (p) => {
        const recovery = p.getByRole('button', { name: 'Resolve design questions', exact: true });
        if (await recovery.isVisible()) await recovery.click();
        await p.getByRole('button', { name: 'Prepare baseline evidence', exact: true }).click();
        await expect(p.getByLabel('Historical commit or local ref')).toBeVisible();
      },
    );
    await page
      .getByRole('checkbox', {
        name: 'Use these historical revisions and create the displayed local baseline tags.',
      })
      .check();
    await page
      .getByRole('button', { name: 'Prepare historical sources and tags', exact: true })
      .click();
    await expect(page.getByText(/Sources prepared ·/)).toBeVisible();
    await walk.capture(
      'work-item-baseline-prepared',
      'Work item · prepared historical baseline and retained evidence',
      async (p) => {
        const recovery = p.getByRole('button', { name: 'Resolve design questions', exact: true });
        if (await recovery.isVisible()) await recovery.click();
        await expect(p.getByText(/Sources prepared ·/)).toBeVisible();
      },
    );
    await page
      .getByLabel('Answers and guidance')
      .fill('I own the baseline decision. Use the pinned baseline.');
    await page.getByRole('combobox', { name: 'Next action', exact: true }).selectOption('continue');
    await page.getByRole('button', { name: 'Continue design with evidence', exact: true }).click();
    await expect(cycle.getByRole('button', { name: 'Authorize more remediation' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(cycle.getByRole('button', { name: 'Resume automation' })).toHaveCount(0);
    await walk.capture(
      'work-item-remediation-recovery',
      'Work item · exhausted remediation allowance',
    );
    await cycle
      .getByLabel('Additional cycle guidance (optional)')
      .fill('E2E-AUTHORIZED-RECOVERY: Address the remaining regression.');
    await cycle.getByRole('button', { name: 'Authorize more remediation' }).click();

    await expect(cycle.getByText('Awaiting merge approval', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await walk.capture('work-item-awaiting-merge', 'Work item · cycle awaiting merge approval');
    await walk.capture('work-item-merge-form', 'Work item · merge confirmation', async (p) => {
      await p.getByRole('button', { name: 'Merge…', exact: true }).click();
      await expect(p.getByRole('form', { name: 'Merge target' })).toBeVisible();
    });
    await cycle.getByRole('button', { name: 'Open current run' }).click();
    await expect(page.getByRole('heading', { name: 'Review run', exact: true })).toBeVisible();
    await walk.capture('run-review', 'Review run with findings', async (p) => {
      const findings = p.getByRole('group', { name: 'Review findings', exact: true });
      if (!(await findings.getByText('F-001', { exact: true }).isVisible()))
        await findings.locator('summary').click();
      await expect(findings.getByText('F-001', { exact: true })).toBeVisible();
    });
    await page.getByRole('button', { name: 'Work item', exact: true }).click();
    await page.getByRole('button', { name: 'Merge…', exact: true }).click();
    await page
      .getByRole('form', { name: 'Merge target' })
      .getByRole('button', { name: 'Merge', exact: true })
      .click();
    await expect(cycle.getByText(/Previous cycle: Completed/)).toBeVisible();
    await walk.capture('work-item-completed', 'Work item · completed by merge');

    // ---- Roadmap ---------------------------------------------------------------------------
    await navigate(page, 'Roadmaps');
    await walk.capture('roadmaps-empty', 'Roadmaps · none yet');
    await walk.capture('roadmap-editor', 'Roadmaps · editor', async (p) => {
      await p.getByRole('button', { name: 'New roadmap', exact: true }).click();
      const editor = p.getByRole('region', { name: 'Roadmap editor' });
      await editor.getByLabel('Roadmap name').fill('AQ sequential');
      for (const sourceId of ['AQ-02', 'AQ-03']) {
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
    });
    const editor = page.getByRole('region', { name: 'Roadmap editor' });
    await editor.getByRole('button', { name: 'Save roadmap', exact: true }).click();
    const roadmap = page.getByRole('region', { name: 'AQ sequential', exact: true });
    await expect(roadmap.getByText('Draft', { exact: true })).toBeVisible();
    await walk.capture('roadmap-draft', 'Roadmaps · saved draft');
    await roadmap.getByRole('button', { name: 'Start roadmap', exact: true }).click();
    await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await walk.capture('roadmap-running', 'Roadmaps · running, first item awaiting merge');

    // ---- Cross-project map -----------------------------------------------------------------
    for (const [file, name] of [
      ['wi-fabric-2-foundational-package-r5-aq-baseline-alignment.zip', 'WorldInterface'],
      ['exo-v3-comprehensive-design-package-r6-aq-baseline-alignment.zip', 'Exoskeleton'],
    ] as const) {
      await navigate(page, 'Import plan');
      await page.getByRole('button', { name: 'Import ZIP archive', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Import plan ZIP' });
      await panel
        .getByLabel('Planning ZIP (up to 8 MiB)')
        .setInputFiles(fileURLToPath(new URL(file, CONCURRENCY)));
      await panel.getByRole('button', { name: 'Preview ZIP', exact: true }).click();
      await expect(panel.getByText('Plan validated:', { exact: false })).toBeVisible();
      await panel.getByLabel('New project name').fill(name);
      if (name === 'Exoskeleton') {
        await walk.capture('import-zip-preview', 'Import plan · ZIP preview', async (p) => {
          if (await p.getByRole('button', { name: 'Import ZIP archive', exact: true }).isVisible())
            await p.getByRole('button', { name: 'Import ZIP archive', exact: true }).click();
          const region = p.getByRole('region', { name: 'Import plan ZIP' });
          if (!(await region.getByText('Plan validated:', { exact: false }).isVisible())) {
            await region
              .getByLabel('Planning ZIP (up to 8 MiB)')
              .setInputFiles(fileURLToPath(new URL(file, CONCURRENCY)));
            await region.getByRole('button', { name: 'Preview ZIP', exact: true }).click();
            await expect(region.getByText('Plan validated:', { exact: false })).toBeVisible();
            await region.getByLabel('New project name').fill(name);
          }
        });
      }
      await panel.getByRole('button', { name: 'Import reviewed plan ZIP' }).click();
      await expect(panel.getByText('Import: succeeded', { exact: true })).toBeVisible();
      const applicationRepo = initRepository('craftingtable-walkthrough-application-', {
        'README.md': `# ${name} fixture\n`,
      });
      applicationRepositories.push(applicationRepo);
      await navigate(page, 'Repositories');
      await page.getByLabel('Absolute path to the checkout').fill(applicationRepo);
      await page.getByLabel('Display name (optional)').fill(`${name} fixture`);
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      await expect(page.getByText(applicationRepo, { exact: true })).toBeVisible();
      await navigate(page, 'Projects');
      await page.getByRole('button', { name, exact: true }).click();
      const settings = page.getByRole('region', { name: 'Repository & branches', exact: true });
      await settings.getByRole('button', { name: 'Configure branches' }).click();
      await settings
        .getByRole('combobox', { name: 'Repository', exact: true })
        .selectOption({ label: `${name} fixture` });
      await settings
        .getByRole('combobox', { name: 'Branch action', exact: true })
        .selectOption('create');
      await settings.getByLabel('Integration branch', { exact: true }).fill('revision');
      await settings.getByRole('combobox', { name: 'Create from branch' }).selectOption('main');
      await settings.getByRole('button', { name: 'Save branch settings' }).click();
      await expect(settings.getByText('revision', { exact: true })).toBeVisible();
    }
    await navigate(page, 'Roadmaps');
    const maps = page.getByRole('region', { name: 'Cross-project roadmap imports' });
    await maps.getByText('Import concurrency map', { exact: true }).click();
    await maps
      .getByLabel('Concurrency map ZIP (up to 8 MiB)')
      .setInputFiles(
        fileURLToPath(
          new URL('cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip', CONCURRENCY),
        ),
      );
    await maps.getByRole('button', { name: 'Import map ZIP', exact: true }).click();
    await expect(
      maps.getByText('Imported definition · explicit delegation required', { exact: true }),
    ).toBeVisible();
    const aq = maps
      .locator('article.import-binding')
      .filter({ has: page.getByLabel('aq upstream repository') });
    await aq.getByLabel('aq upstream repository').selectOption({ label: 'ActionQueue upstream' });
    for (const alias of ['wi', 'exo']) {
      const select = maps.getByLabel(`${alias} plan version`, { exact: true });
      const value = await select
        .locator('option')
        .filter({ hasText: 'exact source match' })
        .getAttribute('value');
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
    await expect(runtime.getByText(/Supplied crates: aq_walkthrough_pin/)).toBeVisible();
    const selectTarget = async (p: Page) => {
      // A fresh page lists imported maps without opening one.
      const drafts = p.getByLabel('Imported roadmap draft');
      if (await drafts.isVisible()) {
        await drafts.selectOption({ index: 1 });
        await p
          .getByRole('region', { name: 'Cross-project roadmap imports' })
          .getByText('Recorded binding revision: 1.', { exact: false })
          .waitFor();
      }
      const region = p.getByRole('region', { name: 'Create cross-project roadmap', exact: true });
      const target = region.getByRole('combobox', { name: 'Planning target', exact: true });
      if ((await target.inputValue()) === '')
        await target.selectOption('WI-EMBEDDED-WORKER-PROOF-1');
      await expect(region.getByText(/selected milestones/)).toBeVisible();
    };
    await selectTarget(page);
    await walk.capture(
      'roadmaps-cross-project',
      'Roadmaps · imported map and cross-project supervisor',
      selectTarget,
    );

    await walk.capture(
      'roadmaps-reviewer-responsibilities',
      'Roadmaps · direct reviewer responsibility assignment',
      async (p: Page) => {
        await selectTarget(p);
        const supervisor = p.getByRole('region', {
          name: 'Create cross-project roadmap',
          exact: true,
        });
        await supervisor
          .getByRole('button', {
            name: 'Assign independent reviewer responsibilities',
            exact: true,
          })
          .click();
        await expect(
          supervisor.getByRole('checkbox', { name: 'repository-maintainer', exact: true }),
        ).toBeVisible();
      },
    );

    await walk.capture(
      'roadmaps-verification-environments',
      'Roadmaps · native approval and Kata readiness',
      async (p: Page) => {
        await selectTarget(p);
        await p
          .getByRole('button', { name: 'Review verification environments', exact: true })
          .first()
          .click();
        await expect(
          p.getByRole('button', { name: 'Audit workstation readiness', exact: true }).first(),
        ).toBeVisible();
      },
    );

    await walk.capture(
      'roadmaps-dependency-graph',
      'Roadmaps · EXO integration requirements and WI providers',
      async (p: Page) => {
        await selectTarget(p);
        const supervisor = p.getByRole('region', {
          name: 'Create cross-project roadmap',
          exact: true,
        });
        await supervisor
          .getByRole('combobox', { name: 'Selection mode', exact: true })
          .selectOption('prioritize-full');
        await supervisor
          .getByRole('combobox', { name: 'Focused dependency view', exact: true })
          .selectOption('slice:exo/EXO-03/integration:merged');
        await expect(
          supervisor.getByRole('region', { name: 'Dependency graph', exact: true }),
        ).toBeVisible();
      },
    );

    await page
      .getByRole('region', { name: 'Create cross-project roadmap', exact: true })
      .getByRole('button', { name: 'Create cross-project roadmap', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Independent review recovery', exact: true }),
    ).toBeVisible();
    await walk.capture(
      'roadmap-recovery-delegation',
      'Roadmaps · bounded independent review recovery',
      async (p: Page) => {
        const recovery = p.getByRole('region', {
          name: 'Independent review recovery',
          exact: true,
        });
        await recovery
          .getByRole('button', { name: 'Configure review recovery', exact: true })
          .click();
        await expect(recovery.getByLabel('Total automatic repair rounds per parent')).toHaveValue(
          '3',
        );
        await expect(
          recovery.getByRole('button', { name: 'Save recovery delegation' }),
        ).toBeEnabled();
        await recovery.scrollIntoViewIfNeeded();
      },
    );

    await navigate(page, 'Projects');
    await page.getByRole('button', { name: 'WorldInterface', exact: true }).click();
    await page.getByRole('button', { name: 'WI-01', exact: true }).first().click();
    await expect(
      page
        .getByRole('region', { name: 'Execution slices and parent acceptance' })
        .getByRole('heading', { name: /wi\/WI-01/ })
        .first(),
    ).toBeVisible();
    await walk.capture('work-item-slices', 'Work item · execution slices from a map');

    // ---- Lists and settings ------------------------------------------------------------------
    await navigate(page, 'Agenda');
    await expect(page.getByRole('heading', { name: 'Work items', exact: true })).toBeVisible();
    await walk.capture('agenda', 'Agenda · in agenda');
    await page.getByRole('tab', { name: 'All', exact: true }).click();
    await walk.capture('agenda-all', 'Agenda · every item');
    await navigate(page, 'Runs');
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
    await walk.capture('runs', 'Runs');
    await navigate(page, 'Dashboard');
    await expect(page.getByRole('heading', { name: 'Walkthrough', exact: true })).toBeVisible();
    await walk.capture('dashboard', 'Dashboard with work in flight');
    await phone.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(phone.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await walk.capturePhoneOnly('menu-open', 'Phone navigation menu');
    await navigate(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
    await walk.capture('settings', 'Workspace settings');
    await navigate(page, `Account · ${USERNAME}`);
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await walk.capture('account', 'Account');
    await navigate(page, 'All workspaces');
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
    await walk.capture('workspaces', 'All workspaces');

    walk.writeIndex(label, commit);
  } finally {
    await phone.context().close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
    for (const path of applicationRepositories) rmSync(path, { recursive: true, force: true });
  }
});
