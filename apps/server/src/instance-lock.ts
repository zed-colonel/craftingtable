import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
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
 * The socket file that holds an agents' temporary root's lock where there is no abstract
 * namespace. It lives in the root, beside the run directories, and the start sweep leaves it.
 */
export const AGENTS_ROOT_LOCK_FILE = '.craftingtable-daemon.lock';

/**
 * One process per data directory (R-I8). The daemon's startup marks every live
 * run interrupted and every running roadmap as needing attention before it binds
 * its port, so a second daemon started by mistake would damage the live one's
 * state even though it then fails to listen. The lock is taken before any
 * database work.
 *
 * On Linux it is a listening socket in the abstract namespace, named from the
 * canonical data directory: the kernel releases it the instant the holder dies,
 * so a crash never leaves a stale lock behind. Elsewhere it is a socket file in
 * the state directory, reclaimed when nothing answers on it.
 */
export async function acquireInstanceLock(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<InstanceLock> {
  const canonical = canonicalDirectory(dataDir);
  return acquireLock(
    canonical,
    platform === 'linux' ? abstractAddress('craftingtable', canonical) : socketFile(canonical),
    'data-directory',
    platform,
  );
}

/**
 * Both of a daemon's locks, taken before any database work: its data directory's, then its
 * agents' temporary root's (R-G5). On Linux both are abstract sockets, which are scoped to a
 * network namespace: a daemon started inside a sandbox with a network namespace of its own is
 * not refused by them. A start sweeps every run-named directory of that root, so a
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
    root = await acquireLock(
      canonical,
      platform === 'linux'
        ? abstractAddress('craftingtable-agents', canonical)
        : join(canonical, AGENTS_ROOT_LOCK_FILE),
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

async function acquireLock(
  canonical: string,
  address: string,
  resource: InstanceLockResource,
  platform: NodeJS.Platform,
): Promise<InstanceLock> {
  const holder: InstanceLockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  const server = createServer((socket) => {
    socket.end(`${JSON.stringify(holder)}\n`);
  });
  server.unref();
  try {
    await listen(server, address);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    const current = await askHolder(address);
    if (current !== 'no-answer' || platform === 'linux')
      throw new InstanceLockedError(
        canonical,
        current === 'no-answer' ? undefined : current,
        resource,
      );
    // A socket file nobody answers on was left by a crashed process.
    rmSync(address, { force: true });
    await listen(server, address);
  }
  return {
    address,
    release: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

function canonicalDirectory(dataDir: string): string {
  const absolute = resolve(dataDir);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return realpathSync(absolute);
}

function socketFile(canonical: string): string {
  const state = join(canonical, 'state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return join(state, 'daemon.lock');
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
