import {
  type AgentRunId,
  type EventId,
  isWellFormedId,
  type ProjectId,
  type UserId,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { z } from 'zod';

function idSchema<T extends string>(label: string) {
  return z.custom<T>(isWellFormedId, {
    message: `${label} must be a non-empty string without surrounding whitespace`,
  });
}

export const userIdSchema = idSchema<UserId>('userId');
export const workspaceIdSchema = idSchema<WorkspaceId>('workspaceId');
export const projectIdSchema = idSchema<ProjectId>('projectId');
export const workItemIdSchema = idSchema<WorkItemId>('workItemId');
export const agentRunIdSchema = idSchema<AgentRunId>('runId');
export const eventIdSchema = idSchema<EventId>('eventId');
