import { expect, it } from 'vitest';
import { reviewFindingSchema } from './review.js';

const finding = {
  id: 'F-1',
  severity: 'major',
  status: 'open',
  title: 'Defect',
  explanation: 'Why',
  recommendation: 'Fix',
};

it("reads a finding's named owner by the map's slice-ID rule, and null as not named (LIVE-27 review)", () => {
  expect(
    reviewFindingSchema.safeParse({ ...finding, owningSlice: 'wi/WI-03/integration' }).success,
  ).toBe(true);
  expect(reviewFindingSchema.safeParse({ ...finding, owningSlice: null }).success).toBe(true);
  expect(reviewFindingSchema.safeParse({ ...finding, owningSlice: '../elsewhere' }).success).toBe(
    false,
  );
});
