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

export class InstanceLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly holder: InstanceLockHolder | undefined,
  ) {
    super(
      holder === undefined
        ? `Another CraftingTable process is already using ${dataDir}.`
        : `Another CraftingTable process (pid ${holder.pid}, started ${holder.startedAt} from ${holder.cwd}) is already using ${dataDir}.`,
    );
    this.name = 'InstanceLockedError';
  }
}

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
  const address =
    platform === 'linux'
      ? `\0craftingtable-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`
      : socketFile(canonical);
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
      throw new InstanceLockedError(canonical, current === 'no-answer' ? undefined : current);
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
