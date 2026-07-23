import type { AgentEventEnvelope } from '@craftingtable/contracts';
import { describe, expect, it } from 'vitest';
import {
  DISCONNECTED_AFTER_CONSECUTIVE_ERRORS,
  type EventStreamState,
  INITIAL_STREAM_STATE,
  reduceStreamState,
} from './streamState.js';

const envelope = {
  id: 'evt-1',
  sequence: 1,
  occurredAt: '2026-07-23T12:00:00.000Z',
  workspaceId: 'ws-demo',
  kind: 'status-changed',
  payload: { status: 'Editing 3 files' },
} as AgentEventEnvelope;

function afterErrors(count: number, sourceClosed = false): EventStreamState {
  let state = reduceStreamState(INITIAL_STREAM_STATE, { type: 'opened' });
  for (let i = 0; i < count; i += 1) {
    state = reduceStreamState(state, { type: 'stream-error', sourceClosed });
  }
  return state;
}

describe('reduceStreamState', () => {
  it('starts connecting and opens with a clean slate', () => {
    expect(INITIAL_STREAM_STATE.connection).toBe('connecting');
    const opened = reduceStreamState(
      {
        connection: 'disconnected',
        events: [envelope],
        invalidEventCount: 2,
        consecutiveErrors: 5,
      },
      { type: 'opened' },
    );
    expect(opened).toEqual({
      connection: 'open',
      events: [],
      invalidEventCount: 0,
      consecutiveErrors: 0,
    });
  });

  it('reports a single transient error as reconnecting', () => {
    expect(afterErrors(1).connection).toBe('reconnecting');
  });

  it('reports a sustained outage as disconnected even while EventSource retries (CT01-R3)', () => {
    expect(afterErrors(DISCONNECTED_AFTER_CONSECUTIVE_ERRORS).connection).toBe('disconnected');
    expect(afterErrors(10).connection).toBe('disconnected');
  });

  it('reports a closed source as disconnected immediately', () => {
    expect(afterErrors(1, true).connection).toBe('disconnected');
  });

  it('recovers to open after an outage when the connection re-establishes', () => {
    const outage = afterErrors(5);
    const recovered = reduceStreamState(outage, { type: 'opened' });
    expect(recovered.connection).toBe('open');
    expect(recovered.consecutiveErrors).toBe(0);
  });

  it('appends valid events and resets the error streak', () => {
    const state = reduceStreamState(afterErrors(1), { type: 'event-received', envelope });
    expect(state.events).toEqual([envelope]);
    expect(state.consecutiveErrors).toBe(0);
  });

  it('counts invalid events without rendering them', () => {
    const state = reduceStreamState(INITIAL_STREAM_STATE, { type: 'event-invalid' });
    expect(state.invalidEventCount).toBe(1);
    expect(state.events).toEqual([]);
  });
});
