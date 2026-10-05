import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migratedTemplate } from './template-test-support.js';
import { RUN_PREFIXES, runDirectoryPrefix, sweepEndedRuns } from './test-run-directory.js';

/**
 * The node project's global setup (TS-M13, R-I2). The run takes a directory of its own under
 * the run's test data root, named by its PID namespace and process, and every test daemon of
 * the run keeps its data there: `testDataRoot()` is that directory. It holds the run's one
 * migrated template database too, built before any test starts. The teardown removes it all,
 * whatever killed workers left; a run interrupted before its teardown (Ctrl-C, a kill) leaves
 * it for a later run's `sweepEndedRuns`. Concurrent runs from other worktrees never share one.
 */
export default function setup(project: TestProject): () => void {
  const root = project.getProvidedContext().testDataRoot;
  sweepEndedRuns(root);
  const run = mkdtempSync(join(root, runDirectoryPrefix(RUN_PREFIXES.vitest)));
  const template = join(run, 'template');
  try {
    mkdirSync(template);
    migratedTemplate(template);
  } catch (error) {
    rmSync(run, { recursive: true, force: true });
    throw error;
  }
  project.provide('testTemplateDirectory', template);
  project.provide('testDataRoot', run);
  return () => rmSync(run, { recursive: true, force: true });
}
