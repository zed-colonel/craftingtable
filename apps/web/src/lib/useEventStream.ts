import {
  type AgentEventEnvelope,
  agentEventEnvelopeSchema,
  SSE_AGENT_EVENT_NAME,
} from '@craftingtable/contracts';
import { useEffect, useState } from 'react';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'disconnected';

export interface EventStreamState {
  connection: ConnectionState;
  events: AgentEventEnvelope[];
  invalidEventCount: number;
}

const initialState: EventStreamState = {
  connection: 'connecting',
  events: [],
  invalidEventCount: 0,
};

/**
 * Subscribes to the server's SSE endpoint. Every incoming event is re-validated
 * against the shared contract; invalid events are counted, never rendered.
 * The fake stream replays its scripted run per connection, so events reset
 * whenever a (re)connection opens.
 */
export function useEventStream(url = '/api/events'): EventStreamState {
  const [state, setState] = useState<EventStreamState>(initialState);

  useEffect(() => {
    const source = new EventSource(url);

    source.onopen = () => {
      setState({ connection: 'open', events: [], invalidEventCount: 0 });
    };

    source.onerror = () => {
      setState((previous) => ({
        ...previous,
        connection: source.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting',
      }));
    };

    source.addEventListener(SSE_AGENT_EVENT_NAME, (message: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        parsed = undefined;
      }
      const result = agentEventEnvelopeSchema.safeParse(parsed);
      setState((previous) =>
        result.success
          ? { ...previous, events: [...previous.events, result.data] }
          : { ...previous, invalidEventCount: previous.invalidEventCount + 1 },
      );
    });

    return () => {
      source.close();
    };
  }, [url]);

  return state;
}
