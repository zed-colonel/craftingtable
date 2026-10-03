import { createHash } from 'node:crypto';

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
  /**
   * Keys that appear more than once on one side (`golden <key>` or `replay <key>`). Records are
   * paired by key, so a duplicate would otherwise collapse into its twin unseen.
   */
  readonly duplicates: readonly string[];
  /** Parts of the replay the golden predates, which this check could not compare. */
  readonly notCompared: readonly string[];
}

/** Whether a check found any difference: `controller:replay --check` exits 1 when it did. */
export const differs = (check: ReplayCheck): boolean =>
  check.changed.length > 0 || check.missing.length > 0 || check.duplicates.length > 0;

function repeatedKeys(records: readonly ReplayRecord[], side: string): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { key } of records) (seen.has(key) ? repeated : seen).add(key);
  return [...repeated].map((key) => `${side} ${key}`);
}

/**
 * JSON with keys sorted by code point and no undefined fields: the form two records are
 * compared in. The order does not depend on the locale, so a manifest's pinned hash of a new
 * value is the same on every host.
 */
export function canonicalJson(value: unknown): string {
  return canonical(JSON.parse(JSON.stringify(value ?? null)));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
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
  const duplicates = [...repeatedKeys(expected, 'golden'), ...repeatedKeys(actual, 'replay')];
  return { records: actual.length, changed, missing, duplicates, notCompared };
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
    ...check.duplicates.map((key) => `duplicate key: ${key}\n`),
    ...check.notCompared.map((part) => `not compared: ${part}\n`),
    `${check.records} ${noun} replayed; ${check.changed.length} changed, ${check.missing.length} missing${check.duplicates.length ? `, ${check.duplicates.length} duplicate keys` : ''}\n`,
  ].join('');
}
