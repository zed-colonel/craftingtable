import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_KINDS, isAgentEventKind } from './event-kinds.js';

describe('agent event kinds', () => {
  it('stays deliberately small for CT-01', () => {
    expect(AGENT_EVENT_KINDS).toEqual(['run-started', 'status-changed', 'completion-proposed']);
  });

  it('guards unknown kinds', () => {
    expect(isAgentEventKind('run-started')).toBe(true);
    expect(isAgentEventKind('merge-executed')).toBe(false);
    expect(isAgentEventKind(7)).toBe(false);
  });
});
