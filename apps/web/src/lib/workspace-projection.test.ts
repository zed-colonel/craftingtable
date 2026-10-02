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
    id: asWorkspaceId('workspace-1'),
    name: 'Default workspace',
    slug: 'default',
    status: 'active',
    role: 'owner',
  },
  asOfSequence: 1,
  statusSummary: {
    needsAttention: 0,
    active: 0,
    planningReady: 0,
    dependencyBlocked: 0,
    completed: 0,
    liveRuns: 0,
  },
  planningSummary: {
    projectCount: 0,
    importAttentionCount: 0,
    proposedCount: 0,
    admittedCount: 0,
    completedCount: 0,
    planningReadyCount: 0,
    dependencyBlockedCount: 0,
    riskCounts: { low: 0, medium: 0, high: 0, critical: 0, unspecified: 0 },
  },
  projects: [],
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

  it('B1-UI-004 ignores duplicate sequence and permits global cross-workspace gaps', () => {
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

  it('B1-UI-005 rejects an event for another workspace', () => {
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

describe('planning event invalidation (CT03-A66, CT03-A67)', () => {
  const hydrate = () =>
    reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, { type: 'snapshot-loaded', snapshot });

  it('records the event without patching the model (the event table says what to read again)', () => {
    const imported = {
      ...event,
      id: asEventId('event-2'),
      sequence: 2,
      kind: 'plan-version-imported',
      payload: {
        projectId: 'project-1',
        planVersionId: 'version-1',
        versionNumber: 1,
        document: 'AQ Plan',
        itemCount: 14,
        requiredDependencyCount: 24,
        warningCount: 0,
      },
    } as unknown as WorkspaceEventEnvelope;

    const state = reduceWorkspaceProjection(hydrate(), { type: 'event-received', event: imported });
    // The summary is NOT patched from the payload: the counts stay as the
    // authoritative snapshot left them until a refetch replaces them.
    expect(state.planningSummary.proposedCount).toBe(0);
    expect(state.projects).toEqual([]);
    expect(state.lastSequence).toBe(2);
  });

  it('keeps the last good projection visible when a refetch fails', () => {
    const state = reduceWorkspaceProjection(hydrate(), { type: 'refresh-failed' });
    expect(state.refreshFailed).toBe(true);
    expect(state.snapshotStatus).toBe('ready');
    expect(state.workspace).toEqual(snapshot.workspace);
    expect(state.events).toEqual([event]);
  });

  it('does not reset the cursor or events when a later snapshot arrives', () => {
    const hydrated = hydrate();
    const advanced = reduceWorkspaceProjection(hydrated, {
      type: 'event-received',
      event: { ...event, id: asEventId('event-4'), sequence: 4 },
    });
    const refreshed = reduceWorkspaceProjection(advanced, { type: 'snapshot-loaded', snapshot });
    // A refetch must never rewind the live cursor or discard tailed events.
    expect(refreshed.lastSequence).toBe(4);
    expect(refreshed.events).toHaveLength(2);
  });
  it('does not skip detail invalidations when a background snapshot is ahead of the stream', () => {
    const refreshed = reduceWorkspaceProjection(hydrate(), {
      type: 'snapshot-loaded',
      snapshot: { ...snapshot, asOfSequence: 10 },
    });
    const advanced = reduceWorkspaceProjection(refreshed, {
      type: 'event-received',
      event: { ...event, sequence: 2, id: asEventId('event-2') },
    });
    // The event is still recorded; the app sends every event to the event table (R-D4).
    expect(advanced.lastSequence).toBe(2);
    expect(advanced.events.at(-1)?.sequence).toBe(2);
  });
});

describe('workspace switching (CT03-R6)', () => {
  const otherWorkspace = asWorkspaceId('workspace-2');

  const otherEvent = {
    ...event,
    id: asEventId('event-other'),
    sequence: 7,
    workspaceId: otherWorkspace,
    payload: { name: 'Second workspace', slug: 'second' },
  } as WorkspaceEventEnvelope;

  const otherSnapshot = {
    ...snapshot,
    workspace: { ...snapshot.workspace, id: otherWorkspace, name: 'Second workspace' },
    asOfSequence: 7,
    statusSummary: {
      needsAttention: 0,
      active: 3,
      planningReady: 2,
      dependencyBlocked: 4,
      completed: 1,
      liveRuns: 0,
    },
    recentActivity: [otherEvent],
  } as WorkspaceSnapshotResponse;

  it('B1-UI-007 never carries the previous workspace activity into a new one', () => {
    const first = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    expect(first.events).toEqual([event]);

    const second = reduceWorkspaceProjection(first, {
      type: 'snapshot-loaded',
      snapshot: otherSnapshot,
    });
    expect(second.workspace?.id).toBe(otherWorkspace);
    expect(second.events).toEqual([otherEvent]);
    expect(second.events).not.toContainEqual(event);
    expect(second.statusSummary).toEqual(otherSnapshot.statusSummary);
  });

  it('does not carry the previous workspace cursor forward', () => {
    const first = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot: otherSnapshot,
    });
    expect(first.lastSequence).toBe(7);

    // The new workspace's cursor is lower; retaining the maximum would skip its
    // replay entirely.
    const second = reduceWorkspaceProjection(first, { type: 'snapshot-loaded', snapshot });
    expect(second.lastSequence).toBe(snapshot.asOfSequence);
  });

  it('resets diagnostic counters across a workspace change', () => {
    let state = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    state = reduceWorkspaceProjection(state, { type: 'event-invalid' });
    state = reduceWorkspaceProjection(state, {
      type: 'event-received',
      event: { ...event, workspaceId: otherWorkspace, sequence: 2 },
    });
    expect(state.invalidPayloadCount).toBe(1);
    expect(state.foreignWorkspaceEventCount).toBe(1);

    const switched = reduceWorkspaceProjection(state, {
      type: 'snapshot-loaded',
      snapshot: otherSnapshot,
    });
    expect(switched.invalidPayloadCount).toBe(0);
    expect(switched.foreignWorkspaceEventCount).toBe(0);
  });

  it('clears the projection immediately on workspace-changed', () => {
    const loaded = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    const cleared = reduceWorkspaceProjection(loaded, { type: 'workspace-changed' });
    // Nothing from the old workspace may render while the new request is in
    // flight, not even briefly.
    expect(cleared.snapshotStatus).toBe('loading');
    expect(cleared.workspace).toBeUndefined();
    expect(cleared.events).toEqual([]);
    expect(cleared.projects).toEqual([]);
    expect(cleared.lastSequence).toBe(0);
    expect(cleared.statusSummary).toEqual(INITIAL_WORKSPACE_PROJECTION.statusSummary);
  });

  it('still retains state across a refetch of the same workspace', () => {
    let state = reduceWorkspaceProjection(INITIAL_WORKSPACE_PROJECTION, {
      type: 'snapshot-loaded',
      snapshot,
    });
    state = reduceWorkspaceProjection(state, {
      type: 'event-received',
      event: { ...event, id: asEventId('event-5'), sequence: 5 },
    });
    const refetched = reduceWorkspaceProjection(state, { type: 'snapshot-loaded', snapshot });
    expect(refetched.lastSequence).toBe(5);
    expect(refetched.events).toHaveLength(2);
  });
});
