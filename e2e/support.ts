import { execFileSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * After signing in, `/` opens the admin's last-used workspace, which another spec may have just
 * created (R-I9), so wait for any workspace page rather than the default one.
 */
export async function expectSignedIn(page: Page): Promise<void> {
  await page.waitForURL(/\/workspaces\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** Opens the app and signs in as the e2e admin. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await submitSignIn(page);
  await expectSignedIn(page);
}

/** Opens an existing workspace by name, such as the bootstrap's Default workspace. */
export async function openWorkspaceNamed(page: Page, name: string): Promise<void> {
  const id = await page.evaluate(async (workspaceName) => {
    const listing = await (await fetch('/api/workspaces')).json();
    return (listing.workspaces as { id: string; name: string }[]).find(
      (w) => w.name === workspaceName,
    )?.id;
  }, name);
  if (!id) throw new Error(`No workspace named ${name}`);
  await page.goto(`/workspaces/${id}`);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

/**
 * Signs in and opens a new workspace for the calling spec (R-I9), so specs do not see each
 * other's plans, roadmaps, runs or notifications and can run in parallel. The request goes from
 * the signed-in page, which carries the session, its CSRF token and the origin. `name` must be
 * unique across the run: include the project name when a spec runs in more than one project.
 */
export async function openOwnWorkspace(page: Page, name: string): Promise<string> {
  await signIn(page);
  const id = await page.evaluate(async (workspaceName) => {
    const session = await (await fetch('/api/auth/session')).json();
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-craftingtable-csrf': session.csrfToken,
      },
      body: JSON.stringify({ name: workspaceName }),
    });
    if (!response.ok) throw new Error(`Creating ${workspaceName}: ${await response.text()}`);
    return (await response.json()).workspace.id as string;
  }, name);
  await page.goto(`/workspaces/${id}`);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  return id;
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
  if (!(await link.isVisible()))
    await finished.getByText('Finished roadmaps', { exact: true }).click();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  if (tab !== 'Board')
    await page
      .getByRole('navigation', { name: 'Roadmap pages', exact: true })
      .getByRole('link', { name: tab, exact: true })
      .click();
}

/** Opens one step of a roadmap's setup or a map's creation flow (R-E2). */
export async function setupStep(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Setup checklist', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
}

/**
 * Clicks a control that sends a command and waits for the daemon's answer. A navigation started
 * right after the click aborts the command's request in the browser, and the command then runs
 * only if its request reached the daemon first (test-suite review TS-H5).
 */
export async function sendCommand(page: Page, control: Locator): Promise<void> {
  const answered = page.waitForResponse(
    (response) => response.url().includes('/api/') && response.request().method() !== 'GET',
  );
  await control.click();
  const response = await answered;
  expect(response.ok(), `${response.url()}: ${await response.text()}`).toBe(true);
}

/**
 * Opens a worktree's merge where it is decided, its inbox item (R-A6): the work item page links
 * there. Returns the merge form; the caller merges and returns to the work item.
 */
export async function openMergeDecision(page: Page): Promise<Locator> {
  await page
    .locator('.worktree-item')
    .getByRole('link', { name: 'Open the decision', exact: true })
    .first()
    .click();
  const decision = page.getByRole('region', { name: 'Decision' });
  await decision.getByRole('button', { name: 'Merge…', exact: true }).click();
  return decision.getByRole('form', { name: 'Merge target' });
}
