import { randomUUID } from 'node:crypto';
import type { AgentBackend, BackendDescriptor } from '@craftingtable/agents';
import { type AgentEventEnvelope, agentEventEnvelopeSchema } from '@craftingtable/contracts';
import type { GitService } from '@craftingtable/git';
import type { DemoRunScript } from './demo-run-script.js';

export interface FakeAgentBackendOptions {
  /** Multiplier applied to fixture delays; 0 makes tests instantaneous. */
  timeScale?: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Plays a deterministic scripted run, then keeps the stream open until the
 * signal aborts so SSE clients are not forced into a reconnect-and-replay
 * loop. Every emitted envelope is validated against the shared contract.
 */
export class FakeAgentBackend implements AgentBackend {
  constructor(
    private readonly script: DemoRunScript,
    private readonly git: GitService,
    private readonly options: FakeAgentBackendOptions = {},
  ) {}

  describe(): BackendDescriptor {
    return {
      id: 'fake-agent',
      label: 'Fake agent backend',
      version: '0.1.0',
      simulated: true,
    };
  }

  async *streamEvents(signal: AbortSignal): AsyncIterable<AgentEventEnvelope> {
    const repository = await this.git.describeRepository();
    const timeScale = this.options.timeScale ?? 1;
    let sequence = 0;

    for (const step of this.script.steps) {
      await delay(step.delayMs * timeScale, signal);
      if (signal.aborted) {
        return;
      }
      sequence += 1;
      yield agentEventEnvelopeSchema.parse({
        id: randomUUID(),
        sequence,
        occurredAt: new Date().toISOString(),
        workspaceId: this.script.workspaceId,
        projectId: this.script.projectId,
        workItemId: this.script.workItemId,
        runId: this.script.runId,
        kind: step.kind,
        payload:
          step.kind === 'run-started'
            ? { ...step.payload, branch: repository.branch }
            : step.payload,
      });
    }

    await waitForAbort(signal);
  }
}
