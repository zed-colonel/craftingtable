import type { WorkspaceEventEnvelope, WorkspaceSnapshotResponse } from '@craftingtable/contracts';
import { asEventId, asWorkspaceId } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { INITIAL_WORKSPACE_PROJECTION, reduceWorkspaceProjection } from './workspace-projection.js';

const event = {
  id: asEventId('event-1'),
  sequence: 1,
  occurredAt: '2026-07-24T00:00:00.000Z',
  workspaceId: asWorkspaceId('workspace-1'),
  schemaVersion: 1,
  kind: 'workspace-created',
  payload: { name: 'Default workspace', slug: 'default' },
} as WorkspaceEventEnvelope;

const snapshot = {
  workspace: {
    id: 'workspace-1',
    name: 'Default workspace',
    slug: 'default',
    status: 'active',
    role: 'owner',
  },
  asOfSequence: 1,
  statusSummary: { needsAttention: 0, active: 0, ready: 0, blocked: 0 },
  recentActivity: [event],
} as WorkspaceSnapshotResponse;

describe('workspace projection', () => {
  it('hydrates the snapshot before the live tail', () => {
    const state = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    expect(state.snapshotStatus).toBe('ready');
    expect(state.lastSequence).toBe(1);
    expect(state.events).toEqual([event]);
  });

  it('does not clear authoritative state when the stream opens', () => {
    const hydrated = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    const opened = reduceWorkspaceProjection(hydrated, { type: 'stream-opened' });
    expect(opened.workspace).toEqual(snapshot.workspace);
    expect(opened.events).toEqual([event]);
  });

  it('ignores duplicate sequence and permits global cross-workspace gaps', () => {
    const hydrated = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    expect(reduceWorkspaceProjection(hydrated, { type: 'event-received', event })).toEqual(
      hydrated,
    );
    const gap = { ...event, id: asEventId('event-9'), sequence: 9 };
    const advanced = reduceWorkspaceProjection(hydrated, {
      type: 'event-received',
      event: gap,
    });
    expect(advanced.lastSequence).toBe(9);
    expect(advanced.events).toHaveLength(2);
  });

  it('preserves projection through visible outage and recovery', () => {
    let state = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    state = reduceWorkspaceProjection(state, { type: 'stream-error', sourceClosed: false });
    expect(state.connection).toBe('reconnecting');
    state = reduceWorkspaceProjection(state, { type: 'stream-error', sourceClosed: false });
    expect(state.connection).toBe('disconnected');
    expect(state.events).toEqual([event]);
    state = reduceWorkspaceProjection(state, { type: 'stream-opened' });
    expect(state.connection).toBe('open');
    expect(state.events).toEqual([event]);
  });

  it('rejects an event for another workspace', () => {
    const hydrated = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    const rejected = reduceWorkspaceProjection(hydrated, {
      type: 'event-received',
      event: { ...event, workspaceId: asWorkspaceId('workspace-other'), sequence: 2 },
    });
    expect(rejected.foreignWorkspaceEventCount).toBe(1);
    expect(rejected.invalidPayloadCount).toBe(0);
    expect(rejected.events).toEqual([event]);
  });

  it('counts schema-invalid payloads separately from workspace isolation failures', () => {
    const hydrated = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    const invalid = reduceWorkspaceProjection(hydrated, { type: 'event-invalid' });
    expect(invalid.invalidPayloadCount).toBe(1);
    expect(invalid.foreignWorkspaceEventCount).toBe(0);
  });
});
