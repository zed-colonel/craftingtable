import { afterEach, expect } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  itNeedsCargo,
  roadmapControl,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C14 (LIVE-10): the roadmap pass asks the operator for a decision only when work waits on
 * it and on nothing else. On 2026-09-28 the live inbox listed all 35 answerable decisions in
 * the map, though every entry that needed one also waited on unfinished work.
 */

afterEach(cleanupExecutionFixtures);

const decision = (id: string, requires: readonly unknown[] = []) => ({
  id,
  decision_refs: [],
  owner: 'local',
  kind: 'architecture_decision' as const,
  requires,
  pass_criteria: ['Approve the transport contract.'],
  evidence_profile: 'decision-review',
});
const decisionReview = {
  id: 'decision-review',
  required_evidence: [
    'accepted decision artifact digest and revision',
    'source contract and affected schema or protocol references',
    'decision owner approval and applicability to the active plan generation',
  ],
  reviewer_roles: ['repository-maintainer'],
  independence_required: true as const,
};

/** The supervised fixture with extra checkpoints and slice requirements. */
async function mapWith(
  checkpoints: readonly Record<string, unknown>[],
  requirements: Record<string, Record<string, readonly unknown[]>>,
) {
  const f = await supervisedMapFixture(false, 'automatic', false, false, false, (source) => ({
    ...source,
    checkpoints: [
      ...source.checkpoints,
      ...checkpoints.map((c) => ({ ...source.checkpoints[0]!, ...c })),
    ] as typeof source.checkpoints,
    evidence_profiles: [...source.evidence_profiles, decisionReview],
    slices: source.slices.map((slice) => {
      const added = requirements[slice.id] ?? {};
      return {
        ...slice,
        start_requires: [...slice.start_requires, ...(added.start ?? [])],
        merge_requires: [...slice.merge_requires, ...(added.merge ?? [])],
      } as typeof slice;
    }),
  }));
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  const openCheckpoints = () => {
    state.context.services.roadmapService.syncAttention(true);
    return tx.attention
      .open(ws)
      .filter((item) => item.subjectKey.includes(':checkpoint:'))
      .map((item) => [item.subjectKey.split(':checkpoint:')[1], item.code]);
  };
  const row = (sourceId: string) =>
    state.context.services.roadmapService
      .statusOf(tx.roadmaps.list(ws).find((r) => r.status !== 'draft')!)
      .entries.find((e) => e.sourceId === sourceId && e.scope === 'slice');
  const merged = (sourceId: string) =>
    tx.execution.worktrees
      .listForWorkItem(ws, state.workItemId)
      .some((t) => t.executionScope?.sourceId === sourceId && !!t.mergedAt);
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await state.context.services.roadmapService.tick();
  return { f, state, tx, openCheckpoints, row, merged };
}
const afterA = { kind: 'slice' as const, id: 'local/AQ-01/a', state: 'merged' as const };

itNeedsCargo(
  'asks for a decision once the work that needs it waits on nothing else (LIVE-10)',
  async () => {
    // Slice b starts after slice a merges, and needs LOCAL-ADR-01.
    const m = await mapWith([decision('LOCAL-ADR-01')], {
      'local/AQ-01/b': {
        start: [afterA, { kind: 'checkpoint', id: 'LOCAL-ADR-01', state: 'passed' }],
      },
    });
    // Slice b still waits for slice a: the decision can be answered, but nothing needs it yet.
    expect(m.merged('local/AQ-01/a')).toBe(false);
    expect(m.openCheckpoints()).toEqual([]);
    // The status list agrees: slice b waits on other work first, not on the operator.
    expect(m.row('local/AQ-01/b')?.actor).toBe('controller');
    // Once slice a has merged, the decision is all that holds slice b.
    await waitFor(() => m.merged('local/AQ-01/a'), 'slice a merged', 30000);
    await m.state.context.services.roadmapService.tick();
    expect(m.openCheckpoints()).toEqual([['LOCAL-ADR-01', 'architecture-decision']]);
    expect(m.row('local/AQ-01/b')).toMatchObject({
      actor: 'operator',
      waitsOn: { source: 'attention-item', code: 'architecture-decision' },
    });
  },
);

itNeedsCargo(
  'asks for evidence no review produces once work waits on it (R-C14 review)',
  async () => {
    // A release checkpoint slice b needs to start: no slice review ever produces it.
    const m = await mapWith(
      [
        {
          id: 'LOCAL-RELEASE',
          decision_refs: [],
          owner: 'local',
          kind: 'release',
          requires: [],
          pass_criteria: ['Released.'],
          evidence_profile: 'scope-review',
        },
      ],
      {
        'local/AQ-01/b': {
          start: [afterA, { kind: 'checkpoint', id: 'LOCAL-RELEASE', state: 'passed' }],
        },
      },
    );
    expect(m.openCheckpoints()).toEqual([]);
    await waitFor(() => m.merged('local/AQ-01/a'), 'slice a merged', 30000);
    await m.state.context.services.roadmapService.tick();
    expect(m.openCheckpoints()).toEqual([['LOCAL-RELEASE', 'checkpoint-evidence']]);
    expect(m.row('local/AQ-01/b')?.actor).toBe('operator');
    // It opens the roadmap's setup at the evidence form (R-E2 review).
    const [item] = m.tx.attention
      .open(m.state.workspaceId)
      .filter((i) => i.subjectKey.includes(':checkpoint:'));
    const roadmapId = item!.refs.roadmapId!;
    expect(item!.path).toBe(
      `/workspaces/${m.state.workspaceId}/roadmaps/${roadmapId}/setup#runtime-evidence-roadmap-${roadmapId}-evidence`,
    );
  },
);

itNeedsCargo(
  'asks for the decision a slice’s own checkpoint review waits on (R-C14 review)',
  async () => {
    // Slice a's merge needs LOCAL-SEM, which its own review produces once LOCAL-ADR-01 is
    // accepted: the decision is the operator's, the review the controller's.
    const m = await mapWith(
      [
        decision('LOCAL-ADR-01'),
        {
          id: 'LOCAL-SEM',
          decision_refs: [],
          owner: 'stack',
          kind: 'semantic_review',
          requires: [{ kind: 'checkpoint', id: 'LOCAL-ADR-01', state: 'passed' }],
          pass_criteria: ['Semantics reviewed.'],
          evidence_profile: 'scope-review',
        },
      ],
      { 'local/AQ-01/a': { merge: [{ kind: 'checkpoint', id: 'LOCAL-SEM', state: 'passed' }] } },
    );
    await waitFor(
      () =>
        m.tx.execution.cycles
          .listForWorkspace(m.state.workspaceId)
          .some(
            (c) => c.executionScope?.sourceId === 'local/AQ-01/a' && c.status === 'awaiting-merge',
          ),
      'slice a at its merge',
      30000,
    );
    await m.state.context.services.roadmapService.tick();
    expect(m.openCheckpoints()).toEqual([['LOCAL-ADR-01', 'architecture-decision']]);
    expect(m.row('local/AQ-01/a')).toMatchObject({
      actor: 'operator',
      waitsOn: { source: 'attention-item', code: 'architecture-decision' },
    });
  },
);
