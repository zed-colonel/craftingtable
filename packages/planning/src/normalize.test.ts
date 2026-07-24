import { describe, expect, it } from 'vitest';
import { type NormalizedPlan, normalizePlan } from './normalize.js';
import { parseYamlDocument } from './parse.js';
import { readInvalidFixtureText } from './test-support.js';

function requirePlan(plan: NormalizedPlan | undefined): NormalizedPlan {
  if (plan === undefined) {
    throw new Error('Expected the source to normalize into a plan');
  }
  return plan;
}

/** CT03-A15 and CT03-A16: identifier and field validation. */

function normalizeFixture(fixture: string) {
  const parsed = parseYamlDocument(readInvalidFixtureText(fixture), fixture);
  if (!parsed.ok) {
    throw new Error(`${fixture} did not parse`);
  }
  return normalizePlan(parsed.value, fixture);
}

function normalizeSource(source: string, name = 'probe.yaml') {
  const parsed = parseYamlDocument(source, name);
  if (!parsed.ok) {
    throw new Error(`fixture did not parse: ${JSON.stringify(parsed.diagnostics)}`);
  }
  return normalizePlan(parsed.value, name);
}

describe('work-breakdown normalization', () => {
  it('reports duplicate work-item identifiers with both positions (CT03-A15)', () => {
    const { diagnostics } = normalizeFixture('duplicate-ids.yaml');
    const duplicates = diagnostics.filter((d) => d.code === 'duplicate-work-item-id');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.severity).toBe('error');
    expect(duplicates[0]?.workItemSourceId).toBe('WI-01');
    expect(duplicates[0]?.message).toContain('positions 0 and 1');
  });

  it('reports every malformed identifier with its field path (CT03-A16)', () => {
    const { diagnostics } = normalizeFixture('invalid-ids.yaml');
    const invalid = diagnostics.filter((d) => d.code === 'invalid-work-item-id');
    expect(invalid).toHaveLength(3);
    expect(invalid.map((d) => d.path).toSorted()).toEqual([
      'pull_requests[0].id',
      'pull_requests[1].id',
      'pull_requests[2].id',
    ]);
  });

  it('reports each missing required work-item field (CT03-A16)', () => {
    const { diagnostics } = normalizeFixture('missing-required-fields.yaml');
    const fields = diagnostics.filter((d) => d.code === 'invalid-work-item-field');
    expect(fields.map((d) => d.path).toSorted()).toEqual([
      'pull_requests[0].depends_on',
      'pull_requests[0].exit_gate',
      'pull_requests[0].primary_areas',
    ]);
  });

  it('rejects a work breakdown with no items', () => {
    const { diagnostics } = normalizeFixture('no-work-items.yaml');
    expect(diagnostics.map((d) => d.code)).toContain('missing-work-items');
  });

  it('requires document and pull_requests at the top level', () => {
    const { diagnostics } = normalizeSource('unrelated: true\n');
    expect(diagnostics.map((d) => d.code)).toEqual([
      'invalid-work-breakdown',
      'invalid-work-breakdown',
    ]);
    expect(diagnostics.map((d) => d.path)).toEqual(['document', 'pull_requests']);
  });

  it('normalizes an unmodelled risk to unspecified with a warning', () => {
    const { plan, diagnostics } = normalizeFixture('unrecognized-risk.yaml');
    const warnings = diagnostics.filter((d) => d.code === 'unrecognized-risk');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
    const [item] = requirePlan(plan).workItems;
    if (item === undefined) {
      throw new Error('Expected one normalized work item');
    }
    expect(item.risk).toBe('unspecified');
    // The raw word survives, so nothing the operator wrote is lost.
    expect((item.sourceFields as { risk: string }).risk).toBe('apocalyptic');
  });

  it('treats a non-list depends_on as a field error rather than an empty list', () => {
    const { diagnostics } = normalizeSource(
      'document: X\npull_requests:\n- id: WI-01\n  title: T\n  depends_on: WI-02\n  risk: low\n  primary_areas: []\n  exit_gate: G\n',
    );
    const field = diagnostics.filter((d) => d.code === 'invalid-work-item-field');
    expect(field).toHaveLength(1);
    expect(field[0]?.path).toBe('pull_requests[0].depends_on');
  });

  it('accepts an absent or null recommends as no recommendations', () => {
    const { plan, diagnostics } = normalizeSource(
      'document: X\npull_requests:\n- id: WI-01\n  title: T\n  depends_on: []\n  recommends: null\n  risk: low\n  primary_areas: []\n  exit_gate: G\n',
    );
    expect(diagnostics).toEqual([]);
    expect(plan?.workItems[0]?.recommendedDependencies).toEqual([]);
  });

  it('preserves source ordering as the display ordinal', () => {
    const { plan } = normalizeSource(
      'document: X\npull_requests:\n' +
        '- id: WI-09\n  title: Later identifier first\n  depends_on: []\n  risk: low\n  primary_areas: []\n  exit_gate: G\n' +
        '- id: WI-01\n  title: Earlier identifier second\n  depends_on: []\n  risk: low\n  primary_areas: []\n  exit_gate: G\n',
    );
    expect(plan?.workItems.map((item) => [item.sourceId, item.ordinal])).toEqual([
      ['WI-09', 0],
      ['WI-01', 1],
    ]);
  });

  it('keeps every top-level source key in metadata', () => {
    const { plan } = normalizeSource(
      'document: X\nunmodelled_key: {a: 1}\npull_requests:\n- id: WI-01\n  title: T\n  depends_on: []\n  risk: low\n  primary_areas: []\n  exit_gate: G\n',
    );
    const metadata = requirePlan(plan).metadata as Record<string, unknown>;
    expect(metadata.unmodelled_key).toEqual({ a: 1 });
  });
});
