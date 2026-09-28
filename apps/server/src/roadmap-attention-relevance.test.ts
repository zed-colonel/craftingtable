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

itNeedsCargo(
  'asks for a decision once the work that needs it waits on nothing else (LIVE-10)',
  { timeout: 45000 },
  async () => {
    // Slice b starts after slice a merges, and needs LOCAL-ADR-01.
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
          requires: [],
          pass_criteria: ['Approve the transport contract.'],
          evidence_profile: 'decision-review',
        },
      ],
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
      slices: source.slices.map((slice) =>
        slice.id === 'local/AQ-01/b'
          ? {
              ...slice,
              start_requires: [
                ...slice.start_requires,
                { kind: 'slice' as const, id: 'local/AQ-01/a', state: 'merged' as const },
                { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
              ],
            }
          : slice,
      ),
    }));
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const storedRoadmapOf = () => tx.roadmaps.list(ws).find((r) => r.status !== 'draft')!;
    const decisionItem = () => {
      state.context.services.roadmapService.syncAttention(true);
      return tx.attention
        .open(ws)
        .find((item) => item.subjectKey.endsWith(':checkpoint:LOCAL-ADR-01'));
    };
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    await state.context.services.roadmapService.tick();
    // Slice b still waits for slice a: the decision can be answered, but nothing needs it yet.
    expect(
      tx.execution.worktrees
        .listForWorkItem(ws, state.workItemId)
        .some((t) => t.executionScope?.sourceId === 'local/AQ-01/a' && t.mergedAt),
    ).toBe(false);
    expect(decisionItem()).toBeUndefined();
    // The status list agrees: slice b waits on other work first, not on the operator.
    const sliceB = () =>
      state.context.services.roadmapService
        .statusOf(storedRoadmapOf())
        .entries.find((e) => e.sourceId === 'local/AQ-01/b' && e.scope === 'slice');
    expect(sliceB()?.actor).toBe('controller');
    // Once slice a has merged, the decision is all that holds slice b.
    await waitFor(
      () =>
        tx.execution.worktrees
          .listForWorkItem(ws, state.workItemId)
          .some((t) => t.executionScope?.sourceId === 'local/AQ-01/a' && !!t.mergedAt),
      'slice a merged',
      30000,
    );
    await state.context.services.roadmapService.tick();
    const item = decisionItem();
    expect(item).toMatchObject({ code: 'architecture-decision' });
    expect(sliceB()).toMatchObject({
      actor: 'operator',
      waitsOn: { source: 'attention-item', attentionItemId: item!.id },
    });
  },
);
