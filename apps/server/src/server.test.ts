import {
  type AgentEventEnvelope,
  agentEventEnvelopeSchema,
  healthResponseSchema,
  SSE_AGENT_EVENT_NAME,
} from '@craftingtable/contracts';
import {
  type DemoRunScript,
  demoRunScriptSchema,
  FakeAgentBackend,
  FakeGitService,
} from '@craftingtable/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const script: DemoRunScript = demoRunScriptSchema.parse({
  workspaceId: 'ws-test',
  projectId: 'proj-test',
  workItemId: 'AQ-01',
  runId: 'run-test-1',
  steps: [
    {
      kind: 'run-started',
      delayMs: 0,
      payload: { backend: 'fake-agent', title: 'Test run' },
    },
  ],
});

function testServer() {
  const git = new FakeGitService();
  const backend = new FakeAgentBackend(script, git, { timeScale: 0 });
  return buildServer({ backend, git });
}

const servers: ReturnType<typeof testServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('GET /api/health', () => {
  it('returns a contract-valid health response', async () => {
    const app = testServer();
    servers.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    const parsed = healthResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
  });
});

describe('GET /api/events', () => {
  it('streams a contract-valid SSE agent event', async () => {
    const app = testServer();
    servers.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.addresses()[0] ?? {};

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    if (response.body === null) {
      throw new Error('event stream response has no body');
    }
    const reader = response.body.getReader();

    let buffer = '';
    let envelope: AgentEventEnvelope | undefined;
    const decoder = new TextDecoder();
    while (envelope === undefined) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (const frame of buffer.split('\n\n')) {
        const eventLine = frame.match(/^event: (.+)$/m)?.[1];
        const dataLine = frame.match(/^data: (.+)$/m)?.[1];
        if (eventLine === SSE_AGENT_EVENT_NAME && dataLine !== undefined) {
          envelope = agentEventEnvelopeSchema.parse(JSON.parse(dataLine));
        }
      }
    }
    controller.abort();

    expect(envelope).toBeDefined();
    expect(envelope?.kind).toBe('run-started');
    expect(envelope?.sequence).toBe(1);
  });
});
