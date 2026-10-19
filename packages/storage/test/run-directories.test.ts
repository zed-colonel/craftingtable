import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  type AgentRunId,
  type AgentRunStatus,
  asAgentRunEventId,
  asAgentRunId,
  type SourceRepositoryId,
  type WorktreeId,
} from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { SEED_NOW, seedPlan, seedWorkspace } from './planning-test-support.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

/**
 * The run directories and their cleanup eligibility, read in one pass (R-B5, decision 11): the
 * same rows the correlated query gave, for every combination of a run's status, its worktree's
 * merge and removal, a live run beside it and how its journal says it ended; a worktree's or a
 * run's alone; and a journal that grows.
 */

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** The query `directories()` ran before R-B5, as it was: the oracle. */
const CORRELATED = `SELECT d.run_id AS runId, r.workspace_id AS workspaceId, w.id AS worktreeId, d.path, d.device, MAX(COALESCE(r.finished_at, r.created_at), COALESCE(w.removed_at, w.created_at)) AS retainedSince,
      (r.status IN ('finished','failed','cancelled','interrupted') AND w.status = 'removed' AND w.merged_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM agent_runs live WHERE live.worktree_id = w.id AND live.status NOT IN ('finished','failed','cancelled','interrupted'))) AS eligible,
      (r.status IN ('finished','failed','cancelled')
       AND EXISTS (SELECT 1 FROM agent_run_events ended WHERE ended.run_id=r.id AND ended.kind='run-finished' AND (json_type(ended.payload_json, '$.exitCode')='integer' OR json_type(ended.payload_json, '$.signal')='text'))
       AND NOT EXISTS (SELECT 1 FROM agent_runs live WHERE live.worktree_id = w.id AND live.status NOT IN ('finished','failed','cancelled','interrupted'))) AS buildEligible
      FROM run_directories d JOIN agent_runs r ON r.id = d.run_id JOIN worktrees w ON w.id = r.worktree_id`;

type Ending =
  | { readonly exitCode: number }
  | { readonly signal: string }
  | { readonly status: 'failed' }
  | undefined;

function fixture() {
  const temporary = temporaryStorage();
  fixtures.push(temporary);
  const { storage } = temporary;
  const seed = seedPlan(storage, seedWorkspace(storage));
  const repositoryId = 'repository' as SourceRepositoryId;
  storage.execution.sourceRepositories.insert({
    id: repositoryId,
    workspaceId: seed.workspaceId,
    displayName: 'repository',
    rootPath: '/fixture/repository',
    defaultBranch: 'main',
    registeredHeadSha: 'a'.repeat(40),
    registeredAt: SEED_NOW,
    registeredByUserId: seed.userId,
  });
  const worktree = (id: string, merged: boolean, removed: boolean): WorktreeId => {
    const worktreeId = id as WorktreeId;
    storage.transaction((tx) => {
      tx.execution.worktrees.insert({
        id: worktreeId,
        workspaceId: seed.workspaceId,
        repositoryId,
        projectId: seed.projectId,
        workItemId: seed.rootWorkItemId,
        branchName: `ct/${id}`,
        baseSha: 'a'.repeat(40),
        baseBranch: 'main',
        path: `/fixture/worktrees/${id}`,
        createdAt: SEED_NOW,
        createdByUserId: seed.userId,
      });
      if (merged)
        tx.execution.worktrees.markMerged({
          workspaceId: seed.workspaceId,
          worktreeId,
          mergeSha: 'b'.repeat(40),
          occurredAt: SEED_NOW,
        });
      if (removed)
        tx.execution.worktrees.markRemoved({
          workspaceId: seed.workspaceId,
          worktreeId,
          occurredAt: SEED_NOW,
        });
    });
    return worktreeId;
  };
  const ended = (runId: AgentRunId, ending: Ending, inside = storage.execution) =>
    inside.runEvents.append({
      id: asAgentRunEventId(randomUUID()),
      workspaceId: seed.workspaceId,
      runId,
      occurredAt: SEED_NOW,
      kind: 'run-finished',
      payload: { status: 'finished', ...ending },
    });
  const run = (worktreeId: WorktreeId, status: AgentRunStatus, ending: Ending): AgentRunId => {
    const runId = asAgentRunId(randomUUID());
    storage.transaction((tx) => {
      tx.execution.runs.insert({
        id: runId,
        workspaceId: seed.workspaceId,
        repositoryId,
        projectId: seed.projectId,
        workItemId: seed.rootWorkItemId,
        worktreeId,
        backend: 'codex',
        role: 'implement',
        permissionMode: 'auto',
        brief: 'brief',
        createdAt: SEED_NOW,
        createdByUserId: seed.userId,
      });
      if (status !== 'starting')
        tx.execution.runs.transition({
          workspaceId: seed.workspaceId,
          runId,
          expectedStatuses: ['starting'],
          toStatus: status,
          occurredAt: SEED_NOW,
          ...(['finished', 'failed', 'cancelled', 'interrupted'].includes(status)
            ? { finishedAt: SEED_NOW }
            : {}),
        });
      // Other events first, so a run's events are not only its end.
      tx.execution.runEvents.append({
        id: asAgentRunEventId(randomUUID()),
        workspaceId: seed.workspaceId,
        runId,
        occurredAt: SEED_NOW,
        kind: 'notice',
        payload: { category: 'other', message: 'notice' },
      });
      if (ending !== undefined) ended(runId, ending, tx.execution);
      tx.maintenance.registerRunDirectory(runId, `/fixture/runs/${runId}`, 7);
    });
    return runId;
  };
  const correlated = () => {
    const database = new Database(temporary.databasePath, { readonly: true });
    try {
      const rows = database.prepare(CORRELATED).all() as (Record<string, unknown> & {
        readonly runId: string;
      })[];
      return rows.map((row) => ({
        ...row,
        eligible: row.eligible === 1,
        buildEligible: row.buildEligible === 1,
      }));
    } finally {
      database.close();
    }
  };
  return { storage, worktree, run, ended, correlated };
}

const byRun = <T extends { readonly runId: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => a.runId.localeCompare(b.runId));

const STATUSES: readonly AgentRunStatus[] = [
  'finished',
  'failed',
  'cancelled',
  'interrupted',
  'running',
];
const ENDINGS: readonly Ending[] = [
  { exitCode: 0 },
  { exitCode: 1 },
  { signal: 'SIGTERM' },
  { status: 'failed' },
  undefined,
];

it('gives the rows the correlated query gave, for every status, worktree and ending', () => {
  const f = fixture();
  // Merged and removed; active; merged and removed with a live run beside; removed unmerged.
  const trees = [
    f.worktree('merged', true, true),
    f.worktree('active', false, false),
    f.worktree('live-beside', true, true),
    f.worktree('unmerged', false, true),
  ];
  for (const tree of trees)
    for (const status of STATUSES)
      for (const ending of ENDINGS)
        if (status !== 'running' || tree === trees[2]) f.run(tree, status, ending);
  const rows = byRun(f.storage.maintenance.directories());
  expect(rows).toEqual(byRun(f.correlated()));
  // Every combination the predicates tell apart is present.
  expect(rows.some((row) => row.eligible)).toBe(true);
  expect(rows.some((row) => row.buildEligible && !row.eligible)).toBe(true);
  expect(rows.some((row) => !row.buildEligible && row.worktreeId === trees[0])).toBe(true);
  // A worktree's and a run's directories are the full list's.
  for (const tree of trees)
    expect(byRun(f.storage.maintenance.directories({ worktreeId: tree }))).toEqual(
      rows.filter((row) => row.worktreeId === tree),
    );
  const one = rows[3];
  expect(f.storage.maintenance.directories({ runId: one?.runId })).toEqual([one]);
});

it('sees a run end that the journal records after an earlier read', () => {
  const f = fixture();
  const tree = f.worktree('merged', true, true);
  const runId = f.run(tree, 'finished', undefined);
  expect(f.storage.maintenance.directories()[0]?.buildEligible).toBe(false);
  f.ended(runId, { exitCode: 0 });
  expect(f.storage.maintenance.directories()[0]?.buildEligible).toBe(true);
  expect(byRun(f.storage.maintenance.directories())).toEqual(byRun(f.correlated()));
});

it('keeps nothing a transaction that rolls back recorded', () => {
  const f = fixture();
  const tree = f.worktree('merged', true, true);
  const runId = f.run(tree, 'finished', undefined);
  expect(() =>
    f.storage.transaction((tx) => {
      f.ended(runId, { exitCode: 0 }, tx.execution);
      // Read inside the transaction: its own event counts there.
      expect(tx.maintenance.directories()[0]?.buildEligible).toBe(true);
      throw new Error('rolled back');
    }),
  ).toThrow('rolled back');
  expect(f.storage.maintenance.directories()[0]?.buildEligible).toBe(false);
  expect(byRun(f.storage.maintenance.directories())).toEqual(byRun(f.correlated()));
});
