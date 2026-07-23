import type { AgentEventEnvelope } from '@craftingtable/contracts';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'disconnected';

export interface EventStreamState {
  connection: ConnectionState;
  events: AgentEventEnvelope[];
  invalidEventCount: number;
  consecutiveErrors: number;
}

export const INITIAL_STREAM_STATE: EventStreamState = {
  connection: 'connecting',
  events: [],
  invalidEventCount: 0,
  consecutiveErrors: 0,
};

/**
 * EventSource keeps retrying forever without ever reaching CLOSED when the
 * server is simply unreachable, so a bounded error count — not readyState
 * alone — decides when the outage becomes user-visible (CT01-R3). The source
 * keeps retrying underneath; a later successful open fully recovers.
 */
export const DISCONNECTED_AFTER_CONSECUTIVE_ERRORS = 2;

export type StreamAction =
  | { type: 'opened' }
  | { type: 'stream-error'; sourceClosed: boolean }
  | { type: 'event-received'; envelope: AgentEventEnvelope }
  | { type: 'event-invalid' };

export function reduceStreamState(state: EventStreamState, action: StreamAction): EventStreamState {
  switch (action.type) {
    case 'opened':
      // The fake stream replays its scripted run per connection, so a
      // (re)opened connection starts from a clean slate.
      return { connection: 'open', events: [], invalidEventCount: 0, consecutiveErrors: 0 };
    case 'stream-error': {
      const consecutiveErrors = state.consecutiveErrors + 1;
      const disconnected =
        action.sourceClosed || consecutiveErrors >= DISCONNECTED_AFTER_CONSECUTIVE_ERRORS;
      return {
        ...state,
        consecutiveErrors,
        connection: disconnected ? 'disconnected' : 'reconnecting',
      };
    }
    case 'event-received':
      return {
        ...state,
        events: [...state.events, action.envelope],
        consecutiveErrors: 0,
      };
    case 'event-invalid':
      return { ...state, invalidEventCount: state.invalidEventCount + 1 };
  }
}
