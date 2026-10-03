import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The project's one test timeout in milliseconds, scaled (vitest.config.ts, R-I2). */
    testTimeoutMs: number;
    /** `CRAFTINGTABLE_TEST_TIMEOUT_SCALE`, 1 when unset. */
    testTimeScale: number;
  }
}

/**
 * How long a `findBy…`, `waitFor` or `vi.waitFor` waits for the page (R-I2, TS-H1): 15 s ×
 * the suite's time scale, under the web project's test timeout. Such a wait returns as soon as
 * its condition holds, so a generous bound costs nothing when the test passes; the 1 s defaults
 * failed under load.
 */
export function asyncWaitMs(): number {
  return Math.min(15_000 * inject('testTimeScale'), inject('testTimeoutMs') / 2);
}
