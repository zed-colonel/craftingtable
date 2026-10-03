import { afterEach } from 'vitest';
import { cleanupExecutionFixtures, itNeedsCargo } from './execution-test-support.js';
import { boundedScopeRecovery } from './scope-recovery-test-support.js';

// Recovery that stops because its rounds stop making progress.
// The outcomes share one scenario, in `scope-recovery-test-support.ts`.

afterEach(cleanupExecutionFixtures);

itNeedsCargo.each(['unchanged', 'stalled'] as const)(
  'bounded roadmap scope recovery: %s',
  async (outcome) => {
    await boundedScopeRecovery(outcome);
  },
);
