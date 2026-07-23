import { healthResponseSchema } from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { SERVER_VERSION } from '../config.js';

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () =>
    healthResponseSchema.parse({
      status: 'ok',
      service: 'craftingtable-server',
      version: SERVER_VERSION,
      time: new Date().toISOString(),
    }),
  );
}
