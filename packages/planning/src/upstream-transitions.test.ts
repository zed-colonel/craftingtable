import { readFileSync } from 'node:fs';
import { type UpstreamTransition, upstreamTransitionIssues } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readArchive } from './archive.js';
import { zipFixture } from './archive-test-support.js';
import { analyzeConcurrencyArchive } from './concurrency.js';

// The v0.3 fixture is the live AQ/WI/EXO map, so these are the real links (ADR-069).
const bytes = readFileSync(
  new URL(
    '../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
    import.meta.url,
  ),
);
const entries = readArchive(bytes);
const mapEntry = entries.find((e) => e.path.endsWith('/cross-stack-concurrency-map.yaml'))!;
type Map = ReturnType<typeof parse>;
const map = (): Map => parse(Buffer.from(mapEntry.bytes).toString());
function archive(edit: (map: Map) => void) {
  const value = map();
  edit(value);
  return zipFixture(
    entries.map((e) => (e === mapEntry ? { ...e, bytes: Buffer.from(JSON.stringify(value)) } : e)),
  );
}
const source = analyzeConcurrencyArchive(bytes).source!;
const codes = (transitions: UpstreamTransition[], s = source) =>
  upstreamTransitionIssues(s, transitions).map((i) => i.code);
const wiAq = { consumer: 'wi', upstream: 'aq', slice: 'wi/WI-02/integration' };
/**
 * EXO with one first current-pin slice. On the live map EXO-05/integration and the early-start
 * EXO-18/instance-qualification can both start before EXO-03/integration.
 */
function exoFunnel(m: Map) {
  for (const id of ['exo/EXO-05/integration', 'exo/EXO-18/instance-qualification'])
    m.slices
      .find((s: { id: string }) => s.id === id)
      .start_requires.push({ kind: 'slice', id: 'exo/EXO-03/integration', state: 'merged' });
}

describe('upstream transitions (ADR-069)', () => {
  it('accepts wi→aq at WI-02/integration, which every WI current-pin scope requires first', () => {
    expect(codes([wiAq])).toEqual([]);
    const result = analyzeConcurrencyArchive(archive((m) => (m.upstream_transitions = [wiAq])));
    expect(result.diagnostics).toEqual([]);
    expect(result.source?.upstream_transitions).toEqual([wiAq]);
  });

  it('refuses a transition that other current-pin work could start before', () => {
    const issues = upstreamTransitionIssues(source, [{ ...wiAq, slice: 'wi/WI-03/integration' }]);
    expect(issues.map((i) => i.code)).toEqual(['upstream-transition-order']);
    expect(issues[0]?.message).toContain('wi/WI-02/integration');
  });

  it('cannot read EXO off the live graph: three independent first current-pin slices', () => {
    for (const slice of ['exo/EXO-03/integration', 'exo/EXO-05/integration']) {
      const issues = upstreamTransitionIssues(source, [{ consumer: 'exo', upstream: 'aq', slice }]);
      expect(
        issues.map((i) => i.code),
        slice,
      ).toEqual(['upstream-transition-order']);
      const other = slice.includes('03') ? 'exo/EXO-05/integration' : 'exo/EXO-03/integration';
      expect(issues[0]?.message, slice).toContain(other);
      // An early-start exception lets its native builds precede every EXO integration slice.
      expect(issues[0]?.message, slice).toContain('exo/EXO-18/instance-qualification');
    }
  });

  it('refuses a scoped slice, another repository slice and an unknown slice', () => {
    for (const slice of ['wi/WI-02/domain', 'exo/EXO-03/integration', 'wi/WI-99/integration'])
      expect(codes([{ ...wiAq, slice }]), slice).toEqual(['upstream-transition-slice']);
  });

  it('refuses links that are not consumer→upstream links of the map', () => {
    for (const t of [
      { consumer: 'aq', upstream: 'wi', slice: 'wi/WI-02/integration' },
      { consumer: 'wi', upstream: 'exo', slice: 'wi/WI-02/integration' },
      { consumer: 'nope', upstream: 'aq', slice: 'wi/WI-02/integration' },
    ])
      expect(codes([t]), `${t.consumer}→${t.upstream}`).toEqual(['upstream-transition-link']);
  });

  it('refuses the same link twice', () => {
    expect(codes([wiAq, wiAq])).toEqual(['upstream-transition-duplicate']);
  });

  it('requires a consumer to take an upstream only after the links its current pin carries', () => {
    const funnel = analyzeConcurrencyArchive(archive(exoFunnel)).source!;
    const exo = (upstream: string, slice = 'exo/EXO-03/integration') => ({
      consumer: 'exo',
      upstream,
      slice,
    });
    // WI's current pin builds against AQ, so exo→wi cannot move while exo→aq is historical.
    expect(codes([exo('wi')], funnel)).toEqual(['upstream-transition-coupling']);
    expect(codes([exo('aq'), exo('wi')], funnel)).toEqual([]);
    // AQ carries no upstream of EXO's, so exo→aq may move alone.
    expect(codes([exo('aq')], funnel)).toEqual([]);
  });

  it('fails the import with the same diagnostics', () => {
    const result = analyzeConcurrencyArchive(
      archive((m) => (m.upstream_transitions = [{ ...wiAq, slice: 'wi/WI-02/domain' }])),
    );
    expect(result.source).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual(['upstream-transition-slice']);
  });
});
