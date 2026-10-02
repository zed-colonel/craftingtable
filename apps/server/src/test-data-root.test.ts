import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TEST_DATA_MIN_FREE_BYTES, testDataRoot } from './test-data-root.js';
import { createTestContext, type TestContext } from './test-support.js';

const roots: string[] = [];
const contexts: TestContext[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.cleanup();
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it('puts test data directories in XDG_RUNTIME_DIR when it is a writable directory (TS-H8)', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ct-runtime-'));
  roots.push(runtime);
  const plenty = () => TEST_DATA_MIN_FREE_BYTES;
  expect(testDataRoot({ XDG_RUNTIME_DIR: runtime }, plenty)).toBe(runtime);
  // Too little free space for a daemon to launch runs above its reserve.
  expect(testDataRoot({ XDG_RUNTIME_DIR: runtime }, () => TEST_DATA_MIN_FREE_BYTES - 1)).toBe(
    tmpdir(),
  );
  // Anything else falls back to the temporary directory.
  expect(testDataRoot({})).toBe(tmpdir());
  expect(testDataRoot({ XDG_RUNTIME_DIR: 'relative/run' })).toBe(tmpdir());
  expect(testDataRoot({ XDG_RUNTIME_DIR: join(runtime, 'absent') }, plenty)).toBe(tmpdir());
  writeFileSync(join(runtime, 'file'), '');
  expect(testDataRoot({ XDG_RUNTIME_DIR: join(runtime, 'file') }, plenty)).toBe(tmpdir());
  // Not writable; root may write anyway, so this holds only for other users.
  chmodSync(runtime, 0o500);
  if (process.getuid?.() !== 0)
    expect(testDataRoot({ XDG_RUNTIME_DIR: runtime }, plenty)).toBe(tmpdir());
});

it('gives a test daemon its data directory under the test data root (TS-H8)', async () => {
  const context = await createTestContext();
  contexts.push(context);
  expect(dirname(context.directory)).toBe(testDataRoot());
  expect(context.config.databasePath.startsWith(`${context.directory}/`)).toBe(true);
});
