import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { copyRows, imageOf, preservationProblems } from './migration-preservation.js';
import { discoverMigrations, runMigrations } from './migrations.js';
import { seedPlan, seedWorkspace } from './planning-test-support.js';
import { temporaryStorage } from './test-support.js';

/**
 * Migration 0014 rebuilt worktrees, agent_runs and work_cycles to allow a plan-level
 * subject, without a count guard. This proves the rebuild on seeded schema-13 rows
 * (R-H3, DATA-14): every row survives in rowid order with its values, the new columns
 * read as absent, every index and trigger is back under its name, and the rest of the
 * database is untouched.
 */
function schema13(): Database.Database {
  const fixture = temporaryStorage();
  const source = new Database(fixture.databasePath);
  const database = new Database(':memory:');
  try {
    seedPlan(fixture.storage, seedWorkspace(fixture.storage));
    runMigrations(database, discoverMigrations().slice(0, 13));
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
  const cycle = (id: string, item: string, worktree: string, status: string, version: number) =>
    JSON.stringify({
      id,
      workspaceId: 'workspace-a',
      workItemId: item,
      worktreeId: worktree,
      status,
      version,
      reason: `cycle ${id}`,
    });
  database.exec(`
    INSERT INTO source_repositories (id,workspace_id,display_name,root_path,default_branch,registered_head_sha,status,registered_at,registered_by_user_id)
    VALUES ('repo','workspace-a','Repo','/repo','main','1234567','active','2026-09-01','user-a');
    INSERT INTO worktrees (id,workspace_id,repository_id,project_id,work_item_id,branch_name,base_sha,base_branch,path,status,created_at,created_by_user_id,removed_at,version,merged_at,merge_sha,integration_branch)
    VALUES ('wt-merged','workspace-a','repo','project-a','item-root-a','ct/root','1234567','main','/wt/root','removed','2026-09-01','user-a','2026-09-02',3,'2026-09-02','89abcdef','integration'),
           ('wt-live','workspace-a','repo','project-a','item-middle-a','ct/middle','1234567','main','/wt/middle','active','2026-09-03','user-a',NULL,1,NULL,NULL,NULL);
    INSERT INTO agent_runs (id,workspace_id,worktree_id,repository_id,project_id,work_item_id,parent_run_id,backend,role,status,permission_mode,model,brief,backend_session_id,created_at,created_by_user_id,started_at,finished_at,exit_code,outcome_summary,cost_usd,turn_count,version,resolved_model,billing,verdict,review_branch_context_json)
    VALUES ('run-review','workspace-a','wt-merged','repo','project-a','item-root-a',NULL,'codex','review','finished','edit-only','gpt','Review the change','session-1','2026-09-01','user-a','2026-09-01','2026-09-02',0,'Looks mergeable',1.25,3,4,'gpt-resolved','subscription','mergeable','{"headSha":"89abcdef","targetBranch":"main","targetSha":"1234567","worktreeVersion":2}'),
           ('run-child','workspace-a','wt-merged','repo','project-a','item-root-a','run-review','claude-code','implement','interrupted','auto',NULL,'Fix it',NULL,'2026-09-02','user-a',NULL,'2026-09-02',NULL,NULL,NULL,0,1,NULL,NULL,NULL,NULL),
           ('run-live','workspace-a','wt-live','repo','project-a','item-middle-a',NULL,'claude-code','design','running','auto','opus','Design it','session-2','2026-09-03','user-a','2026-09-03',NULL,NULL,NULL,NULL,1,2,NULL,'api-key',NULL,NULL);
    INSERT INTO work_cycles (id,workspace_id,work_item_id,worktree_id,status,version,state_json)
    VALUES ('cycle-done','workspace-a','item-root-a','wt-merged','completed',9,'${cycle('cycle-done', 'item-root-a', 'wt-merged', 'completed', 9)}'),
           ('cycle-live','workspace-a','item-middle-a','wt-live','running',2,'${cycle('cycle-live', 'item-middle-a', 'wt-live', 'running', 2)}');
    INSERT INTO agent_run_events (id,workspace_id,run_id,occurred_at,kind,payload_json,raw_json)
    VALUES ('event-1','workspace-a','run-review','2026-09-01','notice','{"category":"other","message":"hello"}',NULL),
           ('event-2','workspace-a','run-live','2026-09-03','stderr','{"text":"warning"}','raw');
  `);
  return database;
}

describe('migration 0014 preserves the three execution tables it rebuilds (R-H3)', () => {
  it('keeps every row, in order, with its values, indexes and triggers', () => {
    const database = schema13();
    try {
      const before = imageOf(database);
      expect(before.tables.worktrees).toHaveLength(2);
      expect(before.tables.agent_runs).toHaveLength(3);
      expect(before.tables.work_cycles).toHaveLength(2);

      runMigrations(database, discoverMigrations().slice(0, 14));
      const after = imageOf(database);
      expect(preservationProblems(before, after)).toEqual([]);
      for (const table of ['worktrees', 'agent_runs'])
        expect(
          (after.tables[table] as Record<string, unknown>[]).map((row) => row.plan_version_id),
        ).toEqual((after.tables[table] as unknown[]).map(() => null));
      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);

      // The rebuilt tables still enforce what they did: lineage, uniqueness, append-only events.
      expect(() =>
        database.prepare("DELETE FROM agent_runs WHERE id = 'run-review'").run(),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        database
          .prepare(
            "INSERT INTO worktrees (id,workspace_id,repository_id,project_id,work_item_id,branch_name,base_sha,base_branch,path,status,created_at,created_by_user_id) VALUES ('wt-dup','workspace-a','repo','project-a','item-leaf-a','b','1234567','main','/wt/middle','active','now','user-a')",
          )
          .run(),
      ).toThrow(/UNIQUE/);
      expect(() => database.prepare('DELETE FROM agent_run_events').run()).toThrow(/append-only/);

      // And the rest of the chain carries the same rows to the current schema.
      runMigrations(database, discoverMigrations());
      expect(
        preservationProblems(before, imageOf(database), {
          // 0026 rebuilt the run-profile table; nothing here seeded it.
          tables: ['workspace_run_profiles'],
        }),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('notices a lost row, a moved row, a lost index and a changed value', () => {
    const database = schema13();
    try {
      const before = imageOf(database);
      database.pragma('foreign_keys = OFF');
      database.exec(`
        DROP INDEX uq_work_cycles_item;
        CREATE TABLE cycles_copy AS SELECT * FROM work_cycles ORDER BY rowid DESC;
        DELETE FROM work_cycles;
        INSERT INTO work_cycles SELECT * FROM cycles_copy;
        DROP TABLE cycles_copy;
        DELETE FROM agent_run_events WHERE 0;
        UPDATE worktrees SET branch_name = 'renamed' WHERE id = 'wt-live';
      `);
      database.prepare("DELETE FROM agent_runs WHERE id = 'run-live'").run();
      const problems = preservationProblems(before, imageOf(database));
      expect(problems).toEqual(
        expect.arrayContaining([
          'table agent_runs had 3 rows and now has 2',
          expect.stringMatching(/^table work_cycles row 0 changed or moved/),
          expect.stringMatching(/^table worktrees row 1 changed or moved/),
          'index uq_work_cycles_item is gone',
        ]),
      );
    } finally {
      database.close();
    }
  });
});
