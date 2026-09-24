import {
  type CycleStatus,
  type CycleTransitionRecord,
  CYCLE_ATTENTION,
  CYCLE_STATUSES,
  type CycleAttentionCode,
  effectiveCycleAttention,
  type OperatorWaitReport,
  summarizeOperatorWait,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * Operator wait for the dashboard (R-C1), read from the cycle audit trail and run
 * intervals. Transitions recorded before attention codes existed recover their code from
 * the legacy reason mapping, the only place that reads that text.
 */
export class OperatorWaitService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  report(context: AuthContext, workspaceId: WorkspaceId, days: number): OperatorWaitReport {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor', 'viewer']);
    return operatorWaitReport(this.storage, workspaceId, {
      from: new Date(this.now().getTime() - days * 86_400_000),
      to: this.now(),
    });
  }
}

export function operatorWaitReport(
  storage: CraftingTableStorage,
  workspaceId: WorkspaceId,
  window: { readonly from: Date; readonly to: Date },
): OperatorWaitReport {
  const to = window.to.toISOString();
  const transitions = storage.audit
    .listCycleTransitions(workspaceId, to)
    .flatMap((row): CycleTransitionRecord[] => {
      const status = row.metadata.status;
      if (!CYCLE_STATUSES.includes(status as CycleStatus)) return [];
      return [
        {
          cycleId: row.cycleId,
          at: row.occurredAt,
          status: status as CycleStatus,
          ...recordedAttention(status as CycleStatus, row.metadata),
        },
      ];
    });
  return summarizeOperatorWait(
    transitions,
    storage.execution.runs.activityBetween(workspaceId, window.from.toISOString(), to),
    window,
  );
}

function recordedAttention(
  status: CycleStatus,
  metadata: Readonly<Record<string, unknown>>,
): Pick<CycleTransitionRecord, 'attention'> {
  const declared = metadata.attention as { code?: unknown; owner?: unknown } | undefined;
  if (
    typeof declared?.code === 'string' &&
    declared.code in CYCLE_ATTENTION &&
    (declared.owner === 'operator' || declared.owner === 'controller')
  )
    return { attention: { code: declared.code as CycleAttentionCode, owner: declared.owner } };
  const recovered = effectiveCycleAttention({
    status,
    reason: typeof metadata.reason === 'string' ? metadata.reason : '',
  });
  return recovered ? { attention: { code: recovered.code, owner: recovered.owner } } : {};
}
