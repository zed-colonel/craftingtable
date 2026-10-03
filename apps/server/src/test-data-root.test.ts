import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, inject, it } from 'vitest';
import { migratedTemplate, migrationLedger } from '../../../packages/storage/src/test-template.js';
import { TEST_DAEMON_RESERVE_GIB } from './test-daemon-storage.js';
import { chooseTestDataRoot } from './test-data-root.js';
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

it('chooses XDG_RUNTIME_DIR when it is a writable directory, and says when it falls back (TS-H8)', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ct-runtime-'));
  roots.push(runtime);
  const warnings: string[] = [];
  const choose = (env: NodeJS.ProcessEnv) => chooseTestDataRoot(env, (m) => warnings.push(m));
  expect(choose({ XDG_RUNTIME_DIR: runtime })).toBe(runtime);
  expect(warnings).toEqual([]);
  // Anything else falls back to the temporary directory, with one warning each time.
  expect(choose({})).toBe(tmpdir());
  expect(choose({ XDG_RUNTIME_DIR: 'relative/run' })).toBe(tmpdir());
  expect(choose({ XDG_RUNTIME_DIR: join(runtime, 'absent') })).toBe(tmpdir());
  writeFileSync(join(runtime, 'file'), '');
  expect(choose({ XDG_RUNTIME_DIR: join(runtime, 'file') })).toBe(tmpdir());
  expect(warnings).toHaveLength(4);
  expect(warnings[0]).toContain('XDG_RUNTIME_DIR is not set');
  expect(warnings[1]).toContain('relative/run');
  // Not writable; root may write anyway, so this holds only for other users.
  chmodSync(runtime, 0o500);
  if (process.getuid?.() !== 0) expect(choose({ XDG_RUNTIME_DIR: runtime })).toBe(tmpdir());
});

it.skipIf(!process.env.XDG_RUNTIME_DIR)(
  "keeps this run's test daemons in XDG_RUNTIME_DIR, with the test reserve (TS-H8)",
  async () => {
    // Decided once by vitest.config.ts, so it cannot change during the run.
    expect(testDataRoot()).toBe(process.env.XDG_RUNTIME_DIR);
    const context = await createTestContext();
    contexts.push(context);
    expect(dirname(context.directory)).toBe(process.env.XDG_RUNTIME_DIR);
    expect(context.config.databasePath.startsWith(`${context.directory}/`)).toBe(true);
    // The production 5 GiB reserve would refuse launches on a small tmpfs.
    expect(context.storage.maintenance.settings()?.policy.minimumFreeGiB).toBe(
      TEST_DAEMON_RESERVE_GIB,
    );
  },
);

it("starts each test daemon from a copy of the run's migrated template, with the test reserve (TS-M13)", async () => {
  // The template is read from a copy: a reader opened in place would add a log beside it.
  const scratch = mkdtempSync(join(testDataRoot(), 'craftingtable-template-test-'));
  roots.push(scratch);
  copyFileSync(migratedTemplate(inject('testTemplateDirectory')), join(scratch, 'template.sqlite'));
  const context = await createTestContext();
  contexts.push(context);
  // A migration of its own would stamp every row with the time it ran.
  expect(migrationLedger(context.config.databasePath)).toEqual(
    migrationLedger(join(scratch, 'template.sqlite')),
  );
  // The template holds no settings, so the daemon's first boot still saved the test reserve.
  expect(context.storage.maintenance.settings()?.policy.minimumFreeGiB).toBe(
    TEST_DAEMON_RESERVE_GIB,
  );
});
