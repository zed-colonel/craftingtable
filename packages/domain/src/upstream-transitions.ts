import { concurrencyMilestones, milestoneKey } from './concurrency-graph.js';
import type { ConcurrencySource } from './concurrency-source.js';
import type { ExecutionScope } from './execution-scope.js';

/** The consumer slice whose merge moves one consumer→upstream link to the current pin (ADR-069). */
export interface UpstreamTransition {
  readonly consumer: string;
  readonly upstream: string;
  readonly slice: string;
}
export interface UpstreamTransitionIssue {
  readonly code:
    | 'upstream-transition-duplicate'
    | 'upstream-transition-link'
    | 'upstream-transition-slice'
    | 'upstream-transition-order'
    | 'upstream-transition-coupling';
  readonly message: string;
}

/**
 * Whether an execution scope builds with scoped checks rather than the current pins (ADR-053).
 * This changes build applicability only; every phase and evidence gate still applies.
 */
export function scopedBuildScope(
  s: ConcurrencySource,
  scope?: Pick<ExecutionScope, 'kind' | 'sourceId'>,
): boolean {
  const scopedSlice = (id: string): boolean => {
    const slice = s.slices.find((x) => x.id === id);
    if (!slice || slice.aq_baseline_case_ids.length) return false;
    if (slice.mode === 'domain') return true;
    if (slice.mode !== 'implementation') return false;
    const parent = s.work_items.find((w) => w.id === slice.work_item);
    if (!parent || !/^independent\b/i.test(parent.source_maturity)) return false;
    // A generic implementation slice is independent only when its explicit gates
    // contain no upstream runtime obligations. Unknown requirements fail closed.
    const local = (r: (typeof slice.start_requires)[number]): boolean => {
      if (r.kind === 'checkpoint') {
        const c = s.checkpoints.find((c) => c.id === r.id);
        return !!c && ['plan_approval', 'architecture_decision'].includes(c.kind);
      }
      const owner =
        r.kind === 'work_item'
          ? s.work_items.find((w) => w.id === r.id)?.repository
          : s.work_items.find((w) => w.id === s.slices.find((x) => x.id === r.id)?.work_item)
              ?.repository;
      return owner === parent.repository;
    };
    return [...slice.start_requires, ...slice.merge_requires, ...slice.verify_requires].every(
      local,
    );
  };
  if (scope?.kind === 'slice' || scope?.kind === 'slice-verification')
    return scopedSlice(scope.sourceId);
  if (scope?.kind !== 'parent-acceptance') return false;
  const p = s.work_items.find((w) => w.id === scope.sourceId);
  const slices = p && [...new Set([...p.required_slices, ...p.profile_evidence_slices])];
  return (
    !!p &&
    /^independent\b/i.test(p.source_maturity) &&
    !p.aq_baseline_case_ids.length &&
    !!slices?.length &&
    slices.every(scopedSlice) &&
    p.acceptance_requires.every((r) => {
      if (r.kind === 'slice') return slices.includes(r.id) && scopedSlice(r.id);
      if (r.kind === 'work_item') {
        const predecessor = s.work_items.find((w) => w.id === r.id);
        // Accepted local predecessors sequence work; they do not imply an upstream build.
        return r.state === 'accepted' && r.id !== p.id && predecessor?.repository === p.repository;
      }
      if (r.kind !== 'checkpoint') return false;
      const c = s.checkpoints.find((c) => c.id === r.id);
      return !!c && ['plan_approval', 'architecture_decision'].includes(c.kind);
    })
  );
}

/** The upstream repositories a consumer builds against. */
export function consumerUpstreams(s: ConcurrencySource, consumer: string): string[] {
  const required = new Set(
    s.repositories
      .filter((r) => r.role === 'implemented_upstream' && r.id !== consumer)
      .map((r) => r.id),
  );
  const parents = s.work_items.filter((w) => w.repository === consumer);
  for (const slice of s.slices.filter((x) => parents.some((w) => w.id === x.work_item)))
    for (const req of [...slice.start_requires, ...slice.merge_requires]) {
      const owner =
        req.kind === 'checkpoint'
          ? s.checkpoints.find((c) => c.id === req.id)?.owner
          : req.kind === 'work_item'
            ? s.work_items.find((w) => w.id === req.id)?.repository
            : s.work_items.find((w) => w.id === s.slices.find((x) => x.id === req.id)?.work_item)
                ?.repository;
      if (owner && owner !== consumer && s.repositories.some((r) => r.id === owner))
        required.add(owner);
    }
  return [...required];
}

/** Milestones that must hold before `key`, following every retained requirement transitively. */
function predecessorsOf(s: ConcurrencySource) {
  const byKey = new Map(concurrencyMilestones(s).map((n) => [n.key, n]));
  const memo = new Map<string, ReadonlySet<string>>();
  return (key: string): ReadonlySet<string> => {
    const cached = memo.get(key);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(byKey.get(key)?.requires ?? [])];
    while (stack.length) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(byKey.get(next)?.requires ?? []));
    }
    memo.set(key, seen);
    return seen;
  };
}

/**
 * Why a set of transitions cannot be declared for this map, or nothing (ADR-069). The same
 * checks apply to a map's own `upstream_transitions` and to an operator's transition record.
 */
export function upstreamTransitionIssues(
  s: ConcurrencySource,
  transitions: readonly UpstreamTransition[],
): UpstreamTransitionIssue[] {
  const issues: UpstreamTransitionIssue[] = [];
  const merged = (slice: string) => milestoneKey({ kind: 'slice', id: slice, state: 'merged' });
  const predecessors = predecessorsOf(s);
  const link = (t: Pick<UpstreamTransition, 'consumer' | 'upstream'>) =>
    `${t.consumer}→${t.upstream}`;
  const declared = new Map<string, UpstreamTransition>();
  const linked: UpstreamTransition[] = [];
  for (const t of transitions) {
    if (declared.has(link(t))) {
      issues.push({
        code: 'upstream-transition-duplicate',
        message: `${link(t)} is declared more than once.`,
      });
      continue;
    }
    declared.set(link(t), t);
    const consumer = s.repositories.find((r) => r.id === t.consumer);
    if (
      consumer?.role !== 'planned_application' ||
      !consumerUpstreams(s, t.consumer).includes(t.upstream)
    ) {
      issues.push({
        code: 'upstream-transition-link',
        message: `${link(t)} is not a consumer→upstream link of this map.`,
      });
      continue;
    }
    const slice = s.slices.find((x) => x.id === t.slice);
    const owner = slice && s.work_items.find((w) => w.id === slice.work_item)?.repository;
    if (owner !== t.consumer || scopedBuildScope(s, { kind: 'slice', sourceId: t.slice })) {
      issues.push({
        code: 'upstream-transition-slice',
        message: `${t.slice} cannot move ${link(t)}: the transition must be a ${t.consumer} slice that builds against the current pins.`,
      });
      continue;
    }
    linked.push(t);
    // No work that needs the current pins may start before its link moves.
    const early = [
      ...s.slices
        .filter(
          (x) =>
            x.id !== t.slice &&
            s.work_items.find((w) => w.id === x.work_item)?.repository === t.consumer &&
            !scopedBuildScope(s, { kind: 'slice', sourceId: x.id }) &&
            !predecessors(milestoneKey({ kind: 'slice', id: x.id, state: 'started' })).has(
              merged(t.slice),
            ),
        )
        .map((x) => x.id),
      ...s.work_items
        .filter(
          (w) =>
            w.repository === t.consumer &&
            !scopedBuildScope(s, { kind: 'parent-acceptance', sourceId: w.id }) &&
            !predecessors(milestoneKey({ kind: 'work_item', id: w.id, state: 'accepted' })).has(
              merged(t.slice),
            ),
        )
        .map((w) => w.id),
    ];
    if (early.length)
      issues.push({
        code: 'upstream-transition-order',
        message: `${t.slice} cannot move ${link(t)}: ${early.slice(0, 5).join(', ')}${early.length > 5 ? ` and ${early.length - 5} more` : ''} need the current pins without requiring it first.`,
      });
  }
  // An upstream's current pin carries its own upstreams, so the consumer must move those first.
  for (const t of linked)
    for (const inner of consumerUpstreams(s, t.upstream).filter((u) =>
      consumerUpstreams(s, t.consumer).includes(u),
    )) {
      const first = declared.get(link({ consumer: t.consumer, upstream: inner }));
      if (
        !first ||
        (first.slice !== t.slice &&
          !predecessors(milestoneKey({ kind: 'slice', id: t.slice, state: 'started' })).has(
            merged(first.slice),
          ))
      )
        issues.push({
          code: 'upstream-transition-coupling',
          message: `${link(t)} needs ${link({ consumer: t.consumer, upstream: inner })} declared at ${t.slice} or at a slice it requires, because ${t.upstream}'s current pin builds against ${inner}.`,
        });
    }
  return issues;
}
