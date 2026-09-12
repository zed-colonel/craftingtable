import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { checksumSql, discoverMigrations, runMigrations } from './migrations.js';
import { seedPlan, seedWorkspace } from './planning-test-support.js';
import { temporaryStorage } from './test-support.js';

it('preserves runs, lineage and journal rows while widening the backend constraint', () => {
  const fixture = temporaryStorage();
  const database = new Database(':memory:');
  const source = new Database(fixture.databasePath);
  try {
    seedPlan(fixture.storage, seedWorkspace(fixture.storage));
    const migrations = discoverMigrations();
    runMigrations(database, migrations.slice(0, 6));
    database.pragma('foreign_keys = OFF');
    // Copy a valid planning graph into the schema-six database.
    for (const table of [
      'users',
      'workspaces',
      'projects',
      'plan_bundles',
      'plan_versions',
      'work_items',
    ]) {
      for (const row of source.prepare(`SELECT * FROM ${table}`).all() as Record<
        string,
        unknown
      >[]) {
        database
          .prepare(
            `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
              .map(() => '?')
              .join(',')})`,
          )
          .run(...Object.values(row));
      }
    }
    database.pragma('foreign_keys = ON');
    database.exec(`
      INSERT INTO source_repositories (id,workspace_id,display_name,root_path,default_branch,registered_head_sha,status,registered_at,registered_by_user_id)
      VALUES ('repo','workspace-a','Repo','/repo','main','1234567','active','now','user-a');
      INSERT INTO worktrees (id,workspace_id,repository_id,project_id,work_item_id,branch_name,base_sha,base_branch,path,status,created_at,created_by_user_id)
      VALUES ('wt','workspace-a','repo','project-a','item-root-a','branch','1234567','main','/wt','active','now','user-a');
      INSERT INTO agent_runs (id,workspace_id,worktree_id,repository_id,project_id,work_item_id,backend,role,status,permission_mode,brief,created_at,created_by_user_id,resolved_model,billing,verdict)
      VALUES ('run','workspace-a','wt','repo','project-a','item-root-a','claude-code','review','running','auto','brief','now','user-a','opus','subscription','mergeable');
      INSERT INTO agent_runs SELECT 'child',workspace_id,worktree_id,repository_id,project_id,work_item_id,'run',backend,role,status,permission_mode,model,brief,backend_session_id,created_at,created_by_user_id,started_at,finished_at,exit_code,outcome_summary,cost_usd,turn_count,version,resolved_model,billing,verdict FROM agent_runs WHERE id='run';
      INSERT INTO agent_run_events (id,workspace_id,run_id,occurred_at,kind,payload_json,raw_json)
      VALUES ('event','workspace-a','run','now','notice','{"category":"other","message":"hello"}','raw');
    `);
    const runs = database.prepare('SELECT * FROM agent_runs ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    const events = database.prepare('SELECT * FROM agent_run_events').all();
    runMigrations(database, migrations);
    expect(database.prepare('SELECT * FROM agent_runs ORDER BY id').all()).toEqual(
      runs.map((run) => ({ ...run, review_branch_context_json: null, plan_version_id: null })),
    );
    expect(database.prepare('SELECT integration_branch FROM worktrees').get()).toEqual({
      integration_branch: null,
    });
    expect(database.prepare('SELECT * FROM agent_run_events').all()).toEqual(events);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    database.prepare("UPDATE agent_runs SET backend = 'codex' WHERE id = 'child'").run();
    expect(() => database.prepare("UPDATE agent_runs SET backend = 'other'").run()).toThrow(
      /CHECK/,
    );
    expect(() => database.prepare("DELETE FROM agent_runs WHERE id = 'run'").run()).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => database.prepare('DELETE FROM agent_run_events').run()).toThrow(/append-only/);
    expect(database.prepare("PRAGMA index_list('agent_runs')").all()).toHaveLength(5);
    runMigrations(database, migrations);
  } finally {
    source.close();
    database.close();
    fixture.cleanup();
  }
});

it('rolls back a bad rebuild and restores foreign key enforcement', () => {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    const sql =
      '-- requires: foreign_keys=off\nCREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(parent REFERENCES parent(id)); INSERT INTO child VALUES (1);';
    expect(() =>
      runMigrations(database, [{ version: 1, name: 'bad', sql, checksum: checksumSql(sql) }]),
    ).toThrow(/foreign key/);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  } finally {
    database.close();
  }
});
