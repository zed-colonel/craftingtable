import { expect, it } from 'vitest';
import {
  type ResolvedScope,
  scopeBrief,
  scopeNeedsKata,
} from '../../src/services/execution-scope.js';

const slice = (id: string) => ({ id, scope: `${id} scope`, excludes: [`not ${id}`] });
const resolved = (kind: 'parent-acceptance' | 'slice') =>
  ({
    scope: { kind, sourceId: 'wi/WI-1/domain', bindingRevision: 1 },
    ...(kind === 'slice'
      ? { slice: { ...slice('wi/WI-1/domain'), aq_baseline_case_ids: [] } }
      : {}),
    parent: {
      id: 'WI-1',
      title: 'Parent',
      source_exit_gate: 'Exit gate',
      source_profile_case_ids: [],
      aq_baseline_case_ids: [],
      depends_on: [],
      required_slices: ['wi/WI-1/domain', 'wi/WI-1/api'],
    },
    profile: { required_evidence: [] },
    definition: {
      id: 'd',
      digest: 'digest',
      source: {
        slices: [slice('wi/WI-1/domain'), slice('wi/OTHER/domain'), slice('wi/WI-1/api')],
        acceptance_coverage: [],
      },
    },
  }) as unknown as ResolvedScope;

it("offers a parent reviewer only the parent's required slices as owners (LIVE-27 review)", () => {
  expect(scopeBrief(resolved('parent-acceptance')).owningSlices).toEqual([
    slice('wi/WI-1/domain'),
    slice('wi/WI-1/api'),
  ]);
  expect(scopeBrief(resolved('slice'))).not.toHaveProperty('owningSlices');
});

it('speaks of Kata only for a scope whose own cases need a Kata host (R-F2 part 6, AGT-55)', () => {
  const withCoverage = (requiresKata: boolean, slices: string[]) => {
    const r = resolved('slice');
    return {
      ...r,
      definition: {
        ...r.definition,
        source: {
          ...r.definition.source,
          acceptance_coverage: [
            { id: 'K-1', requires_kata_host: requiresKata, producing_slices: slices },
          ],
        },
      },
    } as unknown as ResolvedScope;
  };
  expect(scopeNeedsKata(withCoverage(true, ['wi/WI-1/domain']))).toBe(true);
  expect(scopeNeedsKata(withCoverage(false, ['wi/WI-1/domain']))).toBe(false);
  // Another slice's Kata case is not this scope's.
  expect(scopeNeedsKata(withCoverage(true, ['wi/WI-1/api']))).toBe(false);
});
