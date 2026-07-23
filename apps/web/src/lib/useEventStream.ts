import { agentEventEnvelopeSchema, SSE_AGENT_EVENT_NAME } from '@craftingtable/contracts';
import { useEffect, useReducer } from 'react';
import { type EventStreamState, INITIAL_STREAM_STATE, reduceStreamState } from './streamState.js';

export type { ConnectionState, EventStreamState } from './streamState.js';

/**
 * Subscribes to the server's SSE endpoint. Every incoming event is re-validated
 * against the shared contract; invalid events are counted, never rendered.
 * Connection-state policy (including when an outage becomes user-visible)
 * lives in `streamState.ts`.
 */
export function useEventStream(url = '/api/events'): EventStreamState {
  const [state, dispatch] = useReducer(reduceStreamState, INITIAL_STREAM_STATE);

  useEffect(() => {
    const source = new EventSource(url);

    source.onopen = () => {
      dispatch({ type: 'opened' });
    };

    source.onerror = () => {
      dispatch({ type: 'stream-error', sourceClosed: source.readyState === EventSource.CLOSED });
    };

    source.addEventListener(SSE_AGENT_EVENT_NAME, (message: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        parsed = undefined;
      }
      const result = agentEventEnvelopeSchema.safeParse(parsed);
      if (result.success) {
        dispatch({ type: 'event-received', envelope: result.data });
      } else {
        dispatch({ type: 'event-invalid' });
      }
    });

    return () => {
      source.close();
    };
  }, [url]);

  return state;
}
