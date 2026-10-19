import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { workCycleSchema } from '@craftingtable/contracts';
import {
  cycleActions,
  cycleStop,
  heldStop,
  type PhaseBlocker,
  stopCode,
  type WorkCycle,
  type WorkCycleId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { discoverMigrations, openDatabase, runMigrations } from '@craftingtable/storage';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cycleShapes, storeShapes } from '../../../packages/storage/test/cycle-shapes.js';
import { openDaemonStorage } from '../src/persisted-records.js';
import { checkTransition } from '../src/services/cycle/core/transitions.js';
import { cycleStep } from '../src/services/entry-waits.js';
import { testDataRoot } from './test-support.js';

/**
 * R-B4b's characterization (increment 1; program rule 3), and its proof that migration 0047 maps
 * every stored shape one to one (increment 2). `fixtures/cycle-shapes.json` holds what the readers
 * answered at a0dd0bb for every cycle record shape stored before R-B4b (`cycle-shapes.ts`), read
 * in that shape. Each row is now stored raw at schema 46, migrated by the daemon's own storage,
 * read back through its contract, and its readers must answer exactly the same. A blocker's
 * resource key is its own answer: the decoder read it from the message, the migration stores it
 * in the blocker's refs. The record is compared, never rewritten.
 */

const RECORD = join(import.meta.dirname, '../../../fixtures/cycle-shapes.json');
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
const recorded = JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, Json>;
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;

/** What each reader answers for a cycle record as the daemon reads it. */
function answers(cycle: WorkCycle): Json {
  const contract = workCycleSchema.safeParse(cycle);
  let keeps = 'kept';
  try {
    checkTransition(cycle, cycle, 'advance');
  } catch (error) {
    keeps = (error as Error).message;
  }
  const phase = cycle.waits?.phase;
  const design = cycle.waits?.design;
  const retired = cycle.retiredFinalization;
  return json({
    contract: contract.success ? 'valid' : contract.error.issues.map((i) => i.path.join('.')),
    stop: cycleStop(cycle),
    held: heldStop(cycle) ?? null,
    code: stopCode(cycle) ?? null,
    actions: cycleActions(cycle, cycle.currentRunId),
    entry: cycleStep(cycle),
    keeps,
    waits: {
      phase: phase
        ? {
            since: phase.since,
            blockers: phase.blockers.map((blocker: PhaseBlocker) => {
              const { resourceKey: _key, ...refs } = blocker.refs ?? {};
              return {
                ...blocker,
                refs: Object.keys(refs).length ? refs : undefined,
                // Stored since 0047, where the decoder recovered them (R-B4b increment 3).
                code: blocker.code,
                resourceKey: blocker.refs?.resourceKey ?? null,
              };
            }),
          }
        : null,
      design: design ? { since: design.since, requirements: design.requirements } : null,
    },
    attempt: cycle.attempt ?? {},
    retired: {
      polishRound: retired?.polishRound ?? null,
      deferredNits: retired?.deferredNits ?? null,
    },
  });
}

const rows = cycleShapes();
let directory: string;
const migrated = new Map<string, WorkCycle>();
beforeAll(() => {
  directory = mkdtempSync(join(testDataRoot(), 'craftingtable-cycle-shapes-'));
  const path = join(directory, 'state.sqlite');
  const database = openDatabase(path);
  runMigrations(database, discoverMigrations().slice(0, 46));
  const stored = storeShapes(database, rows);
  database.close();
  const storage = openDaemonStorage(path);
  try {
    for (const { row, record } of stored) {
      const cycle = storage.execution.cycles.find(
        record.workspaceId as WorkspaceId,
        record.id as WorkCycleId,
      );
      if (!cycle) throw new Error(`${row.name}: not read back`);
      // Stored under ids of its own (the unique indexes), read under the row's.
      const original = row.record as unknown as Pick<WorkCycle, 'id' | 'worktreeId' | 'workItemId'>;
      migrated.set(row.name, {
        ...cycle,
        id: original.id,
        worktreeId: original.worktreeId,
        ...(original.workItemId ? { workItemId: original.workItemId } : {}),
      });
    }
  } finally {
    storage.close();
  }
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('names each stored shape once, covers the survey, the decoders and every end, and its record', () => {
  // Recorded at a0dd0bb, on the code before R-B4b; compared here, never rewritten.
  const names = rows.map((row) => row.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.filter((name) => name.startsWith('stored: '))).toHaveLength(41);
  expect(names.filter((name) => name.startsWith('written: '))).toHaveLength(13);
  expect(names.filter((name) => name.startsWith('uncoded: '))).toHaveLength(27);
  expect(names.filter((name) => name.startsWith('stops: '))).toHaveLength(7);
  expect(names.filter((name) => name.startsWith('ended: '))).toHaveLength(8);
  expect(Object.keys(recorded).sort()).toEqual([...names].sort());
});

it.each(rows.map((row) => [row.name, row] as const))(
  '%s answers as before the migration',
  (name, row) => {
    const before = recorded[name] as { readonly held: Json; readonly stop: Json };
    // A record from before codes held no stop; the migration stores the one its decoder
    // recovered, the stop its readers already answered (R-B4 decision 8). Nothing else moves.
    const uncoded = !('attention' in row.record);
    const expected =
      uncoded && before.held === null ? { ...before, held: before.stop ?? null } : before;
    expect(answers(migrated.get(name) as WorkCycle)).toEqual(expected);
  },
);

it('lets a work-item cycle keep a retired polish round, never deferred nits, as before R-B4b', () => {
  // The contract's work-item rule refused only `deferredNits` before 0047 (increment 2 review, NIT-7).
  const cycle = [...migrated.values()].find((c) => c.workItemId !== undefined) as WorkCycle;
  const valid = (retiredFinalization: unknown) =>
    workCycleSchema.safeParse({ ...cycle, retiredFinalization }).success;
  expect(valid({ polishRound: 1 })).toBe(true);
  expect(valid({ deferredNits: [] })).toBe(false);
});
