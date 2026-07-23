import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  it('accepts a valid health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'craftingtable-server',
      version: '0.1.0',
      time: '2026-07-22T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown service name', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'other-server',
      version: '0.1.0',
      time: '2026-07-22T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed timestamp', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'craftingtable-server',
      version: '0.1.0',
      time: 'yesterday',
    });
    expect(result.success).toBe(false);
  });
});
