import type { ConcurrencyDefinition, ExecutionScope } from '@craftingtable/domain';
import { scopedBuildScope } from '@craftingtable/domain';

/** This changes build applicability only. All map phase/evidence gates still apply. */
export function buildVerificationPolicy(d: ConcurrencyDefinition, scope?: ExecutionScope) {
  const scoped = scopedBuildScope(d.source, scope);
  return {
    version: 1 as const,
    mode: scoped ? ('scoped-checks' as const) : ('current-upstream-build' as const),
    ...(scope ? { scope } : {}),
    reason: scoped
      ? 'Independent contract/domain scope: verify changed code and every declared scope obligation. Historical characterization and scoped checks do not establish current upstream integration.'
      : 'Integration, conformance, release, finalization or unclassified scope: a successful build/test against the current exact upstream pins is required.',
  };
}
