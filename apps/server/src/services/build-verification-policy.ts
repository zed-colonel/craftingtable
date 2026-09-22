import type { ConcurrencyDefinition, ExecutionScope } from '@craftingtable/domain';

/** This changes build applicability only. All map phase/evidence gates still apply. */
export function buildVerificationPolicy(d: ConcurrencyDefinition, scope?: ExecutionScope) {
  const scopedSlice = (id: string): boolean => {
    const slice = d.source.slices.find((s) => s.id === id);
    if (!slice || slice.aq_baseline_case_ids.length) return false;
    if (slice.mode === 'domain') return true;
    if (slice.mode !== 'implementation') return false;
    const parent = d.source.work_items.find((w) => w.id === slice.work_item);
    if (!parent || !/^independent\b/i.test(parent.source_maturity)) return false;
    // A generic implementation slice is independent only when its explicit gates
    // contain no upstream runtime obligations. Unknown requirements fail closed.
    const local = (r: (typeof slice.start_requires)[number]): boolean => {
      if (r.kind === 'checkpoint') {
        const c = d.source.checkpoints.find((c) => c.id === r.id);
        return !!c && ['plan_approval', 'architecture_decision'].includes(c.kind);
      }
      const owner =
        r.kind === 'work_item'
          ? d.source.work_items.find((w) => w.id === r.id)?.repository
          : d.source.work_items.find(
              (w) => w.id === d.source.slices.find((s) => s.id === r.id)?.work_item,
            )?.repository;
      return owner === parent.repository;
    };
    return [...slice.start_requires, ...slice.merge_requires, ...slice.verify_requires].every(
      local,
    );
  };
  let scoped = false;
  if (scope?.kind === 'slice' || scope?.kind === 'slice-verification')
    scoped = scopedSlice(scope.sourceId);
  else if (scope?.kind === 'parent-acceptance') {
    const p = d.source.work_items.find((w) => w.id === scope.sourceId);
    const slices = p && [...new Set([...p.required_slices, ...p.profile_evidence_slices])];
    scoped =
      !!p &&
      /^independent\b/i.test(p.source_maturity) &&
      !p.aq_baseline_case_ids.length &&
      !!slices?.length &&
      slices.every(scopedSlice) &&
      p.acceptance_requires.every((r) => {
        if (r.kind === 'slice') return slices.includes(r.id) && scopedSlice(r.id);
        if (r.kind === 'work_item') {
          const predecessor = d.source.work_items.find((w) => w.id === r.id);
          // Accepted local predecessors sequence work; they do not imply an upstream build.
          return (
            r.state === 'accepted' && r.id !== p.id && predecessor?.repository === p.repository
          );
        }
        if (r.kind !== 'checkpoint') return false;
        const c = d.source.checkpoints.find((c) => c.id === r.id);
        return !!c && ['plan_approval', 'architecture_decision'].includes(c.kind);
      });
  }
  return {
    version: 1 as const,
    mode: scoped ? ('scoped-checks' as const) : ('current-upstream-build' as const),
    ...(scope ? { scope } : {}),
    reason: scoped
      ? 'Independent contract/domain scope: verify changed code and every declared scope obligation. Historical characterization and scoped checks do not establish current upstream integration.'
      : 'Integration, conformance, release, finalization or unclassified scope: a successful build/test against the current exact upstream pins is required.',
  };
}
