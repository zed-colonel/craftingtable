import { AGENT_EVENT_KINDS } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { agentEventEnvelopeSchema } from './agent-event.js';

const validRunStarted = {
  id: 'evt-1',
  sequence: 1,
  occurredAt: '2026-07-22T12:00:00.000Z',
  workspaceId: 'ws-demo',
  projectId: 'proj-craftingtable',
  workItemId: 'AQ-01',
  runId: 'run-demo-1',
  kind: 'run-started',
  payload: { backend: 'fake-agent', title: 'Demo run', branch: 'ct-01/fake-demo' },
};

describe('agentEventEnvelopeSchema', () => {
  it('accepts a valid run-started envelope', () => {
    expect(agentEventEnvelopeSchema.safeParse(validRunStarted).success).toBe(true);
  });

  it('accepts optional scope fields being absent', () => {
    const { projectId, workItemId, runId, ...minimal } = validRunStarted;
    expect(agentEventEnvelopeSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(
      agentEventEnvelopeSchema.safeParse({ ...validRunStarted, kind: 'merge-executed' }).success,
    ).toBe(false);
  });

  it('rejects a payload that does not match the kind', () => {
    expect(
      agentEventEnvelopeSchema.safeParse({
        ...validRunStarted,
        kind: 'status-changed',
      }).success,
    ).toBe(false);
  });

  it('rejects non-positive and non-integer sequences', () => {
    expect(agentEventEnvelopeSchema.safeParse({ ...validRunStarted, sequence: 0 }).success).toBe(
      false,
    );
    expect(agentEventEnvelopeSchema.safeParse({ ...validRunStarted, sequence: 1.5 }).success).toBe(
      false,
    );
  });

  it('rejects malformed timestamps and blank ids', () => {
    expect(
      agentEventEnvelopeSchema.safeParse({ ...validRunStarted, occurredAt: 'noon' }).success,
    ).toBe(false);
    expect(agentEventEnvelopeSchema.safeParse({ ...validRunStarted, id: '' }).success).toBe(false);
  });

  it('covers exactly the domain event-kind vocabulary', () => {
    const schemaKinds = agentEventEnvelopeSchema.options.map((option) => option.shape.kind.value);
    expect(schemaKinds.toSorted()).toEqual([...AGENT_EVENT_KINDS].toSorted());
  });
});
