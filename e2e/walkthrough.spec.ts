import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, devices, type Locator, type Page } from '@playwright/test';
import {
  E2E_USERNAME,
  expect,
  git,
  openMergeDecision,
  sendCommand,
  setupStep,
  signIn,
  test,
} from './support';

/**
 * The UI walkthrough: seed one workspace with every kind of state the app can
 * show, then photograph each page on a desktop and a phone viewport.
 *
 * It is not a test of behavior (the other specs are); it is a record of how the
 * UI looked. `pnpm ui:walkthrough` writes one dated directory of images into a
 * store outside the repository (`CRAFTINGTABLE_WALKTHROUGH_DIR`, by default
 * `$XDG_DATA_HOME/craftingtable-walkthrough`), so screenshots never enter Git
 * history, and appends one row to the committed `docs/ui-walkthrough/INDEX.md`
 * so later UI work can find and compare earlier captures. Each capture is
 * labeled by `WALKTHROUGH_LABEL` or the commit.
 *
 * `pnpm test:e2e` also rehearses it (`CRAFTINGTABLE_WALKTHROUGH=rehearse`): the same
 * seeding and navigation on both viewports, without screenshots, images or an INDEX row.
 * The seeding drives real controller flows, so the rehearsal keeps them from breaking
 * unnoticed between captures, as happened after R-G3.
 */

const FIXTURES = new URL('../fixtures/plan-bundles/aq-cont-1/', import.meta.url);
const CONCURRENCY = new URL('../fixtures/concurrency/', import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Images live outside the repository: a structural boundary, not an ignore pattern. */
const OUTPUT_ROOT =
  process.env.CRAFTINGTABLE_WALKTHROUGH_DIR ??
  join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
    'craftingtable-walkthrough',
  );
/** The committed record of captures: one row per capture, text only. */
const INDEX_FILE = join(REPOSITORY_ROOT, 'docs', 'ui-walkthrough', 'INDEX.md');
/** Photograph and record; otherwise only rehearse the walk. */
const RECORDING = process.env.CRAFTINGTABLE_WALKTHROUGH === '1';

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

/**
 * Rail links carry a live count in their name ("Runs 1"), so match the label prefix. Pages
 * repeat some names in their crumbs ("Roadmaps"), so only the rail is searched.
 */
async function navigate(page: Page, name: string): Promise<void> {
  const label = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .getByRole('navigation', { name: 'Primary', exact: true })
    .getByRole('link', { name: new RegExp(`^${label}( \\d+)?$`) })
    .click();
}

/**
 * R-A5's done-when: in a seeded state, the rail count, the inbox, the dashboard and the
 * push log (Settings) list the same open items. Leaves the page on Settings.
 */
async function attentionAgrees(page: Page): Promise<number> {
  await navigate(page, 'Needs you');
  await expect(page.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible();
  await settled(page);
  const inbox = await page
    .getByRole('region', { name: 'Open items' })
    .locator('.attention-title')
    .allTextContents();
  const count = inbox.length;
  await expect(page.getByRole('link', { name: /^Needs you/ })).toHaveText(
    count ? new RegExp(`^Needs you\\s*${count}$`) : /^Needs you$/,
  );
  await navigate(page, 'Dashboard');
  await settled(page);
  const dashboard = page.getByRole('region', { name: 'Needs you' });
  if (count) {
    await expect(dashboard.locator('.attention-title')).toHaveCount(Math.min(count, 5));
    expect(await dashboard.locator('.attention-title').allTextContents()).toEqual(
      inbox.slice(0, 5),
    );
  } else await expect(dashboard).toHaveCount(0);
  await navigate(page, 'Settings');
  const open = page.locator('.notification-records li', { hasText: 'Still needs attention' });
  await expect(open).toHaveCount(count);
  expect([...(await open.locator('a').allTextContents())].sort()).toEqual([...inbox].sort());
  return count;
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
  // 1× keeps a capture small; WALKTHROUGH_SCALE=2 for crisp review.
  const deviceScaleFactor = process.env.WALKTHROUGH_SCALE === '2' ? 2 : 1;
  const context = await browser.newContext({ ...phone, deviceScaleFactor });
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
    if (!RECORDING) return;
    mkdirSync(join(directory, 'desktop'), { recursive: true });
    mkdirSync(join(directory, 'phone'), { recursive: true });
  }

  private async photograph(page: Page, viewport: 'desktop' | 'phone', file: string) {
    if (RECORDING)
      await page.screenshot({ path: join(this.directory, viewport, file), fullPage: true });
  }

  private nextFile(name: string): string {
    const file = `${String(this.ordinal).padStart(2, '0')}-${name}.png`;
    this.ordinal += 1;
    return file;
  }

  /** `landmark` must show on both viewports, so a page that rendered nothing fails the walk. */
  async capture(
    name: string,
    title: string,
    landmark: Landmark,
    setup?: (page: Page) => Promise<void>,
  ): Promise<void> {
    const file = this.nextFile(name);
    const url = this.desktop.url();
    if (setup) await setup(this.desktop);
    await settled(this.desktop, landmark);
    await this.photograph(this.desktop, 'desktop', file);
    await this.phone.goto(url);
    if (setup) await setup(this.phone);
    await settled(this.phone, landmark);
    await this.photograph(this.phone, 'phone', file);
    this.shots.push({ file, title, path: pathOf(url), viewports: 'both' });
  }

  /** A scene that only exists on the phone layout, photographed as it stands. */
  async capturePhoneOnly(name: string, title: string, landmark: Landmark): Promise<void> {
    const file = this.nextFile(name);
    await settled(this.phone, landmark);
    await this.photograph(this.phone, 'phone', file);
    this.shots.push({ file, title, path: pathOf(this.phone.url()), viewports: 'phone' });
  }

  writeIndex(label: string, commit: string): void {
    if (!RECORDING) return;
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
    const phoneOnly = this.shots.filter((shot) => shot.viewports === 'phone').length;
    appendFileSync(
      INDEX_FILE,
      `| ${label} | \`${commit}\` | ${new Date().toISOString().slice(0, 10)} | ` +
        `${this.shots.length}${phoneOnly ? ` (${phoneOnly} phone only)` : ''} | ` +
        `${process.env.WALKTHROUGH_SCALE === '2' ? '2×' : '1×'} |\n`,
    );
  }
}

/**
 * What shows that a page rendered its own content, not only the app's frame or an empty
 * shell (TS-M15, E2E F6): its main heading, or a region of it where the heading does not
 * name the scene.
 */
type Landmark = (page: Page) => Locator;
const heading =
  (name: string | RegExp): Landmark =>
  (page) =>
    page.getByRole('heading', { level: 1, name, exact: typeof name === 'string' });
const region =
  (name: string): Landmark =>
  (page) =>
    page.getByRole('region', { name, exact: true });
const navigation =
  (name: string): Landmark =>
  (page) =>
    page.getByRole('navigation', { name, exact: true });

/**
 * The page has rendered its data. The event stream keeps a connection open for
 * the life of the page, so "network idle" never arrives; wait for the loading
 * placeholders to leave and the page's landmark to show instead. A photograph then
 * waits a beat for fonts and layout; a rehearsal takes none, so it never waits on time.
 */
async function settled(page: Page, landmark?: Landmark): Promise<void> {
  await expect(page.getByText(/^(Loading|Checking session|Opening your workspace)/)).toHaveCount(0);
  if (landmark) await expect(landmark(page)).toBeVisible();
  if (RECORDING) await page.waitForTimeout(400);
}

/**
 * Opens design recovery in a design decision, unless it is open already (the desktop keeps
 * it open between scenes). Its section shows either the button or the open form, so the
 * check waits for one of them rather than reading the page before it has rendered.
 */
async function openDesignRecovery(page: Page): Promise<void> {
  const recovery = page.getByRole('region', { name: 'Resolve design questions', exact: true });
  const open = recovery.getByRole('button', { name: 'Resolve design questions', exact: true });
  const opened = recovery.getByRole('heading', { name: 'Resolve design questions', exact: true });
  await expect(open.or(opened)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(opened).toBeVisible();
}

function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

test('captures every page of the app on desktop and phone viewports', async ({
  page,
  browser,
  browserErrors,
}) => {
  const { label, directory, commit } = captureDirectory();
  if (RECORDING) rmSync(directory, { recursive: true, force: true });
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
  browserErrors.watch(phone.context());
  try {
    // ---- Sign-in on both viewports ---------------------------------------------------
    await page.goto('/');
    await expect(page.getByLabel('Username')).toBeVisible();
    await phone.goto('/');
    await expect(phone.getByLabel('Username')).toBeVisible();
    const walk = new Walkthrough(page, phone, directory);
    await walk.capture('login', 'Sign in', heading('Sign in to CraftingTable'));
    await signIn(page);
    await signIn(phone);

    // ---- Workspace -------------------------------------------------------------------
    await navigate(page, 'Workspaces');
    const create = page.getByRole('region', { name: 'New workspace' });
    await create.getByLabel('Name', { exact: true }).fill('Walkthrough');
    await create.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Walkthrough', exact: true })).toBeVisible();
    await walk.capture('dashboard-empty', 'Dashboard of a new workspace', heading('Walkthrough'));

    // ---- Import a plan bundle -------------------------------------------------------------
    await navigate(page, 'Import plan');
    await walk.capture('import-plan', 'Import plan', heading('Import plan'));
    await page.getByLabel('Project name').fill('ActionQueue');
    await page
      .getByLabel('Implementation plan')
      .setInputFiles(new URL('aq-cont-1-implementation-plan.md', FIXTURES).pathname);
    await page
      .getByLabel('Work breakdown')
      .setInputFiles(new URL('aq-cont-1-work-breakdown.yaml', FIXTURES).pathname);
    await page.getByRole('button', { name: 'Import plan bundle' }).click();
    await expect(page.getByRole('heading', { name: /Work items \(14\)/ })).toBeVisible();
    await walk.capture('project-imported', 'Project after import', heading(/^ActionQueue/));

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
    await walk.capture('repositories', 'Repositories', heading('Repositories'));

    await navigate(page, 'Projects');
    await walk.capture('projects', 'Projects', heading('Projects'));
    await page.getByRole('button', { name: 'ActionQueue', exact: true }).click();
    const branches = page.getByRole('region', { name: 'Repository & branches', exact: true });
    await walk.capture(
      'project-branch-form',
      'Project · configure branches',
      heading(/^ActionQueue/),
      async (p) => {
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
      },
    );
    await branches.getByRole('button', { name: 'Save branch settings' }).click();
    await expect(branches.getByText('revision', { exact: true })).toBeVisible();
    await walk.capture(
      'repository-policy-form',
      'Project · adopt repository policy',
      heading(/^ActionQueue/),
      async (p) => {
        await p.getByRole('button', { name: 'Record repository policy', exact: true }).click();
        await expect(p.getByRole('form', { name: 'Adopt repository policy' })).toBeVisible();
      },
    );
    await page
      .getByRole('checkbox', {
        name: 'I adopt this interpretation and the displayed freeze, where selected, for this plan.',
      })
      .check();
    await page.getByRole('button', { name: 'Adopt repository policy', exact: true }).click();
    await expect(page.getByText(/Adopted revision 1/)).toBeVisible();
    await walk.capture('project', 'Project with branches configured', heading(/^ActionQueue/));

    // ---- Plan version and finalization setup ---------------------------------------------
    await page.getByRole('button', { name: 'v1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Plan version 1', exact: true })).toBeVisible();
    await walk.capture('plan-version', 'Plan version', heading('Plan version 1'));
    await walk.capture(
      'plan-version-finalization-setup',
      'Plan version · finalization setup',
      heading('Plan version 1'),
      async (p) => {
        await p
          .getByRole('region', { name: 'Finalize integration', exact: true })
          .getByRole('button', { name: 'Set up finalization' })
          .click();
        await expect(p.getByRole('region', { name: 'Finalization stage setup' })).toBeVisible();
      },
    );

    // ---- Work item: admit, worktree, manual run --------------------------------------------
    await navigate(page, 'Projects');
    await page.getByRole('button', { name: 'ActionQueue', exact: true }).click();
    await page.getByRole('button', { name: 'AQ-01', exact: true }).click();
    await expect(page.getByRole('heading', { name: /AQ-01 ·/ })).toBeVisible();
    await walk.capture('work-item-proposed', 'Work item · proposed', heading(/^AQ-01 · /));
    await page.getByRole('button', { name: 'Admit into agenda' }).click();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
    await walk.capture(
      'work-item-worktree',
      'Work item · worktree ready to delegate',
      heading(/^AQ-01 · /),
    );
    await page.getByLabel(/Instructions for this run/).fill('Walkthrough smoke run');
    await page.getByRole('button', { name: /Launch implement run/ }).click();
    await expect(page.getByRole('heading', { name: /Implement run/ })).toBeVisible();
    const feed = page.getByTestId('run-feed');
    await expect(feed.getByText('fake agent finished turn 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    await walk.capture('run-waiting', 'Run · waiting for the operator', heading(/^Implement run/));
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
    await walk.capture('run-finished', 'Run · finished with an outcome', heading(/^Implement run/));
    await walk.capture('run-diff', 'Run · diff', heading(/^Implement run/), async (p) => {
      await p.getByRole('button', { name: 'View diff', exact: true }).click();
      await expect(p.getByTestId('diff-text')).toBeVisible();
    });

    // ---- Work item: automated cycle to merge approval ---------------------------------------
    await page.getByRole('button', { name: 'Work item', exact: true }).click();
    const cycle = page.getByRole('region', { name: 'Automated cycle', exact: true });
    await walk.capture(
      'work-item-cycle-setup',
      'Work item · cycle setup',
      heading(/^AQ-01 · /),
      async (p) => {
        const region = p.getByRole('region', { name: 'Automated cycle', exact: true });
        await region.getByText('Set up a cycle', { exact: true }).click();
        await expect(region.getByLabel('Allowed nits')).toBeVisible();
      },
    );
    await cycle.getByLabel('Allowed nits').fill('1');
    await cycle.getByLabel('Maximum remediation rounds').fill('0');
    await cycle
      .getByLabel(/Instructions/)
      .fill('MOBILE-FINDINGS DESIGN-QUESTIONS CYCLE-EXTRA-REMEDIATION SERVICE-RETRY');
    await cycle.getByRole('button', { name: 'Start automated cycle' }).click();
    await expect(cycle.getByRole('region', { name: 'Model service recovery' })).toBeVisible();
    await walk.capture(
      'work-item-provider-recovery',
      'Work item · bounded model service retry',
      heading(/^AQ-01 · /),
    );
    await cycle.getByRole('button', { name: 'Open current run' }).click();
    await expect(page.getByRole('region', { name: 'Model service recovery' })).toBeVisible();
    await walk.capture(
      'run-provider-recovery',
      'Run · model service failure and recovery controls',
      region('Model service recovery'),
    );
    await page.getByRole('button', { name: 'Work item', exact: true }).click();
    await cycle.getByRole('button', { name: 'Retry now', exact: true }).click();

    // A design stop is decided in its inbox item; the work item links there (R-A6).
    const designPage = page.url();
    const openDecision = cycle.getByRole('link', { name: 'Open the decision', exact: true });
    await expect(openDecision).toBeVisible();
    await walk.capture(
      'work-item-design-questions',
      'Work item · design needs answers, decided in Needs you',
      heading(/^AQ-01 · /),
    );
    await openDecision.click();
    const designDecision = page.getByRole('region', { name: 'Decision' });
    await expect(
      designDecision.getByRole('button', { name: 'Resolve design questions', exact: true }),
    ).toBeVisible();
    await walk.capture(
      'work-item-design-recovery',
      'Needs you · design recovery and evidence',
      region('Decision'),
      async (p) => {
        await p.getByRole('button', { name: 'Resolve design questions', exact: true }).click();
        await expect(p.getByLabel('Answers and guidance')).toBeVisible();
      },
    );
    await walk.capture(
      'work-item-baseline-preparation',
      'Needs you · historical sources and explicit baseline preparation',
      region('Decision'),
      async (p) => {
        await openDesignRecovery(p);
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
      'Needs you · prepared historical baseline and retained evidence',
      region('Decision'),
      async (p) => {
        await openDesignRecovery(p);
        await expect(p.getByText(/Sources prepared ·/)).toBeVisible();
      },
    );
    await page
      .getByLabel('Answers and guidance')
      .fill('Investigate the available baseline evidence without approving it.');
    await sendCommand(
      page,
      page.getByRole('button', { name: 'Start bounded investigation', exact: true }),
    );
    // The investigation's results are a new stop, with its own item.
    await page.goto(designPage);
    await expect(openDecision).toBeVisible();
    await openDecision.click();
    await expect(
      page.getByText('Investigation results and evidence', { exact: true }),
    ).toBeVisible();
    await walk.capture(
      'work-item-investigation-results',
      'Needs you · recorded investigation evidence',
      region('Decision'),
      async (p) => {
        await p.getByText('Investigation results and evidence', { exact: true }).click();
        await expect(p.getByRole('heading', { name: 'Final outcome', exact: true })).toBeVisible();
      },
    );
    await openDesignRecovery(page);
    await page.getByRole('button', { name: 'Refresh available evidence', exact: true }).click();
    await page
      .getByLabel('Answers and guidance')
      .fill('I own the baseline decision. Use the pinned baseline.');
    await page.getByRole('combobox', { name: 'Next action', exact: true }).selectOption('continue');
    await sendCommand(
      page,
      page.getByRole('button', { name: 'Continue design with evidence', exact: true }),
    );
    await page.goto(designPage);
    // A stop is decided in its inbox item; the work item links there (R-A6).
    const decisionLink = cycle.getByRole('link', { name: 'Open the decision', exact: true });
    await expect(decisionLink).toBeVisible();
    await expect(cycle.getByRole('button', { name: 'Resume automation' })).toHaveCount(0);
    await walk.capture(
      'work-item-remediation-recovery',
      'Work item · exhausted remediation allowance, decided in Needs you',
      heading(/^AQ-01 · /),
    );
    const workItemPage = page.url();
    const exhaustedItem = (await decisionLink.getAttribute('href')) ?? '';
    await decisionLink.click();
    const exhausted = page.getByRole('region', { name: 'Decision' });
    await expect(
      exhausted.getByRole('button', { name: 'Authorize more remediation' }),
    ).toBeVisible();
    await walk.capture(
      'inbox-remediation-recovery',
      'Needs you · authorize more remediation',
      region('Decision'),
    );
    await exhausted
      .getByLabel('Guidance for the next run (optional)')
      .fill('E2E-AUTHORIZED-RECOVERY E2E-OPERATOR-QUESTION: Address the remaining regression.');
    await sendCommand(page, exhausted.getByRole('button', { name: 'Authorize more remediation' }));
    await page.goto(workItemPage);
    // The next stop, its questions, is a new item.
    await expect(decisionLink).toHaveAttribute(
      'href',
      new RegExp(`^(?!${exhaustedItem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$)`),
    );
    await walk.capture(
      'work-item-guided-recovery',
      'Work item · implementation questions, decided in Needs you',
      heading(/^AQ-01 · /),
    );
    await decisionLink.click();
    const decision = page.getByRole('region', { name: 'Decision' });
    await decision
      .getByLabel('Answers and recovery guidance')
      // Guidance belongs to the step it is given for (R-G3), so the recovery instruction is
      // repeated with the answer.
      .fill(
        'E2E-AUTHORIZED-RECOVERY E2E-ANSWERED-QUESTION: Use the approved pinned baseline and retain every check.',
      );
    await walk.capture(
      'inbox-guided-recovery',
      'Needs you · answer implementation questions',
      region('Decision'),
    );
    await sendCommand(
      page,
      decision.getByRole('button', { name: 'Continue with guidance', exact: true }),
    );
    await page.goto(workItemPage);

    await expect(cycle.getByText('Awaiting merge approval', { exact: true })).toBeVisible();
    await walk.capture(
      'work-item-awaiting-merge',
      'Work item · cycle awaiting merge approval',
      heading(/^AQ-01 · /),
    );
    // The merge approval is an inbox item whose decision is the merge itself (R-A6).
    const awaitingMerge = page.url();
    expect(await attentionAgrees(page)).toBe(1);
    await navigate(page, 'Needs you');
    await walk.capture('inbox', 'Needs you · one merge approval', heading('Needs you'));
    await page
      .getByRole('region', { name: 'Open items' })
      .getByRole('link', { name: 'Merge approval' })
      .click();
    await expect(
      page.getByRole('region', { name: 'Decision' }).getByRole('button', { name: 'Merge…' }),
    ).toBeVisible();
    await walk.capture('inbox-item', 'Needs you · the merge approval', region('Decision'));
    await page.goto(awaitingMerge);
    await expect(cycle.getByText('Awaiting merge approval', { exact: true })).toBeVisible();
    // The work item links to the merge's inbox item, where it is decided (R-A6).
    await expect(page.getByText(/This merge is decided in Needs you/)).toBeVisible();
    await walk.capture(
      'work-item-merge-form',
      'Work item · the merge, decided in Needs you',
      heading(/^AQ-01 · /),
    );
    await cycle.getByRole('button', { name: 'Open current run' }).click();
    await expect(page.getByRole('heading', { name: 'Review run', exact: true })).toBeVisible();
    await walk.capture(
      'run-review',
      'Review run with findings',
      heading('Review run'),
      async (p) => {
        // A disclosure: open it unless it is open already.
        const findings = p.getByRole('group', { name: 'Review findings', exact: true });
        await expect(findings).toBeVisible();
        if (!(await findings.evaluate((details) => (details as HTMLDetailsElement).open)))
          await findings.locator('summary').click();
        await expect(findings.getByText('F-001', { exact: true })).toBeVisible();
      },
    );
    await page.getByRole('button', { name: 'Work item', exact: true }).click();
    const mergeForm = await openMergeDecision(page);
    await walk.capture('inbox-merge-form', 'Needs you · merge confirmation', region('Decision'));
    await mergeForm.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect(page.getByText('This item is resolved.')).toBeVisible();
    await page.goto(awaitingMerge);
    await expect(cycle.getByText(/Previous cycle: Completed/)).toBeVisible();
    await walk.capture(
      'work-item-completed',
      'Work item · completed by merge',
      heading(/^AQ-01 · /),
    );

    // ---- Roadmap ---------------------------------------------------------------------------
    await navigate(page, 'Roadmaps');
    await walk.capture('roadmaps-empty', 'Roadmaps · none yet', heading('Roadmaps'));
    await walk.capture('roadmap-editor', 'Roadmaps · editor', heading('Roadmaps'), async (p) => {
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
    await walk.capture('roadmap-draft', 'Roadmaps · saved draft', region('AQ sequential'));
    const roadmapUrl = page.url();
    await navigate(page, 'Settings');
    await walk.capture(
      'roadmap-agent-profiles',
      'Future roadmap agent profiles',
      heading('Settings'),
      async (p) => {
        await p.getByRole('button', { name: 'Edit future run profiles' }).click();
        await p
          .getByRole('region', { name: 'Roadmap agent profiles' })
          .getByText(/Specialist overrides ·/)
          .click();
      },
    );
    await page.goto(roadmapUrl);
    await roadmap.getByRole('button', { name: 'Start roadmap', exact: true }).click();
    await expect(roadmap.getByText('Awaiting merge approval', { exact: true })).toBeVisible();
    await walk.capture(
      'roadmap-running',
      'Roadmaps · running, first item awaiting merge',
      region('AQ sequential'),
    );

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
        await walk.capture(
          'import-zip-preview',
          'Import plan · ZIP preview',
          heading('Import plan'),
          async (p) => {
            // Choosing the ZIP form again keeps a preview the desktop already made.
            await p.getByRole('button', { name: 'Import ZIP archive', exact: true }).click();
            const region = p.getByRole('region', { name: 'Import plan ZIP' });
            await expect(region).toBeVisible();
            if (!(await region.getByText('Plan validated:', { exact: false }).isVisible())) {
              await region
                .getByLabel('Planning ZIP (up to 8 MiB)')
                .setInputFiles(fileURLToPath(new URL(file, CONCURRENCY)));
              await region.getByRole('button', { name: 'Preview ZIP', exact: true }).click();
              await expect(region.getByText('Plan validated:', { exact: false })).toBeVisible();
              await region.getByLabel('New project name').fill(name);
            }
          },
        );
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
    // The imported map opens on its own page (R-E2).
    const map = page.getByRole('region', { name: 'Imported map', exact: true });
    await expect(
      map.getByText('Imported definition · explicit delegation required', { exact: true }),
    ).toBeVisible();
    const aq = map
      .locator('article.import-binding')
      .filter({ has: page.getByLabel('aq upstream repository') });
    await aq.getByLabel('aq upstream repository').selectOption({ label: 'ActionQueue upstream' });
    for (const alias of ['wi', 'exo']) {
      const select = map.getByLabel(`${alias} plan version`, { exact: true });
      const value = await select
        .locator('option')
        .filter({ hasText: 'exact source match' })
        .getAttribute('value');
      await select.selectOption(value as string);
    }
    await map.getByRole('button', { name: 'Save exact bindings', exact: true }).click();
    await expect(map.getByText('Recorded binding revision: 1.', { exact: false })).toBeVisible();
    const runtime = map.getByRole('region', { name: 'Dependency environments and evidence' });
    await setupStep(page, 'Dependency environment');
    await runtime
      .getByText('Configure pinned dependencies and environments', { exact: true })
      .click();
    await runtime.getByLabel('aq · branch or commit', { exact: true }).fill('main');
    await runtime.getByRole('button', { name: 'Inspect aq', exact: true }).click();
    await expect(runtime.getByText(/Supplied crates: aq_walkthrough_pin/)).toBeVisible();
    await runtime.getByLabel('Conformance revision', { exact: true }).fill('16');
    await runtime.getByRole('button', { name: 'Add environment', exact: true }).click();
    await runtime.getByLabel('Environment name', { exact: true }).fill('walkthrough-local');
    await runtime.getByLabel('Environment SHA-256', { exact: true }).fill('1'.repeat(64));
    await runtime.getByLabel('Fixture SHA-256', { exact: true }).fill('2'.repeat(64));
    await runtime.getByLabel('Toolchain SHA-256', { exact: true }).fill('3'.repeat(64));
    await runtime
      .getByLabel('Authorization and scope', { exact: true })
      .fill('Disposable walkthrough fixtures only.');
    await runtime.getByRole('button', { name: 'Save dependency environment', exact: true }).click();
    await expect(runtime.getByText('Generation 1 · binding 1', { exact: true })).toBeVisible();
    await setupStep(page, 'Shared architecture decisions');
    await runtime
      .getByText('Advanced manual decision preparation and clause staging', { exact: true })
      .click();
    await runtime.getByText('Prepare a decision or stage early clauses', { exact: true }).click();
    await runtime
      .getByRole('combobox', { name: 'Architecture checkpoint', exact: true })
      .selectOption('WI-ADR-012');
    await runtime
      .getByLabel('Exact decision to approve', { exact: true })
      .fill(
        'Use stable provider identities and retain ordering evidence. Verify replay and duplicate handling independently.',
      );
    await runtime.getByRole('button', { name: 'Save proposal for review', exact: true }).click();
    await expect(
      runtime.getByText('Proposal saved · awaiting your approval', { exact: true }),
    ).toBeVisible();
    writeFileSync(join(upstream, 'POLICY.md'), 'Updated fixture policy.\n');
    git(['add', 'POLICY.md'], upstream);
    git(['commit', '--no-gpg-sign', '-m', 'Update provider fixture'], upstream);
    const selectTarget = async (p: Page) => {
      // The imported map has its own page (R-E2), so a fresh page opens on it.
      await setupStep(p, 'Plan and repository bindings');
      const region = p.getByRole('region', { name: 'Create cross-project roadmap', exact: true });
      const target = region.getByRole('combobox', { name: 'Planning target', exact: true });
      if ((await target.inputValue()) === '')
        await target.selectOption('WI-EMBEDDED-WORKER-PROOF-1');
      await expect(region.getByText(/selected milestones/)).toBeVisible();
    };
    await selectTarget(page);
    await walk.capture(
      'roadmaps-shared-decision-review',
      'Roadmaps · shared decision, automatic references and explicit approval',
      region('Imported map'),
      async (p: Page) => {
        await selectTarget(p);
        await setupStep(p, 'Shared architecture decisions');
        const card = p.getByRole('region', { name: 'WI-ADR-012', exact: true });
        await card.getByRole('button', { name: 'Review saved proposal', exact: true }).click();
        await expect(card.getByText('Review the saved decision', { exact: true })).toBeVisible();
        await card.scrollIntoViewIfNeeded();
      },
    );
    await walk.capture(
      'roadmaps-dependency-refresh',
      'Roadmaps · explicit dependency refresh preview',
      region('Imported map'),
      async (p: Page) => {
        await selectTarget(p);
        await setupStep(p, 'Dependency environment');
        const pins = p.getByRole('region', { name: 'Dependency pin refresh', exact: true });
        await pins.getByRole('button', { name: 'Preview dependency refresh' }).click();
        await expect(pins.getByText('Generation 1 → 2', { exact: true })).toBeVisible();
        await pins
          .getByLabel('Dependency refresh rationale')
          .fill('Review the provider policy update.');
        await pins.scrollIntoViewIfNeeded();
      },
    );
    await walk.capture(
      'roadmaps-cross-project',
      'Roadmaps · imported map and cross-project supervisor',
      region('Imported map'),
      selectTarget,
    );

    await walk.capture(
      'roadmaps-reviewer-responsibilities',
      'Roadmaps · direct reviewer responsibility assignment',
      region('Imported map'),
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
      region('Imported map'),
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
      'roadmaps-upstream-transitions',
      'Roadmaps · when each application moves to current upstream pins',
      region('Imported map'),
      async (p: Page) => {
        await selectTarget(p);
        await setupStep(p, 'Dependency environment');
        const transitions = p.getByRole('region', { name: 'Upstream transitions', exact: true });
        await transitions
          .getByLabel('WI → AQ transition slice')
          .selectOption('wi/WI-02/integration');
        await transitions
          .getByLabel('Transition rationale')
          .fill('WI-02/integration moved WI onto the current AQ pin.');
        await transitions.scrollIntoViewIfNeeded();
      },
    );

    await walk.capture(
      'roadmaps-dependency-graph',
      'Roadmaps · EXO integration requirements and WI providers',
      region('Imported map'),
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
      page.getByRole('navigation', { name: 'Roadmap pages', exact: true }),
    ).toBeVisible();
    // The new roadmap opens on its setup page (R-E2).
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Change future delegation', exact: true }),
    ).toBeVisible();
    await walk.capture(
      'roadmap-future-delegation',
      'Roadmaps · explicit future delegation',
      heading('Cross-project roadmap'),
      async (p) => {
        await p.getByRole('button', { name: 'Change future delegation', exact: true }).click();
        const form = p
          .locator('details')
          .filter({ has: p.getByText('Delegation for queued and started work', { exact: true }) })
          .last();
        await form.getByRole('button', { name: 'Select all entries', exact: true }).click();
        await expect(
          form.getByRole('button', { name: 'Apply future delegation', exact: true }),
        ).toBeDisabled();
      },
    );
    await walk.capture(
      'roadmap-decision-preparation',
      'Roadmaps · independent architecture preparation',
      heading('Cross-project roadmap'),
      async (p) => {
        await p.getByRole('button', { name: 'Prepare architecture decision', exact: true }).click();
        await p
          .getByRole('combobox', { name: 'Decision to prepare', exact: true })
          .selectOption('WI-ADR-008');
        await expect(
          p.getByRole('button', { name: 'Prepare decision brief', exact: true }),
        ).toBeEnabled();
      },
    );

    await walk.capture(
      'roadmap-recovery-delegation',
      'Roadmaps · bounded independent review recovery',
      heading('Cross-project roadmap'),
      async (p: Page) => {
        await setupStep(p, 'Reviewer responsibilities and delegation');
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

    // A roadmap's other pages, and the list that links them (R-E2).
    const roadmapPages = page.getByRole('navigation', { name: 'Roadmap pages', exact: true });
    await roadmapPages.getByRole('link', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Roadmap controls' })).toBeVisible();
    await walk.capture(
      'roadmap-board',
      'Roadmap · board and controls',
      heading('Cross-project roadmap'),
    );
    await roadmapPages.getByRole('link', { name: 'History', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Saved revisions', exact: true })).toBeVisible();
    await walk.capture(
      'roadmap-history',
      'Roadmap · revisions and amendments',
      region('Saved revisions'),
    );
    await navigate(page, 'Roadmaps');
    await expect(page.getByRole('region', { name: 'Active roadmaps', exact: true })).toBeVisible();
    await walk.capture(
      'roadmaps-list',
      'Roadmaps · every roadmap and imported map',
      region('Active roadmaps'),
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
    await walk.capture(
      'work-item-slices',
      'Work item · execution slices from a map',
      region('Execution slices and parent acceptance'),
    );

    // ---- Lists and settings ------------------------------------------------------------------
    await navigate(page, 'Work items');
    await expect(page.getByRole('heading', { name: 'Work items', exact: true })).toBeVisible();
    await walk.capture('agenda', 'Agenda · in agenda', heading('Work items'));
    await page.getByRole('tab', { name: 'All', exact: true }).click();
    await walk.capture('agenda-all', 'Agenda · every item', heading('Work items'));
    await navigate(page, 'Runs');
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
    await walk.capture('runs', 'Runs', heading('Runs'));
    await navigate(page, 'Dashboard');
    await expect(page.getByRole('heading', { name: 'Walkthrough', exact: true })).toBeVisible();
    await walk.capture('dashboard', 'Dashboard with work in flight', heading('Walkthrough'));
    await attentionAgrees(page);
    await navigate(page, 'Needs you');
    await walk.capture('inbox-roadmap', 'Needs you · with a roadmap running', heading('Needs you'));
    await navigate(page, 'Dashboard');
    await phone.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(phone.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await walk.capturePhoneOnly('menu-open', 'Phone navigation menu', navigation('Primary'));
    await navigate(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change workstation capacity' })).toBeEnabled();
    await walk.capture('settings', 'Workspace settings', heading('Settings'));
    await walk.capture(
      'workspace-agent-profiles',
      'Workspace defaults and specialist inheritance',
      heading('Settings'),
      async (p) => {
        await p.getByRole('button', { name: 'Edit workspace defaults' }).click();
        await p
          .getByRole('region', { name: 'Agent profiles' })
          .getByText(/Specialist overrides ·/)
          .click();
      },
    );
    await page
      .getByRole('region', { name: 'Agent profiles' })
      .getByRole('button', { name: 'Close editor' })
      .click();
    await walk.capture(
      'agent-recommendations',
      'Model recommendations mapped to UI fields',
      heading('Settings'),
      async (p) => {
        await p.getByText('Suggested models and where to set them').click();
      },
    );
    await page.getByText('Suggested models and where to set them').click();
    await walk.capture(
      'execution-capacity',
      'Unified execution capacity controls',
      heading('Settings'),
      async (p) => {
        await p.getByRole('button', { name: 'Change workstation capacity' }).click();
      },
    );
    await navigate(page, `Account · ${E2E_USERNAME}`);
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await walk.capture('account', 'Account', heading('Account'));
    await navigate(page, 'Workspaces');
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
    await walk.capture('workspaces', 'Workspaces', heading('Workspaces'));

    walk.writeIndex(label, commit);
  } finally {
    await phone.context().close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
    for (const path of applicationRepositories) rmSync(path, { recursive: true, force: true });
  }
});
