/**
 * The scheduler's derived attention (R-A4; R-B7): the setup items, the checkpoints ready for the
 * operator, the held entries and their waits, projected from a read snapshot after each pass and
 * written as the difference.
 */
import type { RoadmapSelection } from './selection.js';
import type { RoadmapState } from './state.js';
import { roadmapPath } from '../roadmap-paths.js';
import {
  type ConcurrencyDefinitionId,
  holdStop,
  required,
  type Roadmap,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { ProjectedItem } from '../attention-projector.js';
import { checkpointSubjectKey } from '../checkpoint-subject.js';
import { slicesWaitingOn } from '../decision-demand.js';
import { decisionSettlement, settlementLines } from '../decision-settlement.js';
import { scopePhaseBlockers } from '../execution-scope.js';
import { mapReadSnapshot } from '../map-read-snapshot.js';
import { operatorSetupItem } from '../operator-setup-item.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { RoadmapViews } from './views.js';

/**
 * What a shared decision's item says of the work it serves (LIVE-22): the roadmap's selected
 * slices an accepted clause-level decision settles it for, and the selected slices and work
 * items that still need it. Nothing to add when nothing is settled and nothing selected needs
 * it directly (it is needed through another milestone): the plain line says it all.
 */
function decisionNeeds(
  tx: StorageRepositories,
  ws: WorkspaceId,
  selection: { readonly definitionId: ConcurrencyDefinitionId; readonly bindingRevision: number },
  nodes: readonly {
    readonly kind: string;
    readonly sourceId: string;
    readonly included: boolean;
  }[],
  checkpointId: string,
): string | undefined {
  const d = tx.imports.definition(ws, selection.definitionId);
  if (!d) return undefined;
  const selected = new Set(
    nodes
      .filter((n) => (n.kind === 'slice' || n.kind === 'work_item') && n.included)
      .map((n) => n.sourceId),
  );
  return settlementLines(
    decisionSettlement(tx, ws, d, selection.bindingRevision, checkpointId),
    selected,
  );
}

export class RoadmapAttention {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly state: RoadmapState,
    private readonly selection: RoadmapSelection,
    private readonly views: RoadmapViews,
  ) {}

  /**
   * Brings the scheduler's derived attention up to date (R-A4): verification setup for
   * slice verifications it cannot start, checkpoints ready for independent evidence, and
   * entries held for the operator. They need the map, so the scheduler evaluates them after
   * its pass, from a read snapshot, and writes only the difference. A stopped or paused
   * roadmap's items are resolved with the roadmap's own write.
   */
  syncAttention(force = false): void {
    const attention = this.state.attention;
    if (!attention) return;
    const generation = this.notifier.generation;
    const now = this.state.now().getTime();
    if (
      !force &&
      generation === this.state.attentionSynced.generation &&
      now - this.state.attentionSynced.at < 30_000
    )
      return;
    this.state.attentionSynced = { generation, at: now };
    const snapshot = mapReadSnapshot(this.storage);
    for (const roadmap of this.storage.roadmaps.list()) {
      if (roadmap.status !== 'running') continue;
      const items = this.attentionItems(snapshot, roadmap);
      this.storage.transaction((tx) => {
        const current = tx.roadmaps.find(roadmap.workspaceId, roadmap.id);
        // Checkpoints were one set item before they became one item each (R-A5): the set
        // hands its push schedule to them and is superseded, not resolved as a false alarm.
        const set = `roadmap:${roadmap.id}:checkpoints`;
        attention.sync(
          tx,
          roadmap.workspaceId,
          `roadmap-pass:${roadmap.id}`,
          current?.status === 'running' ? items : [],
          { superseded: new Set([set]), carryFrom: set },
        );
      });
    }
  }

  /** Replay seam (R-I10): the items this roadmap's pass would project if it were running. */
  passAttention(roadmap: Roadmap): readonly ProjectedItem[] {
    return this.attentionItems(mapReadSnapshot(this.storage), roadmap);
  }

  attentionItems(tx: StorageRepositories, roadmap: Roadmap): ProjectedItem[] {
    const workspaceId = roadmap.workspaceId;
    // The roadmap's board (R-E2); setup items open its setup at their section.
    const ws = encodeURIComponent(workspaceId);
    const path = roadmapPath(ws, roadmap.id);
    const setupPath = (section: string) =>
      roadmapPath(ws, roadmap.id, 'setup', `runtime-evidence-roadmap-${roadmap.id}${section}`);
    const name = roadmap.definition.name;
    const items: ProjectedItem[] = [];
    // Entries only the operator can move by setup or a stop of their own (R-E3b): a slice
    // verification not yet started, by its verify gate; the rest by their computed progress.
    const operator = this.views.withOperatorNeeds(tx, roadmap);
    const entryProgress = this.views.view(roadmap, tx, operator).progress;
    const setup = operatorSetupItem({
      roadmapId: roadmap.id,
      name,
      setupPath,
      entries: roadmap.definition.entries.map((entry) => ({
        entry,
        blockers:
          entry.executionScope?.kind === 'slice-verification' &&
          !roadmap.attempts.some((a) => a.entryId === entry.id)
            ? scopePhaseBlockers(tx, workspaceId, entry.workItemId, entry.executionScope, 'verify')
            : entryProgress.find((p) => p.entryId === entry.id)?.blockers,
      })),
    });
    if (setup) items.push(setup);
    if (roadmap.definition.crossProject) {
      // Each checkpoint ready for the operator's acceptance is its own item, named by its kind
      // and counting the unfinished selected slices that wait on it (R-A5, R-C3b).
      const selection = roadmap.definition.crossProject;
      const nodes = required(operator.mapState(), "the cross-project map's state").nodes;
      const source = tx.imports.definition(workspaceId, selection.definitionId)?.source;
      const needed = operator.needs(entryProgress)?.all ?? new Set();
      for (const node of nodes) {
        if (
          !node.included ||
          node.satisfied ||
          node.kind !== 'checkpoint' ||
          node.blockers.length ||
          !needed.has(node.key)
        )
          continue;
        const kind = source?.checkpoints.find((c) => c.id === node.sourceId)?.kind;
        const code =
          kind === 'architecture_decision'
            ? ('architecture-decision' as const)
            : kind === 'plan_approval'
              ? ('plan-acceptance' as const)
              : ('checkpoint-evidence' as const);
        items.push({
          subjectKey: checkpointSubjectKey(roadmap.id, node.sourceId),
          code,
          kind: 'attention',
          title: `${name} · ${node.sourceId} · ${
            code === 'architecture-decision'
              ? 'Decision to accept'
              : code === 'plan-acceptance'
                ? 'Plan to accept'
                : 'Evidence to review'
          }`,
          message: `${node.title}\n${
            (code === 'architecture-decision' &&
              decisionNeeds(tx, workspaceId, selection, nodes, node.sourceId)) ||
            'Ready for independent evidence review and your acceptance.'
          }`,
          path: setupPath(
            code === 'architecture-decision'
              ? '-decisions'
              : code === 'plan-acceptance'
                ? '-plan-acceptance'
                : '-evidence',
          ),
          refs: { roadmapId: roadmap.id },
          blocks: slicesWaitingOn(nodes, node.key),
        });
      }
    }
    for (const [entryId, hold] of Object.entries(roadmap.entryHolds ?? {})) {
      const held = holdStop(hold);
      if (!held) continue;
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry) continue;
      const attempt = roadmap.attempts.find((a) => a.entryId === entryId);
      const cycle = attempt && tx.execution.cycles.find(workspaceId, attempt.cycleId);
      // The recovery round started from this entry's review, whose repair is where its work
      // happens (LIVE-13). A round for another entry of the work item carries other stops.
      const round = this.selection.roundFor(roadmap, entry);
      const repair =
        round?.recovery?.sourceEntryId === entry.id
          ? tx.execution.cycles.find(workspaceId, round.cycleId)
          : undefined;
      // A manual recovery, or the round's repair, has taken over this checkpoint. The saved
      // hold remains historical until reconciliation; it is not a second task.
      if (cycle?.status === 'running' || repair?.status === 'running') continue;
      if (entry.executionScope && this.selection.scopeComplete(tx, roadmap, entry)) continue;
      // The cycle's own item already carries this stop, with its findings and branch.
      if (
        [cycle, repair].some(
          (carrier) =>
            carrier &&
            tx.attention
              .openInScope(workspaceId, `worktree:${carrier.worktreeId}`)
              .some((item) => item.subjectKey === `cycle:${carrier.id}`),
        )
      )
        continue;
      const reverifiable = !('refused' in this.selection.reverification(roadmap, entry, tx));
      items.push({
        subjectKey: `roadmap:${roadmap.id}:entry:${entry.id}`,
        code: held.code,
        kind: 'attention',
        title: `${entry.sourceId} · Roadmap item needs attention`,
        message: `${entry.title}\n${hold.reason}`,
        path,
        refs: {
          roadmapId: roadmap.id,
          entryId: entry.id,
          workItemId: entry.workItemId,
          ...(cycle ? { cycleId: cycle.id } : {}),
        },
        ...(reverifiable ? { actions: ['reverify' as const] } : {}),
      });
    }
    // An entry held back for a predecessor's missing merge (R-B4, decision 1): its merge is
    // recorded, or merged, in Plan branch settings of the entry's plan.
    for (const [entryId, wait] of Object.entries(roadmap.entryWaits ?? {})) {
      if (wait.code !== 'predecessor-merge-missing') continue;
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      const item = entry && tx.planning.workItems.find(workspaceId, entry.workItemId);
      if (!entry || !item) continue;
      items.push({
        subjectKey: `roadmap:${roadmap.id}:entry:${entry.id}:predecessor-merge`,
        code: 'predecessor-merge-missing',
        kind: 'attention',
        title: `${entry.sourceId} · Predecessor merge missing`,
        message: `${entry.title}\n${wait.reason}`,
        path: `/workspaces/${ws}/projects/${encodeURIComponent(item.projectId)}/plans/${encodeURIComponent(entry.planVersionId)}#branches`,
        refs: { roadmapId: roadmap.id, entryId: entry.id, workItemId: entry.workItemId },
      });
    }
    // An entry whose cycle ended (stopped, or completed without completing the entry) waits on
    // the operator, and the cycle's own item closed with it (R-C10's follow-up, decision 7). A
    // review entry offers Re-verify where it applies; otherwise its item opens the board, whose
    // controls are today's.
    for (const [entryId, wait] of Object.entries(roadmap.entryWaits ?? {})) {
      if (wait.code !== 'cycle-ended') continue;
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry) continue;
      const reverifiable =
        !!entry.executionScope &&
        entry.executionScope.kind !== 'slice' &&
        !('refused' in this.selection.reverification(roadmap, entry, tx));
      items.push({
        subjectKey: `roadmap:${roadmap.id}:entry:${entry.id}:cycle-ended`,
        code: 'cycle-needs-attention',
        kind: 'attention',
        title: `${entry.sourceId} · Cycle ended`,
        message: `${entry.title}\n${wait.reason}`,
        path,
        refs: {
          roadmapId: roadmap.id,
          entryId: entry.id,
          workItemId: entry.workItemId,
          ...(wait.refs?.cycleId ? { cycleId: wait.refs.cycleId } : {}),
        },
        ...(reverifiable ? { actions: ['reverify' as const] } : {}),
      });
    }
    return items;
  }
}
