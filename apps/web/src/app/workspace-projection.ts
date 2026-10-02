import type { WorkspaceId } from '@craftingtable/domain';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiError } from '../lib/api-client.js';
import {
  INITIAL_WORKSPACE_PROJECTION,
  reduceWorkspaceProjection,
} from '../lib/workspace-projection.js';
import { useSnapshot } from './reads.js';

/**
 * The workspace's projection: its snapshot, read through the store under the event table's
 * rule (R-D4 increment 4b), and the live stream's activity and connection. Events never become
 * the model; they mark the snapshot stale and it is read again (CT03-A66).
 */
export function useWorkspaceProjection(
  workspaceId: WorkspaceId | undefined,
  onExpired: () => void,
) {
  const [projection, dispatch] = useReducer(
    reduceWorkspaceProjection,
    INITIAL_WORKSPACE_PROJECTION,
  );
  const [streamAfter, setStreamAfter] = useState(0);
  const snapshot = useSnapshot(workspaceId);
  const current = useRef(projection);
  current.current = projection;
  useEffect(() => {
    const { data, error } = snapshot;
    if (error instanceof ApiError && error.status === 401) {
      onExpired();
      return;
    }
    if (data !== undefined && data.workspace.id === workspaceId) {
      if (error !== undefined) {
        // Keep the last good projection; only mark it stale (CT03-A67).
        dispatch({ type: 'refresh-failed' });
        return;
      }
      // Seed the stream once per workspace. Background snapshots must not reconnect it or skip
      // invalidations that arrived while their requests were in flight.
      const before = current.current;
      if (before.snapshotStatus !== 'ready' || before.workspace?.id !== data.workspace.id)
        setStreamAfter(data.asOfSequence);
      dispatch({ type: 'snapshot-loaded', snapshot: data });
    } else if (error !== undefined) dispatch({ type: 'snapshot-failed' });
  }, [snapshot, workspaceId, onExpired]);
  /** Another workspace: nothing of this one's projection is shown again. */
  const reset = useCallback(() => {
    setStreamAfter(0);
    dispatch({ type: 'workspace-changed' });
  }, []);
  return { projection, dispatch, streamAfter, reset };
}
