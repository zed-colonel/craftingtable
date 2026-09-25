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

/**
 * A scoped tree whose every upstream link has moved to its current pin builds entirely against
 * the current pins (ADR-069): nothing legacy is left to spare it, so it is held to, and reports,
 * a current-upstream build. Only this upgrade exists; nothing relaxes a current-upstream scope.
 */
export function movedVerificationPolicy(policy: ReturnType<typeof buildVerificationPolicy>) {
  return policy.mode === 'scoped-checks'
    ? {
        ...policy,
        mode: 'current-upstream-build' as const,
        reason:
          'Every upstream link of this scope has moved to its current pin: a successful build/test against the current exact upstream pins is required.',
      }
    : policy;
}
