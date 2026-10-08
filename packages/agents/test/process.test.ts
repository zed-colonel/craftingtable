import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  it('pauses stdout once the waiting lines pass 16 MiB, however few they are', async () => {
    // 64 lines of a mebibyte: far fewer than 1000 items, but 64 MiB of memory.
    const fake = script(
      'for i in $(seq 64); do head -c 1048576 /dev/zero | tr "\\\\0" x; echo; done\ntouch finished',
      'agent',
      '/bin/sh',
    );
    const child = spawn(fake, { maxLineBytes: 4 * 1024 * 1024 });
    const iterator = child.items[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'stdout-line' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(join(fake.cwd, 'finished'))).toBe(false);
    let lines = 1;
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next())
      if (next.value.type === 'stdout-line') lines += 1;
    expect(lines).toBe(64);
  });

  it('says stderr is quiet a while after its last chunk, not its first', async () => {
    // Six chunks 300 ms apart, then nothing for two seconds.
    const fake = script(`
      let left = 6;
      const next = () => {
        process.stderr.write('chunk\\n');
        if (--left > 0) setTimeout(next, 300);
        else setTimeout(() => {}, 2000);
      };
      next();`);
    const kinds = (await collect(spawn(fake, { stderrQuietMs: 1000 }).items)).map(
      (item) => item.type,
    );
    expect(kinds.filter((kind) => kind === 'stderr')).toHaveLength(6);
    expect(kinds.filter((kind) => kind === 'stderr-quiet')).toHaveLength(1);
    expect(kinds.lastIndexOf('stderr')).toBeLessThan(kinds.indexOf('stderr-quiet'));
  });

  it('pauses stderr once the waiting chunks pass 16 MiB, however few they are', async () => {
    // 48 MiB in a pipe kept full: chunks of up to 64 KiB, so fewer than 1000 of them.
    const fake = script(
      'head -c 50331648 /dev/zero | tr "\\\\0" x >&2\ntouch finished',
      'agent',
      '/bin/sh',
    );
    const child = spawn(fake);
    const iterator = child.items[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'stderr' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(join(fake.cwd, 'finished'))).toBe(false);
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next());
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

  it('records nothing for a child that does not lead its own group', () => {
    // An ordinary child, in this process's group: never this process's to record.
    const child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      expect(processGroupIdentity(child.pid)).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('never signals the reaper’s own group', async () => {
    // Run apart, in a group of its own the test starts: a regression could signal only that
    // group. Its leader starts a member, which asks to reap the group it is in.
    const directory = mkdtempSync(join(tmpdir(), 'craftingtable-own-group-'));
    directories.push(directory);
    const reaper = join(directory, 'reaper.mts');
    writeFileSync(
      reaper,
      `import { readFileSync } from 'node:fs';
import { reapProcessGroup } from ${JSON.stringify(fileURLToPath(new URL('../src/process.ts', import.meta.url)))};
const leader = Number(process.argv[2]);
const stat = readFileSync('/proc/' + leader + '/stat', 'utf8');
const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
console.log(JSON.stringify(await reapProcessGroup({ pid: leader, startTime, bootId }, { graceMs: 100 })));
`,
    );
    const leader = script(
      `const ran = require('node:child_process').spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ${JSON.stringify(reaper)}, String(process.pid)], { encoding: 'utf8' });
      process.stdout.write(ran.stdout || 'no answer\\n');`,
    );
    const items = await collect(spawn(leader).items);
    expect(items.filter((item) => item.type === 'stdout-line')).toEqual([
      { type: 'stdout-line', line: JSON.stringify({ outcome: 'other-process' }) },
    ]);
    expect(items.at(-1)).toMatchObject({ type: 'exited', exitCode: 0, signal: null });
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

  /** A supervised group whose leader starts a member and exits, leaving the member running. */
  /**
   * A supervised group whose leader starts members and exits, leaving them running. A member
   * is `marked` (it inherits the run's marker), `unmarked` (started without it), or
   * `undumpable` (marked, but its environment unreadable: it makes itself non-dumpable).
   */
  async function leaderlessGroup(
    members: readonly ('marked' | 'unmarked' | 'undumpable')[] = ['marked'],
  ) {
    const child = spawn(
      script(`
        const { spawn } = require('node:child_process');
        const unmarked = { ...process.env };
        delete unmarked.CRAFTINGTABLE_RUN_ID;
        for (const kind of ${JSON.stringify(members)}) {
          if (kind === 'undumpable')
            spawn('python3', ['-c', 'import ctypes, time\\nctypes.CDLL(None).prctl(4, 0, 0, 0, 0)\\ntime.sleep(1000)'], { stdio: 'ignore' });
          else
            spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: kind === 'marked' ? process.env : unmarked });
        }
        setTimeout(() => process.exit(0), 500);`),
      {
        env: { PATH: process.env.PATH ?? '', CRAFTINGTABLE_RUN_ID: 'run-1' },
        // The supervisor waits for the group, so the test's cleanup can still end it.
        backgroundWorkTimeoutMs: 60_000,
      },
    );
    const identity = processGroupIdentity(child.pid);
    if (!identity) throw new Error('no identity');
    const iterator = child.items[Symbol.asyncIterator]();
    // The supervisor says the leader exited with work still running in its group.
    let next = await iterator.next();
    while (!next.done && next.value.type !== 'background-work-waiting')
      next = await iterator.next();
    return { identity, iterator };
  }

  it('ends a group whose leader has exited when every member is the run’s (operator 2026-10-07)', async () => {
    const before = Date.now();
    const { identity, iterator } = await leaderlessGroup();
    const proven = { graceMs: 2000, notStartedBefore: before, runId: 'run-1' };
    // Without the run's start or its marker, nothing proves whose the leaderless group is.
    for (const partial of [{ runId: 'run-1' }, { notStartedBefore: before }])
      expect(await reapProcessGroup(identity, { graceMs: 100, ...partial })).toEqual({
        outcome: 'unverifiable',
      });
    // Another run's marker, another boot, or a run that began after the members started.
    expect(await reapProcessGroup(identity, { ...proven, runId: 'run-2' })).toEqual({
      outcome: 'unverifiable',
    });
    expect(
      await reapProcessGroup(
        { ...identity, bootId: '00000000-0000-4000-8000-000000000000' },
        proven,
      ),
    ).toEqual({ outcome: 'other-process' });
    expect(
      await reapProcessGroup(identity, { ...proven, notStartedBefore: Date.now() + 60_000 }),
    ).toEqual({ outcome: 'other-process' });
    expect(await reapProcessGroup(identity, proven)).toEqual({
      outcome: 'terminated',
      signal: 'SIGTERM',
    });
    for (let next = await iterator.next(); !next.done; next = await iterator.next());
    expect(await reapProcessGroup(identity, proven)).toEqual({ outcome: 'gone' });
  });

  it.each([
    ['one of its members lacks the marker', ['marked', 'unmarked']],
    ['a member’s environment cannot be read', ['marked', 'undumpable']],
  ] as const)(
    'leaves a leaderless group alone when %s (R-G11 re-check LOW-7)',
    async (_, members) => {
      const before = Date.now();
      const { identity } = await leaderlessGroup(members);
      expect(
        await reapProcessGroup(identity, {
          graceMs: 100,
          notStartedBefore: before,
          runId: 'run-1',
        }),
      ).toEqual({ outcome: 'unverifiable' });
    },
  );

  it('leaves a leaderless group alone when a member does not carry the run’s marker (operator 2026-10-07)', async () => {
    const before = Date.now();
    const { identity } = await leaderlessGroup(['unmarked']);
    expect(
      await reapProcessGroup(identity, { graceMs: 100, notStartedBefore: before, runId: 'run-1' }),
    ).toEqual({ outcome: 'unverifiable' });
  });
});

/**
 * Whether this host lets a test make its own user and pid namespace, where pids can be reused
 * on purpose and every process is the test's: the namespace ends with its first process.
 */
const isolatedPids =
  process.platform === 'linux' &&
  spawnSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', 'true'])
    .status === 0 &&
  spawnSync('python3', ['-c', 'pass']).status === 0;

/**
 * The independent review's reuse case (MEDIUM-1): the run's group is recorded, then ends
 * entirely; later an unrelated program gets the same pid, leads a group (by setpgid, or by
 * setsid as another daemon's agent would) and exits, leaving a member. Run as pid 1's child in a
 * fresh pid namespace, it prints what the reaper decided and whether the member still runs.
 */
const REUSE_CASE = `
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { processGroupIdentity, reapProcessGroup } from ${JSON.stringify(fileURLToPath(new URL('../src/process.ts', import.meta.url)))};
if (process.pid > 50) throw new Error('not in a fresh pid namespace; refusing');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stat = (pid) => {
  try {
    const text = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], pgrp: Number(fields[2]) };
  } catch {
    return undefined;
  }
};
const runStarted = Date.now() - 1000;
const leader = spawn('sleep', ['1000'], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, CRAFTINGTABLE_RUN_ID: 'run-1' },
});
await sleep(50);
const identity = processGroupIdentity(leader.pid);
process.kill(-leader.pid, 'SIGKILL');
await new Promise((resolve) => leader.once('exit', resolve));
writeFileSync('/proc/sys/kernel/ns_last_pid', String(identity.pid - 1));
const lead = process.argv[2] === 'setsid' ? 'os.setsid()' : 'os.setpgid(0, 0)';
const unrelated = spawn('python3', ['-c', 'import os, time\\n' + lead + '\\nif os.fork() == 0:\\n  time.sleep(1000)\\nprint(os.getpid(), flush=True)\\ntime.sleep(0.3)\\n'], { stdio: ['ignore', 'pipe', 'inherit'] });
const reused = Number(await new Promise((resolve) => unrelated.stdout.once('data', (data) => resolve(String(data)))));
// The member holds the pipe open for good: stop reading it, or this process never ends.
unrelated.stdout.destroy();
await new Promise((resolve) => unrelated.once('exit', resolve));
await sleep(100);
const members = () => readdirSync('/proc').filter((entry) => /^\\d+$/.test(entry)).map(Number)
  .filter((pid) => stat(pid)?.pgrp === identity.pid && stat(pid)?.state !== 'Z');
const before = members();
const reaping = await reapProcessGroup(identity, { graceMs: 300, notStartedBefore: runStarted, runId: 'run-1' });
console.log(JSON.stringify({ reused: reused === identity.pid, members: before.length, reaping, after: members().length }));
// This is the namespace's first process: its end ends every process in it.
process.exit(0);
`;

describe.runIf(isolatedPids)(
  'a reused pgid (R-G11 independent review, operator 2026-10-07)',
  () => {
    it.each([
      ['setpgid', 'other-process'],
      ['setsid', 'unverifiable'],
    ])('leaves alone an unrelated group that took the recorded pid by %s', (variant, outcome) => {
      const directory = mkdtempSync(join(tmpdir(), 'craftingtable-reuse-'));
      directories.push(directory);
      const path = join(directory, 'reuse.mts');
      writeFileSync(path, REUSE_CASE);
      const ran = spawnSync(
        'unshare',
        [
          '--user',
          '--map-root-user',
          '--pid',
          '--fork',
          // Should the test give up on it, the namespace's first process goes with it.
          '--kill-child',
          '--mount-proc',
          process.execPath,
          '--experimental-transform-types',
          '--no-warnings',
          path,
          variant,
        ],
        { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
      );
      expect(ran.status, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '')).toEqual({
        reused: true,
        members: 1,
        reaping: { outcome },
        after: 1,
      });
    });
  },
);
