import { readFileSync } from 'node:fs';
import { finalizationViewSchema } from '@craftingtable/contracts';
import { expect, it } from 'vitest';
import { recordIssues } from './persisted-records.js';

/**
 * The one completed legacy (improvement-round) finalization on the live database, 2026-09-13
 * (R-B10). New finalizations are staged; this record must stay readable after the legacy
 * controller branches are removed. The web test renders the same fixture.
 */
const record = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/records/legacy-finalization-2026-09-13.json', import.meta.url),
    'utf8',
  ),
);

it('keeps the completed legacy finalization and its cycle valid persisted records', () => {
  expect(record.finalization.stages).toBeUndefined();
  expect(record.finalization.rounds).toHaveLength(2);
  expect(recordIssues('finalization', record.finalization)).toEqual([]);
  expect(recordIssues('work-cycle', record.cycle)).toEqual([]);
  expect(
    finalizationViewSchema.parse({
      finalization: record.finalization,
      cycle: record.cycle,
      runs: [],
      mergeRecoveryPending: false,
    }).cycle?.polishPhase,
  ).toBe('final-review');
});
