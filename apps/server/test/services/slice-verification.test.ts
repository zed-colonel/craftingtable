import type { ExecutionScope, ScopeReceipt } from '@craftingtable/domain';
import { asConcurrencyDefinitionId } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { sliceVerification } from '../../src/services/execution-scope.js';

/** R-C7 D7 (shown since R-E5b): which receipt's follow-ups a slice shows. */
const scope: ExecutionScope = {
  kind: 'slice',
  definitionId: asConcurrencyDefinitionId('map'),
  bindingRevision: 2,
  sourceId: 'wi/WI-01/domain',
};
const receipt = (id: string, fields: Partial<ScopeReceipt> = {}) =>
  ({
    id,
    scope,
    integrationSha: 'merge',
    recordedAt: '2026-10-01T00:00:00.000Z',
    ...fields,
  }) as ScopeReceipt;

it('takes the latest current receipt of this exact scope against the slice’s merge', () => {
  const older = receipt('older');
  const latest = receipt('latest', { recordedAt: '2026-10-02T00:00:00.000Z' });
  expect(sliceVerification([older, latest], scope, 'merge', () => true)?.id).toBe('latest');
  expect(sliceVerification([latest, older], scope, 'merge', () => true)?.id).toBe('latest');
});

it('ignores another scope, another merge, a receipt no longer current, and an unmerged slice', () => {
  const other = receipt('other', { scope: { ...scope, sourceId: 'wi/WI-01/integration' } });
  const kind = receipt('kind', { scope: { ...scope, kind: 'slice-verification' } });
  const stale = receipt('stale', { integrationSha: 'earlier-merge' });
  const retired = receipt('retired');
  const current = (r: ScopeReceipt) => r.id !== 'retired';
  expect(sliceVerification([other, kind, stale, retired], scope, 'merge', current)).toBeUndefined();
  expect(sliceVerification([receipt('only')], scope, undefined, () => true)).toBeUndefined();
});
