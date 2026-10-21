/**
 * What the browser reads of a roadmap (R-B7): its view and per-entry progress, the status list,
 * the page region with its board and graph, the agents' and capacities' settings views with what
 * holds them (`settingsHeld`, which the commands refuse on too), the list's summaries, the
 * definitions and history, and what the operator is needed for (R-C14). One map evaluation per
 * read; nothing here writes.
 */
import type { RoadmapSelection } from './selection.js';
import type { RoadmapWriter } from './writer.js';
import type { RoadmapState } from './state.js';
import { ended } from './shared.js';
import { supportsArchitectureDecision } from '../architecture-decision-policy.js';
import { attemptDefinition, effectiveDelegation } from '../roadmap-delegation-policy.js';
import type {
  RoadmapAgentSettings,
  RoadmapCapacities,
  CrossProjectView,
  RoadmapBoard,
  RoadmapGraph,
} from '@craftingtable/contracts';
import {
  type AttentionItem,
  DEFAULT_ROADMAP_SCHEDULING,
  ENTRY_WAIT,
  holdStop,
  operatorOwnsAll,
  PHASE_BLOCKERS,
  required,
  type Roadmap,
  type RoadmapDefinition,
  type RoadmapId,
  type RoadmapStatusEntry,
  type RoadmapStatusList,
  roadmapStop,
  type RoadmapView,
  startedAttempts,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import {
  entryAgents,
  latestAssignment,
  preparationAgent,
  stepPermissions,
} from '../agent-profile-policy.js';
import { selectionSet } from '../agent-resolution.js';
import type { AuthContext } from '../auth-service.js';
import { checkpointSubjectKey } from '../checkpoint-subject.js';
import { crossProjectState, effectiveMapLevel, mapActivity } from '../map-state.js';
import { slicesHeldBy } from '../decision-demand.js';
import { cycleStep } from '../entry-waits.js';
import { NotFoundError } from '../errors.js';
import { scopePhaseBlockers } from '../execution-scope.js';
import { mapReadSnapshot } from '../map-read-snapshot.js';
import {
  buildBoard,
  type ItemSubject,
  itemNodeKeys,
  itemSubjectOf,
  mapGraph,
  type NodeEvaluation,
  sequenceGraph,
} from '../roadmap-board.js';
import type { WorkCycleService } from '../work-cycle-service.js';
import type { WorkspaceService } from '../workspace-service.js';

type CheckpointNode = {
  readonly key: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly included: boolean;
  readonly satisfied: boolean;
  readonly blockers: readonly string[];
  readonly requirements: readonly string[];
};

/**
 * What the operator is needed for now (R-C14, LIVE-10): per entry, the checkpoint IDs only the
 * operator settles that stand between the entry and progress; and all of them together.
 *
 * - The operator settles a decision, a plan acceptance, and evidence no slice review produces
 *   (a checkpoint no slice requires at merge). A slice's merge checkpoint is produced by that
 *   slice's own delegated review, or its cycle stops for the operator itself.
 * - An entry is on the frontier when every blocker is the operator's or a checkpoint. From
 *   its checkpoints, the walk follows unmet checkpoint prerequisites (a decision behind a
 *   delegated review), and keeps those the operator settles and can answer now.
 * - Once every entry is complete, every checkpoint the selected scope still needs.
 */
function operatorNeeds(
  nodes: readonly CheckpointNode[],
  mergeRequired: ReadonlySet<string>,
  decisionKinds: ReadonlyMap<string, string>,
  progress: RoadmapView['progress'],
): { readonly all: ReadonlySet<string>; readonly byEntry: ReadonlyMap<string, readonly string[]> } {
  const bySource = new Map(
    nodes.filter((n) => n.kind === 'checkpoint').map((n) => [n.sourceId, n]),
  );
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const settledByOperator = (node: CheckpointNode) =>
    ['architecture_decision', 'plan_approval'].includes(decisionKinds.get(node.sourceId) ?? '') ||
    !mergeRequired.has(node.sourceId);
  const all = new Set<string>();
  const byEntry = new Map<string, readonly string[]>();
  for (const p of progress) {
    if (
      p.status === 'completed' ||
      !p.blockers?.length ||
      !p.blockers.every(
        (b) => PHASE_BLOCKERS[b.code].owner === 'operator' || !!b.refs?.checkpointId,
      )
    )
      continue;
    const seen = new Set<string>();
    const queue = p.blockers.flatMap((b) => {
      const node = b.refs?.checkpointId ? bySource.get(b.refs.checkpointId) : undefined;
      return node && !node.satisfied ? [node.key] : [];
    });
    const needed: CheckpointNode[] = [];
    while (queue.length) {
      const key = required(queue.pop(), 'a queued checkpoint');
      if (seen.has(key)) continue;
      seen.add(key);
      const node = byKey.get(key);
      if (node?.kind !== 'checkpoint' || node.satisfied) continue;
      if (settledByOperator(node) && node.included && !node.blockers.length) needed.push(node);
      queue.push(...node.requirements);
    }
    if (needed.length)
      byEntry.set(
        p.entryId,
        needed.map((n) => n.sourceId),
      );
    for (const node of needed) all.add(node.key);
  }
  if (progress.every((p) => p.status === 'completed'))
    for (const node of bySource.values())
      if (node.included && !node.satisfied && !node.blockers.length) all.add(node.key);
  return { all, byEntry };
}

/**
 * Whether only the operator can move this entry now: the checkpoints it waits on need the
 * operator, or every blocker is the operator's own setup. The inbox, the entries' state and
 * the status list use this one rule (R-C14).
 */
function operatorActsNext(
  progress: Pick<RoadmapView['progress'][number], 'entryId' | 'blockers'>,
  needs: { readonly byEntry: ReadonlyMap<string, readonly string[]> } | undefined,
): boolean {
  return !!needs?.byEntry.has(progress.entryId) || operatorOwnsAll(progress.blockers);
}

export class RoadmapViews {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly cycles: WorkCycleService,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly selection: RoadmapSelection,
  ) {}

  list(context: AuthContext, workspaceId: WorkspaceId): readonly RoadmapView[] {
    this.workspaces.requireAuthorized(context, workspaceId);
    // One read snapshot for the whole list: roadmaps share definitions, evidence
    // and scheduling reads, so a per-roadmap snapshot re-decoded them (PERF-08a).
    const snapshot = mapReadSnapshot(this.storage);
    return this.storage.roadmaps.list(workspaceId).map((roadmap) => this.view(roadmap, snapshot));
  }

  /**
   * A roadmap's agents as its setup edits them (R-E5b): each entry's effective agents with their
   * sources, its step permissions, and on a map roadmap its activity and settings level.
   */
  agentSettings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
  ): RoadmapAgentSettings {
    this.workspaces.requireAuthorized(context, workspaceId);
    const r = this.writer.find(workspaceId, id);
    const held = this.settingsHeld(workspaceId, r);
    const cp = r.definition.crossProject;
    const binding =
      cp &&
      this.storage.imports
        .bindings(workspaceId, cp.definitionId)
        .find((b) => b.revision === cp.bindingRevision);
    return {
      id: r.id,
      name: r.definition.name,
      version: r.version,
      status: r.status,
      editBlocker: held.running
        ? 'A roadmap command is in progress.'
        : held.ended
          ? 'This roadmap has ended. Its agents can no longer change.'
          : held.settling
            ? 'This roadmap is being stopped.'
            : held.amendment
              ? 'Decide the pending planning amendment first.'
              : null,
      entries: r.definition.entries.map((e) => {
        const agents = entryAgents(r, e);
        const assignment = latestAssignment(r, e.id);
        const activity = cp ? mapActivity(e) : undefined;
        const alias = binding?.bindings.find((b) => b.planVersionId === e.planVersionId)?.alias;
        const level =
          cp && alias !== undefined && e.executionScope
            ? effectiveMapLevel(cp, alias, mapActivity(e), e.executionScope.sourceId)
            : undefined;
        return {
          id: e.id,
          label: e.sourceId + (e.executionScope ? ` · ${e.executionScope.kind}` : ''),
          projectId: e.projectId,
          projectName:
            this.storage.planning.projects.find(workspaceId, e.projectId)?.name ?? e.projectId,
          selections: selectionSet(agents),
          agents,
          permissions: stepPermissions(e.profiles),
          ...(activity ? { activity } : {}),
          ...(cp
            ? { settingsLevel: level ? { level: level.level, key: level.key } : 'defaults' }
            : {}),
          ...(assignment ? { appliedAt: assignment.appliedAt } : {}),
          started: startedAttempts(r).some((a) => a.entryId === e.id),
        };
      }),
    };
  }

  decisionSettings(context: AuthContext, ws: WorkspaceId, id: RoadmapId) {
    this.workspaces.requireAuthorized(context, ws);
    const roadmap = this.writer.find(ws, id),
      cp = roadmap.definition.crossProject;
    const d = cp && this.storage.imports.definition(ws, cp.definitionId);
    const binding = cp && this.storage.imports.bindings(ws, cp.definitionId)[0];
    return {
      version: roadmap.version,
      status: roadmap.status,
      decisions: (d?.source.checkpoints ?? [])
        .filter((c) => supportsArchitectureDecision(required(d, 'the map definition'), c.id))
        .flatMap((c) => {
          const owner = binding?.bindings.find((b) => b.alias === c.owner);
          const entry = roadmap.definition.entries.find(
            (e) => e.planVersionId === owner?.planVersionId,
          );
          if (!entry) return [];
          const latest = roadmap.decisionPreparations?.findLast((p) => p.checkpointId === c.id);
          const run = latest && this.storage.execution.runs.find(ws, latest.runId);
          return [
            {
              id: c.id,
              title: c.title,
              ...(() => {
                const agent = preparationAgent(roadmap, entry);
                return { profile: agent.selection, agent };
              })(),
              ...(latest
                ? {
                    latest: {
                      runId: latest.runId,
                      status: latest.failure ? 'failed' : (run?.status ?? 'preparing'),
                      summary: latest.failure ?? run?.outcomeSummary ?? '',
                      createdAt: latest.createdAt,
                    },
                  }
                : {}),
            },
          ];
        }),
    };
  }

  /** Capacity settings need no Git inspection or dependency-graph evaluation. */
  capacities(context: AuthContext, workspaceId: WorkspaceId): RoadmapCapacities {
    this.workspaces.requireAuthorized(context, workspaceId);
    return {
      roadmaps: this.storage.roadmaps
        .list(workspaceId)
        .filter((r) => !ended(r))
        .map((r) => [r, this.settingsHeld(workspaceId, r)] as const)
        .map(([r, held]) => ({
          id: r.id,
          version: r.version,
          name: r.definition.name,
          status: r.status,
          crossProject: !!r.definition.crossProject,
          revision: r.definition.revision,
          scheduling: r.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING,
          editBlocker: held.running
            ? 'A roadmap command is in progress.'
            : held.settling
              ? 'This roadmap is being stopped.'
              : held.amendment
                ? 'Decide the pending planning amendment first.'
                : (r.definition.scheduling?.mode ?? 'sequential') !== 'parallel'
                  ? 'This roadmap is sequential: one item at a time. Change scheduling mode on the roadmap before configuring parallel limits.'
                  : null,
          inFlight: r.attempts.flatMap((a) => {
            const entry = r.definition.entries.find((e) => e.id === a.entryId);
            return a.status !== 'completed' &&
              entry &&
              (!entry.executionScope || entry.executionScope.kind === 'slice')
              ? [{ workItemId: entry.workItemId, label: entry.sourceId, attemptId: a.id }]
              : [];
          }),
        })),
    };
  }

  /** The roadmap's read-only status list (R-E3a). */
  statusList(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId): RoadmapStatusList {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.statusOf(this.writer.find(workspaceId, id));
  }

  /**
   * Every open entry's state, what it waits on and who acts next, read from what the daemon
   * recorded: an open attention item (R-A4), the entry's hold, the scheduler's recorded wait
   * (R-C12), and last the entry's progress. Nothing here decides anything again.
   */
  statusOf(
    roadmap: Roadmap,
    snapshot: StorageRepositories = mapReadSnapshot(this.storage),
    operator = this.withOperatorNeeds(snapshot, roadmap),
    progress: readonly import('@craftingtable/domain').RoadmapEntryProgress[] = this.view(
      roadmap,
      snapshot,
      operator,
    ).progress,
  ): RoadmapStatusList {
    const ws = roadmap.workspaceId;
    const needs = operator.needs(progress);
    const items = this.storage.attention.open(ws);
    const attention = roadmapStop(roadmap);
    const entries: RoadmapStatusEntry[] = [];
    for (const entry of roadmap.definition.entries) {
      const state = progress.find((p) => p.entryId === entry.id);
      if (!state || state.status === 'completed') continue;
      // The recovery round that carries this work item's review, if any: its repair cycle is
      // where the entry's work happens while the round repairs.
      const round = this.selection.roundFor(roadmap, entry);
      const repair =
        round?.recovery?.phase === 'repair'
          ? snapshot.execution.cycles.find(ws, round.cycleId)
          : undefined;
      // The entry's own cycles, and those of the rounds that carry it.
      const cycleIds = new Set(
        roadmap.attempts
          .filter((a) => a.entryId === entry.id || a.recovery?.sourceEntryId === entry.id)
          .map((a) => a.cycleId),
      );
      if (round) cycleIds.add(round.cycleId);
      const item = items
        .filter(
          (i) =>
            (i.refs.roadmapId === roadmap.id && i.refs.entryId === entry.id) ||
            (i.refs.cycleId !== undefined && cycleIds.has(i.refs.cycleId)),
        )
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt))[0];
      const hold = roadmap.entryHolds?.[entry.id];
      const wait = roadmap.entryWaits?.[entry.id];
      const attempt = roadmap.attempts.find((a) => a.entryId === entry.id && !a.recovery);
      const own = attempt && snapshot.execution.cycles.find(ws, attempt.cycleId);
      const base = {
        entryId: entry.id,
        sourceId: entry.executionScope?.sourceId ?? entry.sourceId,
        scope: entry.executionScope?.kind ?? ('item' as const),
        title: entry.title,
        workItemId: entry.workItemId,
        state: state.status,
      };
      const blockers = state.blockers?.length
        ? { blockers: [...new Set(state.blockers.map((b) => b.code))] }
        : {};
      // A checkpoint the operator is asked to settle for this entry (R-C14).
      const checkpointItem = needs?.byEntry
        .get(entry.id)
        ?.map((id) => items.find((i) => i.subjectKey === checkpointSubjectKey(roadmap.id, id)))
        .find((i) => i !== undefined);
      const found = item ?? (hold?.status !== 'paused' ? checkpointItem : undefined);
      if (found) {
        entries.push({
          ...base,
          actor: 'operator',
          waitsOn: {
            source: 'attention-item',
            code: found.code,
            // The item's message says why; its title only names the subject.
            reason: found.message,
            since: found.openedAt,
            attentionItemId: found.id,
            ...(found.refs.cycleId ? { cycleId: found.refs.cycleId } : {}),
            ...(found.refs.runId ? { runId: found.refs.runId } : {}),
            ...blockers,
          },
        });
      } else if (hold) {
        const held = holdStop(hold);
        entries.push({
          ...base,
          actor: 'operator',
          waitsOn: { source: 'entry-hold', code: held?.code ?? hold.status, reason: hold.reason },
        });
      } else if (wait) {
        entries.push({
          ...base,
          actor: ENTRY_WAIT[wait.code],
          waitsOn: {
            source: 'entry-wait',
            code: wait.code,
            reason: wait.reason,
            since: wait.since,
            ...(wait.refs?.cycleId ? { cycleId: wait.refs.cycleId } : {}),
            ...(wait.refs?.entryId ? { entryId: wait.refs.entryId } : {}),
            ...(wait.refs?.blockers ? { blockers: [...wait.refs.blockers] } : {}),
          },
        });
      } else if (state.status === 'running') {
        // Running only while a cycle runs: the round's repair, else the entry's own cycle.
        const working = repair ?? own;
        const run =
          working?.status === 'running'
            ? snapshot.execution.runs.find(ws, working.currentRunId)
            : undefined;
        const step = working && working.status !== 'running' ? cycleStep(working) : undefined;
        entries.push({
          ...base,
          actor:
            working?.status === 'running'
              ? 'agent'
              : step && 'wait' in step
                ? ENTRY_WAIT[step.wait.code]
                : 'controller',
          waitsOn: {
            source: 'progress',
            code: step && 'wait' in step ? step.wait.code : state.status,
            reason: step && 'wait' in step ? `${state.reason} ${step.wait.reason}` : state.reason,
            ...(run?.startedAt ? { since: run.startedAt } : {}),
            ...(working ? { cycleId: working.id } : {}),
            ...(run ? { runId: run.id } : {}),
          },
        });
      } else {
        // The operator acts next when every blocker is theirs, as the inbox decides (LIVE-10);
        // a blocker-free stop or pause is the operator's by its state.
        const operatorActs = state.blockers?.length
          ? operatorActsNext(state, needs)
          : ['needs-attention', 'paused'].includes(state.status);
        // The roadmap's setup item lists the entries held on the operator's setup (R-E3b).
        const setup =
          operatorActs &&
          items.find((i) => i.refs.roadmapId === roadmap.id && i.members?.includes(entry.id));
        entries.push({
          ...base,
          actor: operatorActs ? 'operator' : 'controller',
          waitsOn: {
            source: 'progress',
            code: state.status,
            reason: state.reason,
            ...(setup ? { attentionItemId: setup.id } : {}),
            ...(own ? { cycleId: own.id } : {}),
            ...blockers,
          },
        });
      }
    }
    return {
      roadmapId: roadmap.id,
      name: roadmap.definition.name,
      status: roadmap.status,
      reason: roadmap.reason,
      ...(attention ? { attentionCode: attention.code } : {}),
      completed: progress.filter((p) => p.status === 'completed').length,
      entries,
    };
  }

  /**
   * A roadmap page's region (R-D5, PERF-06/14): the roadmap's view without its definition, the
   * revision to read that by, and its status list, in one transaction over one map snapshot. The
   * status list reads the view's progress, and both read one evaluation of the map (R-E3b).
   */
  page(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.readTransaction((tx) => {
      const snapshot = mapReadSnapshot(tx);
      const roadmap = this.writer.find(workspaceId, id);
      const operator = this.withOperatorNeeds(snapshot, roadmap);
      const view = this.view(roadmap, snapshot, operator);
      const { definition, ...withoutDefinition } = view.roadmap;
      const status = this.statusOf(roadmap, snapshot, operator, view.progress);
      const map = operator.mapState();
      if (map) this.rememberMap(roadmap, map);
      const board = this.board(snapshot, roadmap, operator, status, view.progress);
      return {
        view: { ...view, roadmap: withoutDefinition },
        definitionRevision: definition.revision,
        status,
        ...(board ? { board } : {}),
      };
    });
  }

  /**
   * The roadmap's board (R-E3b) from the read's one evaluation of the map: each milestone's
   * state, entries, run and open item, its roots and the slices it unblocks, and the gates.
   */
  board(
    tx: StorageRepositories,
    roadmap: Roadmap,
    operator: ReturnType<RoadmapViews['withOperatorNeeds']>,
    status: RoadmapStatusList,
    progress: RoadmapView['progress'],
  ): RoadmapBoard | undefined {
    const graph = this.graphAt(tx, roadmap.workspaceId, roadmap.id, roadmap.definition);
    if (!graph) return undefined;
    let state: (key: string) => NodeEvaluation | undefined;
    if (graph.model === 'map') {
      const map = operator.mapState();
      if (!map) return undefined;
      const evaluated = new Map(map.nodes.map((n) => [n.key, n]));
      state = (key) => evaluated.get(key);
    } else {
      // A work item is met when the daemon completed every entry on it, or, outside the
      // roadmap, the work item itself.
      const completed = new Set(
        progress.filter((p) => p.status === 'completed').map((p) => p.entryId),
      );
      const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
      state = (key) => {
        const node = byKey.get(key);
        if (!node?.workItemId) return undefined;
        const entries = roadmap.definition.entries.filter((e) => e.workItemId === node.workItemId);
        return {
          satisfied: entries.length
            ? entries.every((e) => completed.has(e.id))
            : tx.planning.workItems.find(roadmap.workspaceId, node.workItemId)?.status ===
              'completed',
          requirements: node.requires.map((r) => required(graph.nodes[r], 'a required node').key),
        };
      };
    }
    const items = new Map(
      this.storage.attention.open(roadmap.workspaceId).map((item) => [item.subjectKey, item.id]),
    );
    return buildBoard({
      graph,
      state,
      status,
      entries: roadmap.definition.entries,
      checkpointItems: new Map(
        graph.nodes.flatMap((n) => {
          const id =
            n.kind === 'checkpoint'
              ? items.get(checkpointSubjectKey(roadmap.id, n.sourceId))
              : undefined;
          return id ? [[n.sourceId, id] as const] : [];
        }),
      ),
    });
  }

  /**
   * How many slices each open item on a map roadmap holds (R-E3b decision 8), so the inbox ranks
   * them in one unit: one map evaluation per roadmap that has such an item. Items on no map
   * roadmap are left out and keep their own count.
   */
  mapItemSlices(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    items: readonly { readonly item: AttentionItem; readonly checkpointId?: string }[],
  ): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const roadmap of tx.roadmaps.list(workspaceId)) {
      const selection = roadmap.definition.crossProject;
      if (!selection || ended(roadmap)) continue;
      const graph = this.graphAt(tx, workspaceId, roadmap.id, roadmap.definition);
      if (!graph) continue;
      let nodes: CrossProjectView['nodes'] | undefined;
      for (const { item, checkpointId } of items) {
        if (counts.has(item.id)) continue;
        const subject = this.itemSubject(tx, roadmap, graph, item, checkpointId);
        if (!subject) continue;
        nodes ??= this.mapForRead(tx, roadmap).nodes;
        counts.set(
          item.id,
          slicesHeldBy(nodes, itemNodeKeys(graph, roadmap.definition.entries, subject)),
        );
      }
    }
    return counts;
  }

  rememberMap(roadmap: Roadmap, view: CrossProjectView): void {
    this.state.readMaps.set(roadmap.id, {
      commits: this.storage.commits,
      revision: roadmap.definition.revision,
      view,
    });
  }

  mapForRead(tx: StorageRepositories, roadmap: Roadmap): CrossProjectView {
    const known = this.state.readMaps.get(roadmap.id);
    if (known?.commits === this.storage.commits && known.revision === roadmap.definition.revision)
      return known.view;
    const view = crossProjectState(
      tx,
      roadmap.workspaceId,
      required(roadmap.definition.crossProject, 'the cross-project selection'),
    );
    this.rememberMap(roadmap, view);
    return view;
  }

  /** What an item is about on this map roadmap, from its typed references; none if not on it. */
  itemSubject(
    tx: StorageRepositories,
    roadmap: Roadmap,
    graph: RoadmapGraph,
    item: AttentionItem,
    checkpointId: string | undefined,
  ): ItemSubject | undefined {
    const cycle = item.refs.cycleId
      ? tx.execution.cycles.find(roadmap.workspaceId, item.refs.cycleId)
      : undefined;
    return itemSubjectOf({
      item,
      roadmapId: roadmap.id,
      checkpointId,
      cycle: cycle && { ...(cycle.owner ? { owner: cycle.owner } : {}) },
      bindsWorkItem: (id) => graph.nodes.some((n) => n.workItemId === id),
    });
  }

  /** A roadmap's dependency structure at one revision (R-E3b); revisions never change. */
  graph(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId, revision: number) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.writer.find(workspaceId, id);
    const definition = this.storage.roadmaps.definition(workspaceId, id, revision);
    const graph = definition && this.graphAt(this.storage, workspaceId, id, definition);
    if (!graph) throw new NotFoundError();
    return graph;
  }

  graphAt(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    roadmapId: RoadmapId,
    definition: RoadmapDefinition,
  ): RoadmapGraph | undefined {
    const key = `${workspaceId}:${roadmapId}:${definition.revision}`;
    const cached = this.state.graphs.get(key);
    if (cached) return cached;
    const selection = definition.crossProject;
    const map = selection && tx.imports.definition(workspaceId, selection.definitionId);
    if (selection && !map) return undefined;
    const graph = !selection
      ? sequenceGraph({
          roadmapId,
          revision: definition.revision,
          entries: definition.entries,
          workItem: (id) => tx.planning.workItems.find(workspaceId, id),
          predecessors: (id) =>
            tx.planning.dependencies
              .listPredecessors(workspaceId, id)
              .filter((p) => p.kind === 'required')
              .map((p) => p.workItemId),
          projectName: (id) =>
            tx.planning.projects.find(workspaceId, id as import('@craftingtable/domain').ProjectId)
              ?.name,
        })
      : mapGraph({
          roadmapId,
          revision: definition.revision,
          source: required(map, 'the roadmap’s map definition').source,
          bindings:
            tx.imports
              .bindings(workspaceId, required(map, 'the roadmap’s map definition').id)
              .find((b) => b.revision === selection.bindingRevision)?.bindings ?? [],
          targetId: selection.targetId,
          selection: selection.selection,
        });
    // A few roadmaps' current revisions; an old one is rebuilt if it is ever read again.
    if (this.state.graphs.size >= 32)
      this.state.graphs.delete(required(this.state.graphs.keys().next().value, 'the oldest graph'));
    this.state.graphs.set(key, graph);
    return graph;
  }

  /** One revision of a roadmap's definition; revisions never change (R-B3, R-D5). */
  definition(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId, revision: number) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.writer.find(workspaceId, id);
    const definition = this.storage.roadmaps.definition(workspaceId, id, revision);
    if (!definition) throw new NotFoundError();
    return definition;
  }

  /**
   * The roadmaps list page's rows (R-D5, PERF-06): each roadmap's name, status, reason and how
   * many of its entries are done, without its definition or per-entry progress.
   */
  summaries(context: AuthContext, workspaceId: WorkspaceId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.readTransaction((tx) => {
      const snapshot = mapReadSnapshot(tx);
      return snapshot.roadmaps.list(workspaceId).map((roadmap) => {
        const attention = roadmapStop(roadmap);
        return {
          id: roadmap.id,
          name: roadmap.definition.name,
          status: roadmap.status,
          reason: roadmap.reason,
          ...(attention ? { attentionCode: attention.code } : {}),
          completed: roadmap.definition.entries.filter((entry) =>
            this.selection.complete(roadmap, entry, snapshot),
          ).length,
          entries: roadmap.definition.entries.length,
        };
      });
    });
  }

  history(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.writer.find(workspaceId, id);
    return this.storage.roadmaps.history(workspaceId, id);
  }

  view(
    roadmap: Roadmap,
    snapshot = mapReadSnapshot(this.storage),
    operator = this.withOperatorNeeds(snapshot, roadmap),
  ): RoadmapView {
    const capacity = (key: string) => ({
      limit: snapshot.phaseScheduling.capacity(key),
      inUse: snapshot.phaseScheduling.active().filter((r) => r.resourceKey === key).length,
    });
    return {
      roadmap,
      hostCapacity: {
        development: capacity('local-development'),
        verification: capacity('local-verification'),
      },
      progress: operator.progress(
        roadmap.definition.entries
          .map((entry): import('@craftingtable/domain').RoadmapEntryProgress => {
            if (this.selection.complete(roadmap, entry, snapshot))
              return { entryId: entry.id, status: 'completed', reason: 'Completed.' };
            const hold = roadmap.entryHolds?.[entry.id];
            const currentAttempt = roadmap.attempts.find(
              (a) => a.entryId === entry.id && !a.recovery,
            );
            const currentCycle =
              currentAttempt &&
              snapshot.execution.cycles.find(roadmap.workspaceId, currentAttempt.cycleId);
            if (currentCycle && this.cycles.isTransitioning(currentCycle.id))
              return {
                entryId: entry.id,
                status: 'running',
                reason: 'Preparing the requested recovery.',
              };
            if (hold && currentCycle?.status !== 'running')
              return { entryId: entry.id, status: hold.status, reason: hold.reason };
            const recovery = this.selection.roundFor(roadmap, entry);
            if (recovery && entry.executionScope?.kind !== 'slice') {
              const repair = snapshot.execution.cycles.find(roadmap.workspaceId, recovery.cycleId);
              const repairNeedsYou =
                required(recovery.recovery, 'the recovery round’s state').phase === 'repair' &&
                repair &&
                ['paused', 'needs-attention', 'stopped'].includes(repair.status);
              return {
                entryId: entry.id,
                status: repairNeedsYou
                  ? 'needs-attention'
                  : roadmap.status === 'running'
                    ? 'running'
                    : 'paused',
                reason: repairNeedsYou
                  ? `Owning-slice recovery: ${repair.reason}`
                  : `Roadmap recovery: ${required(recovery.recovery, 'the recovery round’s state').phase === 'repair' ? 'repair and integration' : required(recovery.recovery, 'the recovery round’s state').phase === 'verification' ? 'fresh independent verification' : 'parent acceptance'}.`,
              };
            }
            const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
            const cycle =
              attempt && snapshot.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
            if (attempt?.reverification)
              return {
                entryId: entry.id,
                status: roadmap.status === 'running' ? 'queued' : 'paused',
                reason:
                  'Fresh independent review queued by Re-verify. Existing code and reviewer assignment are retained; it runs when the roadmap is running.',
              };
            if (attempt?.dependencyRefresh)
              return {
                entryId: entry.id,
                status: roadmap.status === 'running' ? 'queued' : 'paused',
                reason: `Fresh independent review queued for dependency generation ${attempt.dependencyRefresh.generation}. Existing code and reviewer assignment are retained; plan acceptance and Resume are required.`,
              };
            if (
              entry.executionScope &&
              (!cycle || ['running', 'awaiting-merge'].includes(cycle.status))
            ) {
              const phase =
                entry.executionScope.kind === 'parent-acceptance'
                  ? 'accept'
                  : entry.executionScope.kind === 'slice-verification'
                    ? 'verify'
                    : cycle?.status === 'awaiting-merge'
                      ? 'merge'
                      : 'start';
              const blockers = [
                ...scopePhaseBlockers(
                  snapshot,
                  roadmap.workspaceId,
                  entry.workItemId,
                  entry.executionScope,
                  phase,
                  { ownerId: cycle?.currentRunId },
                ),
                ...(phase === 'start' && !attempt
                  ? this.selection.decisionHold(snapshot, roadmap, entry)
                  : []),
              ];
              if (blockers.length)
                return {
                  entryId: entry.id,
                  // Whether the operator is the one to move it is decided once every entry's
                  // blockers are known (`withOperatorNeeds`, R-C14).
                  status: blockers.some((b) => b.code === 'resource-busy')
                    ? 'capacity-blocked'
                    : 'dependency-blocked',
                  reason: blockers.map((b) => `${phase} · ${b.kind}: ${b.message}`).join(' '),
                  phase,
                  blockers,
                };
            }
            if (cycle)
              return {
                entryId: entry.id,
                status:
                  cycle.status === 'running'
                    ? 'running'
                    : cycle.status === 'awaiting-merge'
                      ? 'awaiting-merge'
                      : 'needs-attention',
                reason: cycle.reason,
              };
            const reason = this.selection.blocker(roadmap, entry, attempt, snapshot);
            return {
              entryId: entry.id,
              status: reason?.needsAttention ? 'needs-attention' : reason ? reason.kind : 'queued',
              reason: reason?.reason ?? 'Waiting for its turn in the sequence.',
            };
          })
          .map((progress) => {
            const attempt = roadmap.attempts.find((a) => a.entryId === progress.entryId);
            const definition = attempt
              ? attemptDefinition(snapshot, roadmap, attempt)
              : roadmap.definition;
            const entry = required(
              roadmap.definition.entries.find((e) => e.id === progress.entryId),
              'the progress row’s entry',
            );
            return {
              ...progress,
              ...(progress.status !== 'completed' &&
              !('refused' in this.selection.reverification(roadmap, entry, snapshot))
                ? { reverifiable: true as const }
                : {}),
              effectiveAutomation: effectiveDelegation(
                roadmap,
                definition?.entries.find((e) => e.id === progress.entryId) ??
                  required(
                    roadmap.definition.entries.find((e) => e.id === progress.entryId),
                    'the progress row’s entry',
                  ),
                definition ?? roadmap.definition,
              ).automation,
            };
          }),
      ),
    };
  }

  /**
   * What the operator is needed for on this roadmap (R-C14), and a pass over computed progress
   * that marks an entry `needs-attention` exactly when only the operator can move it.
   */
  withOperatorNeeds(tx: StorageRepositories, roadmap: Roadmap) {
    let needs: ReturnType<typeof operatorNeeds> | undefined;
    // The map's evaluation, once per read: the view, the status list and the attention items
    // all read this one (R-E3b).
    let map: CrossProjectView | undefined;
    const selection = roadmap.definition.crossProject;
    const mapState = () => {
      if (selection && !map) map = crossProjectState(tx, roadmap.workspaceId, selection);
      return map;
    };
    const needsOf = (progress: RoadmapView['progress']) => {
      const source =
        selection && tx.imports.definition(roadmap.workspaceId, selection.definitionId)?.source;
      if (!selection || !source) return undefined;
      needs ??= operatorNeeds(
        required(mapState(), 'the cross-project map’s state').nodes,
        new Set(
          source.slices.flatMap((slice) =>
            slice.merge_requires.flatMap((r) => (r.kind === 'checkpoint' ? [r.id] : [])),
          ),
        ),
        new Map(source.checkpoints.map((c) => [c.id, c.kind])),
        progress,
      );
      return needs;
    };
    return {
      mapState,
      needs: (progress: RoadmapView['progress']) => needsOf(progress),
      progress: (progress: RoadmapView['progress']): RoadmapView['progress'] => {
        const found = needsOf(progress);
        return progress.map((p) =>
          p.phase && p.blockers?.length && operatorActsNext(p, found)
            ? { ...p, status: 'needs-attention' as const }
            : p,
        );
      },
    };
  }

  /**
   * What holds a roadmap's settings (R-B7, CTRL-14; decision 2 A): it ended, its wind-down
   * settles, a roadmap command holds it, or a planning amendment is pending. The commands refuse
   * on these and the views explain them, each site in its own order and words.
   */
  settingsHeld(workspaceId: WorkspaceId, roadmap: Roadmap) {
    return {
      ended: ended(roadmap),
      settling: this.storage.windDowns.find(workspaceId, roadmap.id)?.status === 'settling',
      running: this.state.controlling.has(roadmap.id),
      amendment: !!this.storage.amendments.pending(workspaceId, roadmap.id),
    };
  }
}
