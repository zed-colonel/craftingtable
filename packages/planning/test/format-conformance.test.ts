import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { concurrencyMilestones, type JsonValue, targetClosure } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { analyzePlanBundle, type PlanBundleAnalysis, type PlanBundleInput } from '../src/bundle.js';
import { analyzeConcurrencyArchive, sourceRecordDigest } from '../src/concurrency.js';
import { sha256Hex } from '../src/digest.js';
import type { PlanEdge } from '../src/graph.js';
import { inspectPlanArchive, preparePlanArchive } from '../src/plan-archive.js';
import { aqBundleArtifacts, readInvalidFixtureText, syntheticBundle } from './test-support.js';

/**
 * Golden conformance tests for the plan-bundle and concurrency-map formats
 * (review register R-F4).
 *
 * Every committed fixture is imported through the same pure entry points the
 * daemon uses, and the normalized model, diagnostics and digests are compared
 * with committed golden files under `packages/planning/golden/`. Existing plan
 * versions and maps are identified by these digests and interpreted through
 * this model, so a refactor that changes any of it changes the meaning of data
 * the operator has already imported.
 *
 * A mismatch is a failure, never an automatic update. When a change to the
 * format interpretation is intended and reviewed, regenerate the files with
 *
 *   CRAFTINGTABLE_UPDATE_GOLDEN=1 pnpm exec vitest run packages/planning/test/format-conformance.test.ts
 *
 * and commit the golden diff together with the change that caused it.
 */

const REPOSITORY_ROOT = new URL('../../../', import.meta.url);
const GOLDEN_DIR = new URL('packages/planning/golden/', REPOSITORY_ROOT);
const CONCURRENCY_DIR = new URL('fixtures/concurrency/', REPOSITORY_ROOT);
const INVALID_DIR = new URL('fixtures/plan-bundles/invalid/', REPOSITORY_ROOT);
const UPDATE = process.env.CRAFTINGTABLE_UPDATE_GOLDEN === '1';

function expectGolden(name: string, actual: unknown): void {
  const file = new URL(name, GOLDEN_DIR);
  // Round-trip through JSON so the comparison sees exactly what is stored.
  const normalized = JSON.parse(JSON.stringify(actual)) as unknown;
  if (UPDATE) {
    writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(
      `Golden file ${name} is missing. Generate it intentionally with CRAFTINGTABLE_UPDATE_GOLDEN=1.`,
    );
  }
  expect(normalized).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}

const edge = (e: PlanEdge) => `${e.predecessorSourceId} -> ${e.successorSourceId} #${e.ordinal}`;

/** The interpretation of one plan bundle that the importer persists. */
function planModel(analysis: PlanBundleAnalysis) {
  const plan = analysis.plan;
  const graph = analysis.graph;
  return {
    digest: analysis.digest ?? null,
    fatal: analysis.fatal,
    errorCount: analysis.errorCount,
    warningCount: analysis.warningCount,
    diagnostics: analysis.diagnostics,
    totalByteLength: analysis.totalByteLength,
    artifacts: analysis.artifacts.map(({ bytes: _bytes, ...artifact }) => artifact),
    plan:
      plan === undefined
        ? null
        : {
            ...plan,
            // The verbatim top level is stored as `normalized_source_json`; pin it by
            // its canonical fingerprint rather than repeating the whole document.
            metadata: {
              keys: Object.keys(plan.metadata as object),
              canonicalSha256: sourceRecordDigest(plan.metadata),
            },
            workItems: plan.workItems.map(({ sourceFields, ...item }) => ({
              ...item,
              sourceFieldKeys: Object.keys(sourceFields as object),
              // Same fingerprint as a map's `source_record_sha256`.
              sourceFieldsSha256: sourceRecordDigest(sourceFields),
            })),
          },
    graph:
      graph === undefined
        ? null
        : {
            requiredEdges: graph.requiredEdges.map(edge),
            recommendedEdges: graph.recommendedEdges.map(edge),
            rootSourceIds: graph.rootSourceIds,
            planningReadySourceIds: graph.planningReadySourceIds,
            requiredPredecessors: Object.fromEntries(graph.requiredPredecessors),
            requiredSuccessors: Object.fromEntries(graph.requiredSuccessors),
          },
  };
}

function readConcurrencyFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, CONCURRENCY_DIR)));
}

/** A plan ZIP imported the way the UI offers it: the single candidate pair. */
function planArchiveModel(name: string) {
  const bytes = readConcurrencyFixture(name);
  const inspected = inspectPlanArchive(bytes);
  const [implementationPlan] = inspected.implementationPlans;
  const [workBreakdown] = inspected.workBreakdowns;
  if (implementationPlan === undefined || workBreakdown === undefined) {
    throw new Error(`${name} offers no plan selection`);
  }
  const prepared = preparePlanArchive(bytes, { implementationPlan, workBreakdown });
  return {
    archive: {
      archiveDigest: inspected.archiveDigest,
      entryCount: inspected.entries.length,
      implementationPlans: inspected.implementationPlans,
      workBreakdowns: inspected.workBreakdowns,
      selectedPaths: prepared.selectedPaths,
    },
    ...planModel(analyzePlanBundle(prepared.bundle)),
  };
}

describe('plan-bundle golden conformance', () => {
  it('interprets the AQ-CONT-1 discrete bundle exactly as recorded', () => {
    const input: PlanBundleInput = { artifacts: aqBundleArtifacts() };
    expectGolden('plan-aq-cont-1.json', planModel(analyzePlanBundle(input)));
  });

  it('interprets the WI-FABRIC-2 r5 plan ZIP exactly as recorded', () => {
    expectGolden(
      'plan-wi-fabric-2-r5.json',
      planArchiveModel('wi-fabric-2-foundational-package-r5-aq-baseline-alignment.zip'),
    );
  });

  it('interprets the EXO-V3 r6 plan ZIP exactly as recorded', () => {
    expectGolden(
      'plan-exo-v3-r6.json',
      planArchiveModel('exo-v3-comprehensive-design-package-r6-aq-baseline-alignment.zip'),
    );
  });

  it('diagnoses every invalid work breakdown exactly as recorded', () => {
    const results: Record<string, unknown> = {};
    for (const name of readdirSync(INVALID_DIR).sort()) {
      const analysis = analyzePlanBundle({
        artifacts: syntheticBundle(readInvalidFixtureText(name)),
      });
      results[name] = {
        fatal: analysis.fatal,
        digest: analysis.digest?.hex ?? null,
        itemCount: analysis.plan?.workItems.length ?? null,
        diagnostics: analysis.diagnostics,
      };
    }
    expectGolden('plan-invalid-work-breakdowns.json', results);
  });
});

describe('concurrency-map golden conformance', () => {
  const name = 'cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip';
  const bytes = readConcurrencyFixture(name);
  const analysis = analyzeConcurrencyArchive(bytes);
  const source = analysis.source;

  it('imports the v0.3 map with the recorded digests and summary', () => {
    if (source === undefined) {
      throw new Error(
        `Expected the map fixture to import: ${JSON.stringify(analysis.diagnostics)}`,
      );
    }
    expectGolden('map-cross-stack-v0.3.0.json', {
      archiveSha256: sha256Hex(bytes),
      // ZIP-path identity: SHA-256 of the raw map YAML bytes.
      digest: analysis.digest,
      // Identity the direct-definition seam would record (canonical JSON).
      canonicalDefinitionSha256: sourceRecordDigest(source as unknown as JsonValue),
      diagnostics: analysis.diagnostics,
      graphNodeCount: analysis.graphNodeCount,
      graphEdgeCount: analysis.graphEdgeCount,
      identity: {
        mapId: source.map_id,
        revision: source.revision,
        terminalCheckpoint: source.terminal_checkpoint,
      },
      collectionSizes: Object.fromEntries(
        Object.entries(source)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, (value as unknown[]).length]),
      ),
      repositories: source.repositories.map((r) => ({ id: r.id, role: r.role })),
      parentBindings: Object.fromEntries(
        source.work_items.map((p) => [p.id, p.source_record_sha256]),
      ),
      planningTargets: source.planning_targets.map((t) => ({
        id: t.id,
        checkpoint: t.checkpoint,
      })),
    });
  });

  it('derives the recorded milestone model and target closures', () => {
    if (source === undefined) {
      throw new Error('Expected the map fixture to import');
    }
    const closures: Record<string, unknown> = {};
    for (const target of source.planning_targets) {
      for (const selection of ['target-only', 'prioritize-full'] as const) {
        const closure = targetClosure(source, target.id, selection);
        closures[`${target.id} ${selection}`] = {
          nodes: closure.nodes.map((n) => n.key),
          excludedCount: closure.excluded.length,
          // The priority set is the target-only closure; pin that it stays so.
          priorityIsTargetOnly:
            [...closure.priority].join() ===
            targetClosure(source, target.id, 'target-only')
              .nodes.map((n) => n.key)
              .join(),
        };
      }
    }
    expectGolden('map-cross-stack-v0.3.0-milestones.json', {
      milestones: Object.fromEntries(
        concurrencyMilestones(source).map((m) => [
          m.key,
          { repository: m.repository, parentId: m.parentId ?? null, requires: m.requires },
        ]),
      ),
      closures,
    });
  });
});
