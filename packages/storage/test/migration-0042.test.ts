import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CYCLE_ATTENTION_CODES } from '@craftingtable/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import {
  discoverMigrations,
  inspectMigrationStatus,
  MigrationValidationError,
  runMigrations,
} from '../src/migrations.js';
import { copyRows, imageOf, preservationProblems } from './migration-preservation.js';
import { seedPlan, seedWorkspace } from './planning-test-support.js';
import { temporaryStorage, testDataRoot } from './test-support.js';

/**
 * Migration 0042 (R-B4, decision 15): the stored vocabulary R-B4's increment 4 adds, recorded in a
 * catalog so that a release without it is refused by the deploy preflight (R-H3), which checks
 * migrations only. The codes are the stops `controller-error` used to hide (decision 3) and the
 * phase gate's blocker refs; an older release's strict contracts would refuse to write a cycle
 * that holds them back. Nothing that existed changes.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migrations = discoverMigrations();
const toSchema41 = migrations.slice(0, 41);

/** The vocabulary increment 4 stores, as the catalog records it. */
const SCHEMA_42 = [
  ['attention-ref', 'blockers'],
  ...[
    'delegation-authority-lost',
    'finalization-inactive',
    'item-completed-unmerged',
    'item-not-admitted',
    'item-unavailable',
    'launch-refused',
    'phase-gate',
    'predecessor-merge-missing',
    'predecessors-incomplete',
    'resolution-not-ready',
    'review-capture-failed',
    'roadmap-binding-changed',
    'service-unavailable',
    'worktree-state',
  ].map((code) => ['cycle-attention', code]),
];

/**
 * The cycle attention codes a schema-41 release could store, before the catalog existed: the
 * domain's `CYCLE_ATTENTION` at the commit before R-B4's increment 4, in its order. Frozen.
 */
// biome-ignore format: one code per line, as the domain lists them.
const STORED_BEFORE_THE_CATALOG = [
  'service-failure-not-retryable',
  'service-retries-exhausted',
  'provider-credentials-rejected',
  'exit-with-open-questions',
  'completion-continuations-exhausted',
  'background-work-unsafe',
  'step-incomplete',
  'resolution-needs-guidance',
  'workflow-report-invalid',
  'workflow-questions-disagree',
  'shared-decision-required',
  'work-item-questions',
  'finalization-needs-input',
  'design-investigation-finished',
  'design-report-invalid',
  'design-dependency-continuations-exhausted',
  'design-dependency-unsupported',
  'design-planning-conflict',
  'design-decision-required',
  'design-open-questions',
  'implementation-open-questions',
  'review-open-questions-at-limit',
  'review-open-questions',
  'finalization-report-rejected',
  'polish-assessment-needs-attention',
  'legacy-finalization-retired',
  'scope-review-open-questions',
  'scope-review-recovery',
  'review-needs-attention',
  'restart-session-lost',
  'agent-environment-unavailable',
  'agent-model-misnamed',
  'restart-resume',
  'controller-error',
  'upstream-transition-undeclared',
  'upstream-pin-moved',
  'repository-checks-undeclared',
  'check-definition-changed',
  'reassessment-failed',
  'worktree-inactive',
  'authority-lost',
  'design-recheck-unavailable',
  'step-time-limit',
  'service-retry-mismatch',
  'scope-review-snapshot-changed',
  'review-baseline-changed',
  'security-reviewer-unassigned',
  'workflow-obligation',
  'checkpoint-attestation-failed',
  'stage-report-invalid',
  'finalization-ledger-full',
  'plan-change-decision',
  'stage-batch-selection',
  'stage-review-changes-requested',
  'remediation-exhausted',
  'remediation-no-change',
  'remediation-stalled',
  'implementation-commit-failed',
  'integration-refresh-limit',
  'integration-conflict',
  'integration-update-failed',
  'resolution-abandoned',
  'merge-approval',
  'merge-requirements',
  'final-promotion',
  'record-scope-evidence',
  'controller-wait',
  'scheduling-held',
  'legacy-attention',
];

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0042-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

/** A database at schema 41 holding two workspaces' plans. */
function schema41(path: string): Database.Database {
  const fixture = temporaryStorage();
  const source = new Database(fixture.databasePath);
  const database = openDatabase(path);
  try {
    const a = seedWorkspace(fixture.storage, 'a');
    seedPlan(fixture.storage, a, { suffix: 'a' });
    const b = seedWorkspace(fixture.storage, 'b');
    seedPlan(fixture.storage, b, { suffix: 'b', digest: 'b'.repeat(64) });
    runMigrations(database, toSchema41);
    database.pragma('foreign_keys = OFF');
    copyRows(source, database, [
      'users',
      'workspaces',
      'workspace_memberships',
      'plan_bundles',
      'projects',
      'plan_versions',
      'work_items',
      'work_item_dependencies',
    ]);
    database.pragma('foreign_keys = ON');
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    source.close();
    fixture.cleanup();
  }
  return database;
}

const catalog = (database: Database.Database) =>
  (
    database
      .prepare(
        'SELECT kind, value, introduced_in_schema AS schema FROM stored_vocabulary ORDER BY kind, value',
      )
      .all() as { kind: string; value: string; schema: number }[]
  ).map((row) => [row.kind, row.value, row.schema]);

describe('migration 0042: stored vocabulary', () => {
  it('records increment 4’s vocabulary and keeps everything that existed', () => {
    const path = temporaryPath();
    const database = schema41(path);
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 42));
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
    expect(catalog(database)).toEqual(SCHEMA_42.map(([kind, value]) => [kind, value, 42]));
    database.close();
  });

  it('keeps the catalog append-only', () => {
    const path = temporaryPath();
    const database = schema41(path);
    runMigrations(database, migrations.slice(0, 42));
    expect(() =>
      database.prepare("UPDATE stored_vocabulary SET value = 'x' WHERE value = 'phase-gate'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      database.prepare("DELETE FROM stored_vocabulary WHERE value = 'phase-gate'").run(),
    ).toThrow(/append-only/);
    database.close();
  });

  it('is refused by a release that does not know it, so a rollback across it is refused', () => {
    const path = temporaryPath();
    const database = schema41(path);
    runMigrations(database, migrations.slice(0, 42));
    database.close();
    // The deploy preflight asks the release's own migrations (R-H3).
    expect(() => inspectMigrationStatus(path, toSchema41)).toThrow(MigrationValidationError);
    try {
      inspectMigrationStatus(path, toSchema41);
    } catch (error) {
      expect((error as MigrationValidationError).failure).toBe('unsupported-version');
    }
    expect(inspectMigrationStatus(path, migrations.slice(0, 42)).currentVersion).toBe(42);
  });

  it('catalogs every cycle attention code stored since it exists', () => {
    // A code added later needs a migration adding its row (R-B4, decision 15).
    const path = temporaryPath();
    const database = openDatabase(path);
    runMigrations(database, migrations);
    const catalogued = new Set(
      catalog(database)
        .filter(([kind]) => kind === 'cycle-attention')
        .map(([, value]) => value as string),
    );
    database.close();
    const known = new Set<string>([...STORED_BEFORE_THE_CATALOG, ...catalogued]);
    expect(CYCLE_ATTENTION_CODES.filter((code) => !known.has(code))).toEqual([]);
    expect(
      [...known].filter((code) => !(CYCLE_ATTENTION_CODES as readonly string[]).includes(code)),
    ).toEqual([]);
    expect(STORED_BEFORE_THE_CATALOG.filter((code) => catalogued.has(code))).toEqual([]);
  });
});
