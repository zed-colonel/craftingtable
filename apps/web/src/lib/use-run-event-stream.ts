import {
  SSE_AUTHENTICATION_EXPIRED_EVENT_NAME,
  SSE_RUN_EVENT_NAME,
  authenticationExpiredEventSchema,
  type RunEventEnvelope,
  runEventEnvelopeSchema,
} from '@craftingtable/contracts';
import type { AgentRunId, WorkspaceId } from '@craftingtable/domain';
import { useEffect } from 'react';

export interface RunEventCallbacks {
  readonly onOpen: () => void;
  readonly onError: (sourceClosed: boolean) => void;
  readonly onEvent: (event: RunEventEnvelope) => void;
  readonly onInvalidEvent: () => void;
  readonly onAuthenticationExpired: () => void;
}

/**
 * Follows one run's normalized events live. A dumb transport, like the
 * workspace stream: it validates and calls back, holding no state, and the
 * browser's native EventSource retry plus the `after` cursor make reconnects
 * idempotent.
 */
export function useRunEventStream(
  workspaceId: WorkspaceId | undefined,
  runId: AgentRunId | undefined,
  after: number,
  callbacks: RunEventCallbacks,
): void {
  useEffect(() => {
    if (workspaceId === undefined || runId === undefined) {
      return;
    }
    const source = new EventSource(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    );
    source.onopen = callbacks.onOpen;
    source.onerror = () => callbacks.onError(source.readyState === EventSource.CLOSED);
    source.addEventListener(SSE_RUN_EVENT_NAME, (message: MessageEvent<string>) => {
      try {
        const parsed = runEventEnvelopeSchema.safeParse(JSON.parse(message.data));
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
    runId,
    after,
    callbacks.onOpen,
    callbacks.onError,
    callbacks.onEvent,
    callbacks.onInvalidEvent,
    callbacks.onAuthenticationExpired,
  ]);
}
