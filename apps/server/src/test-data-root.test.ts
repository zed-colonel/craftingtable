import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { testDataRoot } from './test-data-root.js';
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
  expect(testDataRoot({ XDG_RUNTIME_DIR: runtime })).toBe(runtime);
  // Anything else falls back to the temporary directory.
  expect(testDataRoot({})).toBe(tmpdir());
  expect(testDataRoot({ XDG_RUNTIME_DIR: 'relative/run' })).toBe(tmpdir());
  expect(testDataRoot({ XDG_RUNTIME_DIR: join(runtime, 'absent') })).toBe(tmpdir());
  writeFileSync(join(runtime, 'file'), '');
  expect(testDataRoot({ XDG_RUNTIME_DIR: join(runtime, 'file') })).toBe(tmpdir());
  chmodSync(runtime, 0o500);
  expect(testDataRoot({ XDG_RUNTIME_DIR: runtime })).toBe(tmpdir());
});

it('gives a test daemon its data directory under the test data root (TS-H8)', async () => {
  const context = await createTestContext();
  contexts.push(context);
  expect(dirname(context.directory)).toBe(testDataRoot());
  expect(context.config.databasePath.startsWith(`${context.directory}/`)).toBe(true);
});
