import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { AgentBackend } from '@craftingtable/agents';
import type { AgentBackendKind, WorkspaceId } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { observeDecodes, type PersistedRecordKind } from '@craftingtable/storage';
import { createServices } from './composition.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import type { AuthContext } from './services/auth-service.js';

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
 * Retained evidence: every decoded evidence value is held weakly, with its size; after the
 * reads, their results are dropped and the heap is collected, and the sizes of the values
 * still alive are summed per map. The daemon's services stay alive throughout, so a cache in
 * any of them counts. Git is stubbed, as in the other replays.
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
  readonly state: 'after-insert' | 'in-transaction' | 'warm';
  /** Bytes of evidence documents decoded, by kind. */
  readonly bytes: Readonly<Partial<Record<PersistedRecordKind, number>>>;
  readonly total: number;
}
export interface EvidenceDecodeReplay {
  readonly reads: readonly DecodeMeasure[];
  /** Decoded evidence still alive after the reads, by map, in bytes as stored. */
  readonly retained: Readonly<Record<string, number>>;
  /** The heap the reads left behind after collection, everything included, in bytes. */
  readonly heapGrowth: number;
}

/** `gc()`, exposed for this process only. */
function collector(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

/** Runs over `database`, which it may migrate and write: pass a copy. */
export async function replayEvidenceDecodes(
  database: string,
  dataDir: string,
  now: Date,
): Promise<EvidenceDecodeReplay> {
  const gc = collector();
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
    const views: { name: string; definitionId?: string; render: () => unknown }[] = [];
    for (const ws of storage.workspaces.listActiveIds())
      for (const roadmap of storage.roadmaps.list(ws)) {
        const user = storage.users.findById(roadmap.createdByUserId);
        if (!user || !storage.workspaces.findAuthorized(user.id, ws)) continue;
        // The views check membership only; no session is read.
        const context = { user } as AuthContext;
        const name = roadmap.definition.name;
        views.push({
          name: `roadmap-view ${name}`,
          render: () => services.roadmapService.page(context, ws as WorkspaceId, roadmap.id),
        });
        const selection = roadmap.definition.crossProject;
        if (selection)
          views.push({
            name: `cross-project-preview ${name}`,
            definitionId: selection.definitionId,
            render: () =>
              services.crossProjectService.view(context, ws as WorkspaceId, {
                definitionId: selection.definitionId,
                bindingRevision: selection.bindingRevision,
                targetId: selection.targetId,
                selection: selection.selection,
              }),
          });
      }

    const alive: { ref: WeakRef<object>; bytes: number; definitionId: string }[] = [];
    const measure = (
      read: (typeof views)[number],
      state: DecodeMeasure['state'],
    ): DecodeMeasure => {
      const bytes: Partial<Record<PersistedRecordKind, number>> = {};
      observeDecodes(
        (kind, size, record) => {
          if (!EVIDENCE.has(kind)) return;
          bytes[kind] = (bytes[kind] ?? 0) + size;
          if (typeof record === 'object' && record !== null)
            alive.push({
              ref: new WeakRef(record),
              bytes: size,
              definitionId:
                (record as { definitionId?: string }).definitionId ??
                `decision ${(record as { submissionId?: string }).submissionId ?? ''}`,
            });
        },
        () => {
          read.render();
        },
      );
      return {
        read: read.name,
        state,
        bytes,
        total: Object.values(bytes).reduce((sum, n) => sum + n, 0),
      };
    };

    // A first pass loads code and the services' own state; it is not measured.
    for (const view of views) view.render();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    alive.length = 0;

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

    // Let this job's weak references go, then collect.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    const retained: Record<string, number> = {};
    for (const value of alive)
      if (value.ref.deref())
        retained[value.definitionId] = (retained[value.definitionId] ?? 0) + value.bytes;
    return { reads, retained, heapGrowth: process.memoryUsage().heapUsed - heapBefore };
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
    const over = read.total > DECODE_BOUND_BYTES;
    withinBounds &&= !over;
    lines.push(
      `${read.state.padEnd(15)}${read.read}: decoded ${mb(read.total)} of evidence${over ? ' [over 0.5 MB]' : ''} (${Object.entries(
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
      ? 'PASS: every read decodes at most 0.5 MB of evidence and every map retains at most 1 MB'
      : 'FAIL: a read or a map is over its bound',
  );
  return { text: `${lines.join('\n')}\n`, withinBounds };
}
