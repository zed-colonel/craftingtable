import {
  agentRunRecordSchema,
  archiveImportAttemptRecordSchema,
  attentionItemSchema,
  auditRecordSummarySchema,
  concurrencyBindingRecordSchema,
  concurrencyDefinitionRecordSchema,
  equivalentSchema,
  evidenceDecisionSchema,
  evidenceSubmissionSchema,
  finalizationSchema,
  mapAdoptionSchema,
  mapAmendmentSchema,
  mergeOperationSchema,
  nativeApprovalSchema,
  notificationDeliverySchema,
  notificationRecordSchema,
  planArchiveLinkSchema,
  planBranchSettingsSchema,
  planVersionRecordSchema,
  repositoryPolicySchema,
  roadmapDefinitionSchema,
  roadmapSchema,
  runBuildRecordSchema,
  protectedRefMoveSchema,
  runCheckReceiptSchema,
  runEnvironmentSchema,
  runEventEnvelopeSchema,
  runtimeGenerationSchema,
  scopeIntegrationReuseSchema,
  scopeReceiptSchema,
  storedNotificationSettingsSchema,
  storedStorageSettingsSchema,
  upstreamTransitionRecordSchema,
  workCycleSchema,
  workItemRecordSchema,
  workspaceEventEnvelopeSchema,
  worktreeRecordSchema,
} from '@craftingtable/contracts';
import { concurrencySourceIssues } from '@craftingtable/planning';
import {
  type CraftingTableStorage,
  openCraftingTableStorage,
  type PersistedRecordKind,
  type PersistedRecords,
  type RecordGuard,
  type UnreadableRecord,
} from '@craftingtable/storage';

/**
 * The contract behind every record kind storage keeps (R-H3). Each schema is pinned to the
 * type storage reads, so drift between a domain type and its contract fails to compile, and
 * a kind without a schema fails `satisfies`.
 */
interface RecordSchema {
  safeParse(value: unknown):
    | { readonly success: true }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly { readonly path: readonly PropertyKey[]; message: string }[];
        };
      };
}

const pin = <K extends PersistedRecordKind>(_kind: K) => equivalentSchema<PersistedRecords[K]>();

export const PERSISTED_RECORD_SCHEMAS = {
  'work-cycle': pin('work-cycle')(workCycleSchema),
  roadmap: pin('roadmap')(roadmapSchema),
  'roadmap-definition': pin('roadmap-definition')(roadmapDefinitionSchema),
  finalization: pin('finalization')(finalizationSchema),
  'merge-operation': pin('merge-operation')(mergeOperationSchema),
  'repository-policy': pin('repository-policy')(repositoryPolicySchema),
  'plan-branch-settings': pin('plan-branch-settings')(planBranchSettingsSchema),
  'notification-settings': pin('notification-settings')(storedNotificationSettingsSchema),
  'notification-record': pin('notification-record')(notificationRecordSchema),
  'attention-item': pin('attention-item')(attentionItemSchema),
  'notification-delivery': pin('notification-delivery')(notificationDeliverySchema),
  'storage-settings': pin('storage-settings')(storedStorageSettingsSchema),
  worktree: pin('worktree')(worktreeRecordSchema),
  'agent-run': pin('agent-run')(agentRunRecordSchema),
  'run-event': pin('run-event')(runEventEnvelopeSchema),
  'workspace-event': pin('workspace-event')(workspaceEventEnvelopeSchema),
  'audit-event': pin('audit-event')(auditRecordSummarySchema),
  'runtime-generation': pin('runtime-generation')(runtimeGenerationSchema),
  'evidence-submission': pin('evidence-submission')(evidenceSubmissionSchema),
  'evidence-decision': pin('evidence-decision')(evidenceDecisionSchema),
  'run-environment': pin('run-environment')(runEnvironmentSchema),
  'run-build-record': pin('run-build-record')(runBuildRecordSchema),
  'run-check-receipt': pin('run-check-receipt')(runCheckReceiptSchema),
  'protected-ref-move': pin('protected-ref-move')(protectedRefMoveSchema),
  'native-approval': pin('native-approval')(nativeApprovalSchema),
  'upstream-transition-record': pin('upstream-transition-record')(upstreamTransitionRecordSchema),
  'scope-receipt': pin('scope-receipt')(scopeReceiptSchema),
  'archive-import-attempt': pin('archive-import-attempt')(archiveImportAttemptRecordSchema),
  'concurrency-definition': pin('concurrency-definition')(concurrencyDefinitionRecordSchema),
  'concurrency-binding': pin('concurrency-binding')(concurrencyBindingRecordSchema),
  'plan-archive-link': pin('plan-archive-link')(planArchiveLinkSchema),
  'map-adoption': pin('map-adoption')(mapAdoptionSchema),
  'map-amendment': pin('map-amendment')(mapAmendmentSchema),
  'scope-integration-reuse': pin('scope-integration-reuse')(scopeIntegrationReuseSchema),
  'plan-version': pin('plan-version')(planVersionRecordSchema),
  'work-item': pin('work-item')(workItemRecordSchema),
} satisfies { readonly [K in PersistedRecordKind]: RecordSchema };

/**
 * Checks a schema cannot express, owned by the package that owns the format. The write
 * guard leaves them to that package's own writer: the importer is the only production
 * writer of concurrency definitions and has already applied the same validator. `db:verify`
 * applies them to every stored row.
 */
const FORMAT_CHECKS: {
  readonly [K in PersistedRecordKind]?: (record: PersistedRecords[K]) => readonly string[];
} = {
  // The saved v0.3 map must still conform to the reviewed source schema.
  'concurrency-definition': (definition) =>
    concurrencySourceIssues(definition.source).map((issue) => `source${issue}`),
};

/**
 * Every way `record` breaks the contract for `kind`; empty when it conforms. `format` adds
 * the format owner's checks.
 */
export function recordIssues<K extends PersistedRecordKind>(
  kind: K,
  record: PersistedRecords[K],
  format = true,
): readonly string[] {
  const result = (PERSISTED_RECORD_SCHEMAS[kind] as RecordSchema).safeParse(record);
  const issues = result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(record)'}: ${issue.message}`,
      );
  const check = FORMAT_CHECKS[kind] as
    | ((record: PersistedRecords[K]) => readonly string[])
    | undefined;
  return format && check ? [...issues, ...check(record)] : issues;
}

/** A write refused because the record breaks its contract: a daemon defect, not input. */
export class InvalidRecordError extends Error {
  constructor(
    readonly kind: PersistedRecordKind,
    readonly issues: readonly string[],
  ) {
    super(
      `Refused to store a ${kind} that breaks its contract: ${issues.slice(0, 5).join('; ')}${
        issues.length > 5 ? `; and ${issues.length - 5} more` : ''
      }`,
    );
    this.name = 'InvalidRecordError';
  }
}

/** The daemon's write guard: every record is checked against its contract before storage. */
export const contractRecordGuard: RecordGuard = (kind, record) => {
  const issues = recordIssues(kind, record, false);
  if (issues.length) throw new InvalidRecordError(kind, issues);
};

/** Opens storage the way the daemon does, with every write guarded by the contracts. */
export function openDaemonStorage(databasePath: string): CraftingTableStorage {
  return openCraftingTableStorage(databasePath, contractRecordGuard);
}

export interface InvalidRecord {
  readonly kind: PersistedRecordKind;
  readonly key: string;
  readonly issues: readonly string[];
}

export interface RecordVerification {
  /** Records read and records that broke their contract, per kind. */
  readonly counts: Readonly<Record<PersistedRecordKind, { records: number; invalid: number }>>;
  /** How many records each upcaster brought forward, keyed `kind: upcaster`. */
  readonly upcasts: Readonly<Record<string, number>>;
  readonly invalid: readonly InvalidRecord[];
  readonly unreadable: readonly UnreadableRecord[];
  /** SQLite integrity, foreign keys and retired tables. */
  readonly integrity: readonly string[];
}

/**
 * Reads every stored record as the daemon would and checks it against its contract, and
 * with `format` also against the format owner's checks.
 */
export function verifyRecords(storage: CraftingTableStorage, format = true): RecordVerification {
  const counts = Object.fromEntries(
    Object.keys(PERSISTED_RECORD_SCHEMAS).map((kind) => [kind, { records: 0, invalid: 0 }]),
  ) as Record<PersistedRecordKind, { records: number; invalid: number }>;
  const upcasts: Record<string, number> = {};
  const invalid: InvalidRecord[] = [];
  const unreadable: UnreadableRecord[] = [];
  storage.scanRecords(
    ({ kind, key, record }) => {
      counts[kind].records++;
      const issues = recordIssues(kind, record, format);
      if (issues.length) {
        counts[kind].invalid++;
        invalid.push({ kind, key, issues });
      }
    },
    (record) => {
      counts[record.kind].records++;
      counts[record.kind].invalid++;
      unreadable.push(record);
    },
    (kind, upcaster) => {
      const label = `${kind}: ${upcaster.name}`;
      upcasts[label] = (upcasts[label] ?? 0) + 1;
    },
  );
  return { counts, upcasts, invalid, unreadable, integrity: storage.integrityProblems() };
}

/** True when nothing in the verification needs attention. */
export function verified(verification: RecordVerification): boolean {
  return (
    verification.invalid.length === 0 &&
    verification.unreadable.length === 0 &&
    verification.integrity.length === 0
  );
}
