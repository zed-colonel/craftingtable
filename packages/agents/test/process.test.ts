import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeBackend } from '../src/claude-code/backend.js';
import { CodexBackend } from '../src/codex/backend.js';
import {
  parseProcessGroupIdentity,
  processGroupIdentity,
  reapProcessGroup,
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

  it('pauses stderr too while the consumer lags', async () => {
    const fake = script(
      `seq 0 999999 | sed 's/$/ ${'x'.repeat(100)}/' >&2\ntouch finished`,
      'agent',
      '/bin/sh',
    );
    const child = spawn(fake);
    const iterator = child.items[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'stderr' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // A hundred megabytes of stderr, more than 1000 chunks of a full pipe, were not all read
    // into memory while nobody took them.
    expect(existsSync(join(fake.cwd, 'finished'))).toBe(false);
    let last: SupervisedProcessItem | undefined;
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next())
      last = next.value;
    expect(last).toMatchObject({ type: 'exited', exitCode: 0 });
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

describe.runIf(process.platform === 'linux')('process group identity (R-G11, AGT-02)', () => {
  it('is recorded only for a group this process started and leads', () => {
    const child = spawn(script('setInterval(() => {}, 1000);'));
    const identity = processGroupIdentity(child.pid);
    expect(identity).toEqual({
      pid: child.pid,
      startTime: expect.stringMatching(/^\d+$/),
      bootId: expect.stringMatching(/^[0-9a-f-]+$/),
    });
    // Not this process's child, or not a group leader: nothing a later daemon could signal.
    expect(processGroupIdentity(1)).toBeUndefined();
    expect(processGroupIdentity(process.pid)).toBeUndefined();
    expect(parseProcessGroupIdentity(JSON.parse(JSON.stringify(identity)))).toEqual(identity);
    for (const junk of [
      null,
      { ...identity, pid: 1 },
      { ...identity, pid: '12' },
      { ...identity, startTime: '1 2' },
      { ...identity, bootId: '../x' },
    ])
      expect(parseProcessGroupIdentity(junk)).toBeUndefined();
  });

  it('ends a recorded group that stops on SIGTERM, and leaves one it cannot prove', async () => {
    const child = spawn(script('setInterval(() => {}, 1000);'));
    const identity = processGroupIdentity(child.pid);
    if (!identity) throw new Error('no identity');
    expect(await reapProcessGroup({ ...identity, startTime: '1' }, { graceMs: 100 })).toEqual({
      outcome: 'other-process',
    });
    // A leader that started before the run it is recorded for is not the run's.
    expect(
      await reapProcessGroup(identity, { graceMs: 100, notStartedBefore: Date.now() + 60_000 }),
    ).toEqual({ outcome: 'other-process' });
    expect(
      await reapProcessGroup(identity, { graceMs: 2000, notStartedBefore: Date.now() - 1000 }),
    ).toEqual({
      outcome: 'terminated',
      signal: 'SIGTERM',
    });
    const items = await collect(child.items);
    expect(items.at(-1)).toMatchObject({ type: 'exited', signal: 'SIGTERM' });
    expect(await reapProcessGroup(identity, { graceMs: 100 })).toEqual({ outcome: 'gone' });
  });

  it('ends a group whose leader has exited when every member started after the run (operator 2026-10-07)', async () => {
    const before = Date.now();
    // The leader starts a member in its own group, says so, and exits.
    const child = spawn(
      script(`
        const member = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        require('node:fs').writeFileSync('member.pid', String(member.pid));
        setTimeout(() => process.exit(0), 200);`),
      // The supervisor waits for the group, so the test's cleanup can still end it.
      { backgroundWorkTimeoutMs: 60_000 },
    );
    const identity = processGroupIdentity(child.pid);
    if (!identity) throw new Error('no identity');
    const iterator = child.items[Symbol.asyncIterator]();
    // The supervisor says the leader exited with work still running in its group.
    let next = await iterator.next();
    while (!next.done && next.value.type !== 'background-work-waiting')
      next = await iterator.next();
    // Without the run's start, nothing proves whose the leaderless group is.
    expect(await reapProcessGroup(identity, { graceMs: 100 })).toEqual({
      outcome: 'unverifiable',
    });
    // A run that began after its members started cannot own them.
    expect(
      await reapProcessGroup(identity, { graceMs: 100, notStartedBefore: Date.now() + 60_000 }),
    ).toEqual({ outcome: 'other-process' });
    expect(await reapProcessGroup(identity, { graceMs: 2000, notStartedBefore: before })).toEqual({
      outcome: 'terminated',
      signal: 'SIGTERM',
    });
    for (next = await iterator.next(); !next.done; next = await iterator.next());
    expect(await reapProcessGroup(identity, { graceMs: 100, notStartedBefore: before })).toEqual({
      outcome: 'gone',
    });
  });
});
