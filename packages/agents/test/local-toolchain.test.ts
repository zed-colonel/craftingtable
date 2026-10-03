import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { observeRustToolchain } from '../src/local-toolchain.js';
import { testTimeScale } from './test-time.js';
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function executable(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-observe-'));
  directories.push(dir);
  const path = join(dir, 'tool');
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
  return { dir, path };
}
it('observes bounded version commands without enabling toolchain installation', async () => {
  const { dir, path } = executable(
    `console.log(JSON.stringify({args:process.argv.slice(2),install:process.env.RUSTUP_AUTO_INSTALL}));`,
  );
  const output = await observeRustToolchain({ cargo: path, rustc: path }, dir);
  expect(JSON.parse(output.cargo)).toEqual({ args: ['--version', '--verbose'], install: '0' });
  expect(output.rustc).toBe(output.cargo);
});
it('does not return a successful fingerprint for a failing or oversized probe', async () => {
  const failed = executable('console.log("version"); process.exitCode=1;');
  await expect(
    observeRustToolchain({ cargo: failed.path, rustc: failed.path }, failed.dir),
  ).rejects.toThrow('Could not observe');
  const oversized = executable('console.log("x".repeat(20000));');
  await expect(
    observeRustToolchain({ cargo: oversized.path, rustc: oversized.path }, oversized.dir),
  ).rejects.toThrow('Could not observe');
});
it('terminates a hung observation within its bounded deadline', async () => {
  const { dir, path } = executable('setInterval(()=>{},1000);');
  const started = Date.now();
  await expect(observeRustToolchain({ cargo: path, rustc: path }, dir)).rejects.toThrow(
    'Could not observe',
  );
  // A genuine bound, scaled (R-I2): the observation's own 5 s deadline, with room for load. It
  // fails if that deadline is raised or lost.
  expect(Date.now() - started).toBeLessThan(10_000 * testTimeScale());
});
