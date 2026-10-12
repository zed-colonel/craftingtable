import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { discoverMigrations, runMigrations } from '../src/migrations.js';
import { acceptAnyRecord } from '../src/records.js';
import { openCraftingTableStorage } from '../src/storage.js';
import { copyRows, imageOf, preservationProblems } from './migration-preservation.js';
import { seedPlan, seedWorkspace } from './planning-test-support.js';
import { temporaryStorage, testDataRoot } from './test-support.js';
import { asAgentRunId, asRepositoryCheckDeclarationId } from '@craftingtable/domain';

/**
 * Migration 0038 (R-G13 increment 4, D1): `run_environments` is rebuilt with a nullable
 * `runtime_id`, for check-only runs. Every row, the immutability triggers, and the build records
 * and receipts that reference the table survive (R-H3, DATA-14).
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const RUNTIME = randomUUID();
const RUNS = ['run-a', 'run-b', 'run-c'];

function environment(runId: string) {
  return JSON.stringify({
    runId,
    workspaceId: 'workspace-a',
    runtimeId: RUNTIME,
    manifestPath: `/runs/${runId}/dependencies/manifest.json`,
    manifestDigest: 'd'.repeat(64),
    receiptAuthority: 'daemon',
    ...(runId === 'run-b' ? { checkDeclarationId: randomUUID() } : {}),
  });
}

/** A database at schema 37 holding run environments, their build records and receipts. */
function schema37(path: string): Database.Database {
  const fixture = temporaryStorage();
  const source = new Database(fixture.databasePath);
  const database = openDatabase(path);
  try {
    seedPlan(fixture.storage, seedWorkspace(fixture.storage));
    runMigrations(database, discoverMigrations().slice(0, 37));
    database.pragma('foreign_keys = OFF');
    copyRows(source, database, [
      'users',
      'workspaces',
      'projects',
      'plan_bundles',
      'plan_versions',
      'work_items',
    ]);
    database.pragma('foreign_keys = ON');
  } finally {
    source.close();
    fixture.cleanup();
  }
  database.exec(`
    INSERT INTO source_repositories (id,workspace_id,display_name,root_path,default_branch,registered_head_sha,status,registered_at,registered_by_user_id)
    VALUES ('repo','workspace-a','Repo','/repo','main','1234567','active','2026-09-01','user-a');
    INSERT INTO worktrees (id,workspace_id,repository_id,project_id,work_item_id,branch_name,base_sha,base_branch,path,status,created_at,created_by_user_id)
    VALUES ('wt','workspace-a','repo','project-a','item-root-a','b1','1234567','main','/wt/1','active','2026-09-02','user-a');
    INSERT INTO import_archives (id,workspace_id,digest,filename,byte_length,content,created_at)
    VALUES ('archive','workspace-a','digest','map.zip',0,X'','2026-09-02');
    INSERT INTO concurrency_definitions (id,workspace_id,archive_id,map_id,revision,digest,record_json)
    VALUES ('definition','workspace-a','archive','map','r1','digest','{}');
  `);
  database
    .prepare('INSERT INTO runtime_generations VALUES (?,?,?,?,?,?)')
    .run(RUNTIME, 'workspace-a', 'definition', 1, 1, '{}');
  const run = database.prepare(
    `INSERT INTO agent_runs (id,workspace_id,worktree_id,repository_id,project_id,work_item_id,backend,role,status,permission_mode,brief,created_at,created_by_user_id,finished_at)
     VALUES (?,'workspace-a','wt','repo','project-a','item-root-a','claude-code','review','finished','auto','Review.','2026-09-02','user-a','2026-09-02')`,
  );
  for (const id of RUNS) {
    run.run(id);
    database
      .prepare('INSERT INTO run_environments VALUES (?,?,?,?)')
      .run(id, 'workspace-a', RUNTIME, environment(id));
  }
  database
    .prepare('INSERT INTO run_build_records VALUES (?,?,?)')
    .run('run-a', 'workspace-a', JSON.stringify({ runId: 'run-a', runtimeId: RUNTIME }));
  database
    .prepare('INSERT INTO run_check_receipts VALUES (?,?,?,?)')
    .run('run-b', 1, 'workspace-a', JSON.stringify({ runId: 'run-b', sequence: 1 }));
  return database;
}

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0038-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

describe('migration 0038: run environments without a runtime (R-G13 increment 4)', () => {
  it('keeps every run environment, its triggers and what references it, and lets a check-only run have no runtime', () => {
    const path = temporaryPath();
    const database = schema37(path);
    try {
      const before = imageOf(database);
      runMigrations(database, discoverMigrations().slice(0, 38));
      const after = imageOf(database);
      expect(preservationProblems(before, after)).toEqual([]);
      expect(after.triggers.run_environment_no_update?.table).toBe('run_environments');
      expect(after.triggers.run_environment_no_delete?.table).toBe('run_environments');
      expect(
        database
          .prepare('SELECT "notnull" FROM pragma_table_info(\'run_environments\') WHERE name = ?')
          .get('runtime_id'),
      ).toEqual({ notnull: 0 });
      for (const table of ['run_build_records', 'run_check_receipts'])
        expect(
          database
            .prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)')
            .all(table)
            .filter((key) => (key as { from: string }).from === 'run_id'),
        ).toEqual([{ table: 'run_environments', from: 'run_id', to: 'run_id' }]);
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // Still immutable.
      for (const sql of [
        "UPDATE run_environments SET record_json = '{}'",
        'UPDATE run_environments SET runtime_id = NULL',
        "DELETE FROM run_environments WHERE run_id = 'run-a'",
      ])
        expect(() => database.prepare(sql).run(), sql).toThrow('Run environments are immutable');

      // A row without a runtime must be a daemon-recorded run held to an adopted declaration.
      const add = database.prepare('INSERT INTO run_environments VALUES (?,?,NULL,?)');
      const record = (fields: Record<string, unknown>) =>
        JSON.stringify({ runId: 'run-new', workspaceId: 'workspace-a', ...fields });
      database
        .prepare(
          `INSERT INTO agent_runs (id,workspace_id,worktree_id,repository_id,project_id,work_item_id,backend,role,status,permission_mode,brief,created_at,created_by_user_id)
           VALUES ('run-new','workspace-a','wt','repo','project-a','item-root-a','claude-code','review','running','auto','Review.','2026-10-07','user-a')`,
        )
        .run();
      for (const refused of [
        record({ receiptAuthority: 'daemon' }),
        record({ checkDeclarationId: randomUUID() }),
        record({
          checkDeclarationId: randomUUID(),
          receiptAuthority: 'daemon',
          runtimeId: RUNTIME,
        }),
      ])
        expect(() => add.run('run-new', 'workspace-a', refused)).toThrow(/CHECK constraint/);
    } finally {
      database.close();
    }

    // Storage writes a check-only run's environment, and reads both kinds back.
    const storage = openCraftingTableStorage(path, acceptAnyRecord);
    try {
      storage.transaction((tx) =>
        tx.runtimeEvidence.addRun({
          runId: asAgentRunId('run-new'),
          workspaceId: 'workspace-a' as never,
          manifestPath: '/runs/run-new/checks/manifest.json',
          manifestDigest: 'e'.repeat(64),
          receiptAuthority: 'daemon',
          checkDeclarationId: asRepositoryCheckDeclarationId(randomUUID()),
        }),
      );
      expect(storage.runtimeEvidence.run('workspace-a', 'run-a')?.runtimeId).toBe(RUNTIME);
      const checkOnly = storage.runtimeEvidence.run('workspace-a', 'run-new');
      expect(checkOnly?.runtimeId).toBeUndefined();
      expect(checkOnly?.checkDeclarationId).toBeDefined();
    } finally {
      storage.close();
    }
  });
});
