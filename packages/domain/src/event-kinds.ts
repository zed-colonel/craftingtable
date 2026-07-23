/**
 * Normalized agent-event vocabulary for CT-01. Deliberately limited to what
 * the fake dashboard needs; later work items extend it from the implementation
 * plan's full normalized-event list.
 */
export const AGENT_EVENT_KINDS = ['run-started', 'status-changed', 'completion-proposed'] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export function isAgentEventKind(value: unknown): value is AgentEventKind {
  return (AGENT_EVENT_KINDS as readonly string[]).includes(value as string);
}
