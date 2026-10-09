import type { RoadmapBoard, RoadmapGraph } from '@craftingtable/contracts';
import {
  type ConcurrencyPlanBinding,
  type ConcurrencySource,
  milestoneKey,
  type RoadmapEntry,
  type RoadmapStatusList,
  targetClosure,
  type WorkItemId,
} from '@craftingtable/domain';

/**
 * The roadmap board's read model (R-E3b), pure: the static graph of a map roadmap at one
 * revision, and the board built from one evaluation of the map, the status list and the open
 * checkpoint items. Nothing here decides a state again: satisfaction and requirements are the
 * map's evaluation, states and actors stay on the status list, and the board only joins them by
 * node and walks the requirements for roots and unblocked slices.
 */

/** A map roadmap's milestones at one revision, in the order the map's evaluation lists them. */
export function mapGraph(input: {
  readonly roadmapId: string;
  readonly revision: number;
  readonly source: ConcurrencySource;
  readonly bindings: readonly Pick<ConcurrencyPlanBinding, 'workItems'>[];
  readonly targetId: string;
  readonly selection: 'target-only' | 'prioritize-full';
}): RoadmapGraph {
  const { source } = input;
  const closure = targetClosure(source, input.targetId, input.selection);
  const included = new Set(closure.nodes.map((n) => n.key));
  const all = [...closure.nodes, ...closure.excluded];
  const index = new Map(all.map((n, i) => [n.key, i]));
  const lanes = source.repositories.map((r) => ({ key: r.id, label: r.repository }));
  const laneOf = new Map(lanes.map((lane, i) => [lane.key, i]));
  const workItemIds = new Map(
    input.bindings.flatMap((b) => b.workItems).map((w) => [w.sourceId, w.workItemId]),
  );
  const checkpointKinds = new Map(source.checkpoints.map((c) => [c.id, c.kind]));
  return {
    roadmapId: input.roadmapId,
    revision: input.revision,
    model: 'map',
    lanes,
    nodes: all.map((n) => {
      const r = n.requirement;
      const lane = r.kind === 'checkpoint' ? undefined : laneOf.get(n.repository);
      const parent =
        n.parentId === undefined
          ? undefined
          : index.get(milestoneKey({ kind: 'work_item', id: n.parentId, state: 'accepted' }));
      const workItemId = r.kind === 'work_item' ? workItemIds.get(r.id) : undefined;
      const checkpointKind = r.kind === 'checkpoint' ? checkpointKinds.get(r.id) : undefined;
      return {
        key: n.key,
        kind: r.kind,
        sourceId: r.id,
        state: r.state,
        title: n.title,
        ...(lane === undefined ? {} : { lane }),
        ...(parent === undefined ? {} : { parent }),
        requires: n.requires.flatMap((k) => index.get(k) ?? []),
        included: included.has(n.key),
        ...(workItemId === undefined ? {} : { workItemId }),
        ...(checkpointKind === undefined ? {} : { checkpointKind }),
      };
    }),
  };
}

/**
 * A sequential roadmap's work items at one revision (R-E3b): one node per work item its entries
 * name, in roadmap order, each requiring its required predecessors (`work_item_dependencies`); a
 * predecessor the roadmap does not include is drawn too, as not selected. Lanes are projects.
 */
export function sequenceGraph(input: {
  readonly roadmapId: string;
  readonly revision: number;
  readonly entries: readonly Pick<RoadmapEntry, 'workItemId'>[];
  readonly workItem: (
    id: WorkItemId,
  ) =>
    | { readonly sourceId: string; readonly title: string; readonly projectId: string }
    | undefined;
  /** A work item's required predecessors. */
  readonly predecessors: (id: WorkItemId) => readonly WorkItemId[];
  readonly projectName: (id: string) => string | undefined;
}): RoadmapGraph {
  const included = [...new Set(input.entries.map((e) => e.workItemId))];
  const outside = [
    ...new Set(
      included.flatMap((id) => input.predecessors(id)).filter((id) => !included.includes(id)),
    ),
  ];
  const ids = [...included, ...outside].filter((id) => input.workItem(id) !== undefined);
  const index = new Map(ids.map((id, i) => [id, i]));
  const lanes: { key: string; label: string }[] = [];
  const laneOf = (projectId: string) => {
    const at = lanes.findIndex((l) => l.key === projectId);
    if (at >= 0) return at;
    lanes.push({ key: projectId, label: input.projectName(projectId) ?? projectId });
    return lanes.length - 1;
  };
  return {
    roadmapId: input.roadmapId,
    revision: input.revision,
    model: 'sequence',
    nodes: ids.map((id) => {
      const item = input.workItem(id)!;
      return {
        key: sequenceKey(id),
        kind: 'work_item' as const,
        sourceId: item.sourceId,
        state: 'completed' as const,
        title: item.title,
        lane: laneOf(item.projectId),
        requires: input.predecessors(id).flatMap((p) => index.get(p) ?? []),
        included: included.includes(id),
        workItemId: id,
      };
    }),
    lanes,
  };
}

/** A sequential roadmap's node key for a work item. */
export const sequenceKey = (workItemId: string) => `work_item:${workItemId}:completed`;

/** What the daemon evaluated for one node: whether it is met, and what it requires now. */
export interface NodeEvaluation {
  readonly satisfied: boolean;
  /** Node keys; a requirement a settled decision covers is no longer among them. */
  readonly requirements: readonly string[];
}

/** The graph nodes a roadmap entry works toward: a slice its start and merge, and so on. */
function entryNodeKeys(
  entry: Pick<RoadmapEntry, 'workItemId' | 'executionScope'>,
  graph: RoadmapGraph,
): readonly string[] {
  const scope = entry.executionScope;
  // A sequential roadmap works on whole work items, scoped or not.
  if (graph.model === 'sequence') return [sequenceKey(entry.workItemId)];
  if (scope?.kind === 'slice')
    return (['started', 'merged'] as const).map((state) =>
      milestoneKey({ kind: 'slice', id: scope.sourceId, state }),
    );
  if (scope?.kind === 'slice-verification')
    return [milestoneKey({ kind: 'slice', id: scope.sourceId, state: 'verified' })];
  if (scope?.kind === 'parent-acceptance')
    return [milestoneKey({ kind: 'work_item', id: scope.sourceId, state: 'accepted' })];
  return graph.nodes
    .filter((n) => n.kind === 'work_item' && n.workItemId === entry.workItemId)
    .map((n) => n.key);
}

/**
 * What an inbox item is about on a map roadmap's graph (R-E3b decision 8): a checkpoint, some of
 * the roadmap's entries (an entry's hold, a cycle's stop, the setup an item's members need), a
 * work item, or the whole roadmap.
 */
export type ItemSubject =
  | { readonly checkpointId: string }
  | { readonly entryIds: readonly string[] }
  | { readonly workItemId: string }
  | { readonly roadmap: true };

/**
 * What an inbox item is about on one map roadmap, from its typed references (R-E3b decision 8);
 * none when it is not on it. A cycle's stop is its owning entry's; an item for the roadmap is its
 * checkpoint's, its entry's, its members', or else the whole roadmap's; an item about a work item
 * alone is that work item's, when the map binds it.
 */
export function itemSubjectOf(input: {
  readonly item: {
    readonly refs: {
      readonly roadmapId?: string;
      readonly entryId?: string;
      readonly cycleId?: string;
      readonly workItemId?: string;
    };
    readonly members?: readonly string[];
  };
  readonly roadmapId: string;
  readonly checkpointId: string | undefined;
  /** The item's cycle, when it names one the daemon has, and the entry that owns it. */
  readonly cycle:
    | { readonly owner?: { readonly roadmapId: string; readonly entryId: string } }
    | undefined;
  readonly bindsWorkItem: (workItemId: string) => boolean;
}): ItemSubject | undefined {
  const { item, cycle } = input;
  const { refs } = item;
  const owner = cycle?.owner?.roadmapId === input.roadmapId ? cycle.owner : undefined;
  if (refs.roadmapId !== input.roadmapId && !owner)
    return !refs.roadmapId && !cycle && refs.workItemId && input.bindsWorkItem(refs.workItemId)
      ? { workItemId: refs.workItemId }
      : undefined;
  if (input.checkpointId) return { checkpointId: input.checkpointId };
  if (refs.entryId) return { entryIds: [refs.entryId] };
  if (owner) return { entryIds: [owner.entryId] };
  if (item.members?.length) return { entryIds: item.members };
  return { roadmap: true };
}

/** The graph nodes an item is about, whose slices and dependents it holds. */
export function itemNodeKeys(
  graph: RoadmapGraph,
  entries: readonly Pick<RoadmapEntry, 'id' | 'workItemId' | 'executionScope'>[],
  subject: ItemSubject,
): readonly string[] {
  if ('checkpointId' in subject)
    return [milestoneKey({ kind: 'checkpoint', id: subject.checkpointId, state: 'passed' })];
  if ('entryIds' in subject)
    return entries
      .filter((e) => subject.entryIds.includes(e.id))
      .flatMap((e) => entryNodeKeys(e, graph));
  if ('workItemId' in subject) {
    const own = graph.nodes.findIndex(
      (n) => n.kind === 'work_item' && n.workItemId === subject.workItemId,
    );
    return own < 0
      ? []
      : graph.nodes.flatMap((n, i) => (i === own || n.parent === own ? [n.key] : []));
  }
  return graph.nodes.filter((n) => n.kind === 'slice' && n.included).map((n) => n.key);
}

const MILESTONE_ORDER = ['started', 'merged', 'verified'];

export function buildBoard(input: {
  readonly graph: RoadmapGraph;
  /** The map's evaluation of a node, by key; a node it does not list counts as unmet. */
  readonly state: (key: string) => NodeEvaluation | undefined;
  readonly status: RoadmapStatusList;
  /** The roadmap's entries at the graph's revision, in its priority order. */
  readonly entries: readonly Pick<RoadmapEntry, 'id' | 'workItemId' | 'executionScope'>[];
  /** The open inbox item of each checkpoint the operator is asked to settle, by its source id. */
  readonly checkpointItems: ReadonlyMap<string, string>;
}): RoadmapBoard {
  const { graph, status } = input;
  const nodes = graph.nodes;
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const evaluated = nodes.map((n) => input.state(n.key));
  const satisfied = evaluated.map((e) => e?.satisfied === true);
  const requirements = nodes.map((n, i) =>
    (evaluated[i]?.requirements ?? n.requires.map((r) => nodes[r]!.key)).flatMap(
      (k) => index.get(k) ?? [],
    ),
  );
  const unmet = requirements.map((reqs, i) =>
    satisfied[i] ? [] : reqs.filter((r) => !satisfied[r]),
  );

  // Requirements before what requires them.
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    for (const r of requirements[i]!) visit(r);
    order.push(i);
  };
  for (let i = 0; i < nodes.length; i++) visit(i);

  // Root blockers: walking down from the requirements, each unmet node's unmet requirements,
  // replaced by their own roots when they have unmet requirements of their own.
  const roots: ReadonlySet<number>[] = nodes.map(() => new Set());
  for (const i of order) {
    const found = new Set<number>();
    for (const r of unmet[i]!)
      if (unmet[r]!.length === 0) found.add(r);
      else for (const root of roots[r]!) found.add(root);
    roots[i] = found;
  }
  // Everything downstream, walking up from what nothing requires (one reverse pass).
  const dependents: number[][] = nodes.map(() => []);
  requirements.forEach((reqs, i) => {
    for (const r of reqs) dependents[r]!.push(i);
  });
  const downstream: ReadonlySet<number>[] = nodes.map(() => new Set());
  for (const i of [...order].reverse()) {
    const found = new Set<number>();
    for (const d of dependents[i]!) {
      found.add(d);
      for (const further of downstream[d]!) found.add(further);
    }
    downstream[i] = found;
  }
  /** The unfinished, selected slices downstream: per slice, its earliest such milestone. */
  const unblocks = (i: number): number[] => {
    const bySlice = new Map<string, number>();
    for (const d of downstream[i]!) {
      const node = nodes[d]!;
      if (node.kind !== 'slice' || !node.included || satisfied[d]) continue;
      const prior = bySlice.get(node.sourceId);
      if (
        prior === undefined ||
        MILESTONE_ORDER.indexOf(node.state) < MILESTONE_ORDER.indexOf(nodes[prior]!.state)
      )
        bySlice.set(node.sourceId, d);
    }
    return [...bySlice.values()].sort((a, b) => a - b);
  };

  const entriesOf = new Map<number, number[]>();
  input.entries.forEach((entry, position) => {
    for (const key of entryNodeKeys(entry, graph)) {
      const i = index.get(key);
      if (i !== undefined) entriesOf.set(i, [...(entriesOf.get(i) ?? []), position]);
    }
  });
  const rows = new Map(status.entries.map((row) => [row.entryId, row]));
  const runOf = (positions: readonly number[]) =>
    positions
      .map((p) => rows.get(input.entries[p]!.id))
      .find((row) => row?.actor === 'agent' && row.waitsOn?.runId)?.waitsOn?.runId;
  const itemOf = (i: number) =>
    nodes[i]!.kind === 'checkpoint' ? input.checkpointItems.get(nodes[i]!.sourceId) : undefined;

  const boardNodes = nodes.map((_, i) => {
    const entries = entriesOf.get(i);
    const runId = entries && runOf(entries);
    const attentionItemId = itemOf(i);
    const waitingSlices = satisfied[i] ? [] : unblocks(i);
    return {
      satisfied: satisfied[i]!,
      ...(entries ? { entries } : {}),
      ...(attentionItemId ? { attentionItemId } : {}),
      ...(runId ? { runId } : {}),
      ...(unmet[i]!.length ? { unmet: [...unmet[i]!].sort((a, b) => a - b) } : {}),
      ...(roots[i]!.size ? { roots: [...roots[i]!].sort((a, b) => a - b) } : {}),
      ...(waitingSlices.length ? { unblocks: waitingSlices } : {}),
    };
  });

  const gates = nodes
    .flatMap((node, i) => {
      const slices = boardNodes[i]!.unblocks?.length ?? 0;
      const attentionItemId = boardNodes[i]!.attentionItemId;
      return node.kind === 'checkpoint' && node.included && !satisfied[i] && slices > 0
        ? [{ node: i, slices, ...(attentionItemId ? { attentionItemId } : {}) }]
        : [];
    })
    .sort(
      (a, b) =>
        b.slices - a.slices || nodes[a.node]!.sourceId.localeCompare(nodes[b.node]!.sourceId),
    );

  // A card is a work item with something selected: itself or one of its slices. It is done
  // when everything selected on it is met, and it stands where the roadmap first works on it.
  const children = new Map<number, number[]>();
  nodes.forEach((node, i) => {
    if (node.parent !== undefined)
      children.set(node.parent, [...(children.get(node.parent) ?? []), i]);
  });
  const priority = new Map<number, number>();
  input.entries.forEach((entry, position) => {
    for (const key of entryNodeKeys(entry, graph)) {
      const i = index.get(key);
      const card = i === undefined ? undefined : (nodes[i]!.parent ?? i);
      if (card !== undefined && !priority.has(card)) priority.set(card, position);
    }
  });
  const lanes = graph.lanes.map((_, lane) => {
    const cards = nodes
      .flatMap((node, i) => {
        const own = [i, ...(children.get(i) ?? [])].filter((n) => nodes[n]!.included);
        return node.kind === 'work_item' && node.lane === lane && own.length ? [{ i, own }] : [];
      })
      .sort(
        (a, b) =>
          (priority.get(a.i) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(b.i) ?? Number.MAX_SAFE_INTEGER) || a.i - b.i,
      );
    const done = (own: readonly number[]) => own.every((n) => satisfied[n]);
    return {
      lane,
      cards: cards
        .filter((card) => !done(card.own))
        .map((card) => ({
          node: card.i,
          gates: new Set(
            card.own.flatMap((n) => unmet[n]!.filter((r) => nodes[r]!.kind === 'checkpoint')),
          ).size,
        })),
      done: cards.filter((card) => done(card.own)).map((card) => card.i),
    };
  });

  const actors = status.entries.map((row) => row.actor);
  return {
    revision: graph.revision,
    summary: {
      needsYou: actors.filter((a) => a === 'operator').length,
      agentsAtWork: actors.filter((a) => a === 'agent').length,
      waiting: actors.filter((a) => a !== 'operator' && a !== 'agent').length,
      done: status.completed,
    },
    nodes: boardNodes,
    gates,
    lanes,
  };
}
