import { boundedScopeRecoveryTests } from './scope-recovery-test-support.js';

// Recovery bounded by its round allowance and the lifetime ceiling.
// The outcomes share one scenario, in `scope-recovery-test-support.ts`.
boundedScopeRecoveryTests([
  'exhausted',
  // The allowance counts only since the last passing parent review (LIVE-28).
  'passing-after-exhausted',
  // A review that keeps passing with a fresh minor finding stops at the lifetime ceiling.
  'passing-forever',
]);
