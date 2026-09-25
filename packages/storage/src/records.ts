import {
  type AgentRun,
  type AgentRunEvent,
  type ArchiveImportAttempt,
  type AuditEvent,
  type ConcurrencyBindingRevision,
  type ConcurrencyDefinition,
  type EvidenceDecision,
  type EvidenceSubmission,
  type Finalization,
  type MapAdoption,
  type MapAmendment,
  type MergeOperation,
  type NativeVerificationApproval,
  type PlanArchiveLink,
  type PlanBranchSettings,
  type PlanVersion,
  type RepositoryPolicy,
  type Roadmap,
  type RoadmapDefinition,
  type UpstreamTransitionRecord,
  type RunBuildRecord,
  type RunEnvironment,
  type RuntimeGeneration,
  type ScopeIntegrationReuse,
  type ScopeReceipt,
  type WorkCycle,
  type WorkItem,
  type WorkspaceEvent,
  type Worktree,
  fitsUtf8Bytes,
  OUTCOME_SUMMARY_LIMIT_BYTES,
  truncateUtf8Bytes,
} from '@craftingtable/domain';
import type { StoredStorageSettings } from './maintenance-types.js';
import type { NotificationRecord, StoredNotificationSettings } from './notification-types.js';

/**
 * Every record the daemon keeps, by kind (R-H3). A kind is one shape that the storage
 * read boundary hands to the rest of the daemon: a JSON document, a row with JSON columns,
 * or a journal entry.
 *
 * - Reads bring each record forward with its kind's upcasters (`readRecord`), so callers
 *   see one current shape and never remember old optional fields.
 * - Writes pass the record to the storage's `RecordGuard` first, which the daemon wires to
 *   the contract schemas, so an out-of-bounds record fails where it is created.
 * - `scanRecords` enumerates every stored record for `pnpm db:verify`.
 */
export interface PersistedRecords {
  readonly 'work-cycle': WorkCycle;
  readonly roadmap: Roadmap;
  readonly 'roadmap-definition': RoadmapDefinition;
  readonly finalization: Finalization;
  readonly 'merge-operation': MergeOperation;
  readonly 'repository-policy': RepositoryPolicy;
  readonly 'plan-branch-settings': PlanBranchSettings;
  readonly 'notification-settings': StoredNotificationSettings;
  readonly 'notification-record': NotificationRecord;
  readonly 'storage-settings': StoredStorageSettings;
  readonly worktree: Worktree;
  readonly 'agent-run': AgentRun;
  readonly 'run-event': AgentRunEvent;
  readonly 'workspace-event': WorkspaceEvent;
  readonly 'audit-event': AuditEvent;
  readonly 'runtime-generation': RuntimeGeneration;
  readonly 'evidence-submission': EvidenceSubmission;
  readonly 'evidence-decision': EvidenceDecision;
  readonly 'run-environment': RunEnvironment;
  readonly 'run-build-record': RunBuildRecord;
  readonly 'native-approval': NativeVerificationApproval;
  readonly 'upstream-transition-record': UpstreamTransitionRecord;
  readonly 'scope-receipt': ScopeReceipt;
  readonly 'archive-import-attempt': ArchiveImportAttempt;
  readonly 'concurrency-definition': ConcurrencyDefinition;
  readonly 'concurrency-binding': ConcurrencyBindingRevision;
  readonly 'plan-archive-link': PlanArchiveLink;
  readonly 'map-adoption': MapAdoption;
  readonly 'map-amendment': MapAmendment;
  readonly 'scope-integration-reuse': ScopeIntegrationReuse;
  readonly 'plan-version': PlanVersion;
  readonly 'work-item': WorkItem;
}

export type PersistedRecordKind = keyof PersistedRecords;

/**
 * Checks a record before storage writes it. The daemon validates against the contract
 * schemas; a throw aborts the write and the transaction around it.
 */
export type RecordGuard = <K extends PersistedRecordKind>(
  kind: K,
  record: PersistedRecords[K],
) => void;

/** Accepts every record. Only storage's own SQL-level tests and fixtures use it. */
export const acceptAnyRecord: RecordGuard = () => {};

/**
 * Brings one historical shape forward. `applies` recognises the old shape; `upcast`
 * returns the current one without mutating its input.
 */
export interface RecordUpcaster {
  /** Names the historical shape, for `db:verify`'s report. */
  readonly name: string;
  readonly applies: (record: Readonly<Record<string, unknown>>) => boolean;
  readonly upcast: (record: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(record: Readonly<Record<string, unknown>>) {
  return isObject(record.payload) ? record.payload : undefined;
}

/**
 * Upcasters per kind, applied in order. Add one whenever a stored shape stops matching the
 * current contract, instead of teaching readers about the old shape; `db:verify` reports how
 * many records each one changed.
 */
export const RECORD_UPCASTERS: { readonly [K in PersistedRecordKind]: readonly RecordUpcaster[] } =
  {
    'work-cycle': [],
    roadmap: [],
    'roadmap-definition': [],
    finalization: [],
    'merge-operation': [],
    'repository-policy': [],
    'plan-branch-settings': [],
    'notification-settings': [],
    'notification-record': [],
    'storage-settings': [],
    worktree: [],
    'agent-run': [
      {
        // Builds before 2026-09-05 bounded the summary in characters, not bytes.
        name: 'outcomeSummary bounded in characters (before 2026-09-05)',
        applies: (run) =>
          typeof run.outcomeSummary === 'string' &&
          !fitsUtf8Bytes(run.outcomeSummary, OUTCOME_SUMMARY_LIMIT_BYTES),
        upcast: (run) => ({
          ...run,
          outcomeSummary: truncateUtf8Bytes(
            run.outcomeSummary as string,
            OUTCOME_SUMMARY_LIMIT_BYTES,
          ),
        }),
      },
    ],
    'run-event': [
      {
        // Session-started events recorded before billing was observed carry no `billing`;
        // they read back as `unknown`, which is what the daemon records when it cannot tell.
        name: 'session-started without billing (before 2026-09-05)',
        applies: (event) => {
          const payload = payloadOf(event);
          return event.kind === 'session-started' && !!payload && !('billing' in payload);
        },
        upcast: (event) => ({ ...event, payload: { ...payloadOf(event), billing: 'unknown' } }),
      },
    ],
    'workspace-event': [
      {
        // Schema-2 admissions named the work-contract draft retired with CT-04; nothing reads it.
        name: 'work-item-admitted with the retired workContractDraftId',
        applies: (event) =>
          event.kind === 'work-item-admitted' && 'workContractDraftId' in (payloadOf(event) ?? {}),
        upcast: (event) => {
          const { workContractDraftId: _retired, ...payload } = payloadOf(event) ?? {};
          return { ...event, payload };
        },
      },
    ],
    'audit-event': [],
    'runtime-generation': [],
    'evidence-submission': [],
    'evidence-decision': [],
    'run-environment': [],
    'run-build-record': [],
    'native-approval': [],
    'upstream-transition-record': [],
    'scope-receipt': [],
    'archive-import-attempt': [],
    'concurrency-definition': [],
    'concurrency-binding': [],
    'plan-archive-link': [],
    'map-adoption': [],
    'map-amendment': [],
    'scope-integration-reuse': [],
    'plan-version': [],
    'work-item': [],
  };

/** Told about each upcaster that changed a record, so `db:verify` can count them. */
export type UpcastObserver = (kind: PersistedRecordKind, upcaster: RecordUpcaster) => void;

let observer: UpcastObserver | undefined;

/**
 * Runs a synchronous read with `observe` told about every upcast it applies, whichever
 * repository mapper applied it. Reads are synchronous, so the scope is exact.
 */
export function observeUpcasts<T>(observe: UpcastObserver, read: () => T): T {
  const previous = observer;
  observer = observe;
  try {
    return read();
  } finally {
    observer = previous;
  }
}

/** The storage read boundary: brings a decoded record up to the current shape. */
export function readRecord<K extends PersistedRecordKind>(
  kind: K,
  value: unknown,
): PersistedRecords[K] {
  let record = value;
  for (const upcaster of RECORD_UPCASTERS[kind]) {
    if (isObject(record) && upcaster.applies(record)) {
      record = upcaster.upcast(record);
      observer?.(kind, upcaster);
    }
  }
  return record as PersistedRecords[K];
}

/** A record came back from its own write in a historical shape: a writer defect. */
export class HistoricalRecordWriteError extends Error {
  constructor(
    readonly kind: PersistedRecordKind,
    readonly upcaster: string,
  ) {
    super(`Refused to store a ${kind} in a historical shape (${upcaster})`);
    this.name = 'HistoricalRecordWriteError';
  }
}

/**
 * Reads back a record its caller has just written, for the write guard. The read passes
 * through the upcasters like any other, which would hide a writer that produced an old
 * shape (an over-long summary, a missing field) from the guard. A record written now must
 * already be current, so any upcast here fails the write instead. Journal compaction, which
 * rewrites historical rows on purpose, reads back without this check.
 */
export function readWritten<T>(read: () => T): T {
  let stale: { kind: PersistedRecordKind; upcaster: RecordUpcaster } | undefined;
  const record = observeUpcasts((kind, upcaster) => {
    stale ??= { kind, upcaster };
  }, read);
  if (stale) throw new HistoricalRecordWriteError(stale.kind, stale.upcaster.name);
  return record;
}

/** Decodes a JSON document column and brings it up to the current shape. */
export function parseRecord<K extends PersistedRecordKind>(
  kind: K,
  json: string,
): PersistedRecords[K] {
  return readRecord(kind, JSON.parse(json));
}
