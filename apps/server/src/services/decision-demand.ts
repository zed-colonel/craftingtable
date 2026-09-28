import type { ConcurrencyDefinition } from '@craftingtable/domain';
import { supportsArchitectureDecision } from './architecture-decision-policy.js';

/** The map milestones a roadmap's cross-project view reports (`crossProjectState(...).nodes`). */
export interface DemandNode {
  readonly key: string;
  readonly kind: 'slice' | 'work_item' | 'checkpoint';
  readonly sourceId: string;
  readonly included: boolean;
  readonly satisfied: boolean;
  readonly requirements: readonly string[];
}

/**
 * The distinct unfinished, selected slices that wait on a milestone, directly or through other
 * milestones (R-C3b): what a decision "unblocks", counted as slices rather than graph nodes.
 */
export function slicesWaitingOn(nodes: readonly DemandNode[], key: string): number {
  const dependents = new Map<string, string[]>();
  for (const node of nodes)
    for (const requirement of node.requirements)
      dependents.set(requirement, [...(dependents.get(requirement) ?? []), node.key]);
  const seen = new Set<string>();
  const queue = [...(dependents.get(key) ?? [])];
  while (queue.length) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(dependents.get(next) ?? []));
  }
  return new Set(
    nodes
      .filter((n) => seen.has(n.key) && n.kind === 'slice' && n.included && !n.satisfied)
      .map((n) => n.sourceId),
  ).size;
}

/**
 * The shared architecture decisions the selection still needs: supported, selected and not yet
 * accepted, each with the slices waiting on it, those that unblock the most slices first.
 */
export function neededDecisions(
  definition: ConcurrencyDefinition,
  nodes: readonly DemandNode[],
): readonly { readonly checkpointId: string; readonly slices: number }[] {
  return nodes
    .filter(
      (n) =>
        n.kind === 'checkpoint' &&
        n.included &&
        !n.satisfied &&
        supportsArchitectureDecision(definition, n.sourceId),
    )
    .map((n) => ({ checkpointId: n.sourceId, slices: slicesWaitingOn(nodes, n.key) }))
    .filter((d) => d.slices > 0)
    .sort((a, b) => b.slices - a.slices || a.checkpointId.localeCompare(b.checkpointId));
}
