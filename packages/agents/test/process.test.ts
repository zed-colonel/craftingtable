import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeBackend } from '../src/claude-code/backend.js';
import { CodexBackend } from '../src/codex/backend.js';
import {
  type SupervisedProcess,
  type SupervisedProcessItem,
  spawnSupervisedProcess,
} from '../src/process.js';

const directories: string[] = [];
const children: SupervisedProcess[] = [];
afterEach(() => {
  // Only the process groups these tests started.
  for (const child of children.splice(0)) child.terminate();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A node script as an executable in its own directory, which is also its cwd. */
function script(
  body: string,
  name = 'agent',
  interpreter = process.execPath,
): { executable: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'craftingtable-process-'));
  directories.push(cwd);
  const executable = join(cwd, name);
  writeFileSync(executable, `#!${interpreter}\n${body}\n`);
  chmodSync(executable, 0o755);
  return { executable, cwd };
}

function spawn(
  fake: { executable: string; cwd: string },
  options: Partial<Parameters<typeof spawnSupervisedProcess>[0]> = {},
): SupervisedProcess {
  const child = spawnSupervisedProcess({
    executable: fake.executable,
    args: [],
    cwd: fake.cwd,
    env: { PATH: process.env.PATH ?? '' },
    terminationGraceMs: 100,
    maxLineBytes: 1024 * 1024,
    ...options,
  });
  children.push(child);
  return child;
}

async function collect(items: AsyncIterable<SupervisedProcessItem>) {
  const collected: SupervisedProcessItem[] = [];
  for await (const item of items) collected.push(item);
  return collected;
}

describe('the background-work deadline (R-G11, AGT-16a)', () => {
  it('is refused at launch when it is not a finite time, before anything starts', () => {
    const fake = script("require('node:fs').writeFileSync('started', 'yes');");
    expect(() => spawn(fake, { backgroundWorkDeadlineAt: Number.NaN })).toThrow(/deadline/i);
    expect(() => spawn(fake, { backgroundWorkDeadlineAt: Number.POSITIVE_INFINITY })).toThrow(
      /deadline/i,
    );
    expect(existsSync(join(fake.cwd, 'started'))).toBe(false);
  });

  it.each(['claude-code', 'codex'] as const)(
    'refuses an unparsable run deadline in the %s adapter, which starts nothing',
    async (kind) => {
      const fake = script("require('node:fs').writeFileSync('started', 'yes');", kind);
      const backend =
        kind === 'claude-code'
          ? new ClaudeCodeBackend({ executable: fake.executable })
          : new CodexBackend({ executable: fake.executable });
      await expect(
        backend.launch({
          cwd: fake.cwd,
          prompt: 'go',
          permissionMode: 'unrestricted',
          deadlineAt: 'not a time',
        }),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
      expect(existsSync(join(fake.cwd, 'started'))).toBe(false);
    },
  );
});

describe('stdout supervision (R-G11, AGT-16c, AGT-16e)', () => {
  it('pauses stdout while the consumer lags, and resumes once it has drained', async () => {
    // A shell pipeline writes with blocking writes (a node child would buffer them in its own
    // memory), so the writer reaches `finished` only once the daemon reads its output.
    const lines = 20_000;
    const fake = script(
      `seq 0 ${lines - 1} | sed 's/$/ ${'x'.repeat(100)}/'\ntouch finished`,
      'agent',
      '/bin/sh',
    );
    const child = spawn(fake);
    const iterator = child.items[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: 'stdout-line' });
    // A consumer that reads nothing more for a while: without a pause the whole output, two
    // megabytes, would be read into the daemon's memory and the writer would finish.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(join(fake.cwd, 'finished'))).toBe(false);
    const rest: SupervisedProcessItem[] = [];
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next())
      rest.push(next.value);
    const received = [first.value, ...rest].flatMap((item) =>
      item?.type === 'stdout-line' ? [Number(item.line.split(' ')[0])] : [],
    );
    expect(received).toEqual(Array.from({ length: lines }, (_, i) => i));
    expect(rest.at(-1)).toMatchObject({ type: 'exited', exitCode: 0 });
    expect(existsSync(join(fake.cwd, 'finished'))).toBe(true);
  });

  it('measures a line delivered in many chunks by its bytes, keeping or dropping it exactly', async () => {
    // Two-byte characters, written a few at a time, so the line arrives in many chunks.
    const fake = script(`
      const write = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
      const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
      (async () => {
        for (let i = 0; i < 8; i++) { await write('éé'); await pause(); }
        await write('\\n');
        for (let i = 0; i < 9; i++) { await write('éé'); await pause(); }
        await write('\\nlast\\n');
      })();`);
    const items = await collect(spawn(fake, { maxLineBytes: 32 }).items);
    expect(items.filter((item) => item.type !== 'exited')).toEqual([
      { type: 'stdout-line', line: 'é'.repeat(16) },
      { type: 'stdout-overflow', bytes: 36 },
      { type: 'stdout-line', line: 'last' },
    ]);
  });
});
