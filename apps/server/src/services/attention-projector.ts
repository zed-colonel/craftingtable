import { randomUUID } from 'node:crypto';
import {
  ATTENTION_FLAP_WINDOW_MS,
  type AttentionItem,
  type AttentionItemRefs,
  type AttentionResolution,
  asEventId,
  DEFAULT_NOTIFICATION_PREFERENCES,
  designHasNoOpenQuestions,
  effectiveCycleAttention,
  effectiveRoadmapAttention,
  nextReminderAt,
  notificationText,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import type {
  CraftingTableStorage,
  PersistedRecordKind,
  PersistedRecords,
  StorageRepositories,
  WriteObserver,
} from '@craftingtable/storage';
import type { ControllerPasses } from './attention-gates.js';

/** What a projection unit wants open; the projector gives it identity and history. */
export type ProjectedItem = Pick<
  AttentionItem,
  'subjectKey' | 'code' | 'kind' | 'title' | 'message' | 'path' | 'refs' | 'members' | 'actions'
>;

const UNIT = '\u0000';
const TITLE_LIMIT = 250;
const MESSAGE_LIMIT = 4000;

/**
 * Keeps `attention_items` in step with the state that causes them (R-A4, ADR-070).
 *
 * The storage reports every record it writes. The projector marks the affected projection
 * units dirty and, just before the transaction commits, re-derives only those units and
 * opens, refreshes or resolves their items, in the same transaction. A unit is small and
 * reads only rows: a worktree (its cycle, its latest run, its merge), a roadmap (its status,
 * a pending amendment, a queued dependency refresh), a finalization. Sets that need the map
 * or the filesystem are synced by the component that evaluates them: the roadmap scheduler
 * (`roadmap-pass:<id>`) and the storage monitor (`storage`).
 */
export class AttentionProjector implements WriteObserver {
  private readonly pending = new Set<string>();
  private flushing: string[] = [];
  private changed = new Set<WorkspaceId>();
  /** The controller pass sequence at which each item opened during this boot. */
  private readonly openedAt = new Map<string, number>();

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly passes: ControllerPasses,
    private readonly now: () => Date,
    /** Told after a commit that opened or resolved items, with the workspaces affected. */
    private readonly onChange: (workspaces: readonly WorkspaceId[]) => void = () => undefined,
  ) {}

  written<K extends PersistedRecordKind>(kind: K, record: PersistedRecords[K]): void {
    switch (kind) {
      case 'work-cycle': {
        const cycle = record as PersistedRecords['work-cycle'];
        this.mark(cycle.workspaceId, `worktree:${cycle.worktreeId}`);
        // A roadmap's own stop defers to its cycle's item, so it follows the cycle.
        if (cycle.owner) this.mark(cycle.workspaceId, `roadmap:${cycle.owner.roadmapId}`);
        return;
      }
      case 'agent-run': {
        const run = record as PersistedRecords['agent-run'];
        this.mark(run.workspaceId, `worktree:${run.worktreeId}`);
        return;
      }
      case 'run-event': {
        // A finished turn can raise or clear a hand-started run's questions.
        const event = record as PersistedRecords['run-event'];
        if (event.kind === 'turn-completed') this.mark(event.workspaceId, `run:${event.runId}`);
        return;
      }
      case 'worktree': {
        const tree = record as PersistedRecords['worktree'];
        this.mark(tree.workspaceId, `worktree:${tree.id}`);
        return;
      }
      case 'merge-operation': {
        const merge = record as PersistedRecords['merge-operation'];
        this.mark(merge.workspaceId, `worktree:${merge.worktreeId}`);
        return;
      }
      case 'work-item': {
        const item = record as PersistedRecords['work-item'];
        this.mark(item.workspaceId, `work-item:${item.id}`);
        return;
      }
      case 'roadmap': {
        const roadmap = record as PersistedRecords['roadmap'];
        this.mark(roadmap.workspaceId, `roadmap:${roadmap.id}`);
        return;
      }
      case 'map-amendment': {
        const amendment = record as PersistedRecords['map-amendment'];
        this.mark(amendment.workspaceId, `roadmap:${amendment.roadmapId}`);
        return;
      }
      case 'finalization': {
        const finalization = record as PersistedRecords['finalization'];
        this.mark(finalization.workspaceId, `finalization:${finalization.id}`);
        return;
      }
      default:
        return;
    }
  }

  beforeCommit(tx: StorageRepositories): void {
    if (this.pending.size === 0) return;
    const units = [...this.pending];
    this.pending.clear();
    this.flushing.push(...units);
    this.project(tx, units);
  }

  ended(committed: boolean): void {
    if (!committed) {
      for (const unit of this.flushing) this.pending.add(unit);
      this.changed.clear();
    }
    this.flushing = [];
    this.journaled.clear();
    if (committed && this.changed.size) {
      const workspaces = [...this.changed];
      this.changed.clear();
      this.onChange(workspaces);
    }
  }

  /** Catches up on writes made outside a transaction. */
  flush(): void {
    if (this.pending.size) this.storage.transaction(() => undefined);
  }

  /**
   * Re-derives every unit that could hold an item: at boot, so items follow anything
   * written while the daemon was down, and the first time items exist.
   */
  rebuild(): void {
    this.storage.transaction((tx) => {
      for (const tree of tx.execution.worktrees.listActive())
        this.mark(tree.workspaceId, `worktree:${tree.id}`);
      for (const merge of tx.execution.merges.pending())
        this.mark(merge.workspaceId, `worktree:${merge.worktreeId}`);
      for (const roadmap of tx.roadmaps.list())
        this.mark(roadmap.workspaceId, `roadmap:${roadmap.id}`);
      for (const finalization of tx.execution.finalizations.list())
        this.mark(finalization.workspaceId, `finalization:${finalization.id}`);
      for (const { workspaceId, scopeKey } of tx.attention.openScopes())
        if (!scopeKey.startsWith('roadmap-pass:') && scopeKey !== 'storage')
          this.mark(workspaceId, scopeKey);
    });
  }

  /** The controller pass an item opened after; older items wait for one full pass. */
  openedPass(itemId: string): number {
    return this.openedAt.get(itemId) ?? 0;
  }

  /**
   * Makes `desired` the open items of one scope: new subjects open, vanished ones resolve,
   * the rest are refreshed in place. Callers that evaluate a set themselves (the roadmap
   * scheduler, the storage monitor) use this directly, inside their own transaction.
   */
  sync(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    scopeKey: string,
    desired: readonly ProjectedItem[],
  ): void {
    const now = this.now().toISOString();
    const open = tx.attention.openInScope(workspaceId, scopeKey);
    const same = (a: Pick<AttentionItem, 'subjectKey' | 'code'>, b: typeof a) =>
      a.subjectKey === b.subjectKey && a.code === b.code;
    let resolvedBy: AttentionResolution | undefined;
    for (const item of open) {
      if (desired.some((wanted) => same(wanted, item))) continue;
      resolvedBy = desired.some((wanted) => wanted.subjectKey === item.subjectKey)
        ? 'superseded'
        : this.operatorActedSince(tx, workspaceId, item.openedAt)
          ? 'operator'
          : 'automation';
      tx.attention.update({
        ...item,
        state: 'resolved',
        resolvedAt: now,
        resolvedBy,
        delivery: { ...item.delivery, leaseToken: null, leaseUntil: null },
      });
      this.openedAt.delete(item.id);
      this.changed.add(workspaceId);
    }
    for (const wanted of desired) {
      const bounded = bound(wanted);
      const existing = open.find((item) => same(item, bounded));
      if (existing) {
        const grew =
          existing.delivery.firstSentAt !== null &&
          (bounded.members ?? []).some((member) => !existing.members?.includes(member));
        const refreshed = itemOf(
          existing,
          bounded,
          // A set that gained a member is new work: it pages again as a new first send.
          grew
            ? {
                ...existing.delivery,
                firstSentAt: null,
                lastSentAt: null,
                deliveredCount: 0,
                nextAttemptAt: now,
              }
            : existing.delivery,
        );
        if (!sameItem(existing, refreshed)) tx.attention.update(refreshed);
        if (grew) this.openedAt.set(existing.id, this.passes.current);
        continue;
      }
      const item = this.opening(tx, workspaceId, scopeKey, bounded, now);
      tx.attention.insert(item);
      this.openedAt.set(item.id, this.passes.current);
      this.changed.add(workspaceId);
    }
    if (this.changed.has(workspaceId)) this.journal(tx, workspaceId, now);
  }

  private mark(workspaceId: WorkspaceId, unit: string): void {
    this.pending.add(`${workspaceId}${UNIT}${unit}`);
  }

  private project(tx: StorageRepositories, units: readonly string[]): void {
    const parsed = units.map((key) => {
      const [workspaceId, unit] = key.split(UNIT) as [WorkspaceId, string];
      return { workspaceId, unit };
    });
    // Work items and runs stand for their worktrees.
    const expanded: { workspaceId: WorkspaceId; unit: string }[] = [];
    for (const { workspaceId, unit } of parsed) {
      if (unit.startsWith('run:')) {
        const run = tx.execution.runs.find(
          workspaceId,
          unit.slice('run:'.length) as Parameters<typeof tx.execution.runs.find>[1],
        );
        if (run) expanded.push({ workspaceId, unit: `worktree:${run.worktreeId}` });
        continue;
      }
      if (!unit.startsWith('work-item:')) {
        expanded.push({ workspaceId, unit });
        continue;
      }
      const id = unit.slice('work-item:'.length);
      for (const tree of tx.execution.worktrees.listForWorkItem(
        workspaceId,
        id as Parameters<typeof tx.execution.worktrees.listForWorkItem>[1],
      ))
        expanded.push({ workspaceId, unit: `worktree:${tree.id}` });
    }
    const seen = new Set<string>();
    // Worktrees first: a roadmap's own stop defers to an open item of its cycle.
    const ordered = [
      ...expanded.filter((u) => !u.unit.startsWith('roadmap:')),
      ...expanded.filter((u) => u.unit.startsWith('roadmap:')),
    ];
    for (const { workspaceId, unit } of ordered) {
      if (seen.has(`${workspaceId}${UNIT}${unit}`)) continue;
      seen.add(`${workspaceId}${UNIT}${unit}`);
      const [family, ...rest] = unit.split(':');
      const id = rest.join(':');
      if (family === 'worktree')
        this.sync(tx, workspaceId, unit, this.worktreeItems(tx, workspaceId, id as WorktreeId));
      else if (family === 'roadmap') this.roadmapUnit(tx, workspaceId, id);
      else if (family === 'finalization')
        this.sync(tx, workspaceId, unit, this.finalizationItems(tx, workspaceId, id));
    }
  }

  /** A new occurrence, continuing a flapping predecessor's reminder schedule. */
  private opening(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    scopeKey: string,
    wanted: ProjectedItem,
    now: string,
  ): AttentionItem {
    const previous = tx.attention.latest(workspaceId, wanted.subjectKey, wanted.code);
    const flapped =
      previous?.state === 'resolved' &&
      previous.resolvedAt !== undefined &&
      Date.parse(now) - Date.parse(previous.resolvedAt) < ATTENTION_FLAP_WINDOW_MS;
    const sent = flapped ? previous.delivery : undefined;
    const preferences =
      tx.notifications.settings(workspaceId)?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES;
    return itemOf(
      {
        id: randomUUID(),
        workspaceId,
        scopeKey,
        openedAt: now,
        ...(flapped ? { continues: previous.id } : {}),
      },
      wanted,
      {
        firstSentAt: sent?.firstSentAt ?? null,
        lastSentAt: sent?.lastSentAt ?? null,
        deliveredCount: sent?.deliveredCount ?? 0,
        // A reopened occurrence that was already sent waits for its next reminder.
        nextAttemptAt:
          sent?.firstSentAt != null
            ? nextReminderAt(sent.firstSentAt, sent.lastSentAt ?? sent.firstSentAt, preferences)
            : now,
        failures: 0,
        lastError: null,
        leaseToken: null,
        leaseUntil: null,
      },
    );
  }

  private operatorActedSince(tx: StorageRepositories, workspaceId: WorkspaceId, since: string) {
    const last = tx.audit.lastUserAction(workspaceId);
    return last !== undefined && last >= since;
  }

  private journal(tx: StorageRepositories, workspaceId: WorkspaceId, at: string): void {
    // One event per workspace per commit tells browsers the attention set changed.
    if (this.journaled.has(workspaceId)) return;
    this.journaled.add(workspaceId);
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      workspaceId,
      occurredAt: at,
      kind: 'notifications-changed',
      payload: { action: 'attention' },
    });
  }
  private readonly journaled = new Set<WorkspaceId>();

  /* ------------------------------------------------------------------------ */
  /* Projection units                                                          */
  /* ------------------------------------------------------------------------ */

  /** A worktree's cycle stop, or its latest hand-started run, and its merge state. */
  private worktreeItems(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    treeId: WorktreeId,
  ): ProjectedItem[] {
    const tree = tx.execution.worktrees.find(workspaceId, treeId);
    if (!tree) return [];
    const ws = encodeURIComponent(workspaceId);
    // A worktree without a work item is a plan finalization's or a roadmap's decision
    // preparation.
    const preparing = tree.workItemId
      ? undefined
      : tx.roadmaps
          .list(workspaceId)
          .flatMap((roadmap) =>
            (roadmap.decisionPreparations ?? [])
              .filter((preparation) => preparation.worktreeId === tree.id)
              .map((preparation) => ({ roadmap, preparation })),
          )[0];
    const item = tree.workItemId
      ? tx.planning.workItems.find(workspaceId, tree.workItemId)
      : preparing
        ? {
            status: 'admitted',
            sourceId: preparing.preparation.checkpointId,
            title: `Prepare the ${preparing.preparation.checkpointId} decision`,
          }
        : { status: 'admitted', sourceId: 'Finalization', title: 'Plan conformance and polish' };
    const project = tx.planning.projects.find(workspaceId, tree.projectId);
    const refs: AttentionItemRefs = {
      worktreeId: tree.id,
      projectId: tree.projectId,
      ...(tree.workItemId ? { workItemId: tree.workItemId } : {}),
      ...(tree.planVersionId ? { planVersionId: tree.planVersionId } : {}),
      ...(preparing ? { roadmapId: preparing.roadmap.id } : {}),
    };
    const path = preparing
      ? `/workspaces/${ws}/roadmaps`
      : tree.planVersionId
        ? `/workspaces/${ws}/projects/${encodeURIComponent(tree.projectId)}/plans/${encodeURIComponent(tree.planVersionId)}`
        : `/workspaces/${ws}/work-items/${encodeURIComponent(tree.workItemId ?? '')}`;
    const heading = (kind: 'merge' | 'attention') =>
      `${project?.name ?? 'CraftingTable'} · ${item?.sourceId ?? 'Work item'} · ${
        kind === 'merge' ? 'Ready for merge' : 'Needs attention'
      }`;
    const body = (reason: string) =>
      `${item?.title ?? ''}\n${reason}\nBranch: ${tree.branchName} → ${tree.integrationBranch ?? tree.baseBranch}`;
    const items: ProjectedItem[] = [];
    const merge = tx.execution.merges.latest(workspaceId, tree.id);
    if (merge?.status === 'reserved' && tree.status === 'active')
      items.push({
        subjectKey: `merge:${tree.id}`,
        code: 'merge-recovery-required',
        kind: 'attention',
        title: heading('attention'),
        message: body(
          'A merge stopped after its reservation. Merge again to recover it from the recorded commits.',
        ),
        path,
        refs,
      });
    if (merge?.status === 'merged' && merge.cleanupError)
      items.push({
        subjectKey: `merge:${tree.id}`,
        code: 'merge-cleanup-failed',
        kind: 'attention',
        title: heading('attention'),
        message: body(`Merged, but cleanup failed: ${merge.cleanupError}`),
        path,
        refs,
      });
    if (tree.status !== 'active' || item === undefined) return items;
    const cycle = tx.execution.cycles.latestForWorktree(workspaceId, tree.id);
    // A stopped cycle waits for the operator even when its work item already completed,
    // e.g. a re-verification of a slice of an accepted item.
    if (cycle && cycle.status !== 'stopped' && cycle.status !== 'completed') {
      // The controller declares each stop and whether automation claims it (R-A3); only
      // operator-owned stops become items.
      const attention = effectiveCycleAttention(cycle);
      if (attention?.owner !== 'operator') return items;
      const requirements = attention.code === 'merge-requirements';
      const kind =
        cycle.status === 'awaiting-merge' &&
        !requirements &&
        (!tree.executionScope || tree.executionScope.kind === 'slice')
          ? 'merge'
          : 'attention';
      items.push({
        subjectKey: `cycle:${cycle.id}`,
        code: attention.code,
        kind,
        title: heading(kind),
        message: body(
          requirements && attention.detail ? attention.detail : `${cycle.step}: ${cycle.reason}`,
        ),
        path,
        refs: { ...refs, cycleId: cycle.id, ...(cycle.owner ? ownerRefs(cycle.owner) : {}) },
      });
      return items;
    }
    // A hand-started run on a completed item is history, not a question.
    if (item.status === 'completed') return items;
    const run = tx.execution.runs.listForWorktree(workspaceId, tree.id)[0];
    if (run === undefined || cycle?.currentRunId === run.id) return items;
    const runRefs = { ...refs, runId: run.id };
    const runPath = `/workspaces/${ws}/runs/${encodeURIComponent(run.id)}`;
    if (run.status === 'failed' || run.status === 'interrupted') {
      items.push({
        subjectKey: `run:${run.id}`,
        code: run.status === 'failed' ? 'manual-run-failed' : 'manual-run-interrupted',
        kind: 'attention',
        title: heading('attention'),
        message: body(`${run.role} run ${run.status}. Open the run to inspect and continue.`),
        path: runPath,
        refs: runRefs,
      });
      return items;
    }
    if (run.status !== 'waiting' && run.status !== 'finished') return items;
    const turn = tx.execution.runEvents.latestOfKind(workspaceId, run.id, 'turn-completed');
    const payload = turn?.kind === 'turn-completed' ? turn.payload : undefined;
    if (payload === undefined) return items;
    if (run.role === 'review') {
      const mergeable = run.verdict === 'mergeable' && payload.outcome === 'success';
      // A mergeable verdict counts only for the worktree state it reviewed.
      if (mergeable && run.reviewBranchContext?.worktreeVersion !== tree.version) return items;
      const report = payload.reviewReport;
      const counts = { blocking: 0, major: 0, minor: 0, nit: 0 };
      if (report?.status === 'complete')
        for (const finding of report.report.findings)
          if (finding.status === 'open') counts[finding.severity] += 1;
      items.push({
        subjectKey: `run:${run.id}`,
        code: mergeable ? 'manual-review-mergeable' : 'manual-review-needs-attention',
        kind: mergeable ? 'merge' : 'attention',
        title: heading(mergeable ? 'merge' : 'attention'),
        message: body(
          mergeable
            ? `Review reports mergeable. ${report?.status === 'complete' ? `Open findings: ${counts.blocking} blocking, ${counts.major} major, ${counts.minor} minor, ${counts.nit} nits.` : 'Structured finding counts are unavailable.'} Inspect the review and approve the merge.`
            : 'Review needs attention. Inspect findings and continue remediation.',
        ),
        path,
        refs: runRefs,
      });
    } else if (
      run.role === 'design' &&
      (payload.outcome !== 'success' ||
        !designHasNoOpenQuestions(payload.resultText, payload.truncated))
    )
      items.push({
        subjectKey: `run:${run.id}`,
        code: preparing ? 'decision-preparation-questions' : 'manual-design-questions',
        kind: 'attention',
        title: heading('attention'),
        message: body(
          'Design needs your input: open questions are unresolved or the conclusion is incomplete.',
        ),
        path,
        refs: runRefs,
      });
    return items;
  }

  /** A roadmap's own stop and the operator steps it was paused for. */
  private roadmapUnit(tx: StorageRepositories, workspaceId: WorkspaceId, roadmapId: string): void {
    const roadmap = tx.roadmaps.find(workspaceId, roadmapId);
    const scopeKey = `roadmap:${roadmapId}`;
    // The scheduler's derived sets hold only while it is running.
    if (roadmap?.status !== 'running') this.sync(tx, workspaceId, `roadmap-pass:${roadmapId}`, []);
    if (!roadmap) {
      this.sync(tx, workspaceId, scopeKey, []);
      return;
    }
    const name = roadmap.definition.name;
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/roadmaps`;
    const refs = { roadmapId };
    const items: ProjectedItem[] = [];
    const attention = effectiveRoadmapAttention(roadmap);
    if (attention?.owner === 'operator') {
      const active = roadmap.attempts.find((attempt) => attempt.status !== 'completed');
      // The cycle's own item carries the findings and branch details for this stop.
      const cycleItem =
        active &&
        tx.attention
          .openInScope(workspaceId, `worktree:${active.worktreeId}`)
          .some((item) => item.subjectKey === `cycle:${active.cycleId}`);
      if (!cycleItem)
        items.push({
          subjectKey: `roadmap:${roadmapId}`,
          code: attention.code,
          kind: 'attention',
          title: `${name} · Roadmap needs attention`,
          message: roadmap.reason,
          path,
          refs,
        });
    }
    if (tx.amendments.pending(workspaceId, roadmapId))
      items.push({
        subjectKey: `roadmap:${roadmapId}:amendment`,
        code: 'amendment-decision',
        kind: 'attention',
        title: `${name} · Planning amendment to decide`,
        message:
          'A planning amendment awaits review. The roadmap is held until it is applied or rejected.',
        path,
        refs,
      });
    else if (
      roadmap.status === 'paused' &&
      roadmap.attempts.some((attempt) => attempt.dependencyRefresh)
    )
      items.push({
        subjectKey: `roadmap:${roadmapId}:dependency-refresh`,
        code: 'dependency-refresh-resume',
        kind: 'attention',
        title: `${name} · Resume to run refreshed reviews`,
        message: roadmap.reason,
        path,
        refs,
      });
    this.sync(tx, workspaceId, scopeKey, items);
  }

  private finalizationItems(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    finalizationId: string,
  ): ProjectedItem[] {
    const finalization = tx.execution.finalizations.find(workspaceId, finalizationId);
    const cleanup = finalization?.integrationCleanup;
    if (!finalization || cleanup?.status !== 'blocked') return [];
    const project = tx.planning.projects.find(workspaceId, finalization.projectId);
    return [
      {
        subjectKey: `finalization:${finalization.id}`,
        code: 'finalization-cleanup-blocked',
        kind: 'attention',
        title: `${project?.name ?? 'CraftingTable'} · Integration branch cleanup blocked`,
        message: `${finalization.integrationBranch}: ${cleanup.error ?? 'Removal was refused.'}`,
        path: `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(finalization.projectId)}/plans/${encodeURIComponent(finalization.planVersionId)}`,
        refs: {
          finalizationId: finalization.id,
          projectId: finalization.projectId,
          planVersionId: finalization.planVersionId,
        },
      },
    ];
  }
}

function ownerRefs(owner: { readonly roadmapId: string; readonly entryId: string }) {
  return { roadmapId: owner.roadmapId, entryId: owner.entryId };
}

function bound(item: ProjectedItem): ProjectedItem {
  return {
    ...item,
    title: notificationText(item.title, TITLE_LIMIT),
    message: notificationText(item.message, MESSAGE_LIMIT),
    ...(item.members ? { members: [...item.members].sort() } : {}),
  };
}

/** An open item in one canonical field order, so an unchanged projection writes nothing. */
function itemOf(
  base: Pick<AttentionItem, 'id' | 'workspaceId' | 'scopeKey' | 'openedAt' | 'continues'>,
  wanted: ProjectedItem,
  delivery: AttentionItem['delivery'],
): AttentionItem {
  return {
    id: base.id,
    workspaceId: base.workspaceId,
    scopeKey: base.scopeKey,
    subjectKey: wanted.subjectKey,
    code: wanted.code,
    kind: wanted.kind,
    title: wanted.title,
    message: wanted.message,
    path: wanted.path,
    refs: wanted.refs,
    ...(wanted.members ? { members: wanted.members } : {}),
    ...(wanted.actions?.length ? { actions: wanted.actions } : {}),
    state: 'open',
    openedAt: base.openedAt,
    ...(base.continues ? { continues: base.continues } : {}),
    delivery,
  };
}

function sameItem(a: AttentionItem, b: AttentionItem): boolean {
  return JSON.stringify(itemOf(a, a, a.delivery)) === JSON.stringify(b);
}
