import { expect, it } from 'vitest';
import {
  type DecodeMeasure,
  type EvidenceDecodeReplay,
  evidenceDecodeFaults,
} from '../src/evidence-decode-replay.js';

/** R-H4: the measurement's verdict, which the replay gate reads as changed records. */

const read = (overrides: Partial<DecodeMeasure> = {}): DecodeMeasure => ({
  read: 'roadmap-view R',
  view: true,
  state: 'after-insert',
  bytes: { 'evidence-submission-head': 100 },
  total: 100,
  heads: 2,
  repeatedHeads: [],
  stagedRecords: ['staged'],
  otherRecords: [],
  ...overrides,
});
const replay = (overrides: Partial<EvidenceDecodeReplay> = {}): EvidenceDecodeReplay => ({
  reads: [read()],
  retained: {},
  retainedValues: [],
  heapGrowth: 0,
  ...overrides,
});
const failing = (emulated: 'count-keyed' | 'id-keyed') =>
  replay({ emulated, retained: { map: 2_000_000 } });

it('passes a clean measurement only when every self-check fails', () => {
  expect(evidenceDecodeFaults(replay(), [failing('count-keyed'), failing('id-keyed')])).toEqual([]);
  expect(
    evidenceDecodeFaults(replay(), [failing('count-keyed'), replay({ emulated: 'id-keyed' })]),
  ).toEqual([
    { key: 'self-check id-keyed', fault: 'the measurement passes with the cache put back' },
  ]);
});

it("reports each of the measurement's own faults", () => {
  expect(
    evidenceDecodeFaults(
      replay({
        reads: [
          read({ repeatedHeads: ['h'] }),
          read({ state: 'warm', otherRecords: ['r'] }),
          // A ledger carries accepted records on purpose; only its heads are held.
          read({ read: 'scope-ledger S', view: false, otherRecords: ['r'] }),
        ],
        retained: { map: 1_000_001 },
      }),
      [failing('count-keyed')],
    ),
  ).toEqual([
    { key: 'after-insert roadmap-view R', fault: 'decodes 1 heads more than once' },
    {
      key: 'warm roadmap-view R',
      fault: 'decodes 1 full records that are not staged decisions',
    },
    { key: 'retained map', fault: 'retains 1000001 bytes' },
  ]);
});
