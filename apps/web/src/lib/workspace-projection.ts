import type {
  ProjectSummary,
  WorkspaceEventEnvelope,
  WorkspaceSnapshotResponse,
} from '@craftingtable/contracts';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'disconnected';

export interface WorkspaceProjectionState {
  readonly snapshotStatus: 'idle' | 'loading' | 'ready' | 'error';
  readonly connection: ConnectionState;
  readonly workspace?: WorkspaceSnapshotResponse['workspace'];
  readonly statusSummary: WorkspaceSnapshotResponse['statusSummary'];
  readonly planningSummary: WorkspaceSnapshotResponse['planningSummary'];
  readonly projects: readonly ProjectSummary[];
  readonly lastSequence: number;
  readonly events: readonly WorkspaceEventEnvelope[];
  readonly invalidPayloadCount: number;
  readonly foreignWorkspaceEventCount: number;
  readonly consecutiveErrors: number;
  /** True when a refetch failed; the last good projection stays visible. */
  readonly refreshFailed: boolean;
}

const EMPTY_RISK_COUNTS = { low: 0, medium: 0, high: 0, critical: 0, unspecified: 0 };

export const INITIAL_WORKSPACE_PROJECTION: WorkspaceProjectionState = {
  snapshotStatus: 'idle',
  connection: 'connecting',
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
    riskCounts: EMPTY_RISK_COUNTS,
  },
  projects: [],
  lastSequence: 0,
  events: [],
  invalidPayloadCount: 0,
  foreignWorkspaceEventCount: 0,
  consecutiveErrors: 0,
  refreshFailed: false,
};

export type WorkspaceProjectionAction =
  | { readonly type: 'snapshot-requested' }
  | { readonly type: 'workspace-changed' }
  | { readonly type: 'snapshot-loaded'; readonly snapshot: WorkspaceSnapshotResponse }
  | { readonly type: 'snapshot-failed' }
  | { readonly type: 'stream-opened' }
  | { readonly type: 'stream-error'; readonly sourceClosed: boolean }
  | { readonly type: 'event-received'; readonly event: WorkspaceEventEnvelope }
  | { readonly type: 'event-invalid' }
  | { readonly type: 'refresh-failed' };

export function reduceWorkspaceProjection(
  state: WorkspaceProjectionState,
  action: WorkspaceProjectionAction,
): WorkspaceProjectionState {
  switch (action.type) {
    case 'snapshot-requested':
      return { ...INITIAL_WORKSPACE_PROJECTION, snapshotStatus: 'loading' };
    case 'workspace-changed':
      // Clears the previous workspace's projection *before* the new snapshot
      // resolves, so nothing from the old workspace is ever rendered under the
      // new one, even briefly.
      return { ...INITIAL_WORKSPACE_PROJECTION, snapshotStatus: 'loading' };
    case 'snapshot-loaded': {
      // Retention is keyed by workspace identity. Preserving events, the
      // cursor, or diagnostic counters across a *different* workspace would
      // merge one workspace's activity into another's projection
      // (CT03-R6, CT03-I14). Within the same workspace, retention is exactly
      // what keeps a refetch from discarding the live tail.
      const sameWorkspace =
        state.snapshotStatus === 'ready' && state.workspace?.id === action.snapshot.workspace.id;
      return {
        ...state,
        snapshotStatus: 'ready',
        connection: sameWorkspace ? state.connection : 'connecting',
        workspace: action.snapshot.workspace,
        statusSummary: action.snapshot.statusSummary,
        planningSummary: action.snapshot.planningSummary,
        projects: action.snapshot.projects,
        lastSequence: sameWorkspace ? state.lastSequence : action.snapshot.asOfSequence,
        events: sameWorkspace ? state.events : action.snapshot.recentActivity,
        invalidPayloadCount: sameWorkspace ? state.invalidPayloadCount : 0,
        foreignWorkspaceEventCount: sameWorkspace ? state.foreignWorkspaceEventCount : 0,
        consecutiveErrors: 0,
        refreshFailed: false,
      };
    }
    case 'snapshot-failed':
      return { ...state, snapshotStatus: 'error' };
    case 'stream-opened':
      return { ...state, connection: 'open', consecutiveErrors: 0 };
    case 'stream-error': {
      const consecutiveErrors = state.consecutiveErrors + 1;
      return {
        ...state,
        consecutiveErrors,
        connection: action.sourceClosed || consecutiveErrors >= 2 ? 'disconnected' : 'reconnecting',
      };
    }
    case 'event-received':
      if (action.event.workspaceId !== state.workspace?.id) {
        return {
          ...state,
          foreignWorkspaceEventCount: state.foreignWorkspaceEventCount + 1,
        };
      }
      if (action.event.sequence <= state.lastSequence) {
        return state;
      }
      return {
        ...state,
        lastSequence: action.event.sequence,
        events: [...state.events, action.event].slice(-100),
        consecutiveErrors: 0,
      };
    case 'event-invalid':
      return { ...state, invalidPayloadCount: state.invalidPayloadCount + 1 };
    case 'refresh-failed':
      // Deliberately keeps workspace, summaries, and events: a failed refetch
      // degrades freshness, it does not invalidate committed state.
      return { ...state, refreshFailed: true };
  }
}
