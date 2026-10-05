import { readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The directories a test run keeps in the run's test data root (TS-M13, R-I2), each named by
 * its run's PID namespace and process: `<prefix><namespace>-<pid>-<random>`. The vitest prefix
 * is short: a Unix socket's path holds 107 bytes, and test daemons' lock sockets live beneath. A vitest run's
 * own directory holds its template database and every test daemon's data; the e2e daemon's is
 * its data directory. A run removes its own as it ends; `sweepEndedRuns` removes those of runs
 * that did not (Ctrl-C, a kill, a crash). The root is a persistent disk directory, so nothing
 * else would.
 */
export const RUN_PREFIXES = {
  vitest: 'ct-run-',
  e2e: 'craftingtable-e2e-',
  /** Template directories of runs before R-I2's review, swept the same way. */
  template: 'craftingtable-template-test-',
} as const;

/**
 * This process's PID namespace, by its inode (`/proc/self/ns/pid`), or undefined where there
 * is none to read. A process ID means something only within its namespace.
 */
export function pidNamespace(): string | undefined {
  try {
    return /^pid:\[(\d+)\]$/.exec(readlinkSync('/proc/self/ns/pid'))?.[1];
  } catch {
    return undefined;
  }
}

/** The `mkdtemp` prefix of this process's run directory of one kind. */
export function runDirectoryPrefix(prefix: string): string {
  return `${prefix}${pidNamespace() ?? 0}-${process.pid}-`;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes the run directories of runs that ended without removing them. Only a directory from
 * this namespace whose process is gone is removed: a concurrent run's process is alive, and a
 * run in another namespace (a sandbox with its own process IDs, sharing the root) cannot be
 * checked from here, so its directory is kept. With no namespace to compare, nothing is
 * removed.
 */
export function sweepEndedRuns(root: string, namespace = pidNamespace()): void {
  if (namespace === undefined) return;
  const prefixes = Object.values(RUN_PREFIXES).join('|');
  for (const name of readdirSync(root)) {
    const [, ns, pid] = new RegExp(`^(?:${prefixes})(\\d+)-(\\d+)-`).exec(name) ?? [];
    if (ns === namespace && pid !== undefined && !running(Number(pid)))
      rmSync(join(root, name), { recursive: true, force: true });
  }
}
