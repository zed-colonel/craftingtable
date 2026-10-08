import type { Finalization, Roadmap, RoadmapEntry, WorkCycle } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { finalizationAgents, preparationAgent } from '../../src/services/agent-profile-policy.js';

/**
 * R-E5a: the sources the daemon reports. A finalization's stage profiles are per-action overrides
 * with what they replace (E5-3); a decision preparation's choice is its own layer.
 */
const stage = (model: string) => ({
  backend: 'codex' as const,
  model,
  permissionMode: 'edit-only' as const,
});
const value = {
  finalReview: stage('final'),
  stages: [
    { id: 'one', review: stage('one-review'), implement: stage('one-implement') },
    { id: 'two', review: stage('two-review'), implement: stage('two-implement') },
  ],
} as unknown as Finalization;
const workspace = {
  profiles: [
    {
      role: 'implement' as const,
      backend: 'claude-code' as const,
      model: 'w-implement',
      permissionMode: 'auto' as const,
    },
  ],
  fallback: { backend: 'claude-code' as const, permissionMode: 'auto' as const },
};
const cycle = (fields: Partial<WorkCycle>) =>
  ({ step: 'remediate', finalizationProgress: { stageIndex: 1 }, ...fields }) as WorkCycle;

it('a stage’s profile overrides the workspace default it replaced', () => {
  const agents = finalizationAgents(value, cycle({}), workspace);
  expect(agents.current).toEqual({
    selection: { backend: 'codex', model: 'two-implement' },
    source: { layer: 'finalization-stage', slot: 'implement', stageIndex: 1 },
    permissionMode: 'edit-only',
    inherited: {
      selection: { backend: 'claude-code', model: 'w-implement' },
      source: { layer: 'workspace-default', slot: 'implement' },
    },
  });
  expect(
    agents.stages.map((s) => [s.id, s.review.selection.model, s.review.inherited?.source]),
  ).toEqual([
    ['one', 'one-review', { layer: 'daemon-default' }],
    ['two', 'two-review', { layer: 'daemon-default' }],
  ]);
});
it('a recovery’s agent overrides the stage, with the stage’s permissions (ADR-040)', () => {
  expect(
    finalizationAgents(
      value,
      cycle({
        step: 'review',
        finalizationAgentOverride: { backend: 'claude-code', model: 'switched' },
      }),
      workspace,
    ).current,
  ).toEqual({
    selection: { backend: 'claude-code', model: 'switched' },
    source: { layer: 'finalization-recovery', slot: 'review', stageIndex: 1 },
    permissionMode: 'edit-only',
    inherited: {
      selection: { backend: 'codex', model: 'two-review' },
      source: { layer: 'finalization-stage', slot: 'review', stageIndex: 1 },
    },
  });
});
it('without a cycle, the final reviewer', () => {
  expect(finalizationAgents(value, undefined, workspace).current.selection.model).toBe('final');
});

it('a decision preparation: the operator’s choice over the entry’s investigation selection, read-only', () => {
  const entry = {
    id: 'entry',
    profiles: {
      design: stage('design'),
      implement: stage('implement'),
      review: stage('review'),
      remediate: stage('remediate'),
    },
  } as unknown as RoadmapEntry;
  const roadmap = { definition: { entries: [entry] } } as unknown as Roadmap;
  expect(preparationAgent(roadmap, entry, { backend: 'claude-code', model: 'chosen' })).toEqual({
    selection: { backend: 'claude-code', model: 'chosen' },
    source: { layer: 'decision-preparation' },
    permissionMode: 'edit-only',
    inherited: {
      selection: { backend: 'codex', model: 'design' },
      source: { layer: 'saved-definition', slot: 'design' },
    },
  });
  expect(preparationAgent(roadmap, entry).source).toEqual({
    layer: 'saved-definition',
    slot: 'design',
  });
});
