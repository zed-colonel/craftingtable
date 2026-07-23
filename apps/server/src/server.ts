import type { AgentBackend } from '@craftingtable/agents';
import type { GitService } from '@craftingtable/git';
import { fastify, type FastifyInstance } from 'fastify';
import { registerEventsRoute } from './routes/events.js';
import { registerHealthRoute } from './routes/health.js';

export interface ServerDependencies {
  backend: AgentBackend;
  git: GitService;
}

export interface BuildServerOptions {
  logger?: boolean;
}

export function buildServer(
  deps: ServerDependencies,
  options: BuildServerOptions = {},
): FastifyInstance {
  const app = fastify({ logger: options.logger ?? false });
  registerHealthRoute(app);
  registerEventsRoute(app, deps.backend);
  return app;
}
