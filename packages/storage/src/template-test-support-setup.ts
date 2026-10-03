import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
 * Removes the template directories of runs whose process has ended without its teardown
 * (killed, or crashed). A directory names the process of its run, so a concurrent run's
 * directory, whose process is alive, is never touched.
 */
export function sweepEndedRuns(root: string): void {
  for (const name of readdirSync(root)) {
    const pid = new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1];
    if (pid !== undefined && !running(Number(pid)))
      rmSync(join(root, name), { recursive: true, force: true });
  }
}

/**
 * The node project's global setup (TS-M13, R-I2): migrates one template database for the run
 * before any test starts, and removes it when the run ends. The directory is this run's own,
 * under the run's test data root, so concurrent runs from other worktrees never share one.
 */
export default function setup(project: TestProject): () => void {
  const root = project.getProvidedContext().testDataRoot;
  sweepEndedRuns(root);
  const directory = mkdtempSync(join(root, `${PREFIX}${process.pid}-`));
  try {
    migratedTemplate(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  project.provide('testTemplateDirectory', directory);
  return () => rmSync(directory, { recursive: true, force: true });
}
