import { WORKSPACE_ROLES, WORKSPACE_STATUSES } from '@craftingtable/domain';
import { z } from 'zod';
import { workspaceIdSchema } from './ids.js';

const hasNoControls = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(hasNoControls, { message: 'must not contain C0 or DEL controls' });

export const workspaceSummarySchema = z.strictObject({
  id: workspaceIdSchema,
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  status: z.enum(WORKSPACE_STATUSES),
  role: z.enum(WORKSPACE_ROLES),
});

/** The summary plus the counts a workspace card on the home page shows. */
export const workspaceOverviewSchema = workspaceSummarySchema.extend({
  projectCount: z.number().int().nonnegative().safe(),
  admittedCount: z.number().int().nonnegative().safe(),
  completedCount: z.number().int().nonnegative().safe(),
  liveRunCount: z.number().int().nonnegative().safe(),
  projects: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1).max(120),
        admittedCount: z.number().int().nonnegative().safe(),
        completedCount: z.number().int().nonnegative().safe(),
        proposedCount: z.number().int().nonnegative().safe(),
      }),
    )
    .max(50),
});

export const workspaceListResponseSchema = z.strictObject({
  workspaces: z.array(workspaceOverviewSchema),
});

export const createWorkspaceRequestSchema = z.strictObject({
  name: workspaceNameSchema,
});

export const createWorkspaceResponseSchema = z.strictObject({
  workspace: workspaceSummarySchema,
});

export const renameWorkspaceRequestSchema = z.strictObject({
  name: workspaceNameSchema,
});

export const renameWorkspaceResponseSchema = z.strictObject({
  workspace: workspaceSummarySchema,
  changed: z.boolean(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceOverview = z.infer<typeof workspaceOverviewSchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;
export type RenameWorkspaceRequest = z.infer<typeof renameWorkspaceRequestSchema>;
export type RenameWorkspaceResponse = z.infer<typeof renameWorkspaceResponseSchema>;
