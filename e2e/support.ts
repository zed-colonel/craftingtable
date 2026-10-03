import { execFileSync } from 'node:child_process';
import {
  type BrowserContext,
  test as base,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';

/** A failure a spec causes on purpose, such as a refused sign-in or a request it aborts. */
export interface ExpectedFailure {
  readonly method: string;
  /** The request's path without its query, or a pattern for one that names a record. */
  readonly path: string | RegExp;
  /** The answer's status, or `'dropped'` for a request that got no answer. */
  readonly status: number | 'dropped';
}

const SESSION = '/api/auth/session';
const LOGIN = '/api/auth/login';
const LOGOUT = '/api/auth/logout';

/**
 * Where a browser context stands with the daemon. It starts signed out; a logout begins when
 * its request is sent, so reads already under way may be refused before its answer arrives.
 */
type SessionState = 'signed-out' | 'signed-in' | 'logged-out';

/** How many of a document's fetches have no answer yet: `countFetches` keeps it. */
interface FetchCount {
  e2eFetchesInFlight?: number;
}

/**
 * In every document of a watched context, before its own scripts: counts the fetches it has
 * sent that have no answer yet, so `settle` can wait for them. The count lives in the
 * document, so a navigation, which abandons the old document's fetches without a network
 * event, starts it again at zero. The event streams are not fetches and are not counted.
 */
const countFetches = (): void => {
  const count = window as FetchCount;
  count.e2eFetchesInFlight = 0;
  const send = window.fetch.bind(window);
  window.fetch = (...args: Parameters<typeof fetch>) => {
    count.e2eFetchesInFlight = (count.e2eFetchesInFlight ?? 0) + 1;
    return send(...args).finally(() => {
      count.e2eFetchesInFlight = (count.e2eFetchesInFlight ?? 1) - 1;
    });
  };
};

/**
 * In the page: resolves after three animation frames and then a macrotask, so work queued by
 * the last answers and events (a render, an effect, a short timer) has run. A hidden page
 * draws no frames, so it waits for the macrotask alone.
 */
const nextFrames = (): Promise<void> =>
  new Promise<void>((resolve) => {
    let frames = 3;
    const step = (): void => {
      frames -= 1;
      if (frames === 0) setTimeout(resolve, 0);
      else requestAnimationFrame(step);
    };
    if (document.visibilityState === 'visible') requestAnimationFrame(step);
    else setTimeout(resolve, 0);
  });

/**
 * Fails a spec on what the browser reports as an error on any page it watches (TS-M15,
 * E2E F6): an uncaught exception (`pageerror`; React reports a render error it cannot recover
 * from this way, since the app has no error boundary), a `console.error` or failed
 * `console.assert`, an HTTP answer of 400 or more, or a request that got no answer, unless
 * the spec declared it with `expectFailure`.
 *
 * Some failures need no declaration, each for its reason:
 * - `GET /api/auth/session` answered 401 while the context is signed out: a page opened then
 *   asks the daemon for its session, and that answer is how the app knows to show the sign-in
 *   page. Once a sign-in succeeds, a 401 there is a lost session, and an error.
 * - Any 401 once the context has sent a logout, until it signs in again: reads under way when
 *   the session ended, and the signed-out page's own session probe.
 * - A request Chrome cancelled (`net::ERR_ABORTED`): a navigation, reload or closing page
 *   leaves reads and the event stream behind. Whatever the page should have shown, the spec
 *   asserts.
 *
 * Chrome also logs a console error of its own, with no arguments, for each failed load. It is
 * judged by its request's status or Chrome's error code, never by the log's text.
 */
export class BrowserErrors {
  private readonly errors: string[] = [];
  private readonly loadLogs: { readonly where: string; readonly url: string }[] = [];
  private readonly failedUrls = new Set<string>();
  private readonly expected: ExpectedFailure[] = [];
  private readonly sessions = new WeakMap<BrowserContext, SessionState>();
  private readonly pages = new Set<Page>();

  /**
   * Watches every page of `context`, open now or opened later. Call it before the pages
   * load anything: their fetches are counted from the next document on.
   */
  async watch(context: BrowserContext): Promise<void> {
    await context.addInitScript(countFetches);
    for (const page of context.pages()) this.watchPage(page);
    context.on('page', (page) => this.watchPage(page));
  }

  /**
   * Accepts a failure the calling spec causes on purpose, until the returned function is
   * called. End it where the spec stops causing the failure, so a later one is still caught.
   */
  expectFailure(failure: ExpectedFailure): () => void {
    this.expected.push(failure);
    return () => {
      const index = this.expected.indexOf(failure);
      if (index >= 0) this.expected.splice(index, 1);
    };
  }

  private watchPage(page: Page): void {
    this.pages.add(page);
    page.on('pageerror', (error) =>
      this.errors.push(`uncaught on ${page.url()}: ${error.stack ?? error.message}`),
    );
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'assert') return;
      const where = `console.${message.type()} on ${page.url()}: ${message.text()}`;
      // The browser's own log of a failed load names the resource and passes no arguments.
      if (message.args().length === 0 && message.location().url)
        this.loadLogs.push({ where, url: message.location().url });
      else this.errors.push(where);
    });
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === LOGOUT)
        this.sessions.set(page.context(), 'logged-out');
    });
    page.on('requestfailed', (request) => {
      this.failedUrls.add(request.url());
      const code = request.failure()?.errorText;
      if (code !== 'net::ERR_ABORTED')
        this.judge(page, request.method(), request.url(), 'dropped', `got no answer (${code})`);
    });
    page.on('response', (response) => {
      const method = response.request().method();
      const { pathname } = new URL(response.url());
      const status = response.status();
      if (status < 400) {
        if ((method === 'POST' && pathname === LOGIN) || pathname === SESSION)
          this.sessions.set(page.context(), 'signed-in');
        return;
      }
      this.failedUrls.add(response.url());
      const session = this.sessions.get(page.context()) ?? 'signed-out';
      if (status === 401 && session === 'logged-out') return;
      if (status === 401 && session === 'signed-out' && pathname === SESSION) return;
      this.judge(page, method, response.url(), status, `answered ${status}`);
    });
  }

  private judge(
    page: Page,
    method: string,
    url: string,
    status: ExpectedFailure['status'],
    what: string,
  ): void {
    const { pathname } = new URL(url);
    const declared = this.expected.some(
      (failure) =>
        failure.method === method &&
        failure.status === status &&
        (typeof failure.path === 'string'
          ? failure.path === pathname
          : failure.path.test(pathname)),
    );
    if (!declared) this.errors.push(`${method} ${pathname} ${what} on ${page.url()}`);
  }

  /**
   * Lets what the pages started before the test ended finish, so its errors are judged too:
   * every fetch a page's document sent gets its answer (within the suite's one wait), then
   * each open page runs the work those answers queued.
   */
  async settle(): Promise<void> {
    const open = [...this.pages].filter((page) => !page.isClosed());
    for (const page of open)
      await expect
        .poll(() => page.evaluate(() => (window as FetchCount).e2eFetchesInFlight ?? 0), {
          message: `the fetches ${page.url()} sent before the test ended got their answers`,
        })
        .toBe(0);
    await Promise.all(open.map((page) => page.evaluate(nextFrames).catch(() => undefined)));
  }

  /** Fails the test with every error seen so far. */
  expectNone(): void {
    const unexplained = this.loadLogs
      .filter((log) => !this.failedUrls.has(log.url))
      .map((log) => log.where);
    expect([...this.errors, ...unexplained], 'the browser reported errors').toEqual([]);
  }
}

/** Every spec's `test`: it fails on browser errors in its own context's pages. */
export const test = base.extend<{ browserErrors: BrowserErrors }>({
  browserErrors: [
    async ({ context }, use) => {
      const errors = new BrowserErrors();
      await errors.watch(context);
      await use(errors);
      await errors.settle();
      errors.expectNone();
    },
    { auto: true },
  ],
});
export { expect };

/**
 * Helpers shared by the browser specs (R-I5, QA-05). The e2e daemon bootstraps this admin
 * (`apps/server/test/e2e/e2e-entry.ts`).
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
