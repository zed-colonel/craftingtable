import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentBackend } from '@craftingtable/agents';
import type {
  AgentBackendKind,
  EvidenceSubmission,
  EvidenceSubmissionHead,
  WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import {
  type CraftingTableStorage,
  type PersistedRecordKind,
  startObservingDecodes,
} from '@craftingtable/storage';
import { createServices } from './composition.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import type { AuthContext } from './services/auth-service.js';
import { resolveScope, scopeEvidenceLedger } from './services/execution-scope.js';

/**
 * Measures what evidence the roadmap view and the cross-project preview decode, and how much
 * decoded evidence the daemon keeps afterwards, over a database snapshot (R-H4, PERF-08).
 * Before R-H4's head table each read decoded every submission of the workspace (9.3 MB on the
 * live map, 2026-10-06) whenever no warm cache could answer it, and the cache kept all of it.
 *
 * What it holds the reads to (done-when b as restated by the operator 2026-10-07, and c):
 *
 * - the roadmap view and the cross-project preview decode only heads, and full records only of
 *   staged decisions (an architecture decision limited to clauses: the saved plan's facts digest
 *   them whole), never another submission's record and so never artifact contents;
 * - no read, a scope's evidence ledger included, decodes a head more than once;
 * - each map retains at most 1 MB of decoded evidence.
 *
 * The bytes decoded are reported, not bounded. Storage reports every document a read decodes
 * (`observeDecodes`): its kind, its size in UTF-8 bytes and the decoded value. Each view is read
 * three ways:
 *
 * - `after-insert`: the first read after a submission is added (a copy of the map's newest
 *   record under a new id, on the private copy), when no cache can answer;
 * - `in-transaction`: the same reads inside a write transaction, as an evidence command runs
 *   them, which is then rolled back;
 * - `warm`: the reads repeated.
 *
 * Each open scope's evidence ledger, which a run is given at its start, is read the same way;
 * it carries accepted submissions' full records on purpose, so only the head rule holds it.
 *
 * Retained evidence: every evidence value decoded from the moment the snapshot is opened (the
 * services' start and an unmeasured warm-up pass included) is registered with a `FinalizationRegistry`, with its size; after the reads,
 * their results are dropped and the heap is collected, and the sizes of the values not yet
 * finalized are summed per map. A registry, unlike a `WeakRef`, keeps nothing alive while a
 * read runs; a value whose finalizer has not run yet counts as retained, which errs towards
 * failing. The daemon's services stay alive throughout, so a cache in any of them counts. The
 * heap growth reported is measured from before the warm-up.
 *
 * The services are built with the snapshot's stored host capacities, so the saved plans read as
 * the daemon reads them. Git is stubbed, as in the other replays. `emulate` puts back a cache
 * the head table replaced, for the tool's self-check: the measurement must fail against it.
 *
 * Collecting needs `gc()`: run it with `NODE_OPTIONS='--expose-gc --max-old-space-size=2048'`,
 * the second so that a runaway read fails fast.
 */

const EVIDENCE: ReadonlySet<PersistedRecordKind> = new Set([
  'evidence-submission',
  'evidence-submission-head',
  'evidence-decision',
]);

/** Retained evidence allowed per map (done-when c). */
export const RETAINED_BOUND_BYTES = 1_000_000;

/**
 * A cache the head table replaced, put back for the self-check: R-D5's, which decoded a map's
 * full records again whenever its count changed and kept them, and one that keeps each record
 * by id, decoding it once.
 */
export type CacheEmulation = 'count-keyed' | 'id-keyed';

export interface DecodeMeasure {
  readonly read: string;
  /** The roadmap view or the cross-project preview, held to done-when (b). */
  readonly view: boolean;
  readonly state: 'after-insert' | 'in-transaction' | 'warm';
  /** Bytes of evidence documents decoded, by kind. */
  readonly bytes: Readonly<Partial<Record<PersistedRecordKind, number>>>;
  readonly total: number;
  /** Distinct heads decoded, and those decoded more than once. */
  readonly heads: number;
  readonly repeatedHeads: readonly string[];
  /** Full records decoded: staged decisions, and every other. */
  readonly stagedRecords: readonly string[];
  readonly otherRecords: readonly string[];
}
export interface EvidenceDecodeReplay {
  readonly emulated?: CacheEmulation;
  readonly reads: readonly DecodeMeasure[];
  /** Decoded evidence still alive after the reads, by map, in bytes as stored. */
  readonly retained: Readonly<Record<string, number>>;
  /** The same values by kind, with their ids, to find what holds them. */
  readonly retainedValues: readonly { kind: PersistedRecordKind; id: string; bytes: number }[];
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

type EvidenceRepository = {
  submissions(ws: string, definitionId: string): readonly EvidenceSubmissionHead[];
  submission(ws: string, definitionId: string, id: string): EvidenceSubmission | undefined;
};

/** Patches the evidence repository's class with `emulation`; returns the undo. */
function emulateCache(storage: CraftingTableStorage, emulation: CacheEmulation): () => void {
  const repository = Object.getPrototypeOf(storage.runtimeEvidence) as EvidenceRepository;
  const { submissions, submission } = repository;
  const kept = new Map<string, unknown>();
  repository.submissions = function (this: EvidenceRepository, ws, definitionId) {
    const heads = submissions.call(this, ws, definitionId);
    const full = (id: string) => submission.call(this, ws, definitionId, id);
    if (emulation === 'count-keyed') {
      const key = `${ws}:${definitionId}`;
      const cached = kept.get(key) as { count: number } | undefined;
      if (cached?.count !== heads.length)
        kept.set(key, { count: heads.length, records: heads.map((head) => full(head.id)) });
    } else for (const head of heads) if (!kept.has(head.id)) kept.set(head.id, full(head.id));
    return heads;
  };
  return () => {
    repository.submissions = submissions;
  };
}

/**
 * Each submission's map, by id: decisions name only their submission, and count towards its map.
 * A function of its own, so its loop's last head is not kept alive by the measurement's frame.
 */
function mapSubmissions(storage: CraftingTableStorage, mapOf: Map<string, string>) {
  for (const ws of storage.workspaces.listActiveIds())
    for (const d of storage.imports.definitions(ws))
      for (const head of storage.runtimeEvidence.submissions(ws, d.id)) mapOf.set(head.id, d.id);
}

/**
 * A new submission on each map a cross-project roadmap reads, a copy of its newest record under
 * a new id, so no cache can answer the next read. A function of its own, so the records it reads
 * are not kept alive by the measurement's own frame.
 */
function insertCopies(storage: CraftingTableStorage, mapOf: Map<string, string>) {
  const definitions = new Map<string, WorkspaceId>();
  for (const ws of storage.workspaces.listActiveIds())
    for (const roadmap of storage.roadmaps.list(ws))
      if (roadmap.definition.crossProject)
        definitions.set(roadmap.definition.crossProject.definitionId, ws as WorkspaceId);
  for (const [definitionId, ws] of definitions) {
    const newest = storage.runtimeEvidence.submissions(ws, definitionId)[0];
    const record = newest && storage.runtimeEvidence.submission(ws, definitionId, newest.id);
    if (!record) continue;
    const copy = { ...record, id: randomUUID() };
    mapOf.set(copy.id, definitionId);
    storage.transaction((tx) => tx.runtimeEvidence.addSubmission(copy));
  }
}

/** Runs over `database`, which it may migrate and write: pass a copy. */
export async function replayEvidenceDecodes(
  database: string,
  dataDir: string,
  now: Date,
  gc: () => void,
  emulate?: CacheEmulation,
): Promise<EvidenceDecodeReplay> {
  const storage = openDaemonStorage(database);
  // Every evidence value decoded from here on is registered, whatever reads it; a measured read
  // also counts what it decodes.
  const alive = new Map<
    number,
    { bytes: number; definitionId: string; kind: PersistedRecordKind; id: string }
  >();
  const finalized = new FinalizationRegistry<number>((token) => alive.delete(token));
  const mapOf = new Map<string, string>();
  let tokens = 0;
  let counting: ((kind: PersistedRecordKind, bytes: number, record: object) => void) | undefined;
  const stopObserving = startObservingDecodes((kind, size, record) => {
    if (!EVIDENCE.has(kind) || typeof record !== 'object' || record === null) return;
    const token = tokens++;
    alive.set(token, {
      bytes: size,
      kind,
      id: (record as { id?: string }).id ?? '',
      definitionId:
        (record as { definitionId?: string }).definitionId ??
        mapOf.get((record as { submissionId?: string }).submissionId ?? '') ??
        'unknown map',
    });
    finalized.register(record, token);
    counting?.(kind, size, record);
  });
  const undo = emulate ? emulateCache(storage, emulate) : undefined;
  try {
    await settle(gc);
    const heapBefore = process.memoryUsage().heapUsed;
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: dataDir,
      // Its own credentials file, never the operator's (R-G9).
      CRAFTINGTABLE_CONFIG_DIR: join(dataDir, 'config'),
      CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
      CRAFTINGTABLE_WEB_DIST: '',
      // As stored: building the services writes these into the host limits, which the saved
      // plans' facts include, so a default would make every accepted plan read as changed.
      CRAFTINGTABLE_DEVELOPMENT_CAPACITY: String(
        storage.phaseScheduling.capacity('local-development'),
      ),
      CRAFTINGTABLE_VERIFICATION_CAPACITY: String(
        storage.phaseScheduling.capacity('local-verification'),
      ),
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
    const reads: { name: string; view: boolean; render: () => unknown }[] = [];
    for (const ws of storage.workspaces.listActiveIds())
      for (const roadmap of storage.roadmaps.list(ws)) {
        const user = storage.users.findById(roadmap.createdByUserId);
        if (!user || !storage.workspaces.findAuthorized(user.id, ws)) continue;
        // The views check membership only; no session is read.
        const context = { user } as AuthContext;
        const name = roadmap.definition.name;
        reads.push({
          name: `roadmap-view ${name}`,
          view: true,
          render: () => services.roadmapService.page(context, ws as WorkspaceId, roadmap.id),
        });
        const selection = roadmap.definition.crossProject;
        if (selection)
          reads.push({
            name: `cross-project-preview ${name}`,
            view: true,
            render: () =>
              services.crossProjectService.view(context, ws as WorkspaceId, {
                definitionId: selection.definitionId,
                bindingRevision: selection.bindingRevision,
                targetId: selection.targetId,
                selection: selection.selection,
              }),
          });
      }
    for (const cycle of storage.execution.cycles.listActive())
      if (cycle.executionScope && cycle.workItemId) {
        const { workspaceId, workItemId, executionScope } = cycle;
        reads.push({
          name: `scope-ledger ${executionScope.sourceId}`,
          view: false,
          render: () =>
            scopeEvidenceLedger(
              storage,
              resolveScope(storage, workspaceId, workItemId, executionScope),
            ),
        });
      }

    mapSubmissions(storage, mapOf);
    // A first pass loads code and the services' own state; it is registered, not counted.
    for (const read of reads) read.render();

    const measure = (read: (typeof reads)[number], state: DecodeMeasure['state']) => {
      const bytes: Partial<Record<PersistedRecordKind, number>> = {};
      const heads = new Map<string, number>();
      const staged: string[] = [];
      const other: string[] = [];
      counting = (kind, size, record) => {
        bytes[kind] = (bytes[kind] ?? 0) + size;
        const { id } = record as { id: string };
        if (kind === 'evidence-submission-head') heads.set(id, (heads.get(id) ?? 0) + 1);
        if (kind === 'evidence-submission')
          ((record as EvidenceSubmission).architectureDecision?.coverage === 'clauses'
            ? staged
            : other
          ).push(id);
      };
      try {
        read.render();
      } finally {
        counting = undefined;
      }
      return {
        read: read.name,
        view: read.view,
        state,
        bytes,
        total: Object.values(bytes).reduce((sum, n) => sum + n, 0),
        heads: heads.size,
        repeatedHeads: [...heads].filter(([, count]) => count > 1).map(([id]) => id),
        stagedRecords: staged,
        otherRecords: other,
      } satisfies DecodeMeasure;
    };

    insertCopies(storage, mapOf);
    const measures: DecodeMeasure[] = [];
    for (const read of reads) measures.push(measure(read, 'after-insert'));
    const rollback = new Error('measured');
    try {
      storage.transaction(() => {
        for (const read of reads) measures.push(measure(read, 'in-transaction'));
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    for (const read of reads) measures.push(measure(read, 'warm'));

    await settle(gc);
    const retained: Record<string, number> = {};
    for (const value of alive.values())
      retained[value.definitionId] = (retained[value.definitionId] ?? 0) + value.bytes;
    return {
      ...(emulate ? { emulated: emulate } : {}),
      reads: measures,
      retained,
      retainedValues: [...alive.values()].map(({ kind, id, bytes }) => ({ kind, id, bytes })),
      heapGrowth: process.memoryUsage().heapUsed - heapBefore,
    };
  } finally {
    undo?.();
    stopObserving();
    storage.close();
  }
}

/**
 * Every fault of a measurement and its self-checks: the measurement's own, and each self-check
 * that passed, since a measurement that passes with a replaced cache put back proves nothing.
 */
export function evidenceDecodeFaults(
  measured: EvidenceDecodeReplay,
  checks: readonly EvidenceDecodeReplay[],
): readonly { key: string; fault: string }[] {
  return [
    ...formatEvidenceDecodes(measured).faults,
    ...checks
      .filter((check) => formatEvidenceDecodes(check).passed)
      .map((check) => ({
        key: `self-check ${check.emulated}`,
        fault: 'the measurement passes with the cache put back',
      })),
  ];
}

/** A text report, with each read and map checked against R-H4's done-when. */
export function formatEvidenceDecodes(replay: EvidenceDecodeReplay): {
  text: string;
  passed: boolean;
  /** Each way a read or a map breaks R-H4, keyed for the replay gate's report. */
  faults: readonly { key: string; fault: string }[];
} {
  const lines: string[] = [];
  const found: { key: string; fault: string }[] = [];
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(3)} MB`;
  if (replay.emulated) lines.push(`self-check, with the ${replay.emulated} cache put back:`);
  for (const read of replay.reads) {
    const faults = [
      ...(read.repeatedHeads.length
        ? [`decodes ${read.repeatedHeads.length} heads more than once`]
        : []),
      ...(read.view && read.otherRecords.length
        ? [`decodes ${read.otherRecords.length} full records that are not staged decisions`]
        : []),
    ];
    for (const fault of faults) found.push({ key: `${read.state} ${read.read}`, fault });
    lines.push(
      `${read.state.padEnd(15)}${read.read}: ${read.heads} heads, ${read.stagedRecords.length} staged and ${read.otherRecords.length} other full records; ${mb(read.total)} decoded (${Object.entries(
        read.bytes,
      )
        .map(([kind, bytes]) => `${kind} ${bytes}`)
        .join(', ')})${faults.map((fault) => ` [${fault}]`).join('')}`,
    );
  }
  const maps = Object.entries(replay.retained);
  if (!maps.length) lines.push('retained evidence: none');
  for (const [map, bytes] of maps) {
    const over = bytes > RETAINED_BOUND_BYTES;
    if (over) found.push({ key: `retained ${map}`, fault: `retains ${bytes} bytes` });
    lines.push(`retained evidence of ${map}: ${mb(bytes)}${over ? ' [over 1 MB]' : ''}`);
  }
  const passed = found.length === 0;
  lines.push(
    `heap growth from before the first read, everything included: ${mb(replay.heapGrowth)}`,
    passed
      ? 'PASS: the views decode heads and staged decisions only, no read decodes a head twice, and every map retains at most 1 MB'
      : 'FAIL: a read or a map breaks R-H4',
  );
  return { text: `${lines.join('\n')}\n`, passed, faults: found };
}
