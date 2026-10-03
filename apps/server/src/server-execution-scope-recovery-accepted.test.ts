import { afterEach } from 'vitest';
import { cleanupExecutionFixtures, itNeedsCargo } from './execution-test-support.js';
import { boundedScopeRecovery } from './scope-recovery-test-support.js';

// Recovery rounds that the parent review accepts.
// The outcomes share one scenario, in `scope-recovery-test-support.ts`.

afterEach(cleanupExecutionFixtures);

itNeedsCargo.each([
  'accepted',
  'accepted-after-pause',
  // Two required slices, and the parent review names the one that owns the finding (LIVE-27).
  'accepted-named-owner',
] as const)('bounded roadmap scope recovery: %s', async (outcome) => {
  await boundedScopeRecovery(outcome);
});
