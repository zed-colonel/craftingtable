import { agentEventEnvelopeSchema } from '@craftingtable/contracts';
import { describe, expect, it } from 'vitest';
import { type DemoRunScript, loadDemoRunScript } from './demo-run-script.js';
import { FakeAgentBackend } from './fake-agent-backend.js';
import { FAKE_REPOSITORY_SNAPSHOT, FakeGitService } from './fake-git-service.js';

async function collect(backend: FakeAgentBackend, signal: AbortSignal) {
  const events = [];
  for await (const event of backend.streamEvents(signal)) {
    events.push(event);
    if (events.length === 3) {
      break;
    }
  }
  return events;
}

function instantBackend(script: DemoRunScript): FakeAgentBackend {
  return new FakeAgentBackend(script, new FakeGitService(), { timeScale: 0 });
}

describe('demo run fixture', () => {
  it('loads and validates fixtures/agent-events/demo-run.json', async () => {
    const script = await loadDemoRunScript();
    expect(script.steps.length).toBeGreaterThanOrEqual(1);
    expect(script.steps[0]?.kind).toBe('run-started');
  });
});

describe('FakeAgentBackend', () => {
  it('describes itself as simulated', async () => {
    const backend = instantBackend(await loadDemoRunScript());
    expect(backend.describe().simulated).toBe(true);
    expect(backend.describe().id).toBe('fake-agent');
  });

  it('emits schema-valid envelopes with monotonic sequences', async () => {
    const backend = instantBackend(await loadDemoRunScript());
    const events = await collect(backend, new AbortController().signal);

    expect(events).toHaveLength(3);
    for (const [index, event] of events.entries()) {
      expect(agentEventEnvelopeSchema.safeParse(event).success).toBe(true);
      expect(event.sequence).toBe(index + 1);
    }
    expect(events.map((event) => event.kind)).toEqual([
      'run-started',
      'status-changed',
      'completion-proposed',
    ]);
  });

  it('stamps the fake Git branch into the run-started payload', async () => {
    const backend = instantBackend(await loadDemoRunScript());
    const [first] = await collect(backend, new AbortController().signal);

    expect(first?.kind).toBe('run-started');
    if (first?.kind === 'run-started') {
      expect(first.payload.branch).toBe(FAKE_REPOSITORY_SNAPSHOT.branch);
    }
  });

  it('stops emitting when the signal aborts', async () => {
    const backend = instantBackend(await loadDemoRunScript());
    const controller = new AbortController();
    controller.abort();

    const events = [];
    for await (const event of backend.streamEvents(controller.signal)) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });
});
