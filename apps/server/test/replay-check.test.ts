import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalJson, compareRecords } from '../src/replay-check.js';

/** The `--check` comparator every `controller:replay` mode shares (R-I10). */

it('orders keys by code point, whatever the locale, and drops undefined fields', () => {
  // A locale-aware sort puts "b" before "B"; a pinned hash must not depend on the host.
  expect(canonicalJson({ b: 1, B: 2, a: undefined, c: [{ z: 1, Z: 2 }] })).toBe(
    '{"B":2,"b":1,"c":[{"Z":2,"z":1}]}',
  );
});

it('reports changed, new and missing records, with the new value’s hash', () => {
  const check = compareRecords(
    [
      { key: 'same', value: { a: 1, b: 2 } },
      { key: 'changed', value: { a: 1 } },
      { key: 'gone', value: {} },
    ],
    [
      { key: 'same', value: { b: 2, a: 1 } },
      { key: 'changed', value: { a: 2 } },
      { key: 'added', value: { a: 3 } },
    ],
  );
  expect(check).toEqual({
    records: 3,
    changed: [
      {
        key: 'changed',
        was: { a: 1 },
        now: { a: 2 },
        nowSha256: createHash('sha256').update('{"a":2}').digest('hex'),
      },
      {
        key: 'added',
        now: { a: 3 },
        nowSha256: createHash('sha256').update('{"a":3}').digest('hex'),
      },
    ],
    missing: ['gone'],
    duplicates: [],
    notCompared: [],
  });
});

it('reports a key that appears twice on either side, even with identical values', () => {
  // A map would collapse them, so a duplicated record would replay as 0 changed.
  const a = { key: 'entry:r/e', value: { decision: 'wait' } };
  expect(compareRecords([a], [a, a]).duplicates).toEqual(['replay entry:r/e']);
  expect(compareRecords([a, a], [a]).duplicates).toEqual(['golden entry:r/e']);
  expect(compareRecords([a], [a]).duplicates).toEqual([]);
});
