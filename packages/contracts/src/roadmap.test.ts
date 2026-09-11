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
