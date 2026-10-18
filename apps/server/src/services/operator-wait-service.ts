import {
  type AttentionRefs,
  type CycleStatus,
  type CycleTransitionRecord,
  CYCLE_ATTENTION,
  CYCLE_STATUSES,
  type CycleAttentionCode,
  effectiveCycleAttention,
  effectiveHoldAttention,
  effectiveRoadmapAttention,
  type OperatorWaitKind,
  type OperatorWaitReport,
  type Roadmap,
  ROADMAP_ATTENTION,
  type RoadmapAttention,
  type RoadmapAttentionCode,
  type RoadmapId,
  type RoadmapWaitRecord,
  startedAttempts,
  summarizeOperatorWait,
  type WorkCycle,
  type WorkspaceId,
  type WorkCycleId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * Operator wait for the dashboard (R-C1), read from the cycle and roadmap audit trails and run
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
    // One reading of the clock, so the window is exactly `days` long.
    const to = this.now();
    return operatorWaitReport(this.storage, workspaceId, {
      from: new Date(to.getTime() - days * 86_400_000),
      to,
    });
  }
}

export function operatorWaitReport(
  storage: CraftingTableStorage,
  workspaceId: WorkspaceId,
  window: { readonly from: Date; readonly to: Date },
): OperatorWaitReport {
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  // What an older awaiting-merge record meant depends on the kind of cycle, which never
  // changes, so it is read from the cycle (only when such a record needs it). Whether the
  // controller was still waiting on the step (`workflow.waiting`) was not recorded, so
  // such a transition counts as the operator's.
  let cycles: ReadonlyMap<string, WorkCycle> | undefined;
  const cycleOf = (id: WorkCycleId) => {
    cycles ??= new Map(
      storage.execution.cycles.listForWorkspace(workspaceId).map((cycle) => [cycle.id, cycle]),
    );
    return cycles.get(id);
  };
  const transitions = storage.audit
    .listCycleTransitions(workspaceId, from, to)
    .flatMap((row): CycleTransitionRecord[] => {
      const status = row.metadata.status;
      if (!CYCLE_STATUSES.includes(status as CycleStatus)) return [];
      return [
        {
          cycleId: row.cycleId,
          at: row.occurredAt,
          status: status as CycleStatus,
          ...recordedAttention(status as CycleStatus, row.metadata, () => cycleOf(row.cycleId)),
        },
      ];
    });
  return summarizeOperatorWait(
    transitions,
    storage.execution.runs.activityBetween(workspaceId, window.from.toISOString(), to),
    window,
    roadmapWaitRecords(
      storage.audit.listRoadmapTransitions(workspaceId, from, to),
      storage.roadmaps.list(workspaceId),
    ),
  );
}

/**
 * What a roadmap write records of the roadmap's waits (R-C10's follow-up, decision 5): its own
 * stop and every entry's hold, by code, so the operator-wait measure can count them. Every
 * writer of a roadmap's `roadmap.updated` row adds it; `holds` is always present, which is how
 * the measure tells such a row from one an older release wrote. Audit metadata is a free record,
 * so an older release reads these rows as before.
 */
export function roadmapWaitAudit(
  roadmap: Pick<Roadmap, 'status' | 'reason' | 'attention' | 'entryHolds'>,
): { readonly attention?: AuditedStop; readonly holds: readonly AuditedHold[] } {
  const attention = effectiveRoadmapAttention(roadmap);
  return {
    ...(attention ? { attention: auditedStop(attention) } : {}),
    holds: Object.entries(roadmap.entryHolds ?? {}).map(([entryId, hold]) => {
      const held = effectiveHoldAttention(hold);
      // A hold's `refs.entryId` names the gate's entry, not the hold's (R-C10's follow-up): the
      // record keeps the hold's own key.
      const { entryId: _gated, ...stop } = held ? auditedStop(held) : {};
      return { ...stop, entryId, status: hold.status };
    }),
  };
}

type AuditedStop = {
  readonly code: RoadmapAttentionCode;
  readonly owner: RoadmapAttention['owner'];
  readonly cycleId?: string;
  readonly entryId?: string;
  readonly cause?: CycleAttentionCode;
};
type AuditedHold = Partial<AuditedStop> & {
  readonly entryId: string;
  readonly status: 'paused' | 'needs-attention';
};

function auditedStop({ code, owner, refs }: RoadmapAttention): AuditedStop {
  const kept = (key: keyof AttentionRefs & ('cycleId' | 'entryId' | 'cause')) =>
    refs?.[key] ? { [key]: refs[key] } : {};
  return { code, owner, ...kept('cycleId'), ...kept('entryId'), ...kept('cause') };
}

/** A waiting kind read back from an audited stop, if it is one the operator owns. */
function stopKind(
  value: unknown,
): { kind: OperatorWaitKind; cycleId?: string; entryId?: string } | undefined {
  const stop = value as Partial<Record<keyof AuditedStop, unknown>> | undefined;
  if (
    typeof stop?.code !== 'string' ||
    !Object.hasOwn(ROADMAP_ATTENTION, stop.code) ||
    stop.owner !== 'operator'
  )
    return undefined;
  return {
    kind: stop.code as RoadmapAttentionCode,
    ...(typeof stop.cycleId === 'string' ? { cycleId: stop.cycleId } : {}),
    ...(typeof stop.entryId === 'string' ? { entryId: stop.entryId } : {}),
  };
}

const LIVE: ReadonlySet<unknown> = new Set(['running', 'paused', 'needs-attention']);

/**
 * Each audited roadmap write as the waits it records: the roadmap's own (its pause, or its stop
 * at attention the operator owns) and each entry's hold, while the roadmap has not ended. Each
 * names the cycles whose own stops are the same wait: the stop's cycle where it names one, else
 * the entry's attempts' cycles (retired ones and a recovery round's repair of it included), else,
 * for the roadmap's own stop, every cycle it started; a hold is also within its roadmap's own
 * wait. A row without the record, one an older release wrote, records no wait.
 */
export function roadmapWaitRecords(
  rows: readonly {
    readonly roadmapId: RoadmapId;
    readonly occurredAt: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }[],
  roadmaps: readonly Pick<Roadmap, 'id' | 'attempts' | 'retiredAttempts'>[],
): RoadmapWaitRecord[] {
  const byId = new Map(roadmaps.map((roadmap) => [roadmap.id, roadmap]));
  const records: RoadmapWaitRecord[] = [];
  const open = new Map<RoadmapId, Set<string>>();
  for (const row of rows) {
    const attempts = startedAttempts(byId.get(row.roadmapId) ?? { attempts: [] });
    const entryCycles = (entryId: string) =>
      attempts
        .filter((a) => a.entryId === entryId || a.recovery?.sourceEntryId === entryId)
        .map((a) => a.cycleId);
    const { status, holds } = row.metadata;
    const live = Array.isArray(holds) && LIVE.has(status);
    const stop = live ? stopKind(row.metadata.attention) : undefined;
    const kind =
      status === 'paused' ? 'paused' : status === 'needs-attention' ? stop?.kind : undefined;
    records.push({
      waitId: row.roadmapId,
      at: row.occurredAt,
      ...(live && kind ? { kind } : {}),
      cycleIds: stop?.cycleId
        ? [stop.cycleId as WorkCycleId]
        : stop?.entryId
          ? entryCycles(stop.entryId)
          : attempts.map((a) => a.cycleId),
    });
    const held = new Map<string, RoadmapWaitRecord>();
    for (const hold of live ? (holds as unknown[]) : []) {
      const { entryId, status: holdStatus } = (hold ?? {}) as Record<string, unknown>;
      if (typeof entryId !== 'string') continue;
      const holdStop = holdStatus === 'needs-attention' ? stopKind(hold) : undefined;
      const holdKind = holdStatus === 'paused' ? 'paused' : holdStop?.kind;
      held.set(entryId, {
        waitId: `${row.roadmapId}:${entryId}`,
        at: row.occurredAt,
        within: row.roadmapId,
        ...(holdKind ? { kind: holdKind } : {}),
        cycleIds: [
          ...entryCycles(entryId),
          ...(holdStop?.cycleId ? [holdStop.cycleId as WorkCycleId] : []),
        ],
      });
    }
    // A hold the previous row had and this one does not has ended.
    for (const entryId of open.get(row.roadmapId) ?? [])
      if (!held.has(entryId))
        records.push({ waitId: `${row.roadmapId}:${entryId}`, at: row.occurredAt, cycleIds: [] });
    records.push(...held.values());
    open.set(row.roadmapId, new Set(held.keys()));
  }
  return records;
}

function recordedAttention(
  status: CycleStatus,
  metadata: Readonly<Record<string, unknown>>,
  cycleOf: () => Pick<WorkCycle, 'executionScope' | 'finalizationId'> | undefined,
): Pick<CycleTransitionRecord, 'attention'> {
  const declared = metadata.attention as { code?: unknown; owner?: unknown } | undefined;
  if (
    typeof declared?.code === 'string' &&
    Object.hasOwn(CYCLE_ATTENTION, declared.code) &&
    (declared.owner === 'operator' || declared.owner === 'controller')
  )
    return { attention: { code: declared.code as CycleAttentionCode, owner: declared.owner } };
  const cycle = status === 'awaiting-merge' ? cycleOf() : undefined;
  const recovered = effectiveCycleAttention({
    status,
    attention: undefined,
    reason: typeof metadata.reason === 'string' ? metadata.reason : '',
    ...(cycle?.executionScope ? { executionScope: cycle.executionScope } : {}),
    ...(cycle?.finalizationId ? { finalizationId: cycle.finalizationId } : {}),
  });
  return recovered ? { attention: { code: recovered.code, owner: recovered.owner } } : {};
}
