import { createHash } from 'node:crypto';
import type { JsonValue } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { analyzePlanBundle } from './bundle.js';
import { parseYamlDocument } from './parse.js';
import {
  AQ_BUNDLE_ROLES,
  aqBundleArtifacts,
  readExpectationsText,
  readFixtureBytes,
} from './test-support.js';

/**
 * CT03-A09 to A12.
 *
 * Every expectation is read from work-items/CT-03/CT-03-aq-import-expectations.yaml
 * at run time rather than inlined, so the committed fixture stays authoritative
 * (CT-03 §6) and this test cannot silently drift away from it.
 */

interface Expectations {
  readonly expected: {
    readonly document: string;
    readonly status: string;
    readonly contract: string;
    readonly stack_revision: string;
    readonly repository: string;
    readonly baseline_commit: string;
    readonly work_item_count: number;
    readonly required_dependency_edge_count: number;
    readonly root_source_ids: readonly string[];
    readonly source_ids_in_order: readonly string[];
    readonly risk_counts: Record<string, number>;
    readonly planning_ready_source_ids_before_any_completion: readonly string[];
  };
  readonly required_dependencies: Record<string, readonly string[]>;
  readonly work_item_fields: Record<
    string,
    {
      readonly title: string;
      readonly risk: string;
      readonly primary_areas: readonly string[];
      readonly exit_gate: string;
    }
  >;
}

function loadExpectations(): Expectations {
  const parsed = parseYamlDocument(readExpectationsText(), 'expectations.yaml');
  if (!parsed.ok) {
    throw new Error(`Expectation fixture did not parse: ${JSON.stringify(parsed.diagnostics)}`);
  }
  return parsed.value as unknown as Expectations;
}

const expectations = loadExpectations();
const analysis = analyzePlanBundle({ artifacts: aqBundleArtifacts() });

describe('AQ-CONT-1 fixture import', () => {
  it('parses the exact fixture with no fatal diagnostics (CT03-A09)', () => {
    expect(analysis.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(analysis.fatal).toBe(false);
    expect(analysis.plan).toBeDefined();
    expect(analysis.graph).toBeDefined();
    expect(analysis.plan?.sourceProfile).toBe('exo-work-breakdown-v1');
  });

  it('produces the expected item, edge, root, and risk counts (CT03-A10)', () => {
    const plan = analysis.plan;
    const graph = analysis.graph;
    if (plan === undefined || graph === undefined) {
      throw new Error('Expected the AQ fixture to analyse successfully');
    }

    expect(plan.workItems).toHaveLength(expectations.expected.work_item_count);
    expect(plan.workItems.map((item) => item.sourceId)).toEqual(
      expectations.expected.source_ids_in_order,
    );
    expect(graph.requiredEdges).toHaveLength(expectations.expected.required_dependency_edge_count);
    expect(graph.rootSourceIds).toEqual(expectations.expected.root_source_ids);
    expect(graph.planningReadySourceIds).toEqual(
      expectations.expected.planning_ready_source_ids_before_any_completion,
    );

    const riskCounts: Record<string, number> = {};
    for (const item of plan.workItems) {
      riskCounts[item.risk] = (riskCounts[item.risk] ?? 0) + 1;
    }
    expect(riskCounts).toEqual(expectations.expected.risk_counts);
  });

  it('reproduces every required dependency edge exactly (CT03-A10)', () => {
    const graph = analysis.graph;
    if (graph === undefined) {
      throw new Error('Expected a graph');
    }
    const actual: Record<string, string[]> = {};
    for (const sourceId of expectations.expected.source_ids_in_order) {
      actual[sourceId] = [...(graph.requiredPredecessors.get(sourceId) ?? [])];
    }
    const expected: Record<string, string[]> = {};
    for (const [sourceId, predecessors] of Object.entries(expectations.required_dependencies)) {
      expected[sourceId] = [...predecessors];
    }
    expect(actual).toEqual(expected);
  });

  it('every non-root item reports its unsatisfied required predecessors (CT03-A51)', () => {
    const graph = analysis.graph;
    if (graph === undefined) {
      throw new Error('Expected a graph');
    }
    const blocked = expectations.expected.source_ids_in_order.filter(
      (id) => !expectations.expected.root_source_ids.includes(id),
    );
    expect(blocked).toHaveLength(13);
    for (const sourceId of blocked) {
      expect(graph.requiredPredecessors.get(sourceId)?.length ?? 0).toBeGreaterThan(0);
      expect(graph.planningReadySourceIds).not.toContain(sourceId);
    }
  });

  it('preserves every recognized top-level and work-item field (CT03-A11)', () => {
    const plan = analysis.plan;
    if (plan === undefined) {
      throw new Error('Expected a plan');
    }
    expect(plan.document).toBe(expectations.expected.document);
    expect(plan.status).toBe(expectations.expected.status);
    expect(plan.contract).toBe(expectations.expected.contract);
    expect(plan.stackRevision).toBe(expectations.expected.stack_revision);
    expect(plan.repository).toBe(expectations.expected.repository);
    expect(plan.baselineCommit).toBe(expectations.expected.baseline_commit);

    for (const item of plan.workItems) {
      const expected = expectations.work_item_fields[item.sourceId];
      if (expected === undefined) {
        throw new Error(`Expectation file has no entry for ${item.sourceId}`);
      }
      expect(item.title).toBe(expected.title);
      expect(item.risk).toBe(expected.risk);
      expect(item.primaryAreas).toEqual(expected.primary_areas);
      expect(item.exitGate).toBe(expected.exit_gate);
    }
  });

  it('retains unknown and uninterpreted source fields (CT03-A11, CT03-I16)', () => {
    const plan = analysis.plan;
    if (plan === undefined) {
      throw new Error('Expected a plan');
    }
    const metadata = plan.metadata as Record<string, JsonValue>;
    // `clean_break`, `release_order`, and `forbidden_release_symbols` are not
    // projected into normalized properties; they must still survive.
    expect(metadata.clean_break).toEqual({
      legacy_runtime_compatibility: false,
      legacy_store_readers: false,
      live_dual_authority: false,
      offline_characterization: true,
      integration_branch: 'aq-cont-1',
      baseline_tag: 'actionqueue/pre-aq-cont-1',
    });
    expect(metadata.release_order).toEqual(['AQ-CONT-1', 'WI-FABRIC-2', 'EXO-V3']);
    expect(Array.isArray(metadata.forbidden_release_symbols)).toBe(true);

    const first = plan.workItems[0]?.sourceFields as Record<string, JsonValue>;
    expect(Object.keys(first).toSorted()).toEqual(
      ['depends_on', 'exit_gate', 'id', 'primary_areas', 'risk', 'title'].toSorted(),
    );
  });

  it('leaves artifact bytes and per-artifact digests unchanged (CT03-A12)', () => {
    expect(analysis.artifacts).toHaveLength(AQ_BUNDLE_ROLES.length);
    for (const artifact of analysis.artifacts) {
      const original = readFixtureBytes(artifact.logicalFilename);
      expect(artifact.byteLength).toBe(original.byteLength);
      expect(Buffer.from(artifact.bytes).equals(Buffer.from(original))).toBe(true);
      expect(artifact.sha256).toBe(createHash('sha256').update(original).digest('hex'));
    }
  });

  it('verifies the committed checksum manifest against the submitted bytes', () => {
    // The fixture ships aq-cont-1-implementation-plan.sha256; a mismatch would
    // have produced a fatal checksum-mismatch diagnostic above.
    const manifest = analysis.artifacts.find((artifact) => artifact.role === 'validation-manifest');
    expect(manifest?.logicalFilename).toBe('aq-cont-1-implementation-plan.sha256');
    expect(analysis.diagnostics.filter((d) => d.code === 'checksum-mismatch')).toEqual([]);
  });

  it('assigns a canonical bundle digest', () => {
    expect(analysis.digest?.algorithm).toBe('sha-256');
    expect(analysis.digest?.formatVersion).toBe(1);
    expect(analysis.digest?.hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
