import {
  type AgentRun,
  type AgentSelections,
  asUserId,
  type CycleProfiles,
  type Roadmap,
  type RoadmapEntry,
  type WorkCycle,
  agentSelections,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import {
  assignedReviewMatches,
  cycleAgentSelection,
  effectiveCycleProfiles,
  entryAgentSelections,
} from '../../src/services/agent-profile-policy.js';

/**
 * Characterization of today's agent selection, place by place (R-E5a, DATA-11): what each
 * daemon place that resolves a selection answers before `resolveAgent` replaces its body. The
 * service-level places (a cycle's launch, an investigation, an integration resolution, the
 * delegated resolution, a decision preparation) are pinned in
 * `server-execution-agent-selection.test.ts`.
 */
const codex = (model: string, permissionMode: 'auto' | 'edit-only' | 'unrestricted' = 'auto') => ({
  backend: 'codex' as const,
  model,
  permissionMode,
});
const profiles: CycleProfiles = {
  design: codex('design', 'unrestricted'),
  implement: codex('implement'),
  review: codex('review', 'edit-only'),
  remediate: codex('remediate'),
  investigation: { backend: 'claude-code', model: 'investigation' },
};
const entry = { id: 'entry', profiles } as unknown as RoadmapEntry;
const other = { id: 'other', profiles } as unknown as RoadmapEntry;
const assigned: AgentSelections = {
  design: { backend: 'claude-code' as const, model: 'a-design' },
  implement: {
    backend: 'claude-code' as const,
    model: 'a-implement',
    reasoningEffort: 'high' as const,
  },
  review: { backend: 'claude-code' as const, model: 'a-review' },
  remediate: { backend: 'claude-code' as const, model: 'a-remediate' },
  security: { backend: 'claude-code' as const, model: 'a-security' },
};
const assignment = (id: string, entryIds: string[], appliedAt: string, selections = assigned) => ({
  id,
  entryIds,
  selections,
  appliedAt,
  appliedByUserId: asUserId('operator'),
});
const roadmapWith = (fields: Partial<Roadmap> = {}) =>
  ({
    id: 'roadmap',
    workspaceId: 'ws',
    status: 'paused',
    definition: { entries: [entry, other] },
    attempts: [{ id: 'attempt', entryId: 'entry', cycleId: 'cycle', status: 'active' }],
    ...fields,
  }) as unknown as Roadmap;
const txOf = (roadmap?: Roadmap) =>
  ({
    roadmaps: {
      list: () => (roadmap ? [roadmap] : []),
      find: (_: string, id: string) => (roadmap?.id === id ? roadmap : undefined),
    },
  }) as unknown as StorageRepositories;
const cycleOf = (fields: Partial<WorkCycle> = {}) =>
  ({ id: 'cycle', workspaceId: 'ws', step: 'implement', profiles, ...fields }) as WorkCycle;

describe('roadmap setup (GET roadmaps/agent-profiles): an entry’s effective selections', () => {
  it('reads the saved definition when no assignment covers the entry', () => {
    expect(entryAgentSelections(roadmapWith(), entry)).toEqual({
      selections: agentSelections(profiles),
      assignment: undefined,
    });
  });
  it('reads the latest assignment covering the entry, whole, instead of the definition', () => {
    const first = assignment('first', ['entry'], '2026-09-20T00:00:00Z');
    const later = assignment('later', ['entry'], '2026-09-21T00:00:00Z', {
      ...assigned,
      implement: { backend: 'claude-code', model: 'later' },
    });
    const unrelated = assignment('unrelated', ['other'], '2026-09-22T00:00:00Z');
    const roadmap = roadmapWith({ agentAssignments: [first, later, unrelated] });
    expect(entryAgentSelections(roadmap, entry)).toEqual({
      selections: later.selections,
      assignment: later,
    });
    // A specialist the assignment leaves out is not taken from the definition.
    expect(entryAgentSelections(roadmap, entry).selections).not.toHaveProperty('investigation');
    expect(entryAgentSelections(roadmap, other).assignment).toBe(unrelated);
  });
});

describe('a cycle’s next launch (cycleAgentSelection)', () => {
  it('a cycle no roadmap owns: its own profile for the step, with the step’s permissions', () => {
    expect(cycleAgentSelection(txOf(), cycleOf({ owner: null }))).toEqual({
      profile: codex('implement'),
      provenance: { purpose: 'implement' },
    });
  });
  it('a specialist inherits its base step’s selection and keeps the step’s permissions', () => {
    const review = cycleOf({
      owner: null,
      step: 'review',
      workflow: { activeReview: { kind: 'security' } },
    } as Partial<WorkCycle>);
    expect(cycleAgentSelection(txOf(), review)).toEqual({
      profile: codex('review', 'edit-only'),
      provenance: { purpose: 'security' },
    });
    // A reassessment is an investigation: its own selection, the review step's permissions.
    expect(
      cycleAgentSelection(txOf(), {
        ...review,
        workflow: { activeReview: { kind: 'reassessment' } },
      } as WorkCycle),
    ).toEqual({
      profile: { backend: 'claude-code', model: 'investigation', permissionMode: 'edit-only' },
      provenance: { purpose: 'investigation' },
    });
  });
  it('a conflict resolution inherits remediation and keeps remediation’s permissions', () => {
    expect(
      cycleAgentSelection(txOf(), cycleOf({ owner: null, step: 'review' }), 'conflict'),
    ).toEqual({ profile: codex('remediate'), provenance: { purpose: 'conflict' } });
  });
  it('a roadmap’s cycle: the latest assignment for the purpose, with the step’s permissions', () => {
    const roadmap = roadmapWith({
      agentAssignments: [assignment('first', ['entry'], '2026-09-20T00:00:00Z')],
    });
    expect(cycleAgentSelection(txOf(roadmap), cycleOf())).toEqual({
      profile: { ...assigned.implement, permissionMode: 'auto' },
      provenance: { purpose: 'implement', assignmentId: 'first' },
    });
    // The assignment's own specialist; one it leaves out inherits within the assignment.
    expect(
      cycleAgentSelection(
        txOf(roadmap),
        cycleOf({
          step: 'review',
          workflow: { activeReview: { kind: 'security' } },
        } as Partial<WorkCycle>),
      ).profile,
    ).toEqual({ ...assigned.security, permissionMode: 'edit-only' });
    expect(
      cycleAgentSelection(
        txOf(roadmap),
        cycleOf({
          step: 'design',
          designRecovery: { mode: 'investigate', runId: 'run' },
        } as Partial<WorkCycle>),
        'investigation',
      ).profile,
    ).toEqual({ ...assigned.design, permissionMode: 'unrestricted' });
  });
  it('a roadmap’s cycle without an assignment: the definition’s profile, with any delegation grant', () => {
    const roadmap = roadmapWith({
      delegationAssignments: [
        {
          id: 'grant',
          entryIds: ['entry'],
          automation: { integrationMerge: 'automatic', integrationConflicts: 'automatic' },
          reviewerRoles: [],
          rationale: 'r',
          appliedAt: '2026-09-20T00:00:00Z',
          appliedByUserId: asUserId('operator'),
        },
      ],
    } as Partial<Roadmap>);
    expect(cycleAgentSelection(txOf(roadmap), cycleOf())).toEqual({
      profile: codex('implement'),
      provenance: { purpose: 'implement', delegationId: 'grant' },
    });
  });
});

describe('a cycle’s future agents (the projection’s nextAgentSelections) and a repair cycle’s profiles', () => {
  it('a cycle no assignment covers: its own profiles, specialists included', () => {
    expect(effectiveCycleProfiles(txOf(), cycleOf({ owner: null }))).toEqual(profiles);
    expect(agentSelections(effectiveCycleProfiles(txOf(), cycleOf({ owner: null })))).toEqual(
      agentSelections(profiles),
    );
  });
  it('an assigned cycle: the assignment’s selections with the cycle’s own permissions', () => {
    const roadmap = roadmapWith({
      agentAssignments: [assignment('first', ['entry'], '2026-09-20T00:00:00Z')],
    });
    expect(effectiveCycleProfiles(txOf(roadmap), cycleOf())).toEqual({
      design: { ...assigned.design, permissionMode: 'unrestricted' },
      implement: { ...assigned.implement, permissionMode: 'auto' },
      review: { ...assigned.review, permissionMode: 'edit-only' },
      remediate: { ...assigned.remediate, permissionMode: 'auto' },
      security: assigned.security,
    });
  });
});

describe('review evidence authorization (assignedReviewMatches)', () => {
  const run = (fields: Partial<AgentRun>) =>
    ({
      backend: 'codex',
      model: 'review',
      permissionMode: 'edit-only',
      createdAt: '2026-09-21T00:00:00Z',
      ...fields,
    }) as AgentRun;
  it('a run without an assignment matches the definition’s selection for its purpose', () => {
    const roadmap = roadmapWith();
    expect(assignedReviewMatches(roadmap, entry, run({}))).toBe(true);
    expect(
      assignedReviewMatches(
        roadmap,
        entry,
        run({
          backend: 'claude-code',
          model: 'investigation',
          profileSelection: { purpose: 'investigation' },
        }),
      ),
    ).toBe(true);
    // Its permissions are the definition's review permissions, whatever the purpose.
    expect(assignedReviewMatches(roadmap, entry, run({ permissionMode: 'auto' }))).toBe(false);
    // Only review purposes are authorized.
    expect(
      assignedReviewMatches(roadmap, entry, run({ profileSelection: { purpose: 'implement' } })),
    ).toBe(false);
  });
});
