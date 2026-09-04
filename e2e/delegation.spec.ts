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
}) => {
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
    await page.getByLabel('Absolute path to the checkout').fill(repository);
    await page.getByLabel('Display name (optional)').fill('fixture');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByRole('heading', { name: 'Registered (1)' })).toBeVisible();
    await expect(page.getByText(repository)).toBeVisible();

    // Open AQ-01 and create a worktree.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page
      .getByRole('button', { name: /ActionQueue/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'AQ-01' }).click();
    await expect(page.getByRole('heading', { name: /AQ-01 ·/ })).toBeVisible();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees (1)' })).toBeVisible();
    await expect(page.getByText(/^ct\/aq-01-[0-9a-f]{8}$/).first()).toBeVisible();

    // Launch the agent and follow it live.
    await page.getByLabel(/Instructions for this run/).fill('e2e smoke run');
    await page.getByRole('button', { name: /Launch implement run/ }).click();
    await expect(page.getByRole('heading', { name: /Implement run/ })).toBeVisible();
    await expect(page.getByText('fake agent finished turn 1').first()).toBeVisible();
    await expect(page.getByText('Awaiting your input').first()).toBeVisible();
    await expect(page.getByText('Write: /').first()).toBeVisible();

    // Steer it with a follow-up message.
    await page.getByLabel('Message to the agent').fill('one more turn please');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('fake agent finished turn 2').first()).toBeVisible();
    await expect(page.getByText('one more turn please').first()).toBeVisible();

    // The diff shows the files the agent wrote, then end the session.
    await page.getByRole('button', { name: 'View diff' }).click();
    await expect(page.getByRole('heading', { name: /Diff for ct\/aq-01/ })).toBeVisible();
    await expect(page.getByText('SMOKE-1.md').first()).toBeVisible();
    await expect(page.getByText('SMOKE-2.md').first()).toBeVisible();
    await expect(page.getByTestId('diff-text')).toContainText('+turn 1: # Work item AQ-01');

    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByText('Run finished').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);

    // Back on the work item the run is recorded as finished, and it survives a reload.
    await page.getByRole('button', { name: 'back to work item' }).click();
    await expect(page.getByRole('table', { name: 'Agent runs' })).toContainText('Finished');
    await page.reload();
    await expect(page.getByRole('table', { name: 'Agent runs' })).toContainText('Finished');
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
