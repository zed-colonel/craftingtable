import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireDaemonLocks,
  AGENTS_ROOT_LOCK_FILE,
  ANSWER_TIMEOUT_MS,
  acquireInstanceLock,
  type InstanceLock,
  InstanceLockedError,
} from '../src/instance-lock.js';
import { testDataRoot } from './test-support.js';
/**
 * Where these tests make their directories: a short base, since the socket-file lock lives in
 * them and a Unix socket's path holds 107 bytes; no daemon keeps data here (R-I2 review).
 */
const SOCKET_BASE = '/tmp';

describe('instance lock', () => {
  const held: InstanceLock[] = [];
  const directories: string[] = [];
  const dataDir = (): string => {
    const path = mkdtempSync(join(SOCKET_BASE, 'ctl-'));
    directories.push(path);
    return path;
  };

  afterEach(async () => {
    for (const lock of held.splice(0)) await lock.release();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  for (const platform of ['linux', 'darwin'] as const) {
    describe(platform === 'linux' ? 'abstract socket' : 'socket file', () => {
      it('refuses a second process on the same data directory and names the holder', async () => {
        const dir = dataDir();
        held.push(await acquireInstanceLock(dir, platform));
        const second = acquireInstanceLock(dir, platform);
        await expect(second).rejects.toBeInstanceOf(InstanceLockedError);
        await expect(second).rejects.toThrow(`pid ${process.pid}`);
      });

      it('treats the same directory reached through another path as the same lock', async () => {
        const dir = dataDir();
        held.push(await acquireInstanceLock(dir, platform));
        await expect(acquireInstanceLock(join(dir, '.'), platform)).rejects.toBeInstanceOf(
          InstanceLockedError,
        );
      });

      it('lets different data directories run side by side', async () => {
        held.push(await acquireInstanceLock(dataDir(), platform));
        held.push(await acquireInstanceLock(dataDir(), platform));
        expect(held).toHaveLength(2);
      });

      it('is free again once released', async () => {
        const dir = dataDir();
        const first = await acquireInstanceLock(dir, platform);
        await first.release();
        held.push(await acquireInstanceLock(dir, platform));
      });
    });
  }
});

describe("the agents' temporary root lock (R-G5)", () => {
  const held: InstanceLock[] = [];
  const directories: string[] = [];
  const directory = (prefix: string): string => {
    const path = mkdtempSync(join(SOCKET_BASE, prefix));
    directories.push(path);
    return path;
  };
  const daemon = (agentRoot?: string) => ({
    dataDir: directory('ctl-'),
    execution: { agentTemporaryRoot: agentRoot ?? '' },
  });
  const withDefaultRoot = () => {
    const config = daemon();
    return { ...config, execution: { agentTemporaryRoot: join(config.dataDir, 't') } };
  };

  afterEach(async () => {
    for (const lock of held.splice(0)) await lock.release();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  for (const platform of ['linux', 'darwin'] as const) {
    describe(platform === 'linux' ? 'abstract socket' : 'socket file', () => {
      it('refuses a second daemon on the same root, names the root, and frees its data directory', async () => {
        const root = directory('cta-');
        held.push(await acquireDaemonLocks(daemon(root), platform));
        const second = daemon(root);
        const refused = await acquireDaemonLocks(second, platform).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(InstanceLockedError);
        expect((refused as InstanceLockedError).resource).toBe('agents-temporary-root');
        expect((refused as InstanceLockedError).message).toContain(`pid ${process.pid}`);
        expect((refused as InstanceLockedError).message).toContain(
          `the agents' temporary root ${realpathSync(root)}`,
        );
        // The refused daemon holds nothing: its data directory is free for the next start.
        held.push(await acquireInstanceLock(second.dataDir, platform));
      });

      it('treats the same root reached through a link as the same lock', async () => {
        const root = directory('cta-');
        const link = join(directory('cta-link-'), 'root');
        symlinkSync(root, link);
        held.push(await acquireDaemonLocks(daemon(root), platform));
        await expect(acquireDaemonLocks(daemon(link), platform)).rejects.toMatchObject({
          resource: 'agents-temporary-root',
        });
      });

      it('lets daemons on different roots, and on their default roots, run side by side', async () => {
        held.push(await acquireDaemonLocks(daemon(directory('cta-')), platform));
        held.push(await acquireDaemonLocks(daemon(directory('cta-')), platform));
        held.push(await acquireDaemonLocks(withDefaultRoot(), platform));
        held.push(await acquireDaemonLocks(withDefaultRoot(), platform));
        expect(held).toHaveLength(4);
      });

      it('still refuses a second daemon on the data directory first, and releases both locks', async () => {
        const first = daemon(directory('cta-'));
        const lock = await acquireDaemonLocks(first, platform);
        await expect(
          acquireDaemonLocks(
            { ...first, execution: { agentTemporaryRoot: directory('cta-') } },
            platform,
          ),
        ).rejects.toMatchObject({ resource: 'data-directory' });
        await lock.release();
        held.push(await acquireDaemonLocks(first, platform));
      });
    });
  }
});

/**
 * The locks across network namespaces (operator decision 2026-10-05, R-G5): an abstract socket
 * is scoped to one, so each lock is also a socket file in the directory it locks, which a
 * process in any namespace that sees the directory finds. Each holder publishes its own
 * (`<name>.<id>`), already listening, and checks again after publishing.
 */
describe.skipIf(process.platform !== 'linux')('the locks across network namespaces (R-G5)', () => {
  const held: InstanceLock[] = [];
  const directories: string[] = [];
  const children: ChildProcess[] = [];
  const directory = (prefix: string, base = testDataRoot()): string => {
    const path = mkdtempSync(join(base, prefix));
    directories.push(path);
    return path;
  };
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
    for (const lock of held.splice(0)) await lock.release();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  // Where unprivileged network namespaces are refused, the test that needs one would skip
  // unseen; it fails instead, unless the host is declared to lack them.
  const unshare =
    spawnSync('unshare', ['-rn', 'true']).status === 0 ||
    process.env.CRAFTINGTABLE_TEST_NO_NETNS !== '1';
  const SERVER = fileURLToPath(new URL('..', import.meta.url));
  const LOCK_MODULE = fileURLToPath(new URL('../src/instance-lock.ts', import.meta.url));

  /**
   * A process that takes and releases the daemon's locks on command, in this network namespace
   * or one of its own: `acquire [platform]`, `release`, `hold-open <path>`.
   */
  function lockProcess(dataDir: string, root: string, ownNamespace: boolean) {
    const script = `
      import { acquireDaemonLocks } from ${JSON.stringify(LOCK_MODULE)};
      import { createInterface } from 'node:readline';
      let lock;
      createInterface({ input: process.stdin }).on('line', async (line) => {
        const [command, platform] = line.split(' ');
        if (command === 'acquire')
          try {
            lock = await acquireDaemonLocks(
              { dataDir: ${JSON.stringify(dataDir)}, execution: { agentTemporaryRoot: ${JSON.stringify(root)} } },
              platform,
            );
            console.log('acquired');
          } catch (error) {
            console.log('refused ' + (error.resource ?? error.message) + ' ' + (error.holder?.pid ?? '-'));
          }
        if (command === 'release') {
          await lock?.release();
          lock = undefined;
          console.log('released');
        }
        // Answers, then keeps its event loop busy for that long, as a loaded daemon may.
        if (command === 'block') {
          console.log('blocking');
          setImmediate(() => {
            const until = Date.now() + Number(platform);
            while (Date.now() < until);
          });
        }
      });
      console.log('ready');
    `;
    const node = [process.execPath, '--import', 'tsx', '--input-type=module', '-e', script];
    const child = ownNamespace
      ? spawn('unshare', ['-rn', ...node], { cwd: SERVER, stdio: ['pipe', 'pipe', 'inherit'] })
      : spawn(node[0]!, node.slice(1), { cwd: SERVER, stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(child);
    const lines: string[] = [];
    const waiting: ((line: string) => void)[] = [];
    let buffered = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        const next = waiting.shift();
        if (next) next(line);
        else lines.push(line);
      }
    });
    // A process that ended answers every pending and later command with its exit.
    child.once('exit', (code, signal) => {
      const ended = `exited ${code ?? signal}`;
      lines.push(ended);
      for (const next of waiting.splice(0)) next(ended);
    });
    const nextLine = () =>
      new Promise<string>((resolve) => {
        const line = lines.length > 1 || !lines[0]?.startsWith('exited') ? lines.shift() : lines[0];
        if (line !== undefined) resolve(line);
        else waiting.push(resolve);
      });
    const send = async (command: string) => {
      child.stdin!.write(`${command}\n`);
      return nextLine();
    };
    return { child, ready: nextLine(), send };
  }

  /** The published lock sockets in `directory` whose names start with `prefix`. */
  const lockSockets = (directory: string, prefix: string) =>
    readdirSync(directory).filter(
      (name) => name.startsWith(`${prefix}.`) && lstatSync(join(directory, name)).isSocket(),
    );

  it.skipIf(!unshare)(
    'refuses a daemon in another network namespace on the same data directory or root, naming the holder',
    async () => {
      const dataDir = directory('ctd-');
      const root = directory('cta-');
      held.push(await acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }));
      // The other daemon's own directories differ; only the one shared is refused.
      const sameData = lockProcess(dataDir, directory('cta-'), true);
      expect(await sameData.ready).toBe('ready');
      expect(await sameData.send('acquire')).toBe(`refused data-directory ${process.pid}`);
      const sameRoot = lockProcess(directory('ctd-'), root, true);
      expect(await sameRoot.ready).toBe('ready');
      expect(await sameRoot.send('acquire')).toBe(`refused agents-temporary-root ${process.pid}`);
      // With nothing held, it acquires.
      await held.splice(0)[0]!.release();
      expect(await sameData.send('acquire')).toBe('acquired');
      expect(await sameData.send('release')).toBe('released');
    },
  );

  it.skipIf(!unshare)(
    'releases its abstract socket when the socket file refuses it (review M7)',
    async () => {
      const dataDir = directory('ctd-');
      const root = directory('cta-');
      const other = lockProcess(dataDir, root, true);
      expect(await other.ready).toBe('ready');
      expect(await other.send('acquire')).toBe('acquired');
      await expect(
        acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }),
      ).rejects.toMatchObject({ resource: 'data-directory' });
      expect(await other.send('release')).toBe('released');
      // An abstract socket kept from the refusal would refuse this start.
      held.push(await acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }));
    },
  );

  it('holds its socket files however long their paths, removes them on release, and leaks no descriptor', async () => {
    // Past the 107 bytes a socket's path holds.
    const dataDir = directory(`ctd-${'x'.repeat(100)}-`);
    const root = directory(`cta-${'y'.repeat(100)}-`);
    // Descriptors this process holds on the locked directories; other work in the process
    // opens and closes descriptors of its own meanwhile.
    const onLocked = () =>
      readdirSync('/proc/self/fd').filter((fd) => {
        try {
          const target = readlinkSync(`/proc/self/fd/${fd}`);
          return target === realpathSync(join(dataDir, 'state')) || target === realpathSync(root);
        } catch {
          return false;
        }
      });
    const lock = await acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } });
    expect(onLocked()).toHaveLength(2);
    expect(lockSockets(join(dataDir, 'state'), 'daemon.lock')).toHaveLength(1);
    expect(lockSockets(root, AGENTS_ROOT_LOCK_FILE)).toHaveLength(1);
    await lock.release();
    expect(lockSockets(join(dataDir, 'state'), 'daemon.lock')).toEqual([]);
    expect(lockSockets(root, AGENTS_ROOT_LOCK_FILE)).toEqual([]);
    expect(onLocked()).toEqual([]);
  });

  it("removes a killed holder's socket file, and leaves entries that only share its name", async () => {
    const dataDir = directory('ctd-');
    const root = directory('cta-');
    // Not a lock: a regular file and a directory named like one stay where they are.
    writeFileSync(join(root, `${AGENTS_ROOT_LOCK_FILE}.notes`), 'mine');
    mkdirSync(join(root, `${AGENTS_ROOT_LOCK_FILE}.dir`));
    const killed = lockProcess(dataDir, root, false);
    expect(await killed.ready).toBe('ready');
    expect(await killed.send('acquire')).toBe('acquired');
    await expect(
      acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }),
    ).rejects.toBeInstanceOf(InstanceLockedError);
    killed.child.kill('SIGKILL');
    await new Promise((resolve) => killed.child.once('close', resolve));
    expect(lockSockets(root, AGENTS_ROOT_LOCK_FILE)).toHaveLength(1);
    held.push(await acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }));
    // Only this holder's socket is left, beside the entries that were never a lock.
    expect(lockSockets(root, AGENTS_ROOT_LOCK_FILE)).toHaveLength(1);
    expect(readFileSync(join(root, `${AGENTS_ROOT_LOCK_FILE}.notes`), 'utf8')).toBe('mine');
    expect(existsSync(join(root, `${AGENTS_ROOT_LOCK_FILE}.dir`))).toBe(true);
  });

  it('survives clients that close at once, and releases with a client still connected (review HIGH)', async () => {
    // A short base: this test connects to the socket by its full path.
    const dataDir = directory('ctd-', SOCKET_BASE);
    const root = directory('cta-', SOCKET_BASE);
    const holder = lockProcess(dataDir, root, false);
    expect(await holder.ready).toBe('ready');
    expect(await holder.send('acquire')).toBe('acquired');
    const [socket] = lockSockets(root, AGENTS_ROOT_LOCK_FILE);
    const path = join(root, socket!);
    // Connect and close before the holder answers, many times: an unhandled write error would
    // end the holder's process.
    await Promise.all(
      Array.from(
        { length: 300 },
        () =>
          new Promise<void>((resolve) => {
            const client = createConnection(path, () => client.destroy());
            client.on('error', () => resolve());
            client.on('close', () => resolve());
          }),
      ),
    );
    // A client that stays connected must not keep the release from finishing.
    const lingering = createConnection({ path, allowHalfOpen: true });
    lingering.on('error', () => {});
    await new Promise((resolve) => lingering.once('connect', resolve));
    expect(await holder.send('release')).toBe('released');
    lingering.destroy();
    expect(holder.child.exitCode).toBeNull();
  });

  it('refuses, and never removes, a holder too busy to answer (review M3)', async () => {
    const dataDir = directory('ctd-', SOCKET_BASE);
    const root = directory('cta-', SOCKET_BASE);
    const busy = lockProcess(dataDir, root, false);
    expect(await busy.ready).toBe('ready');
    expect(await busy.send('acquire darwin')).toBe('acquired');
    expect(await busy.send(`block ${ANSWER_TIMEOUT_MS + 1_500}`)).toBe('blocking');
    // The holder answers nobody while its loop is busy: not an ended holder, so refused.
    await expect(
      acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }, 'darwin'),
    ).rejects.toMatchObject({ resource: 'data-directory', holder: undefined });
    // Its lock stands, and it survives the asker that gave up.
    expect(await busy.send('release')).toBe('released');
  });

  it('never lets two processes both hold a lock when they race to replace a stale file (review MEDIUM)', async () => {
    // A short base: the stale sockets this test makes are named by their full paths.
    const dataDir = directory('ctd-', SOCKET_BASE);
    const root = directory('cta-', SOCKET_BASE);
    mkdirSync(join(dataDir, 'state'), { recursive: true });
    // Another process stands in for another namespace: the socket files alone decide.
    const other = lockProcess(dataDir, root, false);
    expect(await other.ready).toBe('ready');
    let both = 0;
    let neither = 0;
    for (let round = 0; round < 150; round++) {
      // A killed holder's file: a socket nobody listens on.
      for (const [path, name] of [
        [join(dataDir, 'state'), 'daemon.lock'],
        [root, AGENTS_ROOT_LOCK_FILE],
      ] as const)
        await staleSocket(path, `${name}.dead${round}`);
      const [theirs, ours] = await Promise.all([
        other.send('acquire darwin'),
        acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }, 'darwin').then(
          (lock) => lock,
          () => undefined,
        ),
      ]);
      if (theirs === 'acquired' && ours) both++;
      if (theirs !== 'acquired' && !ours) neither++;
      if (theirs === 'acquired') expect(await other.send('release')).toBe('released');
      await ours?.release();
    }
    expect(both).toBe(0);
    // Both refused is the safe outcome of a tie; it stays rare.
    expect(neither).toBeLessThan(150);
  });
});

/** A socket file in `directory` that nobody listens on, as a killed holder leaves one. */
async function staleSocket(directory: string, name: string): Promise<void> {
  const live = join(directory, `${name}.live`);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(live, resolve));
  linkSync(live, join(directory, name));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
