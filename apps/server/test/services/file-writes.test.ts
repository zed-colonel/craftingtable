import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileWrites, writingFiles } from '../../src/services/file-writes.js';
import { testDataRoot } from '../test-support.js';

/** A launch's many file writes off the event loop (R-B5 increment 6). */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const directory = mkdtempSync(join(testDataRoot(), 'file-writes-'));
  roots.push(directory);
  return directory;
};

it('writes every file, with its mode and directories, by the time it is settled', async () => {
  const base = root();
  const writes = new FileWrites(3);
  for (let i = 0; i < 40; i++)
    await writes.write(join(base, `d${i % 4}`, 'deep', `f${i}`), `content ${i}`, { mode: 0o600 });
  await writes.settled();
  for (let i = 0; i < 40; i++) {
    const path = join(base, `d${i % 4}`, 'deep', `f${i}`);
    expect(readFileSync(path, 'utf8')).toBe(`content ${i}`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(statSync(join(base, 'd0')).mode & 0o777).toBe(0o700);
});

it('lets the event loop turn between writes, and holds no more than its limit at once', async () => {
  const base = root();
  const writes = new FileWrites(2);
  let turns = 0;
  const tick = () => {
    turns += 1;
    if (turns < 10_000) setImmediate(tick);
  };
  setImmediate(tick);
  for (let i = 0; i < 200; i++) {
    await writes.write(join(base, `f${i}`), 'x'.repeat(4096), { mode: 0o600 });
    expect((writes as unknown as { pending: Set<unknown> }).pending.size).toBeLessThanOrEqual(2);
  }
  await writes.settled();
  // A loop of `writeFileSync` would have let no turn in between.
  expect(turns).toBeGreaterThan(10);
  turns = 10_000;
});

it("throws a write's failure when settled, and refuses writes after it", async () => {
  const base = root();
  writeFileSync(join(base, 'taken'), 'a file, not a directory');
  const writes = new FileWrites(1);
  await writes.write(join(base, 'taken', 'inside'), 'x', { mode: 0o600 });
  await expect(writes.settled()).rejects.toThrow();
  await expect(writes.write(join(base, 'later'), 'x', { mode: 0o600 })).rejects.toThrow();
});

it("keeps an existing file when asked to create only (the baseline's `wx`)", async () => {
  const base = root();
  writeFileSync(join(base, 'kept'), 'original');
  const writes = new FileWrites();
  await writes.write(join(base, 'kept'), 'replaced', { mode: 0o600, flag: 'wx' });
  await expect(writes.settled()).rejects.toThrow();
  expect(readFileSync(join(base, 'kept'), 'utf8')).toBe('original');
});

/** Whether anything still lands in `directory` once the error is out (review MEDIUM-1). */
async function stillLanding(directory: string): Promise<boolean> {
  const count = () => readdirSync(directory, { recursive: true }).length;
  const at = count();
  await new Promise((resolve) => setTimeout(resolve, 100));
  return count() !== at;
}

it("leaves no write in flight once a write's failure is thrown (review MEDIUM-1)", async () => {
  const base = root();
  writeFileSync(join(base, 'taken'), 'a file, not a directory');
  const out = join(base, 'out');
  await expect(
    writingFiles(async (writes) => {
      await writes.write(join(base, 'taken', 'inside'), 'x', { mode: 0o600 });
      for (let i = 0; i < 200; i++)
        await writes.write(join(out, `d${i}`, 'f'), 'x'.repeat(65_536), { mode: 0o600 });
    }),
  ).rejects.toThrow();
  expect(await stillLanding(base)).toBe(false);
});

it('leaves no write in flight once `write` itself throws a failure (mutation round 4)', async () => {
  const base = root();
  writeFileSync(join(base, 'taken'), 'a file, not a directory');
  const writes = new FileWrites();
  await writes.write(join(base, 'taken', 'inside'), 'x', { mode: 0o600 });
  let thrown = false;
  for (let i = 0; i < 200 && !thrown; i++)
    await writes
      .write(join(base, 'out', `d${i}`, 'f'), 'x'.repeat(65_536), { mode: 0o600 })
      .catch(() => {
        thrown = true;
      });
  expect(thrown).toBe(true);
  expect(await stillLanding(base)).toBe(false);
});

it('leaves no write in flight when its caller throws mid-loop (review MEDIUM-1)', async () => {
  const base = root();
  await expect(
    writingFiles(async (writes) => {
      for (let i = 0; i < 20; i++)
        await writes.write(join(base, `d${i}`, 'f'), 'x'.repeat(65_536), { mode: 0o600 });
      throw new Error('the next document cannot be read');
    }),
  ).rejects.toThrow('the next document cannot be read');
  expect(await stillLanding(base)).toBe(false);
  // Every write it started has landed, and only those.
  expect(readdirSync(base)).toHaveLength(20);
});
