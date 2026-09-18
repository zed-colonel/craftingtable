import type { ExecutionScope, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError } from './errors.js';

/** Latest explicit guidance on each related cycle; imported text and agent findings are not decisions. */
export function operatorDecisions(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemIds: readonly WorkItemId[],
  scope?: ExecutionScope,
) {
  const ids = new Set(workItemIds);
  const records = tx.execution.cycles
    .list(workspaceId)
    .filter(
      (c) =>
        c.workItemId &&
        ids.has(c.workItemId) &&
        (!scope ||
          (c.executionScope?.definitionId === scope.definitionId &&
            c.executionScope.bindingRevision === scope.bindingRevision)),
    )
    .filter((c) => c.instructions || c.designRecovery?.instructions)
    .map((c) => ({
      sourceCycleId: c.id,
      recordedAt: c.updatedAt,
      cycleDelegatedByUserId: c.createdByUserId,
      sourceScope: c.executionScope,
      sourceCycleVersion: c.version,
      cycleInstructions: c.instructions,
      ...(c.designRecovery
        ? {
            designRecovery: {
              sourceRunId: c.designRecovery.sourceRunId,
              recoveryRunId: c.designRecovery.runId,
              instructions: c.designRecovery.instructions,
              snapshotDigest: c.designRecovery.snapshotDigest,
            },
          }
        : {}),
      authority:
        'Recorded operator guidance for the identified work item/scope. Not passing test evidence or an automatic waiver of retained obligations. Preserve scope and chronology when reconciling decisions.',
    }));
  if (Buffer.byteLength(JSON.stringify(records)) > 1024 * 1024)
    throw new ExecutionRequestError(
      'conflict',
      'Applicable operator decisions exceed the 1 MiB context limit. Consolidate policy explicitly; guidance cannot be silently truncated.',
    );
  return records;
}
