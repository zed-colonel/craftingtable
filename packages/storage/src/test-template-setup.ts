import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migratedTemplate } from './test-template.js';

/**
 * The node project's global setup (TS-M13, R-I2): migrates one template database for the run
 * before any test starts, and removes it when the run ends. The directory is this run's own,
 * under the run's test data root, so concurrent runs from other worktrees never share one.
 */
export default function setup(project: TestProject): () => void {
  const root = project.getProvidedContext().testDataRoot;
  const directory = mkdtempSync(join(root, 'craftingtable-template-test-'));
  try {
    migratedTemplate(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  project.provide('testTemplateDirectory', directory);
  return () => rmSync(directory, { recursive: true, force: true });
}
