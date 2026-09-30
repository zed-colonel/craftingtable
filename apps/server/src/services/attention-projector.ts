import { randomUUID } from 'node:crypto';
import { roadmapPath } from './roadmap-paths.js';
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
  truncateUtf16,
  type Roadmap,
  type RoadmapEntryHold,
  type WorkCycle,
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
import { preparedDecisionAccepted } from './decision-preparation-policy.js';

/**
 * Where a moved upstream pin is refreshed (LIVE-15): the owning roadmap's dependency
 * environment on the Roadmaps page. `ws` is already encoded; the focus names the panel's element
 * id (`RuntimeEvidencePanel`). A cycle no roadmap owns keeps its own page: the definition's
 * panel renders only once its map revision is picked, so a link to it would land nowhere.
 */
/**
 * Where a cycle's shared decisions are decided (LIVE-18): its roadmap's setup when that page
 * shows them (a cross-project roadmap, or one whose slices come from one map revision), else the
 * page of the map its scope comes from. `ws` is already encoded.
 */
function decisionsPath(tx: StorageRepositories, ws: string, cycle: WorkCycle): string | undefined {
  const scope = cycle.executionScope;
  if (!scope) return undefined;
  const roadmap = cycle.owner && tx.roadmaps.find(cycle.workspaceId, cycle.owner.roadmapId);
  const maps = new Set(
    roadmap?.definition.entries.flatMap((e) =>
      e.executionScope
        ? [`${e.executionScope.definitionId}:${e.executionScope.bindingRevision}`]
        : [],
    ),
  );
  if (roadmap && (roadmap.definition.crossProject || maps.size === 1))
    return roadmapPath(ws, roadmap.id, 'setup', `runtime-evidence-roadmap-${roadmap.id}-decisions`);
  return `/workspaces/${ws}/roadmaps/maps/${encodeURIComponent(scope.definitionId)}#${encodeURIComponent(`runtime-evidence-${scope.definitionId}-decisions`)}`;
}

/** Stops resolved by adopting a repository's checks (R-G13). */
const CHECK_CODES: ReadonlySet<string> = new Set([
  'repository-checks-undeclared',
  'check-definition-changed',
]);

function dependencyRefreshPath(ws: string, roadmapId: string | undefined): string | undefined {
  if (roadmapId === undefined) return undefined;
  return roadmapPath(ws, roadmapId, 'setup', `runtime-evidence-roadmap-${roadmapId}`);
}

/** What a projection unit wants open; the projector gives it identity and history. */
export type ProjectedItem = Pick<
  AttentionItem,
  | 'subjectKey'
  | 'code'
  | 'kind'
  | 'title'
  | 'message'
  | 'path'
  | 'refs'
  | 'members'
  | 'actions'
  | 'blocks'
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
/**
 * The roadmap hold a cycle's item carries, since the hold has no item of its own while the
 * cycle's is open (`projectUnit`; LIVE-20): the hold on the cycle's own entry, unless a recovery
 * round started from that entry is open (its repair's item carries the round's stops, R-C14);
 * and for a round's repair, the hold on the round's source entry, where the roadmap records what
 * stopped the round's merge (LIVE-24). An operator's own pause is not carried.
 */
export function carriedHold(
  roadmap: Pick<Roadmap, 'attempts' | 'entryHolds'> | null | undefined,
  cycle: Pick<WorkCycle, 'id' | 'owner'>,
): RoadmapEntryHold | undefined {
  if (!roadmap || !cycle.owner) return undefined;
  const own = roadmap.entryHolds?.[cycle.owner.entryId];
  const inRound = roadmap.attempts.some(
    (a) => a.recovery?.sourceEntryId === cycle.owner?.entryId && a.recovery?.phase !== 'completed',
  );
  const source = roadmap.attempts.find((a) => a.cycleId === cycle.id && a.recovery)?.recovery
    ?.sourceEntryId;
  const holds = [
    own && !inRound ? own : undefined,
    source ? roadmap.entryHolds?.[source] : undefined,
  ].filter((hold): hold is RoadmapEntryHold => hold?.status === 'needs-attention');
  // Both, when the repair's own entry is held too: neither has an item of its own.
  return holds.length > 1
    ? { ...holds[0]!, reason: holds.map((h) => h.reason).join(' ') }
    : holds[0];
}

export class AttentionProjector implements WriteObserver {
  private readonly pending = new Set<string>();
  private flushing: string[] = [];
  private changed = new Set<WorkspaceId>();
  /** The controller pass sequence at which each item opened during this boot. */
  private readonly openedAt = new Map<string, number>();
  /** Changes to `openedAt`, applied only once their transaction commits. */
  private staged: (() => void)[] = [];
  /** Units whose projection failed; reported once each, retried on every later write. */
  private readonly failing = new Set<string>();

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly passes: ControllerPasses,
    private readonly now: () => Date,
    /** Told after a commit that opened or resolved items, with the workspaces affected. */
    private readonly onChange: (workspaces: readonly WorkspaceId[]) => void = () => undefined,
    private readonly onFailure: (unit: string, error: unknown) => void = (unit, error) =>
      console.error(`Attention projection failed for ${unit}; it is retried.`, error),
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
        // A hold on an entry changes what its cycle's own item says (R-C5 increment 5).
        for (const attempt of roadmap.attempts)
          if (attempt.status !== 'completed')
            this.mark(roadmap.workspaceId, `worktree:${attempt.worktreeId}`);
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
      case 'protected-ref-move': {
        const move = record as PersistedRecords['protected-ref-move'];
        this.mark(move.workspaceId, `protected-refs:${move.repositoryId}`);
        return;
      }
      case 'evidence-decision': {
        // Accepting a decision settles its preparation's questions (LIVE-09).
        const decision = record as PersistedRecords['evidence-decision'];
        for (const roadmap of this.storage.roadmaps.list(decision.workspaceId))
          for (const preparation of roadmap.decisionPreparations ?? [])
            this.mark(decision.workspaceId, `worktree:${preparation.worktreeId}`);
        return;
      }
      default:
        return;
    }
  }

  beforeCommit(tx: StorageRepositories): void {
    if (this.pending.size) {
      const units = [...this.pending];
      this.pending.clear();
      this.flushing.push(...units);
      this.project(tx, units);
    }
    // One event per workspace per commit tells browsers the attention set changed.
    for (const workspaceId of this.changed) {
      if (this.journaled.has(workspaceId)) continue;
      this.journaled.add(workspaceId);
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        workspaceId,
        occurredAt: this.now().toISOString(),
        kind: 'attention-changed',
        payload: { open: tx.attention.open(workspaceId).length },
      });
    }
  }

  ended(committed: boolean): void {
    const staged = this.staged;
    this.staged = [];
    if (committed) for (const apply of staged) apply();
    else {
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

  /** Open items whose subject another item now carries resolve as superseded. */
  private supersede(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    scopeKey: string,
    subjectKey: string,
  ): void {
    const open = tx.attention.openInScope(workspaceId, scopeKey);
    if (!open.some((item) => item.subjectKey === subjectKey)) return;
    this.sync(
      tx,
      workspaceId,
      scopeKey,
      open.filter((item) => item.subjectKey !== subjectKey),
      { superseded: new Set([subjectKey]) },
    );
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
    options: {
      readonly superseded?: ReadonlySet<string>;
      /** An open item whose push schedule new items take over, e.g. a set split per member. */
      readonly carryFrom?: string;
    } = {},
  ): readonly AttentionItem[] {
    const now = this.now().toISOString();
    const open = tx.attention.openInScope(workspaceId, scopeKey);
    const carried = open.find((item) => item.subjectKey === options.carryFrom)?.delivery;
    const same = (a: Pick<AttentionItem, 'subjectKey' | 'code'>, b: typeof a) =>
      a.subjectKey === b.subjectKey && a.code === b.code;
    const touched: AttentionItem[] = [];
    for (const item of open) {
      if (desired.some((wanted) => same(wanted, item))) continue;
      const resolvedBy: AttentionResolution =
        desired.some((wanted) => wanted.subjectKey === item.subjectKey) ||
        options.superseded?.has(item.subjectKey)
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
      this.staged.push(() => this.openedAt.delete(item.id));
      this.changed.add(workspaceId);
      touched.push(item);
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
          // A set that gained a member is new work: it pages again as a new first send,
          // through the same gates as a new item.
          grew
            ? {
                ...existing.delivery,
                firstSentAt: null,
                lastSentAt: null,
                deliveredCount: 0,
                nextAttemptAt: now,
                since: now,
              }
            : existing.delivery,
        );
        if (!sameItem(existing, refreshed)) {
          tx.attention.update(refreshed);
          // Browsers show the text and counts too, so a refresh is a change for them.
          this.changed.add(workspaceId);
        }
        if (grew) {
          const pass = this.passes.current;
          this.staged.push(() => this.openedAt.set(existing.id, pass));
        }
        continue;
      }
      const item = this.opening(tx, workspaceId, scopeKey, bounded, now, carried);
      tx.attention.insert(item);
      const pass = this.passes.current;
      this.staged.push(() => this.openedAt.set(item.id, pass));
      this.changed.add(workspaceId);
      touched.push(item);
    }
    return touched;
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
    // Worktrees first: a roadmap's own stop defers to an open item of its cycle, so a
    // cycle item that opens or resolves re-derives its roadmap in the same commit.
    const queue = [
      ...expanded.filter((u) => !u.unit.startsWith('roadmap:')),
      ...expanded.filter((u) => u.unit.startsWith('roadmap:')),
    ];
    const roadmaps: { workspaceId: WorkspaceId; unit: string }[] = [];
    for (const next of [queue, roadmaps])
      for (let index = 0; index < next.length; index += 1) {
        const { workspaceId, unit } = next[index]!;
        const key = `${workspaceId}${UNIT}${unit}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const staged = this.staged.length;
        try {
          // A savepoint per unit: a unit that cannot be projected never fails the write
          // that caused it, nor any other unit.
          const touched = this.storage.transaction((inner) =>
            this.projectUnit(inner, workspaceId, unit),
          );
          this.failing.delete(key);
          for (const item of touched)
            if (item.refs.roadmapId && item.subjectKey.startsWith('cycle:'))
              roadmaps.push({ workspaceId, unit: `roadmap:${item.refs.roadmapId}` });
        } catch (error) {
          this.staged.length = staged;
          this.pending.add(key);
          if (!this.failing.has(key)) {
            this.failing.add(key);
            this.onFailure(unit, error);
          }
        }
      }
  }

  private projectUnit(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    unit: string,
  ): readonly AttentionItem[] {
    const [family, ...rest] = unit.split(':');
    const id = rest.join(':');
    if (family === 'worktree') {
      const touched = this.sync(
        tx,
        workspaceId,
        unit,
        this.worktreeItems(tx, workspaceId, id as WorktreeId),
      );
      // A cycle's own item replaces the roadmap's hold for the same entry.
      for (const item of tx.attention.openInScope(workspaceId, unit))
        if (item.subjectKey.startsWith('cycle:') && item.refs.roadmapId && item.refs.entryId)
          this.supersede(
            tx,
            workspaceId,
            `roadmap-pass:${item.refs.roadmapId}`,
            `roadmap:${item.refs.roadmapId}:entry:${item.refs.entryId}`,
          );
      return touched;
    }
    if (family === 'roadmap') {
      this.roadmapUnit(tx, workspaceId, id);
      return [];
    }
    if (family === 'finalization')
      return this.sync(tx, workspaceId, unit, this.finalizationItems(tx, workspaceId, id));
    if (family === 'protected-refs')
      return this.sync(tx, workspaceId, unit, this.protectedRefItems(tx, workspaceId, id));
    return [];
  }

  /**
   * Protected branches and tags that moved during runs, not by the daemon, and that nobody has
   * acknowledged (R-G5 follow-up): one item per repository, each move a member, so a new move
   * pages again. It blocks nothing; Acknowledge in the inbox resolves it.
   */
  private protectedRefItems(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    repositoryId: string,
  ): ProjectedItem[] {
    const moves = tx.protectedRefs.unacknowledged(workspaceId, repositoryId);
    const latest = moves.at(-1);
    if (!latest) return [];
    const ws = encodeURIComponent(workspaceId);
    const name =
      tx.execution.sourceRepositories.find(
        workspaceId,
        repositoryId as Parameters<typeof tx.execution.sourceRepositories.find>[1],
      )?.displayName ?? 'Repository';
    const short = (sha: string | null, absent: string) => sha?.slice(0, 12) ?? absent;
    const lines = moves.map(
      (move) =>
        `Run ${move.runId.slice(0, 8)}: ${move.moves
          .map((m) => `${m.branch} ${short(m.before, '(absent)')} → ${short(m.after, '(deleted)')}`)
          .join(', ')}`,
    );
    return [
      {
        subjectKey: `protected-refs:${repositoryId}`,
        code: 'protected-ref-moved',
        kind: 'attention',
        title: `${name} · Protected branches moved outside CraftingTable`,
        message: `Something other than CraftingTable moved these refs while runs worked. Check each move, then acknowledge it.\n${lines.join('\n')}`,
        path: `/workspaces/${ws}/runs/${encodeURIComponent(latest.runId)}`,
        refs: { runId: latest.runId, worktreeId: latest.worktreeId },
        members: moves.map((move) => move.id),
        actions: ['acknowledge'],
        blocks: 0,
      },
    ];
  }

  /** A new occurrence, continuing a flapping predecessor's reminder schedule. */
  private opening(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    scopeKey: string,
    wanted: ProjectedItem,
    now: string,
    carried?: AttentionItem['delivery'],
  ): AttentionItem {
    const previous = tx.attention.latest(workspaceId, wanted.subjectKey, wanted.code);
    const flapped =
      previous?.state === 'resolved' &&
      previous.resolvedAt !== undefined &&
      Date.parse(now) - Date.parse(previous.resolvedAt) < ATTENTION_FLAP_WINDOW_MS;
    // Sent means an accepted push carried it, even one that resolved while in flight.
    const logged = flapped ? tx.attention.delivered(workspaceId, previous.id) : undefined;
    const sent =
      (flapped && previous.delivery.firstSentAt !== null
        ? previous.delivery
        : logged && {
            firstSentAt: logged.first,
            lastSentAt: logged.last,
            deliveredCount: logged.count,
          }) ||
      (carried?.firstSentAt ? carried : undefined) ||
      this.adoptLegacy(tx, workspaceId, wanted.subjectKey);
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

  /**
   * Folds a pre-schema-32 outbox row into the first item for its subject, so a deploy does
   * not page again for something already sent. Matched rows resolve.
   */
  private adoptLegacy(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    subjectKey: string,
  ): Pick<AttentionItem['delivery'], 'firstSentAt' | 'lastSentAt' | 'deliveredCount'> | undefined {
    const matched = tx.notifications
      .records(workspaceId, true)
      .filter((record) => record.kind !== 'test' && legacySubject(record.sourceKey) === subjectKey);
    if (!matched.length) return undefined;
    const now = this.now().toISOString();
    for (const record of matched)
      tx.notifications.saveRecord({
        ...record,
        state: 'resolved',
        resolvedAt: now,
        leaseToken: null,
        leaseUntil: null,
      });
    const sent = matched
      .filter((record) => record.firstSentAt !== null)
      .sort((a, b) => (b.lastSentAt ?? '').localeCompare(a.lastSentAt ?? ''))[0];
    return sent
      ? {
          firstSentAt: sent.firstSentAt,
          lastSentAt: sent.lastSentAt,
          deliveredCount: sent.deliveredCount,
        }
      : undefined;
  }

  private operatorActedSince(tx: StorageRepositories, workspaceId: WorkspaceId, since: string) {
    const last = tx.audit.lastUserAction(workspaceId);
    return last !== undefined && last >= since;
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
      ? roadmapPath(
          ws,
          preparing.roadmap.id,
          'setup',
          `decision-preparation-${preparing.roadmap.id}`,
        )
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
    const active = tx.execution.cycles.activeForWorktree(workspaceId, tree.id);
    // A merge item is held while a command owns the worktree's cycle, like the cycle itself.
    const mergeRefs = active ? { ...refs, cycleId: active.id } : refs;
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
        refs: mergeRefs,
      });
    if (merge?.status === 'merged' && merge.cleanupError)
      items.push({
        subjectKey: `merge:${tree.id}`,
        code: 'merge-cleanup-failed',
        kind: 'attention',
        title: heading('attention'),
        message: body(`Merged, but cleanup failed: ${merge.cleanupError}`),
        path,
        refs: mergeRefs,
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
      // Automatic recovery for this review stopped converging: the review's own item, which
      // hosts its repair controls, carries that stop and the rounds' progress (R-C5).
      const roadmap = cycle.owner && tx.roadmaps.find(workspaceId, cycle.owner.roadmapId);
      const hold = cycle.owner && roadmap?.entryHolds?.[cycle.owner.entryId];
      const escalated =
        hold?.status === 'needs-attention' && hold.attention?.code === 'recovery-not-converging'
          ? hold
          : undefined;
      const carried = escalated ? undefined : carriedHold(roadmap, cycle);
      const held = carried ? `\nThe roadmap holds this item: ${carried.reason}` : '';
      const kind =
        // A held merge is the roadmap's, and it did not happen: not a merge to approve (LIVE-24).
        !carried &&
        cycle.status === 'awaiting-merge' &&
        !requirements &&
        (!tree.executionScope || tree.executionScope.kind === 'slice')
          ? 'merge'
          : 'attention';
      items.push({
        subjectKey: `cycle:${cycle.id}`,
        code: escalated ? 'recovery-not-converging' : attention.code,
        kind,
        title: heading(kind),
        message: body(
          escalated
            ? escalated.reason
            : (requirements && attention.detail
                ? attention.detail
                : `${cycle.step}: ${cycle.reason}`) + held,
        ),
        path:
          !escalated && attention.code === 'upstream-pin-moved'
            ? (dependencyRefreshPath(ws, cycle.owner?.roadmapId) ?? path)
            : // A shared-decision stop opens the decision cards (LIVE-18).
              !escalated && attention.code === 'shared-decision-required'
              ? (decisionsPath(tx, ws, cycle) ?? path)
              : // A check stop opens the repository's checks, where they are adopted (R-G13).
                !escalated &&
                  CHECK_CODES.has(attention.code) &&
                  attention.refs?.repositoryId !== undefined
                ? `/workspaces/${ws}/repositories#repository-checks-${encodeURIComponent(attention.refs.repositoryId)}`
                : path,
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
        !designHasNoOpenQuestions(payload.resultText, payload.truncated)) &&
      // A preparation whose decision was accepted in full asks nobody anything (LIVE-09).
      !(preparing && preparedDecisionAccepted(tx, preparing.preparation))
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
    const path = roadmapPath(encodeURIComponent(workspaceId), roadmapId);
    const refs = { roadmapId };
    const items: ProjectedItem[] = [];
    const superseded = new Set<string>();
    const attention = effectiveRoadmapAttention(roadmap);
    if (attention?.owner === 'operator') {
      const active = roadmap.attempts.find((attempt) => attempt.status !== 'completed');
      // The cycle's own item carries the findings and branch details for this stop.
      const cycleItem =
        active &&
        tx.attention
          .openInScope(workspaceId, `worktree:${active.worktreeId}`)
          .some((item) => item.subjectKey === `cycle:${active.cycleId}`);
      if (cycleItem) superseded.add(`roadmap:${roadmapId}`);
      else
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
        // Amendments are decided on the roadmap's history page (R-E2 review).
        path: roadmapPath(
          encodeURIComponent(workspaceId),
          roadmapId,
          'history',
          `map-amendments-${roadmapId}`,
        ),
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
    this.sync(tx, workspaceId, scopeKey, items, { superseded });
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
    // Contracts count UTF-16 units; `notificationText` counts code points (R-A4 review).
    title: truncateUtf16(notificationText(item.title, TITLE_LIMIT), TITLE_LIMIT),
    message: truncateUtf16(notificationText(item.message, MESSAGE_LIMIT), MESSAGE_LIMIT),
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
    ...(wanted.blocks !== undefined ? { blocks: wanted.blocks } : {}),
    state: 'open',
    openedAt: base.openedAt,
    ...(base.continues ? { continues: base.continues } : {}),
    delivery,
  };
}

function sameItem(a: AttentionItem, b: AttentionItem): boolean {
  return JSON.stringify(itemOf(a, a, a.delivery)) === JSON.stringify(b);
}

/**
 * The item subject a pre-R-A4 outbox key stood for. Keys are identifiers the daemon built,
 * `cycle:<id>:<status>…`, `run:<id>:<sequence>…`, `roadmap:<id>:<kind>…`, never prose.
 */
export function legacySubject(sourceKey: string): string | undefined {
  const [family, id, kind, entry] = sourceKey.split(':');
  if (!id) return undefined;
  if (family === 'cycle') return `cycle:${id}`;
  if (family === 'run') return `run:${id}`;
  if (family === 'storage') return sourceKey;
  if (family !== 'roadmap') return undefined;
  if (kind === 'needs-attention') return `roadmap:${id}`;
  if (kind === 'entry' && entry) return `roadmap:${id}:entry:${entry}`;
  return kind === 'environments' || kind === 'checkpoints' ? `roadmap:${id}:${kind}` : undefined;
}
