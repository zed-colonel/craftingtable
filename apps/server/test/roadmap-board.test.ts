import { roadmapGraphSchema, roadmapPageSchema } from '@craftingtable/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  roadmapControl,
  roadmapId,
  supervisedMapFixture,
} from './execution-test-support.js';

/**
 * R-E3b: a cross-project roadmap's board. Its page read evaluates the map once, and the board's
 * every state, actor and count comes from the daemon.
 */

const mapEvaluations = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/services/cross-project-service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/services/cross-project-service.js')>();
  return {
    ...original,
    crossProjectState: (...args: Parameters<typeof original.crossProjectState>) => {
      mapEvaluations.count += 1;
      return original.crossProjectState(...args);
    },
  };
});

afterEach(cleanupExecutionFixtures);

/** A GET of the daemon's API as the fixture's user. */
async function read(f: Awaited<ReturnType<typeof supervisedMapFixture>>, path: string) {
  const response = await f.state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${f.state.workspaceId}${path}`,
    headers: { cookie: f.state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

it('evaluates the map once per roadmap page read, for the view and the status list together (R-E3b 2)', async () => {
  const f = await supervisedMapFixture(true);
  f.service.save(f.auth, f.state.workspaceId, f.input);
  await adoptSupervisedMap(f);
  mapEvaluations.count = 0;
  const page = roadmapPageSchema.parse(await read(f, `/roadmaps/${roadmapId}/view`));
  expect(page.status.entries.length).toBeGreaterThan(0);
  expect(mapEvaluations.count).toBe(1);
});

/** The supervised fixture with an architecture decision slice a starts on, started. */
async function decisionRoadmap() {
  const f = await supervisedMapFixture(false, 'automatic', false, false, false, (source) => ({
    ...source,
    checkpoints: [
      ...source.checkpoints,
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-ADR-01',
        decision_refs: [],
        owner: 'local',
        kind: 'architecture_decision' as const,
        title: 'Transport contract',
        requires: [],
        pass_criteria: ['Approve the transport contract.'],
        evidence_profile: 'decision-review',
      },
    ] as typeof source.checkpoints,
    evidence_profiles: [
      ...source.evidence_profiles,
      {
        id: 'decision-review',
        required_evidence: [
          'accepted decision artifact digest and revision',
          'source contract and affected schema or protocol references',
          'decision owner approval and applicability to the active plan generation',
        ],
        reviewer_roles: ['repository-maintainer'],
        independence_required: true as const,
      },
    ],
    slices: source.slices.map((slice, index) =>
      index === 0
        ? {
            ...slice,
            start_requires: [
              ...slice.start_requires,
              { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
            ],
          }
        : slice,
    ),
  }));
  f.service.save(f.auth, f.state.workspaceId, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(f.state, 'start');
  await f.state.context.services.roadmapService.tick();
  f.state.context.services.roadmapService.syncAttention(true);
  return f;
}

it('serves the board on the page read and its graph by revision, and places every open entry (R-E3b 3)', async () => {
  const f = await decisionRoadmap();
  const page = roadmapPageSchema.parse(await read(f, `/roadmaps/${roadmapId}/view`));
  const board = page.board!;
  expect(board.revision).toBe(page.definitionRevision);
  const graph = roadmapGraphSchema.parse(
    await read(f, `/roadmaps/${roadmapId}/graph/${board.revision}`),
  );
  expect(graph.nodes).toHaveLength(board.nodes.length);

  // Every open entry is on a card or one of its slices: one selection reaches it.
  const onCards = new Set(
    board.lanes.flatMap((lane) =>
      lane.cards.flatMap((card) => [
        card.node,
        ...graph.nodes.flatMap((n, i) => (n.parent === card.node ? [i] : [])),
      ]),
    ),
  );
  const definition = f.state.context.storage.roadmaps.definition(
    f.state.workspaceId,
    roadmapId,
    board.revision,
  )!;
  const placed = new Set(
    board.nodes.flatMap((n, i) =>
      onCards.has(i) ? (n.entries ?? []).map((p) => definition.entries[p]!.id) : [],
    ),
  );
  expect(page.status.entries.length).toBeGreaterThan(0);
  for (const row of page.status.entries) expect(placed, row.sourceId).toContain(row.entryId);

  // The decision is a gate with its inbox item, unblocking the slices the inbox item counts.
  const adr = graph.nodes.findIndex((n) => n.key === 'checkpoint:LOCAL-ADR-01:passed');
  const item = f.state.context.storage.attention
    .open(f.state.workspaceId)
    .find((i) => i.subjectKey.endsWith(':checkpoint:LOCAL-ADR-01'))!;
  expect(item).toBeDefined();
  expect(board.gates[0]).toEqual({ node: adr, slices: item.blocks, attentionItemId: item.id });
  const startA = graph.nodes.findIndex((n) => n.key === 'slice:local/AQ-01/a:started');
  expect(board.nodes[startA]).toMatchObject({ unmet: [adr], roots: [adr] });
});

it('answers 404 for a revision the roadmap does not have', async () => {
  const f = await supervisedMapFixture(true);
  f.service.save(f.auth, f.state.workspaceId, f.input);
  const response = await f.state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/graph/99`,
    headers: { cookie: f.state.cookie },
  });
  expect(response.statusCode).toBe(404);
});
