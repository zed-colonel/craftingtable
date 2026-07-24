import { WORKSPACE_ROLES, WORKSPACE_STATUSES } from '@craftingtable/domain';
import { z } from 'zod';
import { workspaceIdSchema } from './ids.js';

export const workspaceSummarySchema = z.strictObject({
  id: workspaceIdSchema,
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  status: z.enum(WORKSPACE_STATUSES),
  role: z.enum(WORKSPACE_ROLES),
});

export const workspaceListResponseSchema = z.strictObject({
  workspaces: z.array(workspaceSummarySchema),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
