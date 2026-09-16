import { concurrencyMilestones } from './concurrency-graph.js';
import type { ConcurrencySource } from './concurrency-source.js';
export function canonicalDefinition(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDefinition).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalDefinition(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function scopeDefinitionFingerprint(
  s: ConcurrencySource,
  kind: 'slice' | 'work_item' | 'checkpoint',
  id: string,
) {
  const node =
    kind === 'slice'
      ? s.slices.find((n) => n.id === id)
      : kind === 'work_item'
        ? s.work_items.find((n) => n.id === id)
        : s.checkpoints.find((n) => n.id === id);
  if (!node) return '';
  const profile =
    'acceptance_evidence_profile' in node
      ? node.acceptance_evidence_profile
      : node.evidence_profile;
  const refs =
    'source_refs' in node
      ? node.source_refs.map((r) => r.source_id)
      : [node.source_test_reference.source_id];
  return canonicalDefinition({
    node,
    profile: s.evidence_profiles.find((p) => p.id === profile),
    sources: s.source_files.filter((f) => refs.includes(f.id)),
    decisions:
      'decision_refs' in node ? s.decisions.filter((d) => node.decision_refs.includes(d.id)) : [],
    resources:
      'resources_by_phase' in node
        ? s.resource_profiles.filter((p) =>
            Object.values(node.resources_by_phase).some((ids) => ids.includes(p.id)),
          )
        : [],
    mergeLock:
      'merge_lock' in node ? s.resource_locks.find((l) => l.id === node.merge_lock) : undefined,
    cases: s.acceptance_coverage.filter((c) =>
      kind === 'slice'
        ? c.producing_slices.includes(id)
        : kind === 'checkpoint'
          ? c.checkpoint === id
          : c.owner_work_item === id,
    ),
    baseline: s.baseline_acceptance_coverage.filter((c) =>
      kind === 'slice'
        ? c.producing_slice === id
        : kind === 'checkpoint'
          ? c.capability_gate === id
          : c.owner_work_item === id,
    ),
  });
}
function obligations(
  s: ConcurrencySource,
  kind: 'slice' | 'work_item' | 'checkpoint',
  id: string,
  requires: readonly string[],
) {
  const node =
    kind === 'slice'
      ? s.slices.find((n) => n.id === id)
      : kind === 'work_item'
        ? s.work_items.find((n) => n.id === id)
        : s.checkpoints.find((n) => n.id === id);
  if (!node) return [];
  const profile = s.evidence_profiles.find(
    (p) =>
      p.id ===
      ('acceptance_evidence_profile' in node
        ? node.acceptance_evidence_profile
        : node.evidence_profile),
  );
  const refs =
    'source_refs' in node
      ? node.source_refs.map((r) => r.source_id)
      : [node.source_test_reference.source_id];
  return [
    ...requires,
    ...('scope' in node
      ? [node.scope, ...node.excludes]
      : 'source_exit_gate' in node
        ? [node.source_exit_gate]
        : node.pass_criteria),
    ...(profile?.required_evidence ?? []),
    ...(profile?.reviewer_roles ?? []).map((r) => `Reviewer: ${r}`),
    ...s.source_files.filter((f) => refs.includes(f.id)).map((f) => `Source ${f.id}: ${f.sha256}`),
    ...s.acceptance_coverage
      .filter((c) =>
        kind === 'slice'
          ? c.producing_slices.includes(id)
          : kind === 'checkpoint'
            ? c.checkpoint === id
            : c.owner_work_item === id,
      )
      .map((c) => `Case ${c.id}: ${c.source_record_sha256}`),
  ];
}
export function compareConcurrencyDefinitions(before: ConcurrencySource, after: ConcurrencySource) {
  const a = new Map(concurrencyMilestones(before).map((n) => [n.key, n])),
    b = new Map(concurrencyMilestones(after).map((n) => [n.key, n]));
  return [...new Set([...a.keys(), ...b.keys()])].map((key) => {
    const x = a.get(key),
      y = b.get(key),
      n = y ?? x!;
    return {
      key,
      kind: n.requirement.kind,
      change: !x
        ? ('added' as const)
        : !y
          ? ('removed' as const)
          : canonicalDefinition(x.requires) !== canonicalDefinition(y.requires) ||
              scopeDefinitionFingerprint(before, n.requirement.kind, n.requirement.id) !==
                scopeDefinitionFingerprint(after, n.requirement.kind, n.requirement.id)
            ? ('changed' as const)
            : ('unchanged' as const),
      before: obligations(before, n.requirement.kind, n.requirement.id, x?.requires ?? []),
      after: obligations(after, n.requirement.kind, n.requirement.id, y?.requires ?? []),
    };
  });
}
