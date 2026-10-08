import type { Finalization, Roadmap, RoadmapEntry, WorkCycle } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { resolveAgent } from '../../src/services/agent-resolution.js';
import type { StorageRepositories } from '@craftingtable/storage';
import {
  assignedReviewMatches,
  finalizationAgents,
  launchProvenance,
  operatorResolutionProfile,
  preparationAgent,
} from '../../src/services/agent-profile-policy.js';

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

describe('an integration resolution the operator starts (operator decision 2026-10-07)', () => {
  const profiles = {
    design: stage('design'),
    implement: stage('implement'),
    review: stage('review'),
    remediate: { ...stage('remediate'), permissionMode: 'auto' as const },
  };
  const conflict = { backend: 'claude-code' as const, model: 'conflict' };
  const assigned = {
    id: 'assignment',
    entryIds: ['entry'],
    selections: {
      ...profiles,
      remediate: { backend: 'claude-code' as const, model: 'a-remediate' },
    },
    appliedAt: '2026-10-01T00:00:00Z',
    appliedByUserId: 'operator',
  };
  const roadmap = {
    id: 'roadmap',
    attempts: [{ id: 'attempt', entryId: 'entry', cycleId: 'cycle', status: 'active' }],
    agentAssignments: [assigned],
  } as unknown as Roadmap;
  const tx = (owned: boolean) =>
    ({
      roadmaps: {
        list: () => (owned ? [roadmap] : []),
        find: () => (owned ? roadmap : undefined),
      },
    }) as unknown as StorageRepositories;
  const of = (fields: Partial<WorkCycle['profiles']> = {}) =>
    ({
      id: 'cycle',
      workspaceId: 'ws',
      step: 'review',
      profiles: { ...profiles, ...fields },
    }) as WorkCycle;
  it.each([
    ['the cycle’s remediation profile, with no specialist', false, {}, 'remediate'],
    ['the cycle’s conflict specialist over remediation', false, { conflict }, 'conflict'],
    ['the latest assignment over the specialist', true, { conflict }, 'a-remediate'],
  ] as const)('without a choice: %s, with remediation’s permissions', (_, owned, fields, model) => {
    expect(operatorResolutionProfile(tx(owned), of(fields), undefined)).toMatchObject({
      model,
      permissionMode: 'auto',
    });
  });
  it('the operator’s choice, then on resume the recorded profile, beat every layer', () => {
    const chosen = { ...stage('chosen'), permissionMode: 'unrestricted' as const };
    const recorded = stage('recorded');
    expect(operatorResolutionProfile(tx(true), of({ conflict }), chosen, recorded)).toEqual(chosen);
    expect(operatorResolutionProfile(tx(true), of({ conflict }), undefined, recorded)).toEqual(
      recorded,
    );
  });
});

describe('which launches name the assignment (operator decision 2026-10-07)', () => {
  const same = { backend: 'claude-code' as const, model: 'same' };
  const profiles = {
    design: stage('design'),
    implement: stage('implement'),
    review: stage('review'),
    remediate: stage('remediate'),
  };
  const base = {
    purpose: 'review' as const,
    permissionMode: 'edit-only' as const,
    assignment: { id: 'assignment', selections: { ...profiles, review: same } },
    profiles: { layer: 'saved-definition' as const, value: profiles },
  };
  const recorded = { purpose: 'review' as const, delegationId: 'grant' };
  it('a launch the assignment chose names it, a service retry it outranks included', () => {
    for (const context of [base, { ...base, serviceRetry: { ...stage('retry') } }])
      expect(launchProvenance(recorded, resolveAgent(context))).toEqual({
        purpose: 'review',
        delegationId: 'grant',
        assignmentId: 'assignment',
      });
  });
  it.each([
    ['a resumed session', { resumed: { ...same, permissionMode: 'edit-only' as const } }],
    [
      'a design-question recovery',
      { action: { layer: 'design-recovery' as const, selection: same } },
    ],
    [
      'a finalization stage',
      {
        finalization: {
          stage: { ...same, permissionMode: 'edit-only' as const },
          slot: 'review' as const,
          stageIndex: 0,
        },
      },
    ],
    [
      'a finalization recovery',
      { finalization: { stage: stage('stage'), slot: 'review' as const, recovery: same } },
    ],
    [
      'an integration resolution',
      { integrationResolution: { ...same, permissionMode: 'edit-only' as const } },
    ],
  ])('an equal selection %s chose does not', (_, layer) => {
    const launch = resolveAgent({ ...base, ...layer });
    expect(launch.selection).toEqual(same);
    expect(launchProvenance(recorded, launch)).toEqual({
      purpose: 'review',
      delegationId: 'grant',
    });
  });
  it('a review run that does not name the assignment is held to the saved definition', () => {
    const entry = { id: 'entry', profiles } as unknown as RoadmapEntry;
    const roadmap = {
      agentAssignments: [
        {
          id: 'assignment',
          entryIds: ['entry'],
          selections: base.assignment.selections,
          appliedAt: '2026-10-01T00:00:00Z',
        },
      ],
    } as unknown as Roadmap;
    const run = { ...same, permissionMode: 'edit-only', createdAt: '2026-10-02T00:00:00Z' };
    expect(
      assignedReviewMatches(roadmap, entry, {
        ...run,
        profileSelection: { purpose: 'review', assignmentId: 'assignment' },
      } as never),
    ).toBe(true);
    expect(
      assignedReviewMatches(roadmap, entry, {
        ...run,
        profileSelection: { purpose: 'review' },
      } as never),
    ).toBe(false);
  });
});
