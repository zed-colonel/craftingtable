import { describe, expect, it } from 'vitest';
import { UpstreamTransitionUndeclaredError } from './errors.js';
import { chooseUpstreamSources } from './upstream-transition-policy.js';

// ADR-069: each consumer→upstream link is supplied from its own source. The two upstreams are
// unrelated, so their links may move at different slices (coupled links move together).
const exoAq = { consumer: 'exo', upstream: 'aq', slice: 'exo/EXO-A/integration' };
const exoWi = { consumer: 'exo', upstream: 'wi', slice: 'exo/EXO-B/integration', recordId: 'r1' };
const choose = (input: Partial<Parameters<typeof chooseUpstreamSources>[0]>) =>
  chooseUpstreamSources({
    consumer: 'exo',
    upstreams: ['aq', 'wi'],
    scoped: true,
    transitions: [exoAq, exoWi],
    moved: new Set(),
    historical: ['aq', 'wi'],
    ...input,
  });

describe('choosing upstream sources per link', () => {
  it('builds one link current and the other historical once only the first has moved', () => {
    expect(choose({ moved: new Set(['aq']) })).toEqual([
      { alias: 'aq', source: 'current', transition: { slice: exoAq.slice } },
      { alias: 'wi', source: 'historical', transition: { slice: exoWi.slice, recordId: 'r1' } },
    ]);
  });

  it('keeps a scoped link historical before its transition merges, and on an undeclared link', () => {
    expect(choose({}).map((c) => c.source)).toEqual(['historical', 'historical']);
    expect(choose({ transitions: [] }).map((c) => c.source)).toEqual(['historical', 'historical']);
  });

  it('leaves a scoped link without a prepared historical source dependency-free', () => {
    expect(choose({ historical: ['wi'] }).map((c) => c.source)).toEqual(['none', 'historical']);
  });

  it('gives current-pin work the current pin on every declared link', () => {
    expect(choose({ scoped: false }).map((c) => c.source)).toEqual(['current', 'current']);
  });

  it('stops current-pin work on a link nobody declared instead of guessing', () => {
    expect(() => choose({ scoped: false, transitions: [exoAq] })).toThrow(
      UpstreamTransitionUndeclaredError,
    );
    expect(() => choose({ scoped: false, transitions: [exoAq] })).toThrow(
      'Declare when exo moves to the current wi pin',
    );
  });
});
