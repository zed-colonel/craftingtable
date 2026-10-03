import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migratedTemplate } from './template-test-support.js';

const PREFIX = 'craftingtable-template-test-';

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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

/**
 * Removes the template directories of runs that ended without their teardown (interrupted,
 * killed or crashed). A directory names its run's PID namespace and process. Only a directory
 * from this namespace whose process is gone is removed: a concurrent run's process is alive,
 * and a run in another namespace (a sandbox with its own process IDs, sharing the data root)
 * cannot be checked from here, so its directory is kept. With no namespace to compare, nothing
 * is removed.
 */
export function sweepEndedRuns(root: string, namespace = pidNamespace()): void {
  if (namespace === undefined) return;
  for (const name of readdirSync(root)) {
    const [, ns, pid] = new RegExp(`^${PREFIX}(\\d+)-(\\d+)-`).exec(name) ?? [];
    if (ns === namespace && pid !== undefined && !running(Number(pid)))
      rmSync(join(root, name), { recursive: true, force: true });
  }
}

/**
 * The node project's global setup (TS-M13, R-I2): migrates one template database for the run
 * before any test starts, and removes it at the run's teardown. A run interrupted before its
 * teardown (Ctrl-C, a kill) leaves it for a later run's `sweepEndedRuns`. The directory is this
 * run's own, under the run's test data root, so concurrent runs from other worktrees never
 * share one.
 */
export default function setup(project: TestProject): () => void {
  const root = project.getProvidedContext().testDataRoot;
  sweepEndedRuns(root);
  const directory = mkdtempSync(join(root, `${PREFIX}${pidNamespace() ?? 0}-${process.pid}-`));
  try {
    migratedTemplate(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  project.provide('testTemplateDirectory', directory);
  return () => rmSync(directory, { recursive: true, force: true });
}
