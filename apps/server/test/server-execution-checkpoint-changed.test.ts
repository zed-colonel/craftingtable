import type { WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, vi } from 'vitest';
import { subjectRequirements as requireSubjectRequirements } from '../src/services/runtime-evidence-policy.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  itNeedsCargo,
  roadmapControl,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

/**
 * A delegated checkpoint whose assignment or prerequisites change while its review runs (R-B4
 * increment 4 re-check, NEW-LOW-2). The review can no longer attest, so it is dropped and the
 * checkpoint's obligation decides as for one never reviewed: a stop naming the obligation, or a
 * wait, and a fresh review by itself once the checkpoint is ready again. A stop on the review
 * itself would offer exits that rerun it at once, before anything was fixed.
 */

const changed = vi.hoisted(() => ({
  checkpoint: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../src/services/workflow-policy.js', async (original) => {
  const actual = await original<typeof import('../src/services/workflow-policy.js')>();
  return {
    ...actual,
    workflowContext: (...args: Parameters<typeof actual.workflowContext>) => {
      const value = actual.workflowContext(...args);
      return value && changed.checkpoint
        ? {
            ...value,
            checkpoints: value.checkpoints.map((c) =>
              c.id === 'LOCAL-REVIEW' ? { ...c, ...changed.checkpoint } : c,
            ),
          }
        : value;
    },
  };
});

afterEach(async () => {
  changed.checkpoint = undefined;
  await cleanupExecutionFixtures();
});

async function checkpointRoadmap(change: Record<string, unknown>) {
  const f = await supervisedMapFixture(true, 'automatic', false, false, false, (source) => ({
    ...source,
    checkpoints: [
      ...source.checkpoints,
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-REVIEW',
        kind: 'contract' as const,
        owner: 'local',
        requires: [],
        pass_criteria: ['Candidate boundary is sound'],
        evidence_profile: 'scope-review',
      },
    ],
    slices: source.slices.map((s, i) =>
      i
        ? s
        : {
            ...s,
            mode: 'domain',
            merge_requires: [
              { kind: 'checkpoint' as const, id: 'LOCAL-REVIEW', state: 'passed' as const },
            ],
          },
    ),
  }));
  const original = f.backend.replyForRequest!;
  const reviews = { checkpoint: 0 };
  f.backend.replyForRequest = async (request) => {
    const reply = await original(request);
    if (request.model !== 'review-model') return reply;
    const checkpoint = request.prompt.includes('This is a separate checkpoint review.');
    const report = (options: Record<string, unknown>) =>
      '```craftingtable-workflow\n' +
      JSON.stringify({
        version: 1,
        questions: [],
        resolved: [],
        securityReview: { required: false, sources: [] },
        ...options,
      }) +
      '\n```\n' +
      reply.resultText!;
    if (!checkpoint) return { ...reply, resultText: report({}) };
    // The roadmap changes while the first checkpoint review runs.
    if (++reviews.checkpoint === 1) changed.checkpoint = change;
    const def = f.state.context.storage.imports.definition(
      f.state.workspaceId,
      f.parentScope.definitionId,
    )!;
    const spec = requireSubjectRequirements(
      def,
      { kind: 'checkpoint', sourceId: 'LOCAL-REVIEW' },
      f.scopes[0]!.sourceId,
    );
    return {
      ...reply,
      resultText: report({
        checkpoint: {
          id: 'LOCAL-REVIEW',
          passed: true,
          requirements: spec.requirements.map((requirement) => ({
            requirement,
            evidence: 'Independent exact-candidate check and fixture receipts',
          })),
          caseIds: spec.cases.map((c) => c.id),
        },
      }),
    };
  };
  await adoptSupervisedMap(f);
  f.service.save(f.auth, f.state.workspaceId, f.input);
  await roadmapControl(f.state, 'start');
  const reviewed = () =>
    f.state.context.storage.execution.cycles
      .listForWorkspace(f.state.workspaceId)
      .find((c) => c.workflow && c.executionScope?.sourceId === f.scopes[0]!.sourceId);
  const debug = () =>
    f.state.context.storage.execution.cycles.listForWorkspace(f.state.workspaceId).map((c) => ({
      scope: c.executionScope?.sourceId,
      status: c.status,
      step: c.step,
      code: c.attention?.code,
      reason: c.reason?.slice(0, 160),
      active: c.workflow?.activeReview?.kind,
    }));
  return { f, reviews, reviewed, debug };
}

const dropped = (cycle: WorkCycle | undefined) =>
  !!cycle?.workflow && cycle.workflow.activeReview == null;

itNeedsCargo(
  'a checkpoint unassigned while its review ran stops on its obligation, with the review dropped',
  async () => {
    const { reviews, reviewed, debug } = await checkpointRoadmap({ assigned: false });
    await waitFor(() => reviewed()?.status === 'needs-attention', 'the obligation stop').catch(
      (e) => {
        throw new Error(`${e.message}: ${reviews.checkpoint} ${JSON.stringify(debug())}`);
      },
    );
    expect(reviews.checkpoint).toBe(1);
    expect(reviewed()).toMatchObject({
      attention: { code: 'workflow-obligation', refs: { checkpointId: 'LOCAL-REVIEW' } },
      reason: expect.stringContaining(
        'Saved reviewer responsibilities do not authorize this checkpoint review.',
      ),
    });
    expect(dropped(reviewed())).toBe(true);
  },
);

itNeedsCargo(
  'a checkpoint whose prerequisite went pending while its review ran waits, and is reviewed again once ready',
  async () => {
    const { f, reviews, reviewed } = await checkpointRoadmap({
      pending: ['LOCAL-ADR-01 is not accepted.'],
    });
    await waitFor(
      () =>
        reviews.checkpoint === 1 &&
        dropped(reviewed()) &&
        reviewed()?.attention?.code === 'controller-wait',
      'the prerequisite wait',
    );
    expect(reviewed()).toMatchObject({
      status: 'awaiting-merge',
      reason: 'LOCAL-REVIEW: LOCAL-ADR-01 is not accepted.',
    });
    changed.checkpoint = undefined;
    await waitFor(() => reviewed()?.status === 'completed', 'a fresh review and the merge');
    expect(reviews.checkpoint).toBe(2);
    expect(
      f.state.context.storage.runtimeEvidence
        .submissions(f.state.workspaceId, f.parentScope.definitionId)
        .some((s) => s.subject.sourceId === 'LOCAL-REVIEW'),
    ).toBe(true);
  },
);
