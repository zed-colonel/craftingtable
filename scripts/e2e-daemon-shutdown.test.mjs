import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import config from '../playwright.config.ts';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

const temporary = [];
const running = [];
afterEach(() => {
  for (const child of running.splice(0)) {
    try {
      // The group, not only the shell: a daemon may outlive its wrapper.
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group has already gone.
    }
  }
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the e2e daemon exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the e2e daemon did not become healthy');
}

/** Playwright waits for `close`, after the whole command has exited. */
function closed(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });
}

// `e2e:start` runs the daemon through tsx, which resolves the workspace packages from their
// build output: `pnpm check` builds before it tests; a bare `pnpm test` on a fresh checkout
// skips this until `tsc -b` has run.
const built = existsSync(new URL('../packages/domain/dist/index.js', import.meta.url));

// Playwright stops a web server by killing its process group: with SIGKILL unless the config
// asks for a graceful signal. The e2e daemon keeps its database in a temporary directory that
// only its signal handlers remove, so a SIGKILL left 72 MB behind on every run (2026-09-28:
// 202 directories, 7.5 GB of the user's /tmp quota, which then crashed headless Chrome).
it.skipIf(!built)('the e2e daemon leaves no data directory when Playwright stops it', async () => {
  const daemon = config.webServer.find((server) => server.command.includes('e2e-entry'));
  expect(daemon).toBeDefined();
  const scratch = mkdtempSync(join(tmpdir(), 'craftingtable-e2e-shutdown-'));
  temporary.push(scratch);
  const port = await freePort();
  // Started as Playwright starts it: through a shell, in its own process group.
  const child = spawn(daemon.command, {
    cwd: daemon.cwd ?? REPOSITORY_ROOT,
    shell: true,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...daemon.env,
      CRAFTINGTABLE_PORT: String(port),
      TMPDIR: scratch,
      // The data directory goes on the runtime tmpfs when there is one (TS-H8).
      XDG_RUNTIME_DIR: scratch,
    },
  });
  running.push(child);
  await waitForHealth(`http://127.0.0.1:${port}/api/health`, child, Date.now() + 45_000);
  expect(readdirSync(scratch).filter((name) => name.startsWith('craftingtable-e2e-'))).toHaveLength(
    1,
  );

  const graceful = daemon.gracefulShutdown;
  process.kill(-child.pid, graceful?.signal ?? 'SIGKILL');
  if (graceful) {
    const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), graceful.timeout);
    await closed(child);
    clearTimeout(timer);
  } else {
    await closed(child);
  }
  // The daemon's own children leave with the group; give the file system a moment.
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(readdirSync(scratch).filter((name) => name.startsWith('craftingtable-e2e-'))).toEqual([]);
});
