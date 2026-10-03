import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The project's one test timeout in milliseconds, scaled (vitest.config.ts, R-I2). */
    testTimeoutMs: number;
    /** `CRAFTINGTABLE_TEST_TIMEOUT_SCALE`, 1 when unset. */
    testTimeScale: number;
  }
}

/** The suite's time scale, for the few genuine time bounds a test keeps (R-I2). */
export function testTimeScale(): number {
  const scale = inject('testTimeScale');
  if (typeof scale !== 'number') throw new Error('vitest.config.ts provides no testTimeScale');
  return scale;
}

/**
 * Fails with the label if the promise is still pending at the hang guard, half the scaled test
 * timeout (R-I2): a wait that should never block reports what blocked, before the test itself
 * is timed out.
 */
export async function withinHangGuard<T>(promise: Promise<T>, label: string): Promise<T> {
  const limit = inject('testTimeoutMs') / 2;
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Hung waiting for ${label}: past the ${limit} ms hang guard`)),
      limit,
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}
