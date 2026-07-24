import { describe, expect, it } from 'vitest';
import { analyzePlanGraph } from './graph.js';
import { normalizePlan } from './normalize.js';
import { parseYamlDocument } from './parse.js';
import { readInvalidFixtureText } from './test-support.js';

/** CT03-A17 to A20: dependency graph validation. */

function analyze(fixture: string) {
  const parsed = parseYamlDocument(readInvalidFixtureText(fixture), fixture);
  if (!parsed.ok) {
    throw new Error(`${fixture} did not parse: ${JSON.stringify(parsed.diagnostics)}`);
  }
  const normalized = normalizePlan(parsed.value, fixture);
  if (normalized.plan === undefined) {
    throw new Error(`${fixture} did not normalize: ${JSON.stringify(normalized.diagnostics)}`);
  }
  return analyzePlanGraph(normalized.plan, fixture);
}

describe('required dependency graph', () => {
  it('reports a required dependency on an absent item (CT03-A17)', () => {
    const { diagnostics } = analyze('missing-dependency.yaml');
    const missing = diagnostics.filter((d) => d.code === 'missing-required-dependency');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe('error');
    expect(missing[0]?.workItemSourceId).toBe('WI-01');
    expect(missing[0]?.message).toContain('WI-99');
    expect(missing[0]?.path).toBe('pull_requests[0].depends_on[0]');
  });

  it('reports a self-dependency (CT03-A18)', () => {
    const { diagnostics } = analyze('self-dependency.yaml');
    const self = diagnostics.filter((d) => d.code === 'self-dependency');
    expect(self).toHaveLength(1);
    expect(self[0]?.workItemSourceId).toBe('WI-01');
  });

  it('reports a two-node cycle deterministically (CT03-A19)', () => {
    const { diagnostics } = analyze('two-node-cycle.yaml');
    const cycles = diagnostics.filter((d) => d.code === 'required-dependency-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toBe('Required dependency cycle: WI-01 → WI-02 → WI-01');
    expect(cycles[0]?.severity).toBe('error');
  });

  it('reports a longer cycle deterministically (CT03-A19)', () => {
    const { diagnostics } = analyze('long-cycle.yaml');
    const cycles = diagnostics.filter((d) => d.code === 'required-dependency-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toBe(
      'Required dependency cycle: WI-02 → WI-03 → WI-04 → WI-05 → WI-02',
    );
  });

  it('produces the same cycle diagnostic regardless of item ordering (CT03-A19)', () => {
    const source = `document: Permuted\npull_requests:\n${['WI-03', 'WI-01', 'WI-02']
      .map(
        (id, index) =>
          `- id: ${id}\n  title: Item ${id}\n  depends_on: [${['WI-02', 'WI-03', 'WI-01'][index]}]\n  risk: medium\n  primary_areas: [core]\n  exit_gate: Green.\n`,
      )
      .join('')}`;
    const parsed = parseYamlDocument(source, 'permuted.yaml');
    if (!parsed.ok) {
      throw new Error('permuted fixture did not parse');
    }
    const normalized = normalizePlan(parsed.value, 'permuted.yaml');
    if (normalized.plan === undefined) {
      throw new Error('permuted fixture did not normalize');
    }
    const cycles = analyzePlanGraph(normalized.plan, 'permuted.yaml').diagnostics.filter(
      (d) => d.code === 'required-dependency-cycle',
    );
    expect(cycles).toHaveLength(1);
    // Canonical rotation starts at the lowest-ordinal member, which is WI-03
    // here because it appears first in this permuted source.
    expect(cycles[0]?.message).toBe('Required dependency cycle: WI-03 → WI-01 → WI-02 → WI-03');
  });

  it('warns about an unresolved recommendation without blocking (CT03-A20)', () => {
    const { diagnostics, graph } = analyze('recommends-unknown.yaml');
    const warnings = diagnostics.filter((d) => d.code === 'unknown-recommended-dependency');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // A recommendation must never gain blocking authority (CT03-I09).
    expect(graph?.recommendedEdges).toEqual([]);
    expect(graph?.planningReadySourceIds).toEqual(['WI-01']);
    expect(graph?.rootSourceIds).toEqual(['WI-01']);
  });

  it('deduplicates a repeated required edge with a warning', () => {
    const { diagnostics, graph } = analyze('duplicate-required-edge.yaml');
    const duplicates = diagnostics.filter((d) => d.code === 'duplicate-required-dependency');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.severity).toBe('warning');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(graph?.requiredEdges).toEqual([
      { predecessorSourceId: 'WI-01', successorSourceId: 'WI-02', ordinal: 0 },
    ]);
  });

  it('excludes recommended edges from readiness derivation (CT03-I09)', () => {
    const source =
      'document: Recommended only\npull_requests:\n' +
      '- id: WI-01\n  title: Root\n  depends_on: []\n  risk: low\n  primary_areas: [core]\n  exit_gate: Green.\n' +
      '- id: WI-02\n  title: Recommends the root\n  depends_on: []\n  recommends: [WI-01]\n  risk: low\n  primary_areas: [core]\n  exit_gate: Green.\n';
    const parsed = parseYamlDocument(source, 'recommended.yaml');
    if (!parsed.ok) {
      throw new Error('fixture did not parse');
    }
    const normalized = normalizePlan(parsed.value, 'recommended.yaml');
    if (normalized.plan === undefined) {
      throw new Error('fixture did not normalize');
    }
    const { graph, diagnostics } = analyzePlanGraph(normalized.plan, 'recommended.yaml');
    expect(diagnostics).toEqual([]);
    expect(graph?.recommendedEdges).toHaveLength(1);
    expect(graph?.requiredEdges).toEqual([]);
    expect(graph?.planningReadySourceIds).toEqual(['WI-01', 'WI-02']);
  });

  it('derives readiness from completion rather than from having no predecessors', () => {
    const source =
      'document: Chain\npull_requests:\n' +
      '- id: WI-01\n  title: Root\n  depends_on: []\n  risk: low\n  primary_areas: [core]\n  exit_gate: Green.\n' +
      '- id: WI-02\n  title: Successor\n  depends_on: [WI-01]\n  risk: low\n  primary_areas: [core]\n  exit_gate: Green.\n';
    const parsed = parseYamlDocument(source, 'chain.yaml');
    if (!parsed.ok) {
      throw new Error('fixture did not parse');
    }
    const normalized = normalizePlan(parsed.value, 'chain.yaml');
    if (normalized.plan === undefined) {
      throw new Error('fixture did not normalize');
    }
    expect(analyzePlanGraph(normalized.plan, 'chain.yaml').graph?.planningReadySourceIds).toEqual([
      'WI-01',
    ]);
    // CT-03 can never supply a completed predecessor, but the derivation is
    // written so that CT-04's completion workflow only has to supply this list.
    expect(
      analyzePlanGraph(normalized.plan, 'chain.yaml', ['WI-01']).graph?.planningReadySourceIds,
    ).toEqual(['WI-01', 'WI-02']);
  });
});
