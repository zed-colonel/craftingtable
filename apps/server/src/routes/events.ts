import type { AgentBackend } from '@craftingtable/agents';
import { agentEventEnvelopeSchema, SSE_AGENT_EVENT_NAME } from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';

const HEARTBEAT_INTERVAL_MS = 15_000;

export function registerEventsRoute(app: FastifyInstance, backend: AgentBackend): void {
  const activeStreams = new Set<AbortController>();

  app.addHook('onClose', async () => {
    for (const controller of activeStreams) {
      controller.abort();
    }
  });

  app.get('/api/events', (request, reply) => {
    const controller = new AbortController();
    activeStreams.add(controller);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(':connected\n\n');

    const heartbeat = setInterval(() => {
      reply.raw.write(':hb\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(heartbeat);
      activeStreams.delete(controller);
      controller.abort();
      reply.raw.end();
    };

    request.raw.on('close', finish);

    void (async () => {
      try {
        for await (const envelope of backend.streamEvents(controller.signal)) {
          const validated = agentEventEnvelopeSchema.parse(envelope);
          reply.raw.write(
            `event: ${SSE_AGENT_EVENT_NAME}\nid: ${validated.sequence}\ndata: ${JSON.stringify(validated)}\n\n`,
          );
        }
      } catch (error) {
        request.log.error(error, 'agent event stream failed');
      } finally {
        finish();
      }
    })();
  });
}
