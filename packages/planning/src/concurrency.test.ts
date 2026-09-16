import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readArchive } from './archive.js';
import { zipFixture } from './archive-test-support.js';
import { analyzeConcurrencyArchive, analyzeConcurrencyDefinition } from './concurrency.js';

const bytes = readFileSync(
  new URL(
    '../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
    import.meta.url,
  ),
);
const entries = readArchive(bytes);
const mapEntry = entries.find((e) => e.path.endsWith('/cross-stack-concurrency-map.yaml'))!;
function edited(edit: (map: ReturnType<typeof parse>) => void) {
  const map = parse(Buffer.from(mapEntry.bytes).toString());
  edit(map);
  return zipFixture(
    entries.map((e) => (e === mapEntry ? { ...e, bytes: Buffer.from(JSON.stringify(map)) } : e)),
  );
}
describe('source-bound concurrency definition', () => {
  it('accepts the exact v0.3 map and reconstructs its phase graph', () => {
    const result = analyzeConcurrencyArchive(bytes);
    expect(result.diagnostics).toEqual([]);
    expect(result.digest).toBe('51563f70c37bd7ca696f22833ec81d37acfa4918ba380dec679198c0a4f36cff');
    expect(result.graphNodeCount).toBe(335);
    expect(result.graphEdgeCount).toBe(1221);
    expect(result.source?.work_items).toHaveLength(33);
  });
  it('rejects weakened or unknown required semantics', () => {
    const result = analyzeConcurrencyArchive(
      edited((m) => {
        m.semantics.merge_inherits_start_requirements = false;
      }),
    );
    expect(result.source).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe('unsupported-map-schema');
    expect(
      analyzeConcurrencyArchive(
        edited((m) => {
          m.semantics.auto_complete_parents = true;
        }),
      ).source,
    ).toBeUndefined();
  });
  it('detects a cycle across implicit phase boundaries', () => {
    const result = analyzeConcurrencyArchive(
      edited((m) => {
        m.slices[0].start_requires.push({ kind: 'slice', id: m.slices[0].id, state: 'verified' });
      }),
    );
    expect(result.diagnostics.some((d) => d.code === 'milestone-cycle')).toBe(true);
    expect(result.source).toBeUndefined();
  });
  it('rejects dangling dependencies and changed complete parent obligations', () => {
    expect(
      analyzeConcurrencyArchive(
        edited((m) => {
          m.slices[0].merge_requires.push({ kind: 'checkpoint', id: 'MISSING', state: 'passed' });
        }),
      ).diagnostics.some((d) => d.code === 'unknown-reference'),
    ).toBe(true);
    expect(
      analyzeConcurrencyArchive(
        edited((m) => {
          m.work_items[0].source_exit_gate = 'weaker';
        }),
      ).diagnostics.some((d) => d.code === 'source-record-mismatch'),
    ).toBe(true);
  });
  it('rejects missing case coverage, snapshot changes and YAML aliases', () => {
    expect(
      analyzeConcurrencyArchive(
        edited((m) => {
          m.acceptance_coverage.pop();
        }),
      ).source,
    ).toBeUndefined();
    const changed = entries.map((e) =>
      e.path.endsWith('/source-snapshots/wi-plan.source.txt')
        ? { ...e, bytes: Buffer.from('changed') }
        : e,
    );
    expect(
      analyzeConcurrencyArchive(zipFixture(changed)).diagnostics.some(
        (d) => d.code === 'source-hash-mismatch',
      ),
    ).toBe(true);
    const alias = zipFixture([{ path: mapEntry.path, bytes: Buffer.from('x: &x value\ny: *x\n') }]);
    expect(analyzeConcurrencyArchive(alias).diagnostics[0]?.code).toBe('invalid-yaml');
  });
});

it('validates normalized Studio definitions through the same source-bound semantic gates', () => {
  const original = analyzeConcurrencyArchive(bytes),
    root = mapEntry.path.slice(0, mapEntry.path.lastIndexOf('/') + 1);
  const normalized = analyzeConcurrencyDefinition(original.source, entries, root);
  expect(normalized.source).toEqual(original.source);
  expect(normalized.diagnostics).toEqual([]);
  expect(normalized.graphEdgeCount).toBe(original.graphEdgeCount);
  const changed = structuredClone(original.source!);
  (changed.slices[0]!.start_requires as unknown[]).push({
    kind: 'checkpoint',
    id: 'MISSING',
    state: 'passed',
  });
  expect(analyzeConcurrencyDefinition(changed, entries, root).source).toBeUndefined();
  expect(
    analyzeConcurrencyDefinition(
      original.source,
      [...entries, { ...entries[0]!, path: '../escape' }],
      root,
    ).source,
  ).toBeUndefined();
  expect(
    analyzeConcurrencyDefinition(
      original.source,
      entries.map((e, i) => (i ? e : { ...e, sha256: '0'.repeat(64) })),
      root,
    ).source,
  ).toBeUndefined();
});
it('compares scope obligations and embedded sources when reviewing replacement definitions', async () => {
  const { compareConcurrencyDefinitions, scopeDefinitionFingerprint } = await import(
    '@craftingtable/domain'
  );
  const original = analyzeConcurrencyArchive(bytes).source!,
    changed = structuredClone(original);
  const id = changed.slices[0]!.id;
  (changed.slices[0] as { scope: string }).scope += ' Added obligation';
  const diff = compareConcurrencyDefinitions(original, changed);
  expect(
    diff.filter((d) => d.key.startsWith(`slice:${id}:`)).every((d) => d.change === 'changed'),
  ).toBe(true);
  expect(diff.some((d) => d.change === 'unchanged')).toBe(true);
  expect(scopeDefinitionFingerprint(original, 'slice', id)).not.toBe(
    scopeDefinitionFingerprint(changed, 'slice', id),
  );
});
