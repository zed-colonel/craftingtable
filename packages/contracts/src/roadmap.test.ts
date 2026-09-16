import { CYCLE_STEPS, DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { saveRoadmapRequestSchema } from './roadmap.js';
import { expect, it } from 'vitest';
import { roadmapSchedulingSchema, controlRoadmapRequestSchema } from './roadmap.js';
it('bounds parallel capacity and refresh budgets without adding merge authority', () => {
  const valid = {
    mode: 'parallel',
    maxInFlight: 2,
    maxPerRepository: 2,
    maxIntegrationRefreshes: 3,
  };
  expect(roadmapSchedulingSchema.safeParse(valid).success).toBe(true);
  for (const invalid of [
    { maxInFlight: 0 },
    { maxInFlight: 1.5 },
    { maxPerRepository: 17 },
    { maxIntegrationRefreshes: 0 },
    { maxIntegrationRefreshes: 21 },
    { automaticMerge: true },
  ])
    expect(roadmapSchedulingSchema.safeParse({ ...valid, ...invalid }).success).toBe(false);
  expect(
    controlRoadmapRequestSchema.safeParse({ action: 'merge', expectedVersion: 1 }).success,
  ).toBe(false);
});

it('allows distinct sibling slices but rejects duplicate scopes, mixed parents and review-only entries', () => {
  const scope = {
    kind: 'slice',
    definitionId: '00000000-0000-4000-8000-000000000001',
    bindingRevision: 1,
    sourceId: 'WI-02/domain',
  };
  const entry = {
    id: '00000000-0000-4000-8000-000000000002',
    workItemId: 'item-1',
    profiles: Object.fromEntries(
      CYCLE_STEPS.map((step) => [step, { backend: 'claude-code', permissionMode: 'auto' }]),
    ),
    policy: DEFAULT_COMPLETION_POLICY,
    instructions: '',
    executionScope: scope,
  };
  const sibling = {
    ...entry,
    id: '00000000-0000-4000-8000-000000000003',
    executionScope: { ...scope, sourceId: 'WI-02/integration' },
  };
  const request = { expectedVersion: 0, name: 'Slices', entries: [entry, sibling] };
  expect(saveRoadmapRequestSchema.safeParse(request).success).toBe(true);
  for (const second of [
    { ...sibling, executionScope: scope },
    { ...sibling, executionScope: undefined },
    { ...sibling, executionScope: { ...sibling.executionScope, bindingRevision: 2 } },
    { ...sibling, executionScope: { ...sibling.executionScope, kind: 'parent-acceptance' } },
  ])
    expect(
      saveRoadmapRequestSchema.safeParse({ ...request, entries: [entry, second] }).success,
    ).toBe(false);
});
