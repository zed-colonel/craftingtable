import { expect, it } from 'vitest';
import type { AgentRun, Roadmap, RoadmapEntry, RoadmapDefinition } from '@craftingtable/domain';
import {
  effectiveDelegation,
  historicalReviewerRoles,
} from '../../src/services/roadmap-delegation-policy.js';
const entry = { id: 'entry', reviewerRoles: ['original'] } as unknown as RoadmapEntry;
const definition = {
  automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
} as RoadmapDefinition;
const roadmap = {
  delegationAssignments: [
    {
      id: 'grant',
      entryIds: ['entry'],
      appliedAt: '2026-09-22T10:00:00Z',
      reviewerRoles: ['profile-owner'],
      automation: { integrationMerge: 'automatic', integrationConflicts: 'automatic' },
    },
    {
      id: 'revoke',
      entryIds: ['entry'],
      appliedAt: '2026-09-22T12:00:00Z',
      reviewerRoles: [],
      automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
    },
  ],
} as unknown as Roadmap;
it('keeps original or explicitly granted review authority despite later grants, revocation and equal timestamps', () => {
  const legacy = { createdAt: '2026-09-22T10:00:00Z' } as AgentRun;
  const granted = {
    ...legacy,
    profileSelection: { purpose: 'checkpoint', delegationId: 'grant' },
  } as AgentRun;
  expect(historicalReviewerRoles(roadmap, entry, legacy)).toEqual(['original']);
  expect(historicalReviewerRoles(roadmap, entry, granted)).toEqual(['profile-owner']);
  expect(effectiveDelegation(roadmap, entry, definition).reviewerRoles).toEqual([]);
  expect(historicalReviewerRoles(roadmap, { ...entry, id: 'other' }, granted)).toEqual([]);
  expect(
    historicalReviewerRoles(roadmap, entry, { ...granted, createdAt: '2026-09-22T09:00:00Z' }),
  ).toEqual([]);
});
