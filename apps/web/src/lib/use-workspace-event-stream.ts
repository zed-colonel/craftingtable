import {
  SSE_AUTHENTICATION_EXPIRED_EVENT_NAME,
  SSE_WORKSPACE_EVENT_NAME,
  authenticationExpiredEventSchema,
  workspaceEventEnvelopeSchema,
  type WorkspaceEventEnvelope,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useEffect } from 'react';

export interface WorkspaceEventCallbacks {
  readonly onOpen: () => void;
  readonly onError: (sourceClosed: boolean) => void;
  readonly onEvent: (event: WorkspaceEventEnvelope) => void;
  readonly onInvalidEvent: () => void;
  readonly onAuthenticationExpired: () => void;
}

export function useWorkspaceEventStream(
  workspaceId: WorkspaceId | undefined,
  after: number,
  callbacks: WorkspaceEventCallbacks,
): void {
  useEffect(() => {
    if (workspaceId === undefined) {
      return;
    }
    const source = new EventSource(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/events?after=${after}`,
    );
    source.onopen = callbacks.onOpen;
    source.onerror = () => callbacks.onError(source.readyState === EventSource.CLOSED);
    source.addEventListener(SSE_WORKSPACE_EVENT_NAME, (message: MessageEvent<string>) => {
      try {
        const parsed = workspaceEventEnvelopeSchema.safeParse(JSON.parse(message.data));
        if (parsed.success) {
          callbacks.onEvent(parsed.data);
        } else {
          callbacks.onInvalidEvent();
        }
      } catch {
        callbacks.onInvalidEvent();
      }
    });
    source.addEventListener(
      SSE_AUTHENTICATION_EXPIRED_EVENT_NAME,
      (message: MessageEvent<string>) => {
        try {
          if (authenticationExpiredEventSchema.safeParse(JSON.parse(message.data)).success) {
            callbacks.onAuthenticationExpired();
          }
        } finally {
          source.close();
        }
      },
    );
    return () => source.close();
  }, [
    workspaceId,
    after,
    callbacks.onOpen,
    callbacks.onError,
    callbacks.onEvent,
    callbacks.onInvalidEvent,
    callbacks.onAuthenticationExpired,
  ]);
}
