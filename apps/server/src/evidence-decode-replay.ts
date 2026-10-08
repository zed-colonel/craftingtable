import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentBackend } from '@craftingtable/agents';
import type { AgentBackendKind, WorkspaceId } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { observeDecodes, type PersistedRecordKind } from '@craftingtable/storage';
import { createServices } from './composition.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import type { AuthContext } from './services/auth-service.js';
import { resolveScope, scopeEvidenceLedger } from './services/execution-scope.js';

/**
 * Measures how much evidence the roadmap view and the cross-project preview decode, and how
 * much decoded evidence the daemon keeps afterwards, over a database snapshot (R-H4,
 * PERF-08). Before R-H4's head table each read decoded every submission of the workspace
 * (9.3 MB on the live map, 2026-10-06) whenever no warm cache could answer it, and the cache
 * kept all of it.
 *
 * Storage reports every document a read decodes (`observeDecodes`): its kind, its size in
 * UTF-8 bytes and the decoded value. The evidence kinds are counted per read:
 *
 * - `after-insert`: the first read after a submission is added (a copy of the map's newest
 *   record under a new id, on the private copy), when no cache can answer;
 * - `in-transaction`: the same reads inside a write transaction, as an evidence command runs
 *   them, which is then rolled back;
 * - `warm`: the reads repeated.
 *
 * Each open scope's evidence ledger, which a run is given at its start, is read the same way
 * for comparison; it carries accepted submissions' full records on purpose, so it is not held to
 * the 0.5 MB bound. No read may decode more head bytes than all the maps' heads together: a
 * read that decodes a head twice is a loop re-reading the map, and fails the run.
 *
 * Retained evidence: every decoded evidence value is registered with a `FinalizationRegistry`,
 * with its size; after the reads, their results are dropped and the heap is collected, and the
 * sizes of the values not yet finalized are summed per map. A registry, unlike a `WeakRef`,
 * keeps nothing alive while a read runs, so a read that decodes a lot is not held in memory by
 * the measurement; a value whose finalizer has not run yet counts as retained, which errs
 * towards failing. The daemon's services stay alive throughout, so a cache in any of them
 * counts. Git is stubbed, as in the other replays.
 *
 * Collecting needs `gc()`: run it with `NODE_OPTIONS='--expose-gc --max-old-space-size=2048'`,
 * the second so that a runaway read fails fast.
 */

const EVIDENCE: ReadonlySet<PersistedRecordKind> = new Set([
  'evidence-submission',
  'evidence-submission-head',
  'evidence-decision',
]);

/** Bounds from R-H4's done-when. */
export const DECODE_BOUND_BYTES = 500_000;
export const RETAINED_BOUND_BYTES = 1_000_000;

export interface DecodeMeasure {
  readonly read: string;
  /** Held to the done-when's bound: the roadmap view and the cross-project preview. */
  readonly bounded: boolean;
  readonly state: 'after-insert' | 'in-transaction' | 'warm';
  /** Bytes of evidence documents decoded, by kind. */
  readonly bytes: Readonly<Partial<Record<PersistedRecordKind, number>>>;
  readonly total: number;
  /** More head bytes than every map's heads together: some head was decoded twice. */
  readonly repeatedHeads: boolean;
}
export interface EvidenceDecodeReplay {
  readonly reads: readonly DecodeMeasure[];
  /** Decoded evidence still alive after the reads, by map, in bytes as stored. */
  readonly retained: Readonly<Record<string, number>>;
  /** The heap the reads left behind after collection, everything included, in bytes. */
  readonly heapGrowth: number;
}

/** `gc()`, when the process was started with `--expose-gc`. */
export function exposedCollector(): (() => void) | undefined {
  const gc = (globalThis as { gc?: unknown }).gc;
  return typeof gc === 'function' ? (gc as () => void) : undefined;
}

/** Lets pending finalizers run: they are queued as tasks after a collection. */
async function settle(gc: () => void) {
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Runs over `database`, which it may migrate and write: pass a copy. */
export async function replayEvidenceDecodes(
  database: string,
  dataDir: string,
  now: Date,
  gc: () => void,
): Promise<EvidenceDecodeReplay> {
  const storage = openDaemonStorage(database);
  try {
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: dataDir,
      // Its own credentials file, never the operator's (R-G9).
      CRAFTINGTABLE_CONFIG_DIR: join(dataDir, 'config'),
      CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
      CRAFTINGTABLE_WEB_DIST: '',
    });
    const git = new Proxy({} as GitOperations, {
      get: (_target, method) => async () => ({
        ok: false,
        failure: { kind: 'spawn-failed', message: `Replay has no Git (${String(method)}).` },
      }),
    });
    const services = await createServices(storage, config, {
      gitOperations: git,
      agentBackends: new Map<AgentBackendKind, AgentBackend>(),
      now: () => now,
      notificationTransport: { send: async () => ({ status: 'accepted' }) },
      restartRecovery: false,
    });
    const views: { name: string; bounded: boolean; render: () => unknown }[] = [];
    for (const ws of storage.workspaces.listActiveIds())
      for (const roadmap of storage.roadmaps.list(ws)) {
        const user = storage.users.findById(roadmap.createdByUserId);
        if (!user || !storage.workspaces.findAuthorized(user.id, ws)) continue;
        // The views check membership only; no session is read.
        const context = { user } as AuthContext;
        const name = roadmap.definition.name;
        views.push({
          name: `roadmap-view ${name}`,
          bounded: true,
          render: () => services.roadmapService.page(context, ws as WorkspaceId, roadmap.id),
        });
        const selection = roadmap.definition.crossProject;
        if (selection)
          views.push({
            name: `cross-project-preview ${name}`,
            bounded: true,
            render: () =>
              services.crossProjectService.view(context, ws as WorkspaceId, {
                definitionId: selection.definitionId,
                bindingRevision: selection.bindingRevision,
                targetId: selection.targetId,
                selection: selection.selection,
              }),
          });
      }

    // Not bounded, for comparison: each open scope's evidence ledger, which a run of that scope
    // is given at its start (it carries accepted submissions' full records on purpose).
    for (const cycle of storage.execution.cycles.listActive())
      if (cycle.executionScope && cycle.workItemId) {
        const { workspaceId, workItemId, executionScope } = cycle;
        views.push({
          name: `scope-ledger ${executionScope.sourceId}`,
          bounded: false,
          render: () =>
            scopeEvidenceLedger(
              storage,
              resolveScope(storage, workspaceId, workItemId, executionScope),
            ),
        });
      }

    // Decisions name only their submission: they count towards that submission's map.
    const mapOf = new Map<string, string>();
    for (const ws of storage.workspaces.listActiveIds())
      for (const d of storage.imports.definitions(ws))
        for (const head of storage.runtimeEvidence.submissions(ws, d.id)) mapOf.set(head.id, d.id);
    const alive = new Map<number, { bytes: number; definitionId: string }>();
    const finalized = new FinalizationRegistry<number>((token) => alive.delete(token));
    let tokens = 0;
    const measure = (
      read: (typeof views)[number],
      state: DecodeMeasure['state'],
    ): DecodeMeasure => {
      const bytes: Partial<Record<PersistedRecordKind, number>> = {};
      observeDecodes(
        (kind, size, record) => {
          if (!EVIDENCE.has(kind)) return;
          bytes[kind] = (bytes[kind] ?? 0) + size;
          if (typeof record !== 'object' || record === null) return;
          const token = tokens++;
          alive.set(token, {
            bytes: size,
            definitionId:
              (record as { definitionId?: string }).definitionId ??
              mapOf.get((record as { submissionId?: string }).submissionId ?? '') ??
              'unknown map',
          });
          finalized.register(record, token);
        },
        () => {
          read.render();
        },
      );
      return {
        read: read.name,
        bounded: read.bounded,
        state,
        bytes,
        total: Object.values(bytes).reduce((sum, n) => sum + n, 0),
        repeatedHeads: false,
      };
    };

    // A first pass loads code and the services' own state; it is not measured.
    for (const view of views) view.render();
    await settle(gc);
    const heapBefore = process.memoryUsage().heapUsed;

    const reads: DecodeMeasure[] = [];
    // A new submission on each map the views read, so no cache can answer the next read.
    const definitions = new Map<string, WorkspaceId>();
    for (const ws of storage.workspaces.listActiveIds())
      for (const roadmap of storage.roadmaps.list(ws))
        if (roadmap.definition.crossProject)
          definitions.set(roadmap.definition.crossProject.definitionId, ws as WorkspaceId);
    for (const [definitionId, ws] of definitions) {
      const newest = storage.runtimeEvidence.submissions(ws, definitionId)[0];
      const record = newest && storage.runtimeEvidence.submission(ws, definitionId, newest.id);
      if (record)
        storage.transaction((tx) =>
          tx.runtimeEvidence.addSubmission({ ...record, id: randomUUID() }),
        );
    }
    // Every map's heads, decoded once: no read needs more (R-H4 review).
    let headBytes = 0;
    observeDecodes(
      (kind, size) => {
        if (kind === 'evidence-submission-head') headBytes += size;
      },
      () => {
        for (const ws of storage.workspaces.listActiveIds())
          for (const d of storage.imports.definitions(ws))
            storage.runtimeEvidence.submissions(ws, d.id);
      },
    );
    const measured = (read: DecodeMeasure): DecodeMeasure => ({
      ...read,
      repeatedHeads: (read.bytes['evidence-submission-head'] ?? 0) > headBytes,
    });
    for (const view of views) reads.push(measure(view, 'after-insert'));
    const rollback = new Error('measured');
    try {
      storage.transaction(() => {
        for (const view of views) reads.push(measure(view, 'in-transaction'));
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    for (const view of views) reads.push(measure(view, 'warm'));

    await settle(gc);
    const retained: Record<string, number> = {};
    for (const value of alive.values())
      retained[value.definitionId] = (retained[value.definitionId] ?? 0) + value.bytes;
    return {
      reads: reads.map(measured),
      retained,
      heapGrowth: process.memoryUsage().heapUsed - heapBefore,
    };
  } finally {
    storage.close();
  }
}

/** A text report, with each read and map checked against R-H4's bounds. */
export function formatEvidenceDecodes(replay: EvidenceDecodeReplay): {
  text: string;
  withinBounds: boolean;
} {
  const lines: string[] = [];
  let withinBounds = true;
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(3)} MB`;
  for (const read of replay.reads) {
    const over = read.bounded && read.total > DECODE_BOUND_BYTES;
    withinBounds &&= !over && !read.repeatedHeads;
    lines.push(
      `${read.state.padEnd(15)}${read.read}: decoded ${mb(read.total)} of evidence${over ? ' [over 0.5 MB]' : ''}${read.bounded ? '' : ' [not bounded]'}${read.repeatedHeads ? ' [decodes a head more than once]' : ''} (${Object.entries(
        read.bytes,
      )
        .map(([kind, bytes]) => `${kind} ${bytes}`)
        .join(', ')})`,
    );
  }
  const maps = Object.entries(replay.retained);
  if (!maps.length) lines.push('retained evidence: none');
  for (const [map, bytes] of maps) {
    const over = bytes > RETAINED_BOUND_BYTES;
    withinBounds &&= !over;
    lines.push(`retained evidence of ${map}: ${mb(bytes)}${over ? ' [over 1 MB]' : ''}`);
  }
  lines.push(
    `heap growth after the reads, everything included: ${mb(replay.heapGrowth)}`,
    withinBounds
      ? 'PASS: the views decode at most 0.5 MB of evidence, no read decodes a head twice, and every map retains at most 1 MB'
      : 'FAIL: a read or a map is over its bound',
  );
  return { text: `${lines.join('\n')}\n`, withinBounds };
}
