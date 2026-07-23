import { z } from 'zod';
import {
  agentRunIdSchema,
  eventIdSchema,
  projectIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from './ids.js';

/**
 * SSE wire format (see ADR-003): each normalized event is sent as
 *
 *   event: agent-event
 *   id: <sequence>
 *   data: <JSON AgentEventEnvelope>
 *
 * Comment lines (`:hb`) are keep-alive heartbeats. `Last-Event-ID` replay is
 * deferred to CT-02.
 */
export const SSE_AGENT_EVENT_NAME = 'agent-event';

const envelopeBase = z.object({
  id: eventIdSchema,
  sequence: z.number().int().min(1),
  occurredAt: z.iso.datetime(),
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema.optional(),
  workItemId: workItemIdSchema.optional(),
  runId: agentRunIdSchema.optional(),
});

export const runStartedEventSchema = envelopeBase.extend({
  kind: z.literal('run-started'),
  payload: z.object({
    backend: z.string().min(1),
    title: z.string().min(1),
    branch: z.string().min(1),
  }),
});

export const statusChangedEventSchema = envelopeBase.extend({
  kind: z.literal('status-changed'),
  payload: z.object({
    status: z.string().min(1),
  }),
});

export const completionProposedEventSchema = envelopeBase.extend({
  kind: z.literal('completion-proposed'),
  payload: z.object({
    summary: z.string().min(1),
  }),
});

export const agentEventEnvelopeSchema = z.discriminatedUnion('kind', [
  runStartedEventSchema,
  statusChangedEventSchema,
  completionProposedEventSchema,
]);

export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;
export type RunStartedEvent = z.infer<typeof runStartedEventSchema>;
export type StatusChangedEvent = z.infer<typeof statusChangedEventSchema>;
export type CompletionProposedEvent = z.infer<typeof completionProposedEventSchema>;
