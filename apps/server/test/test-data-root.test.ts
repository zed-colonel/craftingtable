import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { confinedCheckArguments } from '@craftingtable/agents';
import { afterEach, expect, inject, it } from 'vitest';
import {
  migratedTemplate,
  migrationLedger,
  templateLedger,
} from '../../../packages/storage/test/template-test-support.js';
import { configFromEnv } from '../src/config.js';
import { e2eEnvironment } from './e2e/e2e-environment.js';
import { TEST_DAEMON_RESERVE_GIB } from './e2e/test-daemon-storage.js';
import { chooseTestDataRoot } from './e2e/test-data-root.js';
import { createTestContext, type TestContext, testDataRoot } from './test-support.js';

const roots: string[] = [];
const contexts: TestContext[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.cleanup();
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it('chooses CRAFTINGTABLE_TEST_DATA_ROOT over the runtime tmpfs, and refuses one it cannot use (R-I2)', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ct-runtime-'));
  const chosen = mkdtempSync(join(tmpdir(), 'ct-test-data-'));
  roots.push(runtime, chosen);
  const warnings: string[] = [];
  const choose = (env: NodeJS.ProcessEnv) => chooseTestDataRoot(env, (m) => warnings.push(m));
  expect(choose({ CRAFTINGTABLE_TEST_DATA_ROOT: chosen, XDG_RUNTIME_DIR: runtime })).toBe(chosen);
  // Written with a trailing slash, it is the same root (R-I2 review L3).
  expect(choose({ CRAFTINGTABLE_TEST_DATA_ROOT: `${chosen}/` })).toBe(chosen);
  expect(warnings).toEqual([]);
  // The operator named it, so a root it cannot use stops the run rather than moving elsewhere.
  writeFileSync(join(chosen, 'file'), '');
  // A file this user may execute: only the directory check refuses it (review L4).
  writeFileSync(join(chosen, 'program'), '', { mode: 0o700 });
  for (const unusable of [
    'relative/root',
    join(chosen, 'absent'),
    join(chosen, 'file'),
    join(chosen, 'program'),
  ])
    expect(() =>
      choose({ CRAFTINGTABLE_TEST_DATA_ROOT: unusable, XDG_RUNTIME_DIR: runtime }),
    ).toThrow(
      `CRAFTINGTABLE_TEST_DATA_ROOT (${unusable}) is not an absolute directory this user can write`,
    );
  // Not writable; root may write anyway, so this holds only for other users.
  const readOnly = join(chosen, 'read-only');
  mkdirSync(readOnly, { mode: 0o500 });
  if (process.getuid?.() !== 0)
    expect(() => choose({ CRAFTINGTABLE_TEST_DATA_ROOT: readOnly })).toThrow(
      'is not an absolute directory this user can write',
    );
  expect(warnings).toEqual([]);
});

it('refuses a test data root at, inside or above a daemon data directory, through links too (R-I2)', () => {
  const host = mkdtempSync(join(tmpdir(), 'ct-test-data-host-'));
  roots.push(host);
  const live = join(host, 'craftingtable');
  const sibling = join(host, 'craftingtable-test');
  mkdirSync(join(live, 'state'), { recursive: true });
  mkdirSync(sibling);
  // The default data directory is a link to the disk, as on the operator's workstation.
  const share = join(host, 'share');
  mkdirSync(share);
  symlinkSync(live, join(share, 'craftingtable'));
  symlinkSync(join(live, 'state'), join(host, 'state-link'));
  const choose = (root: string, env: NodeJS.ProcessEnv = { XDG_DATA_HOME: share }) =>
    chooseTestDataRoot({ ...env, CRAFTINGTABLE_TEST_DATA_ROOT: root }, () => {});
  expect(choose(sibling)).toBe(sibling);
  // A name inside the data directory that starts with two dots is inside it (review L1).
  mkdirSync(join(live, '..inner'));
  for (const overlapping of [
    live,
    join(live, 'state'),
    join(live, '..inner'),
    host,
    join(host, 'state-link'),
  ])
    expect(() => choose(overlapping)).toThrow(
      `CRAFTINGTABLE_TEST_DATA_ROOT (${overlapping}) overlaps the daemon data directory ${join(share, 'craftingtable')}`,
    );
  // A data directory named by CRAFTINGTABLE_DATA_DIR is the one compared.
  expect(() => choose(join(live, 'state'), { CRAFTINGTABLE_DATA_DIR: live })).toThrow(
    `overlaps the daemon data directory ${live}`,
  );
  expect(choose(join(live, 'state'), { CRAFTINGTABLE_DATA_DIR: sibling + '-other' })).toBe(
    join(live, 'state'),
  );
  // A data directory that is a link to a directory not made yet is followed to it (review L1):
  // a root that would hold it is refused.
  const later = join(host, 'later');
  mkdirSync(later);
  const pending = join(host, 'pending-share');
  mkdirSync(pending);
  symlinkSync(join(later, 'craftingtable'), join(pending, 'craftingtable'));
  expect(() => choose(later, { XDG_DATA_HOME: pending })).toThrow(
    'overlaps the daemon data directory',
  );
});

it('falls back to XDG_RUNTIME_DIR without CRAFTINGTABLE_TEST_DATA_ROOT, and says so (TS-H8, R-I2)', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ct-runtime-'));
  roots.push(runtime);
  const warnings: string[] = [];
  const choose = (env: NodeJS.ProcessEnv) => chooseTestDataRoot(env, (m) => warnings.push(m));
  expect(choose({ XDG_RUNTIME_DIR: runtime })).toBe(runtime);
  expect(choose({ CRAFTINGTABLE_TEST_DATA_ROOT: '', XDG_RUNTIME_DIR: runtime })).toBe(runtime);
  // Anything else falls back to the temporary directory, with one warning each time.
  expect(choose({})).toBe(tmpdir());
  expect(choose({ XDG_RUNTIME_DIR: 'relative/run' })).toBe(tmpdir());
  expect(choose({ XDG_RUNTIME_DIR: join(runtime, 'absent') })).toBe(tmpdir());
  writeFileSync(join(runtime, 'file'), '');
  expect(choose({ XDG_RUNTIME_DIR: join(runtime, 'file') })).toBe(tmpdir());
  expect(warnings).toHaveLength(6);
  for (const warning of warnings)
    expect(warning).toContain('CRAFTINGTABLE_TEST_DATA_ROOT is not set');
  expect(warnings[0]).toContain(`go to ${runtime}`);
  expect(warnings[2]).toContain('XDG_RUNTIME_DIR is not set');
  expect(warnings[3]).toContain('relative/run');
  // Not writable; root may write anyway, so this holds only for other users.
  chmodSync(runtime, 0o500);
  if (process.getuid?.() !== 0) expect(choose({ XDG_RUNTIME_DIR: runtime })).toBe(tmpdir());
});

it("keeps this run's test daemons in the root chosen for the run, with the test reserve (TS-H8, R-I2)", async () => {
  // Decided once by vitest.config.ts, so it cannot change during the run; the global setup
  // gives the run a directory of its own beneath it, named by its process (R-I2 review).
  expect(dirname(testDataRoot())).toBe(chooseTestDataRoot(process.env, () => {}));
  expect(basename(testDataRoot())).toMatch(/^ct-run-\d+-\d+-/);
  const context = await createTestContext();
  contexts.push(context);
  expect(dirname(context.directory)).toBe(testDataRoot());
  expect(context.config.databasePath.startsWith(`${context.directory}/`)).toBe(true);
  // The production 5 GiB reserve would refuse launches on a small root.
  expect(context.storage.maintenance.settings()?.policy.minimumFreeGiB).toBe(
    TEST_DAEMON_RESERVE_GIB,
  );
});

const userManager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
}).stdout?.trim();

/**
 * Runs `script` in a confined check unit, as the e2e daemon's check service would for a check
 * in `worktree`: the worktree and the run directory writable, its agents' roots hidden.
 */
function confinedCheck(worktree: string, runDirectory: string, script: string) {
  const unit = `craftingtable-check-test-root-${process.pid}-${Date.now()}`;
  return spawnSync(
    'systemd-run',
    confinedCheckArguments(
      unit,
      worktree,
      60,
      [worktree, runDirectory],
      { PATH: '/usr/bin:/bin' },
      ['/bin/sh', '-c', script],
    ),
    { encoding: 'utf8' },
  );
}

it.skipIf(!['running', 'degraded'].includes(userManager ?? ''))(
  "a confined check sees an e2e daemon's worktree under the chosen root, and would not on the runtime tmpfs (R-I2)",
  () => {
    const root = testDataRoot();
    const daemonData = (parent: string) => {
      const directory = mkdtempSync(join(parent, 'craftingtable-e2e-'));
      roots.push(directory);
      const config = configFromEnv({
        ...e2eEnvironment(directory, {}),
        CRAFTINGTABLE_AGENT_TMP_ROOT: '/tmp/cte-root-test',
      });
      const worktree = join(config.execution.worktreeRoot, 'w1');
      const runDirectory = join(config.execution.runsRoot, 'r1');
      mkdirSync(worktree, { recursive: true });
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(join(worktree, 'marker'), 'seen');
      return { worktree, runDirectory };
    };
    const script = 'cat marker && echo written > result';
    const e2e = daemonData(root);
    const checked = confinedCheck(e2e.worktree, e2e.runDirectory, script);
    // Without CRAFTINGTABLE_TEST_DATA_ROOT the root is the runtime tmpfs, and this fails with
    // systemd's 200 (the unit could not enter its working directory).
    expect(
      checked.status,
      `${root}: ${checked.stdout}${checked.stderr} (on the runtime tmpfs? set CRAFTINGTABLE_TEST_DATA_ROOT to a disk directory)`,
    ).toBe(0);
    expect(checked.stdout).toContain('seen');
    expect(readFileSync(join(e2e.worktree, 'result'), 'utf8')).toBe('written\n');
    // Why the root left the tmpfs: a confined unit gets an empty, read-only runtime directory.
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) {
      const hidden = daemonData(runtime);
      const refused = confinedCheck(hidden.worktree, hidden.runDirectory, script);
      expect(refused.status).not.toBe(0);
      expect(existsSync(join(hidden.worktree, 'result'))).toBe(false);
    }
  },
);

it("starts each test daemon from a copy of the run's migrated template, with the test reserve (TS-M13)", async () => {
  const context = await createTestContext();
  contexts.push(context);
  // A migration of its own would stamp every row with the time it ran.
  expect(migrationLedger(context.config.databasePath)).toEqual(
    templateLedger(migratedTemplate(inject('testTemplateDirectory'))),
  );
  // The template holds no settings, so the daemon's first boot still saved the test reserve.
  expect(context.storage.maintenance.settings()?.policy.minimumFreeGiB).toBe(
    TEST_DAEMON_RESERVE_GIB,
  );
});

it("passes the configuration's root refusals for test daemons under the chosen root (TS-H3, R-I2)", () => {
  const root = testDataRoot();
  const data = mkdtempSync(join(root, 'craftingtable-config-'));
  roots.push(data);
  // A vitest daemon: the default agents' root inside its data directory.
  expect(configFromEnv({ CRAFTINGTABLE_DATA_DIR: data }).execution.agentTemporaryRoot).toBe(
    join(data, 't'),
  );
  // The e2e daemon: its agents' root in /tmp, beside a data directory under the chosen root.
  expect(
    configFromEnv({ ...e2eEnvironment(data, {}), CRAFTINGTABLE_AGENT_TMP_ROOT: '/tmp/cte-config' })
      .execution.agentTemporaryRoot,
  ).toBe('/tmp/cte-config');
  // An agents' root of its own beside them, under the chosen root.
  const own = join(root, 'cta-config');
  expect(
    configFromEnv({ CRAFTINGTABLE_DATA_DIR: data, CRAFTINGTABLE_AGENT_TMP_ROOT: own }).execution
      .agentTemporaryRoot,
  ).toBe(own);
});
