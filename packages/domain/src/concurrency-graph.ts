import type { ConcurrencySource, ConcurrencyRequirement } from './concurrency-source.js';
export const milestoneKey = (r: ConcurrencyRequirement): string => `${r.kind}:${r.id}:${r.state}`;
export interface ConcurrencyMilestone {
  readonly key: string;
  readonly requirement: ConcurrencyRequirement;
  readonly repository: string;
  readonly title: string;
  readonly parentId?: string;
  readonly requires: readonly string[];
}
/** Source milestones, including retained parent and evidence-producer obligations. */
export function concurrencyMilestones(s: ConcurrencySource): readonly ConcurrencyMilestone[] {
  const nodes: ConcurrencyMilestone[] = [];
  const add = (
    r: ConcurrencyRequirement,
    repository: string,
    title: string,
    requirements: readonly ConcurrencyRequirement[],
    parentId?: string,
  ) =>
    nodes.push({
      key: milestoneKey(r),
      requirement: r,
      repository,
      title,
      requires: [...new Set(requirements.map(milestoneKey))],
      ...(parentId ? { parentId } : {}),
    });
  for (const p of s.work_items) {
    const producers = [
      ...p.required_slices,
      ...p.profile_evidence_slices,
      ...s.acceptance_coverage
        .filter((c) => c.owner_work_item === p.id)
        .flatMap((c) => c.producing_slices),
      ...s.baseline_acceptance_coverage
        .filter((c) => c.owner_work_item === p.id)
        .map((c) => c.producing_slice),
    ];
    add({ kind: 'work_item', id: p.id, state: 'accepted' }, p.repository, p.title, [
      ...p.acceptance_requires,
      ...p.depends_on.map((id) => ({ kind: 'work_item' as const, id, state: 'accepted' as const })),
      ...producers.map((id) => ({ kind: 'slice' as const, id, state: 'verified' as const })),
    ]);
  }
  for (const slice of s.slices) {
    const p = s.work_items.find((p) => p.id === slice.work_item)!;
    add(
      { kind: 'slice', id: slice.id, state: 'started' },
      p.repository,
      slice.title,
      [
        ...slice.start_requires,
        ...(slice.early_start_exception
          ? []
          : p.depends_on.map((id) => ({
              kind: 'work_item' as const,
              id,
              state: 'accepted' as const,
            }))),
      ],
      p.id,
    );
    add(
      { kind: 'slice', id: slice.id, state: 'merged' },
      p.repository,
      slice.title,
      [{ kind: 'slice', id: slice.id, state: 'started' }, ...slice.merge_requires],
      p.id,
    );
    add(
      { kind: 'slice', id: slice.id, state: 'verified' },
      p.repository,
      slice.title,
      [{ kind: 'slice', id: slice.id, state: 'merged' }, ...slice.verify_requires],
      p.id,
    );
  }
  for (const c of s.checkpoints)
    add({ kind: 'checkpoint', id: c.id, state: 'passed' }, c.owner, c.title, c.requires);
  return nodes;
}
export function targetClosure(
  s: ConcurrencySource,
  targetId: string,
  selection: 'target-only' | 'prioritize-full',
) {
  const nodes = concurrencyMilestones(s),
    byKey = new Map(nodes.map((n) => [n.key, n]));
  const target = s.planning_targets.find((t) => t.id === targetId);
  if (!target) throw new Error('Select a declared planning target.');
  const priority = new Set<string>(),
    ordered: string[] = [],
    visiting = new Set<string>();
  const visit = (key: string, output: Set<string>) => {
    if (output.has(key)) return;
    if (visiting.has(key)) throw new Error('Circular retained milestone requirements.');
    const n = byKey.get(key);
    if (!n) throw new Error(`Unknown milestone ${key}`);
    visiting.add(key);
    for (const dep of n.requires) visit(dep, output);
    visiting.delete(key);
    output.add(key);
  };
  visit(milestoneKey({ kind: 'checkpoint', id: target.checkpoint, state: 'passed' }), priority);
  const included = new Set(priority);
  if (selection === 'prioritize-full') for (const n of nodes) visit(n.key, included);
  ordered.push(...included);
  return {
    target,
    nodes: ordered.map((k) => byKey.get(k)!),
    excluded: nodes.filter((n) => !included.has(n.key)),
    priority,
  };
}
