import {
  type AgentRun,
  type Roadmap,
  type RoadmapEntry,
  type WorkCycle,
  agentSelections,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { expect, it } from 'vitest';
import {
  assignedReviewMatches,
  cycleAgentSelection,
} from '../../src/services/agent-profile-policy.js';
const profile = {
  backend: 'codex' as const,
  model: 'old-review',
  permissionMode: 'edit-only' as const,
};
const profiles = { design: profile, implement: profile, review: profile, remediate: profile };
const entry = { id: 'entry', profiles } as RoadmapEntry;
const selections = {
  ...agentSelections(profiles),
  review: { backend: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'high' as const },
  security: { backend: 'codex' as const, model: 'security', reasoningEffort: 'xhigh' as const },
};
const first = {
  id: 'first',
  entryIds: ['entry'],
  selections,
  appliedAt: '2026-09-20T00:00:00Z',
  appliedByUserId: 'operator',
};
const roadmap = {
  definition: { entries: [entry] },
  attempts: [{ entryId: 'entry', cycleId: 'cycle' }],
  agentAssignments: [
    first,
    {
      ...first,
      id: 'second',
      selections: { ...selections, review: { backend: 'codex', model: 'later' } },
      appliedAt: '2026-09-22T00:00:00Z',
    },
  ],
} as unknown as Roadmap;
const run = {
  ...selections.review,
  permissionMode: 'edit-only',
  createdAt: '2026-09-21T00:00:00Z',
  profileSelection: { purpose: 'review', assignmentId: 'first' },
} as AgentRun;
it('preserves accepted review identities when a later assignment changes the selected model', () => {
  expect(assignedReviewMatches(roadmap, entry, run)).toBe(true);
  expect(
    assignedReviewMatches(roadmap, entry, {
      ...run,
      ...profile,
      reasoningEffort: undefined,
      profileSelection: undefined,
    }),
  ).toBe(true);
});
it('rejects unknown, future, wrong-entry and mismatched reviewer authorizations', () => {
  for (const invalid of [
    { ...run, profileSelection: { purpose: 'review', assignmentId: 'absent' } },
    { ...run, profileSelection: { purpose: 'review', assignmentId: 'second' } },
    { ...run, profileSelection: { purpose: 'implement', assignmentId: 'first' } },
    { ...run, model: 'unauthorized' },
    { ...run, reasoningEffort: 'low' },
    { ...run, permissionMode: 'unrestricted' },
  ] as AgentRun[])
    expect(assignedReviewMatches(roadmap, entry, invalid)).toBe(false);
  expect(assignedReviewMatches(roadmap, { ...entry, id: 'other' }, run)).toBe(false);
});
it('dispatches a specialist with the original review permissions and launch provenance', () => {
  const tx = { roadmaps: { list: () => [roadmap] } } as unknown as StorageRepositories;
  const cycle = {
    id: 'cycle',
    profiles: { ...profiles, design: { ...profile, permissionMode: 'unrestricted' } },
    step: 'review',
    workflow: { activeReview: { kind: 'security' } },
  } as WorkCycle;
  expect(cycleAgentSelection(tx, cycle)).toEqual({
    profile: { ...selections.security, permissionMode: 'edit-only' },
    provenance: { purpose: 'security', assignmentId: 'second' },
  });
  expect(
    cycleAgentSelection(tx, {
      ...cycle,
      workflow: { activeReview: { kind: 'reassessment' } },
    } as WorkCycle).profile.permissionMode,
  ).toBe('edit-only');
});
