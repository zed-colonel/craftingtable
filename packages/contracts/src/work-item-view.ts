import { z } from 'zod';
import {
  executionStatusResponseSchema,
  runProfilesResponseSchema,
  sourceRepositoryListResponseSchema,
  workItemExecutionResponseSchema,
} from './execution.js';
import { executionScopeChoicesSchema } from './execution-scope.js';
import { workItemDetailResponseSchema } from './planning.js';
import { cycleViewSchema } from './work-cycle.js';

/**
 * A work item page's region in one answer (R-D5, PERF-14): its detail, worktrees, runs and merge
 * gates, its cycles beside their projections, its execution slices, and what its launch forms
 * offer (the workspace's repositories and profiles, the daemon's agent backends). The daemon
 * reads it in one transaction over one map snapshot, so its parts agree with each other. The
 * Git-derived branch reads stay their own (a plan's branches and policy, a worktree's status).
 */
export const workItemViewSchema = z.strictObject({
  detail: workItemDetailResponseSchema,
  execution: workItemExecutionResponseSchema,
  cycles: z.array(cycleViewSchema),
  scopes: executionScopeChoicesSchema,
  repositories: sourceRepositoryListResponseSchema.shape.repositories,
  backends: executionStatusResponseSchema.shape.backends,
  profiles: runProfilesResponseSchema.shape.profiles,
});
export type WorkItemView = z.infer<typeof workItemViewSchema>;
