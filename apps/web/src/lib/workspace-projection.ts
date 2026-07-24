import type {
  WorkspaceEventEnvelope,
  WorkspaceSnapshotResponse,
  WorkspaceSummary,
} from '@craftingtable/contracts';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'disconnected';

export interface WorkspaceProjectionState {
  readonly snapshotStatus: 'idle' | 'loading' | 'ready' | 'error';
  readonly connection: ConnectionState;
  readonly workspace?: WorkspaceSummary;
  readonly statusSummary: WorkspaceSnapshotResponse['statusSummary'];
  readonly lastSequence: number;
  readonly events: readonly WorkspaceEventEnvelope[];
  readonly invalidPayloadCount: number;
  readonly foreignWorkspaceEventCount: number;
  readonly consecutiveErrors: number;
}

export const INITIAL_WORKSPACE_PROJECTION: WorkspaceProjectionState = {
  snapshotStatus: 'idle',
  connection: 'connecting',
  statusSummary: { needsAttention: 0, active: 0, ready: 0, blocked: 0 },
  lastSequence: 0,
  events: [],
  invalidPayloadCount: 0,
  foreignWorkspaceEventCount: 0,
  consecutiveErrors: 0,
};

export type WorkspaceProjectionAction =
  | { readonly type: 'snapshot-requested' }
  | { readonly type: 'snapshot-loaded'; readonly snapshot: WorkspaceSnapshotResponse }
  | { readonly type: 'snapshot-failed' }
  | { readonly type: 'stream-opened' }
  | { readonly type: 'stream-error'; readonly sourceClosed: boolean }
  | { readonly type: 'event-received'; readonly event: WorkspaceEventEnvelope }
  | { readonly type: 'event-invalid' };

export function reduceWorkspaceProjection(
  state: WorkspaceProjectionState,
  action: WorkspaceProjectionAction,
): WorkspaceProjectionState {
  switch (action.type) {
    case 'snapshot-requested':
      return { ...INITIAL_WORKSPACE_PROJECTION, snapshotStatus: 'loading' };
    case 'snapshot-loaded':
      return {
        snapshotStatus: 'ready',
        connection: 'connecting',
        workspace: action.snapshot.workspace,
        statusSummary: action.snapshot.statusSummary,
        lastSequence: action.snapshot.asOfSequence,
        events: action.snapshot.recentActivity,
        invalidPayloadCount: 0,
        foreignWorkspaceEventCount: 0,
        consecutiveErrors: 0,
      };
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
  }
}
