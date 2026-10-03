import { afterEach } from 'vitest';
import { cleanupExecutionFixtures, itNeedsCargo } from './execution-test-support.js';
import { boundedScopeRecovery } from './scope-recovery-test-support.js';

// Recovery bounded by its round allowance and the lifetime ceiling.
// The outcomes share one scenario, in `scope-recovery-test-support.ts`.

afterEach(cleanupExecutionFixtures);

itNeedsCargo.each([
  'exhausted',
  // The allowance counts only since the last passing parent review (LIVE-28).
  'passing-after-exhausted',
  // A review that keeps passing with a fresh minor finding stops at the lifetime ceiling.
  'passing-forever',
] as const)('bounded roadmap scope recovery: %s', async (outcome) => {
  await boundedScopeRecovery(outcome);
});
