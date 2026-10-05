import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
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
    /** The lock socket that did not say who holds it, when one did not (R-G5 review). */
    readonly socket?: string,
  ) {
    const what =
      resource === 'data-directory' ? directory : `the agents' temporary root ${directory}`;
    super(
      holder === undefined
        ? `Another CraftingTable process is already using ${what}.${
            socket === undefined
              ? ''
              : ` Its lock socket ${socket} did not say who holds it; if no CraftingTable process does, remove it.`
          }`
        : `Another CraftingTable process (pid ${holder.pid}, started ${holder.startedAt} from ${holder.cwd}) is already using ${what}.`,
    );
    this.name = 'InstanceLockedError';
  }
}

/**
 * The name the agents' temporary root's lock sockets start with: each holder publishes
 * `<name>.<id>` in the root, beside the run directories, and the start sweep leaves them.
 */
export const AGENTS_ROOT_LOCK_FILE = '.craftingtable-daemon.lock';

/**
 * One process per data directory (R-I8). The daemon's startup marks every live
 * run interrupted and every running roadmap as needing attention before it binds
 * its port, so a second daemon started by mistake would damage the live one's
 * state even though it then fails to listen. The lock is taken before any
 * database work.
 *
 * Each lock is a socket file in the directory it locks (`state/daemon.lock.<id>`), which
 * a process in any network namespace that sees the directory finds (operator decision
 * 2026-10-05, R-G5); `acquireFileLock` says how they are published and removed. On Linux the
 * lock is first an abstract socket named from the canonical directory as well: the kernel
 * releases it the instant the holder dies, so a crash never leaves it stale. An abstract socket
 * is scoped to its network namespace, so it alone would not refuse a daemon started in a
 * sandbox with one of its own.
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
    { directory: state, prefix: 'daemon.lock' },
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
      { directory: canonical, prefix: AGENTS_ROOT_LOCK_FILE },
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

/** The lock's socket files in `directory`: each holder publishes `<prefix>.<id>`. */
interface SocketFiles {
  readonly directory: string;
  readonly prefix: string;
}

/**
 * A directory's lock: on Linux its abstract socket, then its socket file; elsewhere its socket
 * file alone. A refused second part releases the first.
 */
async function acquireDirectoryLock(
  canonical: string,
  prefix: string,
  files: SocketFiles,
  resource: InstanceLockResource,
  platform: NodeJS.Platform,
): Promise<InstanceLock> {
  if (platform !== 'linux') return acquireFileLock(canonical, files, resource);
  const abstract = await acquireAbstractLock(
    canonical,
    abstractAddress(prefix, canonical),
    resource,
  );
  let socket: InstanceLock;
  try {
    socket = await acquireFileLock(canonical, files, resource);
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

/** The holder's answer to whoever asks, served so that no client can end or hold the process. */
function holderServer(): { server: Server; release: () => Promise<void> } {
  const holder: InstanceLockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    // A client that leaves before the answer, or never reads it, is dropped: an unhandled
    // write error would end the daemon, and an open connection would keep it from closing
    // (R-G5 review).
    socket.on('error', () => socket.destroy());
    // A deadline, not an idle timeout: a client that keeps sending is dropped too.
    const deadline = setTimeout(() => socket.destroy(), ANSWER_TIMEOUT_MS);
    deadline.unref();
    socket.on('close', () => clearTimeout(deadline));
    socket.end(`${JSON.stringify(holder)}\n`);
  });
  server.unref();
  return {
    server,
    release: () =>
      new Promise<void>((done) => {
        for (const client of clients) client.destroy();
        server.close(() => done());
      }),
  };
}

/** How long a holder serves one asker, and how long an asker waits for an answer. */
export const ANSWER_TIMEOUT_MS = 2_000;

/** An abstract socket: released by the kernel when its holder dies, so never stale. */
async function acquireAbstractLock(
  canonical: string,
  address: string,
  resource: InstanceLockResource,
): Promise<InstanceLock> {
  const { server, release } = holderServer();
  try {
    await listen(server, address);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    const current = await askHolder(address);
    throw new InstanceLockedError(
      canonical,
      current === 'no-answer' ? undefined : current,
      resource,
    );
  }
  return { address, release };
}

/**
 * The socket-file part of a lock, which a process in any network namespace that sees the
 * directory finds (operator decision 2026-10-05, R-G5). Each holder publishes its own socket,
 * `<prefix>.<id>`, already listening: it binds a temporary name and renames it into place. So
 * a published socket that refuses a connection belongs to a holder that has ended, and is
 * removed. A starter is refused by any published socket that answers (or does not answer in
 * time), publishes its own, and then looks again: if another holder published meanwhile, it
 * withdraws. Two starters racing can at worst both withdraw, never both hold.
 *
 * Paths may be longer than the 107 bytes a socket's address holds (test data roots are), so
 * on Linux the sockets are named through an open descriptor of the directory,
 * `/proc/self/fd/<n>/<name>`, which the kernel resolves to the same file.
 */
async function acquireFileLock(
  canonical: string,
  files: SocketFiles,
  resource: InstanceLockResource,
): Promise<InstanceLock> {
  // Two starts that publish together see each other and both withdraw (after a crash, two
  // starts racing to replace its socket usually do). A withdrawal is retried after a random
  // pause, so one of them goes ahead; a start refused by a holder that was already there is
  // not retried (R-G5 review).
  for (let attempt = 1; ; attempt++) {
    const outcome = await publishFileLock(canonical, files, resource);
    if (!(outcome instanceof Withdrawn)) return outcome;
    if (attempt >= WITHDRAWN_RETRIES) throw outcome.refusal;
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 90 * attempt));
  }
}

/** Withdrawn after publishing: another holder appeared meanwhile. */
class Withdrawn {
  constructor(readonly refusal: InstanceLockedError) {}
}
const WITHDRAWN_RETRIES = 5;

async function publishFileLock(
  canonical: string,
  files: SocketFiles,
  resource: InstanceLockResource,
): Promise<InstanceLock | Withdrawn> {
  let descriptor: number | undefined;
  let base = files.directory;
  if (existsSync('/proc/self/fd')) {
    descriptor = openSync(files.directory, 'r');
    base = `/proc/self/fd/${descriptor}`;
  }
  const closeDescriptor = () => {
    if (descriptor !== undefined) closeSync(descriptor);
    descriptor = undefined;
  };
  const id = randomBytes(6).toString('hex');
  const published = `${files.prefix}.${id}`;
  const { server, release } = holderServer();
  let listening = false;
  try {
    const refusal = async (except?: string) => {
      const current = await liveHolder(base, files.prefix, except);
      if (current === undefined) return undefined;
      return 'socket' in current
        ? new InstanceLockedError(
            canonical,
            undefined,
            resource,
            current.socket.replace(base, files.directory),
          )
        : new InstanceLockedError(canonical, current, resource);
    };
    const before = await refusal();
    if (before) throw before;
    const temporary = join(base, `${files.prefix}-starting.${id}`);
    await listen(server, temporary);
    listening = true;
    renameSync(temporary, join(base, published));
    const after = await refusal(published);
    if (after) {
      rmSync(join(base, published), { force: true });
      await release();
      closeDescriptor();
      return new Withdrawn(after);
    }
  } catch (error) {
    if (listening) {
      rmSync(join(base, published), { force: true });
      await release();
    }
    closeDescriptor();
    if (error instanceof InstanceLockedError) throw error;
    // Named by the directory, not the descriptor path it was reached through.
    throw new Error(
      `The lock in ${files.directory} could not be taken: ${String((error as Error).message).replaceAll(base, files.directory)}`,
    );
  }
  return {
    address: join(files.directory, published),
    release: async () => {
      // Closing unlinks the temporary name the socket was bound to, which is gone; the
      // published name is this holder's own, so it is removed by name.
      rmSync(join(base, published), { force: true });
      await release();
      closeDescriptor();
    },
  };
}

/**
 * The holder of a published socket in `base` that answers, the socket that does not say who
 * holds it (no answer in time, or no holder's answer), or nothing. A published socket that refuses connections is a holder's that
 * ended, and is removed; entries that are not published sockets are left alone.
 */
async function liveHolder(
  base: string,
  prefix: string,
  except?: string,
): Promise<InstanceLockHolder | { readonly socket: string } | undefined> {
  for (const name of readdirSync(base)) {
    const published = name.startsWith(`${prefix}.`);
    // A starter's socket before it is published: one that refuses connections was left by a
    // starter killed before renaming it, and goes too. A listening one is not a holder yet;
    // its own second look settles who holds.
    const starting = name.startsWith(`${prefix}-starting.`);
    if (name === except || (!published && !starting)) continue;
    const path = join(base, name);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSocket() !== true) continue;
    const answer = await askHolder(path);
    if (answer === 'no-answer') {
      rmSync(path, { force: true });
      continue;
    }
    if (published) return answer ?? { socket: path };
  }
  return undefined;
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
    socket.setTimeout(ANSWER_TIMEOUT_MS, () => {
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
