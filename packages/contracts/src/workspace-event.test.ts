import { describe, expect, it } from 'vitest';
import { workspaceEventEnvelopeSchema } from './workspace-event.js';

const event = {
  id: 'event-1',
  sequence: 1,
  occurredAt: '2026-07-24T00:00:00.000Z',
  workspaceId: 'workspace-1',
  actorUserId: 'user-1',
  schemaVersion: 1,
  kind: 'workspace-created',
  payload: { name: 'Default workspace', slug: 'default' },
};

describe('WorkspaceEventEnvelope', () => {
  it('accepts the exact CT-02 workspace-created envelope', () => {
    expect(workspaceEventEnvelopeSchema.safeParse(event).success).toBe(true);
  });

  it('rejects cross-kind, malformed cursor, and unknown data', () => {
    expect(workspaceEventEnvelopeSchema.safeParse({ ...event, kind: 'run-started' }).success).toBe(
      false,
    );
    expect(workspaceEventEnvelopeSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
    expect(workspaceEventEnvelopeSchema.safeParse({ ...event, secret: 'no' }).success).toBe(false);
  });
});
