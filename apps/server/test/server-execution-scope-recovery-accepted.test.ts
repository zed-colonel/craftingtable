import { boundedScopeRecoveryTests } from './scope-recovery-test-support.js';

// Recovery rounds that the parent review accepts.
// The outcomes share one scenario, in `scope-recovery-test-support.ts`.
boundedScopeRecoveryTests([
  'accepted',
  'accepted-after-pause',
  // Two required slices, and the parent review names the one that owns the finding (LIVE-27).
  'accepted-named-owner',
]);
