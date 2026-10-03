import { createHash } from 'node:crypto';
import { canonicalDefinition } from '@craftingtable/domain';

/**
 * The `--check` comparison every `controller:replay` mode shares (R-I10). A replay and its golden
 * are each reduced to keyed records; a record is changed when its canonical JSON differs, new
 * when the golden lacks its key, and missing when the replay lacks a golden key.
 */

export interface ReplayRecord {
  readonly key: string;
  readonly value: unknown;
}

export interface ReplayChange {
  readonly key: string;
  /** The golden's value; absent for a record the golden does not have. */
  readonly was?: unknown;
  readonly now: unknown;
  /** SHA-256 of `now`'s canonical JSON, which a gate manifest pins an expected change by. */
  readonly nowSha256: string;
}

/** What `--check --report` writes, and what `scripts/replays.mjs` reads. */
export interface ReplayCheck {
  readonly records: number;
  readonly changed: readonly ReplayChange[];
  readonly missing: readonly string[];
  /** Parts of the replay the golden predates, which this check could not compare. */
  readonly notCompared: readonly string[];
}

/** JSON with sorted keys and no undefined fields: the form two records are compared in. */
export function canonicalJson(value: unknown): string {
  return canonicalDefinition(JSON.parse(JSON.stringify(value ?? null)));
}

export function compareRecords(
  expected: readonly ReplayRecord[],
  actual: readonly ReplayRecord[],
  notCompared: readonly string[] = [],
): ReplayCheck {
  const golden = new Map(expected.map((record) => [record.key, canonicalJson(record.value)]));
  const values = new Map(expected.map((record) => [record.key, record.value]));
  const replayed = new Set(actual.map((record) => record.key));
  const changed = actual.flatMap((record): ReplayChange[] => {
    const now = canonicalJson(record.value);
    if (golden.get(record.key) === now) return [];
    return [
      {
        key: record.key,
        ...(values.has(record.key) ? { was: values.get(record.key) } : {}),
        now: record.value,
        nowSha256: createHash('sha256').update(now).digest('hex'),
      },
    ];
  });
  const missing = expected.filter((e) => !replayed.has(e.key)).map((e) => e.key);
  return { records: actual.length, changed, missing, notCompared };
}

/** The check as `controller:replay --check` prints it: each difference, then one count line. */
export function formatCheck(
  check: ReplayCheck,
  noun: string,
  show: (value: unknown) => string = (value) => JSON.stringify(value),
): string {
  return [
    ...check.changed.map(
      (c) =>
        `changed ${c.key}\n  was ${'was' in c ? show(c.was) : '(new)'}\n  now ${show(c.now)}\n`,
    ),
    ...check.missing.map((key) => `missing ${key}\n`),
    ...check.notCompared.map((part) => `not compared: ${part}\n`),
    `${check.records} ${noun} replayed; ${check.changed.length} changed, ${check.missing.length} missing\n`,
  ].join('');
}
