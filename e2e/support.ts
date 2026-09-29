import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

/**
 * Helpers shared by the browser specs (R-I5, QA-05). The e2e daemon bootstraps this admin
 * (`apps/server/src/e2e-entry.ts`).
 */
export const E2E_USERNAME = 'e2e-admin';
export const E2E_PASSWORD = 'correct horse battery staple';

/** Fills in and submits the sign-in form on the current page. */
export async function submitSignIn(page: Page, password = E2E_PASSWORD): Promise<void> {
  await page.getByLabel('Username').fill(E2E_USERNAME);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Opens the app, signs in as the e2e admin and waits for the default workspace. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await submitSignIn(page);
  await expect(page.getByRole('heading', { name: 'Default workspace', exact: true })).toBeVisible();
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

/** Runs Git in a fixture repository with no user or system configuration; returns trimmed stdout. */
export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

/**
 * From the Roadmaps list, opens a roadmap by name on one of its pages (R-E2). A finished
 * roadmap is listed under History, which starts closed.
 */
export async function openRoadmap(
  page: Page,
  name: string,
  tab: 'Board' | 'Setup' | 'History' = 'Board',
): Promise<void> {
  const active = page.getByRole('region', { name: 'Active roadmaps', exact: true });
  const finished = page.getByRole('region', { name: 'Finished roadmaps', exact: true });
  await expect(active.or(finished).first()).toBeVisible();
  const link = page.getByRole('link', { name, exact: true });
  if (!(await link.isVisible())) await finished.getByText('History', { exact: true }).click();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  if (tab !== 'Board')
    await page
      .getByRole('navigation', { name: 'Roadmap pages', exact: true })
      .getByRole('link', { name: tab, exact: true })
      .click();
}
