import { z } from 'zod';
import { workspaceEventEnvelopeSchema } from './workspace-event.js';
import { workspaceSummarySchema } from './workspace.js';

export const workspaceSnapshotResponseSchema = z.strictObject({
  workspace: workspaceSummarySchema,
  asOfSequence: z.number().int().nonnegative().safe(),
  statusSummary: z.strictObject({
    needsAttention: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  recentActivity: z.array(workspaceEventEnvelopeSchema),
});

export type WorkspaceSnapshotResponse = z.infer<typeof workspaceSnapshotResponseSchema>;
