import { afterEach } from 'vitest';
import { cleanupExecutionFixtures, itNeedsCargo } from './execution-test-support.js';
import { boundedScopeRecovery } from './scope-recovery-test-support.js';

// Findings that stay the operator's: questions, and owners recovery cannot name.
// The outcomes share one scenario, in `scope-recovery-test-support.ts`.

afterEach(cleanupExecutionFixtures);

itNeedsCargo.each([
  'questions',
  'ambiguous',
  // Open findings that name different slices stay the operator's to route.
  'split-owners',
  // One finding names its owner and another names none: still the operator's.
  'partly-named',
] as const)('bounded roadmap scope recovery: %s', async (outcome) => {
  await boundedScopeRecovery(outcome);
});
