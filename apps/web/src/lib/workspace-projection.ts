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
  readonly invalidEventCount: number;
  readonly consecutiveErrors: number;
}

export const INITIAL_WORKSPACE_PROJECTION: WorkspaceProjectionState = {
  snapshotStatus: 'idle',
  connection: 'connecting',
  statusSummary: { needsAttention: 0, active: 0, ready: 0, blocked: 0 },
  lastSequence: 0,
  events: [],
  invalidEventCount: 0,
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
        invalidEventCount: 0,
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
      if (
        action.event.sequence <= state.lastSequence ||
        action.event.workspaceId !== state.workspace?.id
      ) {
        return action.event.workspaceId === state.workspace?.id
          ? state
          : { ...state, invalidEventCount: state.invalidEventCount + 1 };
      }
      return {
        ...state,
        lastSequence: action.event.sequence,
        events: [...state.events, action.event].slice(-100),
        consecutiveErrors: 0,
      };
    case 'event-invalid':
      return { ...state, invalidEventCount: state.invalidEventCount + 1 };
  }
}
