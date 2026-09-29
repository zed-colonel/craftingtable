import { expect, it } from 'vitest';
import { configFromEnv } from './config.js';
import { e2eEnvironment } from './e2e-environment.js';

it('passes the gate’s workstation capacity through to the e2e daemon (R-I9 review)', () => {
  const config = configFromEnv(
    e2eEnvironment('/data', {
      CRAFTINGTABLE_DEVELOPMENT_CAPACITY: '8',
      CRAFTINGTABLE_VERIFICATION_CAPACITY: '4',
      CRAFTINGTABLE_LOG_LEVEL: 'debug',
    }),
  );
  expect([config.execution?.developmentCapacity, config.execution?.verificationCapacity]).toEqual([
    8, 4,
  ]);
  // Anything else stays the daemon's own.
  expect(config.logLevel).toBe('warn');
  // Without them, the defaults the walkthrough photographs.
  const defaults = configFromEnv(e2eEnvironment('/data', {}));
  expect([
    defaults.execution?.developmentCapacity,
    defaults.execution?.verificationCapacity,
  ]).toEqual([2, 1]);
});
