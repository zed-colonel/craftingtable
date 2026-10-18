import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  AWAITING_MERGE_GATES,
  type CycleAttention,
  effectiveCycleAttention,
  type LegacyCycleStop,
  type PhaseBlocker,
  phaseBlockerCode,
  phaseBlockerResourceKey,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import {
  discoverMigrations,
  inspectMigrationStatus,
  MigrationValidationError,
  runMigrations,
} from '../src/migrations.js';
import { cycleShapes, type ShapeRow, type StoredCycle, storeShapes } from './cycle-shapes.js';
import { type DatabaseImage, imageOf, preservationProblems } from './migration-preservation.js';
import { testDataRoot } from './test-support.js';

/**
 * Migration 0047 (R-B4b; R-B4 decisions 5 to 8 and 11): every cycle's state rewritten in SQL into
 * the stop, waits, attempt and retired-finalization records, and codes for records written before
 * them, under a count guard. Its preservation test: every stored shape (increment 1's
 * characterization rows) becomes exactly what a TypeScript statement of the mapping, built on
 * the decoders, says, and nothing else in the database changes.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const migrations = discoverMigrations();
function at46() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0047-'));
  directories.push(directory);
  const path = join(directory, 'state.sqlite');
  const database = openDatabase(path);
  runMigrations(database, migrations.slice(0, 46));
  return { database, path };
}

type Json = StoredCycle[string];
const GATES = new Set<string>(AWAITING_MERGE_GATES);
const RESHAPED = [
  'attention',
  'phaseWait',
  'designWait',
  'stepGuidance',
  'housekeepingInstructions',
  'resultContinuations',
  'outputRepair',
  'providerRecovery',
  'polishRound',
  'deferredNits',
] as const;
const END_ACTIONS: Record<string, string> = {
  stop: 'operator-stopped',
  'roadmap-wound-down': 'roadmap-wound-down',
  'amendment-retired': 'amendment-retired',
};

/** The mapping, stated in TypeScript over the decoders: what 0047 must write for a row. */
function reshaped(row: ShapeRow, record: StoredCycle): StoredCycle {
  const status = record.status as string;
  const entered = (wanted: string) =>
    row.history.filter((entry, index) => {
      const previous = row.history[index - 1];
      return entry.status === wanted && previous?.status !== entry.status;
    });
  const out: Record<string, Json> = Object.fromEntries(
    Object.entries(record).filter(([key]) => !(RESHAPED as readonly string[]).includes(key)),
  );
  if (status === 'stopped' || status === 'completed') {
    const code =
      status === 'stopped'
        ? END_ACTIONS[entered('stopped')[0]!.action]!
        : row.scopeReceipt
          ? 'scope-evidence-recorded'
          : 'integrated';
    out.stop = {
      kind: 'ended',
      code,
      at: entered(status).at(-1)?.at ?? (record.updatedAt as string),
    };
  } else {
    const attention: CycleAttention | undefined =
      status === 'paused'
        ? (record.attention as unknown as CycleAttention | undefined)
        : effectiveCycleAttention(record as unknown as LegacyCycleStop);
    if (attention)
      out.stop = {
        kind: GATES.has(attention.code) ? 'gate' : 'attention',
        ...(attention as unknown as Record<string, Json>),
        since:
          entered(status === 'paused' ? 'needs-attention' : status).at(-1)?.at ??
          (record.updatedAt as string),
      };
  }
  const phase = record.phaseWait as { startedAt: string; blockers: PhaseBlocker[] } | null;
  const design = record.designWait as { startedAt: string; requirements: Json } | null;
  if (phase || design)
    out.waits = {
      ...(phase
        ? {
            phase: {
              since: phase.startedAt,
              blockers: phase.blockers.map((blocker) => {
                const code = phaseBlockerCode(blocker);
                const key = phaseBlockerResourceKey({ ...blocker, code });
                return {
                  ...blocker,
                  code,
                  ...(key && !blocker.refs?.resourceKey
                    ? { refs: { ...blocker.refs, resourceKey: key } }
                    : {}),
                } as unknown as Json;
              }),
            },
          }
        : {}),
      ...(design ? { design: { since: design.startedAt, requirements: design.requirements } } : {}),
    };
  const present = (keys: readonly string[]) =>
    Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]!]));
  const attempt = present([
    'stepGuidance',
    'housekeepingInstructions',
    'resultContinuations',
    'outputRepair',
    'providerRecovery',
  ]);
  if (Object.keys(attempt).length) out.attempt = attempt;
  const retired = present(['polishRound', 'deferredNits']);
  if (Object.keys(retired).length) out.retiredFinalization = retired;
  return out;
}

const migrated = (database: Database.Database, id: Json | undefined) =>
  JSON.parse(
    (
      database.prepare('SELECT state_json FROM work_cycles WHERE id = ?').get(id) as {
        state_json: string;
      }
    ).state_json,
  ) as StoredCycle;

/** An image with the rows 0047 rewrites, and the catalog rows it adds, left out. */
function unrewritten(image: DatabaseImage): DatabaseImage {
  const tables = { ...image.tables };
  for (const name of ['work_cycles', 'roadmaps'])
    tables[name] = (tables[name] ?? []).map(({ state_json: _state, ...row }) => row);
  tables.stored_vocabulary = (tables.stored_vocabulary ?? []).filter(
    (row) => row.introduced_in_schema !== 47,
  );
  return { ...image, tables };
}

describe('migration 0047: the cycle state shape', () => {
  it('maps every stored shape one to one, as the mapping says, and changes nothing else', () => {
    const { database } = at46();
    const stored = storeShapes(database, cycleShapes());
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 47));
    for (const { row, record } of stored)
      expect(migrated(database, record.id), row.name).toEqual(reshaped(row, record));
    expect(preservationProblems(unrewritten(before), unrewritten(imageOf(database)))).toEqual([]);
    database.close();
  });

  it('keeps the stored forms of the per-step fields: empty text, zero and null', () => {
    const { database } = at46();
    const [stored] = storeShapes(
      database,
      cycleShapes().filter(
        (row) => row.name === 'stored: running - null null - empty-str zero null null - -',
      ),
    );
    runMigrations(database, migrations.slice(0, 47));
    const after = migrated(database, stored!.record.id);
    expect(after.attempt).toEqual({
      housekeepingInstructions: '',
      resultContinuations: 0,
      outputRepair: null,
      providerRecovery: null,
    });
    // A wait stored as null is no wait.
    expect(after.waits).toBeUndefined();
    database.close();
  });

  it("reads a resource blocker's key as the decoder does, its colons included", () => {
    const { database } = at46();
    const base = cycleShapes().find((row) => row.name === 'uncoded: phase blockers')!;
    const messages = [
      'Waiting for a:b: 1/1 reservations occupied.',
      'Waiting for :x',
      'Waiting for x',
      'Waiting for host:',
      'Waiting for  spaced: 1/1',
      'Waiting for local-development:1/1',
    ];
    const rows = messages.map((message, index) => ({
      ...base,
      name: `key ${index}`,
      record: {
        ...base.record,
        phaseWait: { startedAt: base.record.updatedAt!, blockers: [{ kind: 'resource', message }] },
      },
    }));
    const stored = storeShapes(database, rows);
    runMigrations(database, migrations.slice(0, 47));
    for (const { row, record } of stored)
      expect(migrated(database, record.id), row.name).toEqual(reshaped(row, record));
    database.close();
  });

  it('codes a roadmap stop and an entry hold stored without one, as the decoders do', () => {
    const { database } = at46();
    database.pragma('foreign_keys = OFF');
    // One active roadmap per workspace (`roadmap_workspace_delegation`).
    const roadmap = (id: string, state: Record<string, unknown>) =>
      database
        .prepare(
          'INSERT INTO roadmaps (id, workspace_id, status, version, state_json) VALUES (?, ?, ?, 1, ?)',
        )
        .run(
          id,
          `ws-${id}`,
          state.status,
          JSON.stringify({ id, workspaceId: `ws-${id}`, version: 1, ...state }),
        );
    roadmap('r1', { status: 'needs-attention', reason: 'Daemon restarted. Resume the roadmap.' });
    roadmap('r2', {
      status: 'paused',
      reason: 'Paused.',
      entryHolds: {
        a: { status: 'needs-attention', reason: 'Held before codes.' },
        b: { status: 'paused', reason: 'Paused by the operator.' },
        c: {
          status: 'needs-attention',
          reason: 'Entry blocked.',
          attention: { code: 'entry-blocked', owner: 'operator' },
        },
      },
    });
    roadmap('r3', { status: 'needs-attention', reason: 'Something an older release said.' });
    runMigrations(database, migrations.slice(0, 47));
    const state = (id: string) =>
      JSON.parse(
        (
          database.prepare('SELECT state_json FROM roadmaps WHERE id = ?').get(id) as {
            state_json: string;
          }
        ).state_json,
      );
    expect(state('r1').attention).toEqual({ code: 'restart-resume', owner: 'operator' });
    expect(state('r3').attention).toEqual({ code: 'legacy-attention', owner: 'operator' });
    expect(state('r2').attention).toBeUndefined();
    expect(state('r2').entryHolds).toEqual({
      a: {
        status: 'needs-attention',
        reason: 'Held before codes.',
        attention: { code: 'legacy-attention', owner: 'operator' },
      },
      b: { status: 'paused', reason: 'Paused by the operator.' },
      c: {
        status: 'needs-attention',
        reason: 'Entry blocked.',
        attention: { code: 'entry-blocked', owner: 'operator' },
      },
    });
    database.close();
  });

  it.each([
    [
      'a stopped cycle that entered stopped by an action it does not know',
      (row: ShapeRow): ShapeRow => ({
        ...row,
        history: [
          { action: 'start', status: 'running', at: row.history[0]!.at },
          { action: 'retire', status: 'stopped', at: row.history[0]!.at },
        ],
      }),
    ],
    [
      'a stopped cycle with no audit row that entered stopped',
      (row: ShapeRow): ShapeRow => ({ ...row, history: [] }),
    ],
    [
      'a running cycle carrying a stop',
      (row: ShapeRow): ShapeRow => ({
        ...row,
        record: {
          ...row.record,
          status: 'running',
          attention: { code: 'step-incomplete', owner: 'operator' },
        },
      }),
    ],
  ])('rolls back whole on %s, and the release stays at schema 46', (_name, change) => {
    const { database, path } = at46();
    const base = cycleShapes().find((row) => row.name === 'ended: stopped by the operator')!;
    storeShapes(database, [change(base)]);
    const before = imageOf(database);
    expect(() => runMigrations(database, migrations.slice(0, 47))).toThrow();
    expect(imageOf(database)).toEqual(before);
    database.close();
    expect(inspectMigrationStatus(path, migrations.slice(0, 46)).currentVersion).toBe(46);
  });

  it('records its stored vocabulary in the catalog', () => {
    const { database } = at46();
    runMigrations(database, migrations.slice(0, 47));
    expect(
      database
        .prepare(
          'SELECT kind, value FROM stored_vocabulary WHERE introduced_in_schema = 47 ORDER BY kind, value',
        )
        .all(),
    ).toEqual([
      { kind: 'cycle-end', value: 'amendment-retired' },
      { kind: 'cycle-end', value: 'integrated' },
      { kind: 'cycle-end', value: 'operator-stopped' },
      { kind: 'cycle-end', value: 'roadmap-wound-down' },
      { kind: 'cycle-end', value: 'scope-evidence-recorded' },
      { kind: 'cycle-field', value: 'attempt' },
      { kind: 'cycle-field', value: 'retiredFinalization' },
      { kind: 'cycle-field', value: 'stop' },
      { kind: 'cycle-field', value: 'waits' },
    ]);
    database.close();
  });

  it('is refused by a schema-46 release, so a rollback across it is refused', () => {
    const { database, path } = at46();
    runMigrations(database, migrations.slice(0, 47));
    database.close();
    expect(() => inspectMigrationStatus(path, migrations.slice(0, 46))).toThrow(
      MigrationValidationError,
    );
  });
});
