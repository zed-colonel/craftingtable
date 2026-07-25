import { z } from 'zod';
import { planningStatusCountsSchema, projectSummarySchema } from './planning.js';
import { workspaceEventEnvelopeSchema } from './workspace-event.js';
import { workspaceSummarySchema } from './workspace.js';

/**
 * The workspace bootstrap payload.
 *
 * `statusSummary` names the four dashboard regions. CT-02's `ready` and
 * `blocked` were renamed to `planningReady` and `dependencyBlocked` because a
 * bare "ready" is indistinguishable from executable or merge readiness, neither
 * of which CT-03 owns (CT-03 §5.11, ADR-015).
 *
 * Deliberately lightweight: no artifacts, no diagnostic text, no dependency
 * edges. Detail views use their own authorized queries (CT-03 §5.15).
 */
export const workspaceSnapshotResponseSchema = z.strictObject({
  workspace: workspaceSummarySchema,
  asOfSequence: z.number().int().nonnegative().safe(),
  statusSummary: z.strictObject({
    needsAttention: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    planningReady: z.number().int().nonnegative(),
    dependencyBlocked: z.number().int().nonnegative(),
  }),
  planningSummary: planningStatusCountsSchema.extend({
    projectCount: z.number().int().nonnegative().safe(),
    importAttentionCount: z.number().int().nonnegative().safe(),
  }),
  projects: z.array(projectSummarySchema).max(50),
  recentActivity: z.array(workspaceEventEnvelopeSchema),
});

export type WorkspaceSnapshotResponse = z.infer<typeof workspaceSnapshotResponseSchema>;
