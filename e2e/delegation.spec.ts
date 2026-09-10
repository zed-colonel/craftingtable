import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The first useful loop, driven from the browser: register a repository, open
 * a work item, create a worktree, launch an agent, watch it live, steer it,
 * end it, and read the diff. The daemon runs a scripted `claude` stand-in
 * (e2e/fake-claude.mjs) so the suite is deterministic and free.
 */

const FIXTURES = new URL('../fixtures/plan-bundles/aq-cont-1/', import.meta.url);

function git(args: readonly string[], cwd: string): void {
  execFileSync('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
    stdio: 'ignore',
  });
}

test('registers a repository, delegates a work item, follows the run, and reads the diff', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const repository = mkdtempSync(join(tmpdir(), 'craftingtable-e2e-repo-'));
  try {
    git(['init', '--initial-branch=main', '.'], repository);
    writeFileSync(join(repository, 'README.md'), '# e2e fixture\n');
    git(['add', '--all'], repository);
    git(['commit', '--no-gpg-sign', '-m', 'initial'], repository);

    await page.goto('/');
    await page.getByLabel('Username').fill('e2e-admin');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('status')).toHaveText('Live');

    // A plan so there is a work item to delegate.
    await page.getByRole('link', { name: 'Import plan' }).click();
    await page.getByLabel('Project name').fill('ActionQueue');
    await page
      .getByLabel('Implementation plan')
      .setInputFiles(new URL('aq-cont-1-implementation-plan.md', FIXTURES).pathname);
    await page
      .getByLabel('Work breakdown')
      .setInputFiles(new URL('aq-cont-1-work-breakdown.yaml', FIXTURES).pathname);
    await page.getByRole('button', { name: 'Import plan bundle' }).click();
    await expect(page.getByRole('heading', { name: /Work items \(14\)/ })).toBeVisible();

    // Register the fixture repository.
    await page.getByRole('link', { name: 'Repositories' }).click();
    await expect(page.getByText('/usr/bin/git')).toBeVisible();
    await expect(page.getByText('Claude Code', { exact: true })).toBeVisible();
    await expect(page.getByText('Codex', { exact: true })).toBeVisible();
    await page.getByLabel('Absolute path to the checkout').fill(repository);
    await page.getByLabel('Display name (optional)').fill('fixture');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByRole('heading', { name: 'Registered (1)' })).toBeVisible();
    await expect(page.getByText(repository)).toBeVisible();

    // Open AQ-01, admit it, and create a worktree.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByRole('button', { name: 'ActionQueue', exact: true }).click();
    await page.getByRole('button', { name: 'AQ-01' }).click();
    await expect(page.getByRole('heading', { name: /AQ-01 ·/ })).toBeVisible();
    await page.getByRole('button', { name: 'Admit into agenda' }).click();
    await expect(page.getByText('In agenda', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Delegation', exact: true })
        .getByText(/^ct\/aq-01-[0-9a-f]{8}$/)
        .first(),
    ).toBeVisible();

    // The item is now in progress. Launch the agent and follow it live.
    await expect(page.getByText('In progress', { exact: true })).toBeVisible();
    await page.getByLabel(/Instructions for this run/).fill('e2e smoke run');
    await page.getByRole('button', { name: /Launch implement run/ }).click();
    await expect(page.getByRole('heading', { name: /Implement run/ })).toBeVisible();
    const feed = page.getByTestId('run-feed');
    await expect(feed.getByText('fake agent finished turn 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    await expect(feed.getByText('Write: /').first()).toBeVisible();
    // The model the backend reported, and a subscription cost shown as an estimate.
    await expect(page.getByText('fake-model').first()).toBeVisible();
    await expect(page.getByText(/≈\$0\.01 \(est\.\)/).first()).toBeVisible();
    // Filtering hides tool traffic without touching the daemon.
    await page.getByRole('button', { name: /^Tools/ }).click();
    await expect(feed.getByText('Write: /')).toHaveCount(0);
    await page.getByRole('button', { name: /^Tools/ }).click();

    // Steer it with a follow-up message.
    await page.getByLabel('Message to the agent').fill('one more turn please');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(feed.getByText('fake agent finished turn 2', { exact: true })).toBeVisible();
    await expect(feed.getByText('one more turn please').first()).toBeVisible();

    // The diff shows the files the agent wrote, then end the session.
    await page.getByRole('button', { name: 'View diff' }).click();
    await expect(page.getByRole('heading', { name: /Diff for ct\/aq-01/ })).toBeVisible();
    await expect(page.getByText('SMOKE-1.md').first()).toBeVisible();
    await expect(page.getByText('SMOKE-2.md').first()).toBeVisible();
    await expect(page.getByTestId('diff-text')).toContainText('+turn 1: # Work item AQ-01');

    await page.getByRole('button', { name: 'End session' }).click();
    await page.getByRole('button', { name: /^System/ }).click();
    await expect(feed.getByText('Run finished')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);

    // Back on the work item the run is recorded as finished, and it survives a reload.
    await page.getByRole('button', { name: 'Work item' }).click();
    await expect(page.getByRole('table', { name: 'Agent runs' })).toContainText('Finished');
    await page.reload();
    await expect(page.getByRole('table', { name: 'Agent runs' })).toContainText('Finished');

    // No merge without a review.
    await expect(page.getByText('Needs a review run')).toBeVisible();
    await expect(page.getByRole('button', { name: /Merge into/ })).toHaveCount(0);

    // A finished implement run hands off to a review through the inline form; the
    // review returns a mergeable verdict and opens the gate.
    const launchForm = page.getByRole('form', { name: 'Launch an agent' });
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page
      .getByRole('form', { name: 'Review with' })
      .getByRole('button', { name: 'Launch' })
      .click();
    await expect(page.getByRole('heading', { name: /Review run/ })).toBeVisible();
    await expect(page.getByText('Mergeable').first()).toBeVisible();
    await page.getByRole('button', { name: 'End session' }).click();
    await page.getByRole('button', { name: 'Work item' }).click();
    await expect(page.getByText('Reviewed and mergeable')).toBeVisible();

    // A review with a verdict can be handed straight to a remediation run.
    await expect(page.getByRole('button', { name: 'Remediate' })).toBeVisible();

    // Cross-agent review and remediation: findings return to the Claude implementer.
    await launchForm.getByRole('combobox', { name: /^Agent/ }).selectOption('codex');
    await launchForm.getByLabel('Role').selectOption('review');
    await launchForm.getByLabel(/Instructions for this run/).fill('VERDICT-CHANGES');
    await page.getByRole('button', { name: /Launch review run/ }).click();
    await expect(feed.getByText(/fake Codex review turn 1/).first()).toBeVisible();
    await expect(feed.getByText(/Run: git status --short/)).toBeVisible();
    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    // Remediate opens a handoff form pre-filled from the implement profile; with no
    // profile stored it follows the previous implementer, Claude Code.
    await page.getByRole('button', { name: 'Remediate' }).click();
    const remediateForm = page.getByRole('form', { name: 'Remediate with' });
    await expect(remediateForm.getByRole('combobox', { name: /^Agent/ })).toHaveValue(
      'claude-code',
    );
    await remediateForm
      .getByLabel(/Instructions for this run/)
      .fill('Address finding 1 only; leave the nits.');
    await remediateForm.getByRole('button', { name: 'Launch' }).click();
    await expect(page.getByRole('heading', { name: /Implement run/ })).toBeVisible();
    await expect(page.getByText('Claude Code', { exact: false }).first()).toBeVisible();
    // The guidance reaches the agent as operator instructions in its brief.
    const summary = page.getByRole('group', { name: 'Run summary' });
    await summary.locator('summary').click();
    await summary.getByRole('button', { name: 'Show brief' }).click();
    await expect(page.getByTestId('run-brief')).toContainText(
      'Address finding 1 only; leave the nits.',
    );
    await summary.locator('summary').click();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    await page.getByRole('button', { name: 'End session' }).click();
    await page.getByRole('button', { name: 'Work item' }).click();
    await launchForm.getByRole('combobox', { name: /^Agent/ }).selectOption('codex');
    await launchForm.getByLabel('Role').selectOption('review');
    await page.getByRole('button', { name: /Launch review run/ }).click();
    await expect(page.getByRole('heading', { name: /Review run/ })).toBeVisible();
    await expect(feed.getByText(/^fake Codex review turn 1/).first()).toContainText(
      'VERDICT: mergeable',
    );
    await page.getByRole('button', { name: 'End session' }).click();
    await page.getByRole('button', { name: 'Work item' }).click();
    await expect(page.getByText('Reviewed and mergeable')).toBeVisible();

    // Merge lands the branch on main, removes the worktree, and completes the item.
    await page.getByRole('button', { name: 'Merge…' }).click();
    const mergeForm = page.getByRole('form', { name: 'Merge target' });
    await expect(mergeForm.getByLabel('Merge into')).toHaveValue('main');
    await mergeForm.getByRole('button', { name: 'Merge' }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/merged as [0-9a-f]{10}/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Merge into/ })).toHaveCount(0);
    expect(
      execFileSync('git', ['log', '--oneline', '-5'], { cwd: repository, encoding: 'utf8' }),
    ).toContain('fake agent turn 1');
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }),
    ).toBe('');

    // The dashboard counts the completion and lists the finished runs.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page
      .getByRole('button', { name: /Completed/ })
      .first()
      .click();
    await expect(page.getByRole('button', { name: 'AQ-01', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Runs' }).click();
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(page.getByText(/Review · AQ-01/).first()).toBeVisible();

    // A second item uses Codex for implementation and resumes for a follow-up.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByRole('button', { name: 'ActionQueue', exact: true }).click();
    await page.getByRole('button', { name: 'AQ-02', exact: true }).click();
    await page.getByRole('button', { name: 'Admit into agenda' }).click();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
    await launchForm.getByRole('combobox', { name: /^Agent/ }).selectOption('codex');
    await page.getByRole('button', { name: /Launch implement run/ }).click();
    await expect(feed.getByText('fake Codex finished turn 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    await page.getByLabel('Message to the agent').fill('one more Codex turn');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(feed.getByText('fake Codex finished turn 2', { exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    await page.getByRole('button', { name: 'View diff' }).click();
    await expect(page.getByText('SMOKE-2.md').first()).toBeVisible();
    await expect(page.getByTestId('diff-text')).toContainText('+Codex turn 2: one more Codex turn');
    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);

    // Agent profiles: a stored implement profile pre-fills the launch form for that role.
    await page.getByRole('link', { name: 'Settings' }).click();
    const profiles = page.getByRole('region', { name: 'Agent profiles' });
    const implementProfile = profiles.getByRole('group', { name: 'Implement' });
    await implementProfile.getByRole('combobox', { name: /^Agent/ }).selectOption('codex');
    await implementProfile.getByLabel('Permissions').selectOption('edit-only');
    await profiles.getByRole('button', { name: 'Save profiles' }).click();
    await expect(profiles.getByRole('status')).toHaveText('Profiles saved.');
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByRole('button', { name: 'ActionQueue', exact: true }).click();
    await page.getByRole('button', { name: 'AQ-02', exact: true }).click();
    await expect(launchForm.getByRole('combobox', { name: /^Agent/ })).toHaveValue('codex');
    await expect(launchForm.getByLabel('Permissions')).toHaveValue('edit-only');
    await launchForm.getByLabel('Role').selectOption('review');
    await expect(launchForm.getByRole('combobox', { name: /^Agent/ })).toHaveValue('claude-code');

    // The same admitted, unblocked item can now run the complete cycle from the browser.
    const cyclePanel = page.getByRole('region', { name: 'Automated cycle', exact: true });
    await cyclePanel.getByText('Set up a cycle').click();
    for (const step of ['Design', 'Implement', 'Review', 'Remediate']) {
      await cyclePanel
        .getByRole('group', { name: step, exact: true })
        .getByRole('combobox', { name: 'Agent', exact: true })
        .selectOption('claude-code');
    }
    await expect(cyclePanel.getByLabel('Allowed nits')).toHaveValue('3');
    await cyclePanel.getByLabel('Allowed nits').fill('0');
    await cyclePanel.screenshot({ path: testInfo.outputPath('cycle-settings.png') });
    const beforeCycle = execFileSync('git', ['rev-parse', 'main'], {
      cwd: repository,
      encoding: 'utf8',
    });
    await cyclePanel.getByRole('button', { name: 'Start automated cycle' }).click();
    await expect(cyclePanel.getByText('Awaiting merge approval', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(execFileSync('git', ['rev-parse', 'main'], { cwd: repository, encoding: 'utf8' })).toBe(
      beforeCycle,
    );
    await page.reload();
    await expect(cyclePanel.getByText('Awaiting merge approval', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Cycles needing attention' })).toContainText(
      'AQ-02: Awaiting merge approval',
    );
    await cyclePanel.screenshot({ path: testInfo.outputPath('cycle-approval.png') });
    await page.getByRole('button', { name: 'Merge…' }).click();
    await page
      .getByRole('form', { name: 'Merge target' })
      .getByRole('button', { name: 'Merge', exact: true })
      .click();
    await expect(cyclePanel.getByText(/Previous cycle: Completed/)).toBeVisible();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
