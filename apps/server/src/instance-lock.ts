import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';

/** What a lock holder tells a process that finds the data directory taken. */
export interface InstanceLockHolder {
  readonly pid: number;
  readonly startedAt: string;
  readonly cwd: string;
}

export interface InstanceLock {
  readonly address: string;
  release(): Promise<void>;
}

/** What a lock keeps to one daemon: its data directory, or its agents' temporary root (R-G5). */
export type InstanceLockResource = 'data-directory' | 'agents-temporary-root';

export class InstanceLockedError extends Error {
  constructor(
    /** The canonical directory the lock is keyed on: the data directory or the agents' root. */
    readonly directory: string,
    readonly holder: InstanceLockHolder | undefined,
    readonly resource: InstanceLockResource = 'data-directory',
  ) {
    const what =
      resource === 'data-directory' ? directory : `the agents' temporary root ${directory}`;
    super(
      holder === undefined
        ? `Another CraftingTable process is already using ${what}.`
        : `Another CraftingTable process (pid ${holder.pid}, started ${holder.startedAt} from ${holder.cwd}) is already using ${what}.`,
    );
    this.name = 'InstanceLockedError';
  }
}

/**
 * The socket file that holds an agents' temporary root's lock, beside the abstract socket on
 * Linux. It lives in the root, beside the run directories, and the start sweep leaves it.
 */
export const AGENTS_ROOT_LOCK_FILE = '.craftingtable-daemon.lock';

/**
 * One process per data directory (R-I8). The daemon's startup marks every live
 * run interrupted and every running roadmap as needing attention before it binds
 * its port, so a second daemon started by mistake would damage the live one's
 * state even though it then fails to listen. The lock is taken before any
 * database work.
 *
 * Each lock is a socket file in the directory it locks (the data directory's `state/`), which
 * a process in any network namespace that sees the directory finds (operator decision
 * 2026-10-05, R-G5). One nobody answers on was left by a crashed process and is reclaimed. On
 * Linux the lock is first an abstract socket named from the canonical directory as well: the
 * kernel releases it the instant the holder dies, so a crash never leaves it stale, and only
 * its holder reclaims a stale file. An abstract socket is scoped to its network namespace, so
 * it alone would not refuse a daemon started in a sandbox with one of its own.
 */
export async function acquireInstanceLock(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<InstanceLock> {
  const canonical = canonicalDirectory(dataDir);
  const state = join(canonical, 'state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return acquireDirectoryLock(
    canonical,
    'craftingtable',
    { directory: state, name: 'daemon.lock' },
    'data-directory',
    platform,
  );
}

/**
 * Both of a daemon's locks, taken before any database work: its data directory's, then its
 * agents' temporary root's (R-G5), each taken as `acquireInstanceLock` takes its own, so a
 * daemon in another network namespace is refused too. A start sweeps every run-named directory of that root, so a
 * second daemon on the same root, with a data directory of its own, would remove the first
 * one's live runs' directories. The root's lock refuses it first; the default root, `<data>/t`,
 * differs per data directory. A refused start holds neither lock.
 */
export async function acquireDaemonLocks(
  config: { readonly dataDir: string; readonly execution: { readonly agentTemporaryRoot: string } },
  platform: NodeJS.Platform = process.platform,
): Promise<InstanceLock> {
  const data = await acquireInstanceLock(config.dataDir, platform);
  let root: InstanceLock;
  try {
    let canonical: string;
    try {
      canonical = canonicalDirectory(config.execution.agentTemporaryRoot);
    } catch (error) {
      // A root it cannot create (a link to nowhere yet, an unwritable parent) stops the start
      // with its name, not a bare system error (R-G5 review).
      throw new Error(
        `CRAFTINGTABLE_AGENT_TMP_ROOT ${config.execution.agentTemporaryRoot} could not be created: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      );
    }
    root = await acquireDirectoryLock(
      canonical,
      'craftingtable-agents',
      { directory: canonical, name: AGENTS_ROOT_LOCK_FILE },
      'agents-temporary-root',
      platform,
    );
  } catch (error) {
    await data.release();
    throw error;
  }
  return {
    address: data.address,
    release: async () => {
      await root.release();
      await data.release();
    },
  };
}

function abstractAddress(prefix: string, canonical: string): string {
  return `\0${prefix}-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

/** A socket file named `name` in `directory`. */
interface SocketFile {
  readonly directory: string;
  readonly name: string;
}

/**
 * A directory's lock: on Linux its abstract socket, then its socket file; elsewhere its socket
 * file alone. A refused second part releases the first.
 */
async function acquireDirectoryLock(
  canonical: string,
  prefix: string,
  file: SocketFile,
  resource: InstanceLockResource,
  platform: NodeJS.Platform,
): Promise<InstanceLock> {
  if (platform !== 'linux') return acquireLock(canonical, file, resource);
  const abstract = await acquireLock(canonical, abstractAddress(prefix, canonical), resource);
  let socket: InstanceLock;
  try {
    socket = await acquireLock(canonical, file, resource);
  } catch (error) {
    await abstract.release();
    throw error;
  }
  return {
    address: abstract.address,
    release: async () => {
      await socket.release();
      await abstract.release();
    },
  };
}

/**
 * Listens on `target`: an abstract address, or a socket file. A socket file's path may be
 * longer than the 107 bytes a socket's address holds (test data roots are), so on Linux it is
 * named through an open descriptor of its directory, `/proc/self/fd/<n>/<name>`, which the
 * kernel resolves to the same file.
 */
async function acquireLock(
  canonical: string,
  target: string | SocketFile,
  resource: InstanceLockResource,
): Promise<InstanceLock> {
  const holder: InstanceLockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  let descriptor: number | undefined;
  let address: string;
  if (typeof target === 'string') address = target;
  else if (existsSync('/proc/self/fd')) {
    descriptor = openSync(target.directory, 'r');
    address = `/proc/self/fd/${descriptor}/${target.name}`;
  } else address = join(target.directory, target.name);
  const closeDescriptor = () => {
    if (descriptor !== undefined) closeSync(descriptor);
    descriptor = undefined;
  };
  const server = createServer((socket) => {
    socket.end(`${JSON.stringify(holder)}\n`);
  });
  server.unref();
  try {
    try {
      await listen(server, address);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      const current = await askHolder(address);
      // An abstract address is never stale; a socket file nobody answers on was left by a
      // crashed process.
      if (current !== 'no-answer' || typeof target === 'string')
        throw new InstanceLockedError(
          canonical,
          current === 'no-answer' ? undefined : current,
          resource,
        );
      rmSync(address, { force: true });
      await listen(server, address);
    }
  } catch (error) {
    closeDescriptor();
    throw error;
  }
  return {
    address,
    release: () =>
      new Promise<void>((done) => {
        // Closing unlinks a socket file, through the descriptor still open.
        server.close(() => {
          closeDescriptor();
          done();
        });
      }),
  };
}

function canonicalDirectory(dataDir: string): string {
  const absolute = resolve(dataDir);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return realpathSync(absolute);
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((done, fail) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      fail(error);
    };
    const onListening = () => {
      server.off('error', onError);
      done();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

/** Ask the current holder who it is; a dead socket file answers nothing. */
function askHolder(address: string): Promise<InstanceLockHolder | 'no-answer' | undefined> {
  return new Promise((done) => {
    let text = '';
    const socket = createConnection(address);
    socket.setEncoding('utf8');
    socket.setTimeout(2_000, () => {
      socket.destroy();
      done(undefined);
    });
    socket.on('data', (chunk: string) => {
      text += chunk;
    });
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(text) as InstanceLockHolder;
        done(typeof parsed.pid === 'number' ? parsed : undefined);
      } catch {
        done(undefined);
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'no-answer' : undefined);
    });
  });
}
