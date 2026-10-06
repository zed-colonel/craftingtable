import { z } from 'zod';
import {
  agentRunDetailResponseSchema,
  agentRunSummarySchema,
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
  /**
   * The parts that could not be read this time (R-D5 review): they come empty, and the page says
   * so where they show, while the rest of the region still works.
   */
  unavailable: z
    .array(z.enum(['cycles', 'scopes']))
    .min(1)
    .optional(),
});
export type WorkItemView = z.infer<typeof workItemViewSchema>;

/**
 * A run page's region in one answer (R-D5, PERF-14): the run's detail, the runs of its work item
 * that a hand-off can start from, and what the hand-off form offers. The run's events stay their
 * own reads: pages of the journal, then the stream.
 */
export const runViewSchema = z.strictObject({
  detail: agentRunDetailResponseSchema,
  runs: z.array(agentRunSummarySchema).max(200),
  backends: executionStatusResponseSchema.shape.backends,
  profiles: runProfilesResponseSchema.shape.profiles,
});
export type RunView = z.infer<typeof runViewSchema>;
