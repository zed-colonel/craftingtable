import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { analyzeConcurrencyArchive } from '@craftingtable/planning';
import type { ConcurrencyDefinition, ExecutionScope } from '@craftingtable/domain';
import { buildVerificationPolicy } from './build-verification-policy.js';
const source = analyzeConcurrencyArchive(
  readFileSync(
    new URL(
      '../../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
      import.meta.url,
    ),
  ),
).source!;
const definition = { source } as ConcurrencyDefinition;
function policy(id: string, kind: ExecutionScope['kind'] = 'slice') {
  return buildVerificationPolicy(definition, {
    kind,
    sourceId: id,
    definitionId: 'definition',
    bindingRevision: 4,
  });
}
it('lets the actual WI/EXO independent opening slices and their parent acceptance use scope checks', () => {
  for (const id of [
    'wi/WI-01/implementation',
    'exo/EXO-01/domain',
    'wi/WI-02/domain',
    'exo/EXO-02/domain',
  ]) {
    expect(policy(id).mode, id).toBe('scoped-checks');
    expect(policy(id, 'slice-verification').mode, id).toBe('scoped-checks');
  }
  for (const id of ['wi/WI-01', 'exo/EXO-01', 'exo/EXO-02'])
    expect(policy(id, 'parent-acceptance').mode, id).toBe('scoped-checks');
});
it('keeps integration, conformance, release, mixed parent and finalization on current upstream verification', () => {
  for (const slice of source.slices.filter((s) =>
    ['integration', 'conformance', 'release', 'release_readiness'].includes(s.mode),
  ))
    expect(policy(slice.id).mode, slice.id).toBe('current-upstream-build');
  expect(policy('wi/WI-02', 'parent-acceptance').mode).toBe('current-upstream-build');
  expect(policy('unknown').mode).toBe('current-upstream-build');
  expect(buildVerificationPolicy(definition).mode).toBe('current-upstream-build');
});
it('does not waive explicit AQ case obligations under a domain label', () => {
  const d = {
    ...definition,
    source: {
      ...source,
      slices: source.slices.map((s) => ({ ...s, aq_baseline_case_ids: ['exact-case'] })),
    },
  };
  expect(
    buildVerificationPolicy(d, {
      kind: 'slice',
      sourceId: 'exo/EXO-01/domain',
      definitionId: 'definition',
      bindingRevision: 4,
    }).mode,
  ).toBe('current-upstream-build');
});

it('keeps nonlocal, unknown, unaccepted and explicit runtime obligations on current upstream checks', () => {
  const scope: ExecutionScope = {
    kind: 'parent-acceptance',
    sourceId: 'exo/EXO-02',
    definitionId: 'definition',
    bindingRevision: 4,
  };
  const parent = source.work_items.find((w) => w.id === scope.sourceId)!;
  for (const patch of [
    { source_maturity: 'integration' },
    { aq_baseline_case_ids: ['case'] },
    {
      acceptance_requires: [
        { kind: 'work_item' as const, id: 'wi/WI-01', state: 'accepted' as const },
      ],
    },
    {
      acceptance_requires: [
        { kind: 'work_item' as const, id: 'exo/missing', state: 'accepted' as const },
      ],
    },
    {
      acceptance_requires: [
        { kind: 'work_item' as const, id: parent.id, state: 'accepted' as const },
      ],
    },
    {
      acceptance_requires: [
        { kind: 'checkpoint' as const, id: 'unknown', state: 'passed' as const },
      ],
    },
  ]) {
    const d = {
      ...definition,
      source: {
        ...source,
        work_items: source.work_items.map((w) => (w.id === parent.id ? { ...w, ...patch } : w)),
      },
    };
    expect(buildVerificationPolicy(d, scope).mode).toBe('current-upstream-build');
  }
});
