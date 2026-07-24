import { healthResponseSchema } from '@craftingtable/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe('GET /api/health', () => {
  it('remains public and contract-valid', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const response = await context.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.safeParse(response.json()).success).toBe(true);
  });
});
