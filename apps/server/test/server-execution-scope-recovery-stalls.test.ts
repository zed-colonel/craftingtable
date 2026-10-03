import { boundedScopeRecoveryTests } from './scope-recovery-test-support.js';

// Recovery that stops because its rounds stop making progress.
// The outcomes share one scenario, in `scope-recovery-test-support.ts`.
boundedScopeRecoveryTests(['unchanged', 'stalled']);
