import type { Finalization, Roadmap, RoadmapEntry, WorkCycle } from '@craftingtable/domain';
import { asAgentAssignmentId, asDelegationAssignmentId } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { resolveAgent } from '../../src/services/agent-resolution.js';
import type { StorageRepositories } from '@craftingtable/storage';
import {
  assignedReviewMatches,
  cycleAgents,
  cycleLaunchRecord,
  entryAgents,
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
    assignment: {
      id: asAgentAssignmentId('assignment'),
      selections: { ...profiles, review: same },
    },
    profiles: { layer: 'saved-definition' as const, value: profiles },
  };
  const recorded = { purpose: 'review' as const, delegationId: asDelegationAssignmentId('grant') };
  it('a launch the assignment chose names it, a service retry it outranks included', () => {
    for (const context of [base, { ...base, serviceRetry: { ...stage('retry') } }])
      expect(launchProvenance(recorded, resolveAgent(context))).toEqual({
        purpose: 'review',
        delegationId: 'grant',
        assignmentId: 'assignment',
      });
  });
  it.each([
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
  // Operator decisions 2026-10-07: a resumed session (an output repair, a restart resume) keeps
  // the attribution of the run it continues, while that assignment is still the entry's latest.
  it('a resumed session names the assignment exactly when the run it continues did', () => {
    const launch = resolveAgent({ ...base, resumed: { ...same, permissionMode: 'edit-only' } });
    expect(launch.source.layer).toBe('resumed-session');
    const current = { ...recorded, latestAssignmentId: asAgentAssignmentId('earlier') };
    expect(
      launchProvenance(current, launch, {
        purpose: 'review',
        assignmentId: asAgentAssignmentId('earlier'),
      }),
    ).toEqual({ purpose: 'review', delegationId: 'grant', assignmentId: 'earlier' });
    // Once a newer assignment replaced it, the resume names none and is held to the definition.
    expect(
      launchProvenance({ ...recorded, latestAssignmentId: asAgentAssignmentId('later') }, launch, {
        purpose: 'review',
        assignmentId: asAgentAssignmentId('earlier'),
      }),
    ).toEqual({ purpose: 'review', delegationId: 'grant' });
    expect(
      launchProvenance(recorded, launch, {
        purpose: 'review',
        assignmentId: asAgentAssignmentId('earlier'),
      }),
    ).toEqual({ purpose: 'review', delegationId: 'grant' });
    expect(launchProvenance(recorded, launch, { purpose: 'review' })).toEqual({
      purpose: 'review',
      delegationId: 'grant',
    });
    expect(launchProvenance(recorded, launch)).toEqual({
      purpose: 'review',
      delegationId: 'grant',
    });
    // Only a resume inherits: another layer's launch ignores the run before it.
    const recovery = resolveAgent({
      ...base,
      action: { layer: 'design-recovery', selection: same },
    });
    expect(
      launchProvenance(
        { ...recorded, latestAssignmentId: asAgentAssignmentId('earlier') },
        recovery,
        {
          purpose: 'review',
          assignmentId: asAgentAssignmentId('earlier'),
        },
      ),
    ).toEqual({ purpose: 'review', delegationId: 'grant' });
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

describe('the R-E5a review’s gaps', () => {
  const profiles = {
    design: stage('design'),
    implement: { ...stage('implement'), permissionMode: 'auto' as const },
    review: stage('review'),
    remediate: { ...stage('remediate'), permissionMode: 'auto' as const },
  };
  const entry = { id: 'entry', profiles } as unknown as RoadmapEntry;
  const assignment = {
    id: 'assignment',
    entryIds: ['entry'],
    selections: {
      design: { backend: 'claude-code' as const, model: 'a-design' },
      implement: { backend: 'claude-code' as const, model: 'a-implement' },
      review: { backend: 'claude-code' as const, model: 'a-review' },
      remediate: { backend: 'claude-code' as const, model: 'a-remediate' },
    },
    appliedAt: '2026-10-01T00:00:00Z',
  };
  const grant = (integrationConflicts: 'manual' | 'automatic') => ({
    id: 'grant',
    entryIds: ['entry'],
    automation: {
      integrationMerge: 'automatic',
      integrationConflicts,
      resolutionProfile: { ...stage('delegated'), permissionMode: 'auto' as const },
    },
    reviewerRoles: [],
  });
  const roadmapOf = (fields: Record<string, unknown> = {}) =>
    ({
      id: 'roadmap',
      definition: { entries: [entry] },
      attempts: [{ id: 'attempt', entryId: 'entry', cycleId: 'cycle', status: 'active' }],
      ...fields,
    }) as unknown as Roadmap;
  const txOf = (roadmap?: Roadmap) =>
    ({
      roadmaps: {
        list: () => (roadmap ? [roadmap] : []),
        find: () => roadmap,
        definition: () => roadmap?.definition,
      },
    }) as unknown as StorageRepositories;
  const cycle = (fields: Partial<WorkCycle> = {}) =>
    ({ id: 'cycle', workspaceId: 'ws', step: 'implement', profiles, ...fields }) as WorkCycle;

  it('MEDIUM-2: the reported conflict agent is the delegation’s when conflicts are automatic', () => {
    const delegated = {
      selection: { backend: 'codex', model: 'delegated' },
      source: { layer: 'roadmap-delegation', delegationId: 'grant' },
      permissionMode: 'auto',
    };
    const granted = roadmapOf({ delegationAssignments: [grant('automatic')] });
    expect(entryAgents(granted, entry).conflict).toMatchObject(delegated);
    expect(cycleAgents(txOf(granted), cycle()).conflict).toMatchObject(delegated);
    // The saved definition's own automation, without a grant, has its own label.
    const saved = roadmapOf({
      definition: {
        entries: [entry],
        automation: grant('automatic').automation,
      },
    });
    expect(entryAgents(saved, entry).conflict.source).toEqual({ layer: 'roadmap-automation' });
    // Manual conflicts launch nothing delegated; a specialist comes first. An assignment's
    // inherited remediation does not displace the delegation (R-C17 part 4 increment 3 review
    // HIGH-1, ADR-064 amended 2026-10-18).
    expect(
      entryAgents(roadmapOf({ delegationAssignments: [grant('manual')] }), entry).conflict.source,
    ).toEqual({ layer: 'saved-definition', slot: 'remediate' });
    expect(
      entryAgents(
        roadmapOf({ delegationAssignments: [grant('automatic')], agentAssignments: [assignment] }),
        entry,
      ).conflict.source,
    ).toMatchObject({ layer: 'roadmap-delegation', delegationId: 'grant' });
    // The selection set (nextAgentSelections, a repair's profiles) is unchanged by it.
    expect(cycleAgents(txOf(granted), cycle()).remediate.source.layer).toBe('saved-definition');
  });
  it('LOW-6: the projection reads the delegation of the revision its attempt started under', () => {
    const automation = (model: string) => ({
      integrationMerge: 'automatic' as const,
      integrationConflicts: 'automatic' as const,
      resolutionProfile: { ...stage(model), permissionMode: 'auto' as const },
    });
    const started = { revision: 1, entries: [entry], automation: automation('attempt-revision') };
    const roadmap = roadmapOf({
      definition: { revision: 2, entries: [entry], automation: automation('current-revision') },
      attempts: [
        {
          id: 'attempt',
          entryId: 'entry',
          cycleId: 'cycle',
          status: 'active',
          definitionRevision: 1,
        },
      ],
    });
    const tx = {
      roadmaps: {
        list: () => [roadmap],
        find: () => roadmap,
        definition: (_: string, __: string, revision: number) =>
          revision === 1 ? started : undefined,
      },
    } as unknown as StorageRepositories;
    expect(cycleAgents(tx, cycle()).conflict).toMatchObject({
      selection: { backend: 'codex', model: 'attempt-revision' },
      source: { layer: 'roadmap-automation' },
    });
  });
  it('LOW-2: a launch record carries no attribution of its own', () => {
    const record = cycleLaunchRecord(
      txOf(roadmapOf({ agentAssignments: [assignment], delegationAssignments: [grant('manual')] })),
      cycle(),
    );
    expect(record).toEqual({
      purpose: 'implement',
      delegationId: 'grant',
      latestAssignmentId: 'assignment',
    });
    expect(record).not.toHaveProperty('assignmentId');
  });
  it('LOW-3: a roadmap’s cycle reads its saved definition, one started on its own its start, and an assigned cycle runs with its steps’ permissions', () => {
    expect(cycleAgents(txOf(roadmapOf()), cycle()).implement.source).toEqual({
      layer: 'saved-definition',
      slot: 'implement',
    });
    expect(cycleAgents(txOf(), cycle({ owner: null })).implement.source).toEqual({
      layer: 'cycle-start',
      slot: 'implement',
    });
    const assigned = cycleAgents(txOf(roadmapOf({ agentAssignments: [assignment] })), cycle());
    expect(
      Object.fromEntries(
        (['design', 'implement', 'review', 'remediate', 'security'] as const).map((p) => [
          p,
          assigned[p].permissionMode,
        ]),
      ),
    ).toEqual({
      design: 'edit-only',
      implement: 'auto',
      review: 'edit-only',
      remediate: 'auto',
      security: 'edit-only',
    });
  });
  it('LOW-4: a run names an assignment only if it was applied by then and covers its entry', () => {
    const run = (assignmentId: string, createdAt: string) =>
      ({
        backend: 'claude-code',
        model: 'a-review',
        permissionMode: 'edit-only',
        createdAt,
        profileSelection: { purpose: 'review', assignmentId },
      }) as never;
    const other = { ...assignment, id: 'other', entryIds: ['elsewhere'] };
    const roadmap = roadmapOf({ agentAssignments: [assignment, other] });
    expect(assignedReviewMatches(roadmap, entry, run('assignment', '2026-10-02T00:00:00Z'))).toBe(
      true,
    );
    // Applied after the run started.
    expect(assignedReviewMatches(roadmap, entry, run('assignment', '2026-09-30T00:00:00Z'))).toBe(
      false,
    );
    // Unknown, or another entry's: refused, even though the definition would match.
    const definitionRun = (assignmentId: string) =>
      ({
        ...stage('review'),
        createdAt: '2026-10-02T00:00:00Z',
        profileSelection: { purpose: 'review', assignmentId },
      }) as never;
    expect(assignedReviewMatches(roadmap, entry, definitionRun('unknown'))).toBe(false);
    expect(assignedReviewMatches(roadmap, entry, definitionRun('other'))).toBe(false);
    expect(
      assignedReviewMatches(roadmap, entry, {
        ...stage('review'),
        createdAt: '2026-10-02T00:00:00Z',
      } as never),
    ).toBe(true);
  });
});
