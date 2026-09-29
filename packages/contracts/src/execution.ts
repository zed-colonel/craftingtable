import {
  AGENT_BACKENDS,
  AGENT_BILLING_SOURCES,
  AGENT_EXIT_REASONS,
  AGENT_NOTICE_CATEGORIES,
  AGENT_PERMISSION_MODES,
  AGENT_PROFILE_PURPOSES,
  AGENT_RUN_ROLES,
  AGENT_RUN_STATUSES,
  AGENT_RUN_VERDICTS,
  type JsonValue,
  OUTCOME_SUMMARY_LIMIT_BYTES,
  SOURCE_REPOSITORY_STATUSES,
  WORKTREE_STATUSES,
} from '@craftingtable/domain';
import { z } from 'zod';
import { profileSelectionSchema, reasoningEffortSchema } from './agent-profiles.js';
import { executionScopeSchema } from './execution-scope.js';
import {
  agentRunEventIdSchema,
  agentRunIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { providerFailureSchema } from './provider-failure.js';
import { reviewReportAssessmentSchema } from './review.js';

export const SSE_RUN_EVENT_NAME = 'run-event';

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const boundedUtf8 = (maximum: number) =>
  z.string().refine((value) => utf8Length(value) <= maximum, {
    message: `must be at most ${maximum} UTF-8 bytes`,
  });
const hasNoControls = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
const nonNegativeSafeInteger = z.number().int().nonnegative().safe();
const positiveSafeInteger = z.number().int().positive().safe();

/** JSON value schema for bounded tool inputs; the adapter truncates before this. */
/** Any JSON value, typed as the domain's `JsonValue`. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const executionStatusResponseSchema = z.strictObject({
  git: z.strictObject({
    available: z.boolean(),
    executable: z.string().optional(),
  }),
  backends: z
    .array(
      z.strictObject({
        kind: z.enum(AGENT_BACKENDS),
        label: z.string().min(1).max(100),
        available: z.boolean(),
        executable: z.string().optional(),
        models: z
          .array(
            z.strictObject({ id: z.string().min(1).max(100), label: z.string().min(1).max(100) }),
          )
          .max(50),
      }),
    )
    .max(10),
});

/* -------------------------------------------------------------------------- */
/* Source repositories                                                         */
/* -------------------------------------------------------------------------- */

export const sourceRepositoryPathSchema = boundedUtf8(4096)
  .min(2)
  .refine((value) => value.startsWith('/'), { message: 'must be an absolute path' })
  .refine((value) => !value.includes('\0'), { message: 'must not contain NUL' });

export const sourceRepositoryDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(hasNoControls, { message: 'must not contain C0 or DEL controls' });

export const gitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);
export const gitBranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(hasNoControls, { message: 'must not contain C0 or DEL controls' });

export const sourceRepositorySummarySchema = z.strictObject({
  id: sourceRepositoryIdSchema,
  workspaceId: workspaceIdSchema,
  displayName: sourceRepositoryDisplayNameSchema,
  rootPath: sourceRepositoryPathSchema,
  defaultBranch: gitBranchNameSchema,
  registeredHeadSha: gitShaSchema,
  status: z.enum(SOURCE_REPOSITORY_STATUSES),
  registeredAt: z.iso.datetime(),
  registeredByUserId: userIdSchema,
  retiredAt: z.iso.datetime().optional(),
  version: positiveSafeInteger,
});

export const registerSourceRepositoryRequestSchema = z.strictObject({
  rootPath: sourceRepositoryPathSchema,
  displayName: sourceRepositoryDisplayNameSchema.optional(),
});

export const registerSourceRepositoryResponseSchema = z.strictObject({
  repository: sourceRepositorySummarySchema,
  /** False when an active registration for the same path already existed. */
  created: z.boolean(),
});

export const sourceRepositoryListResponseSchema = z.strictObject({
  repositories: z.array(sourceRepositorySummarySchema).max(200),
});

export const repositoryBranchesResponseSchema = z.strictObject({
  branches: z.array(gitBranchNameSchema).max(1000),
  /** The branch the primary checkout has checked out, when it is on one. */
  checkedOut: gitBranchNameSchema.optional(),
});

export const retireSourceRepositoryRequestSchema = z.strictObject({});
export const retireSourceRepositoryResponseSchema = z.strictObject({
  repository: sourceRepositorySummarySchema,
  changed: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Worktrees                                                                   */
/* -------------------------------------------------------------------------- */

function hasExecutionSubject(value: { workItemId?: string; planVersionId?: string }): boolean {
  return (value.workItemId !== undefined) !== (value.planVersionId !== undefined);
}

const worktreeRecordShape = {
  executionScope: executionScopeSchema.optional(),
  id: worktreeIdSchema,
  workspaceId: workspaceIdSchema,
  repositoryId: sourceRepositoryIdSchema,
  projectId: projectIdSchema,
  workItemId: workItemIdSchema.optional(),
  planVersionId: planVersionIdSchema.optional(),
  branchName: gitBranchNameSchema,
  baseSha: gitShaSchema,
  baseBranch: gitBranchNameSchema,
  integrationBranch: gitBranchNameSchema.optional(),
  path: sourceRepositoryPathSchema,
  status: z.enum(WORKTREE_STATUSES),
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
  removedAt: z.iso.datetime().optional(),
  mergedAt: z.iso.datetime().optional(),
  mergeSha: gitShaSchema.optional(),
  version: positiveSafeInteger,
};
/** A worktree as storage keeps it (R-H3). */
export const worktreeRecordSchema = z
  .strictObject(worktreeRecordShape)
  .refine(hasExecutionSubject, {
    message: 'Execution must have exactly one work-item or plan-version subject',
  });
export const worktreeSummarySchema = z
  .strictObject({
    ...worktreeRecordShape,
    mergeCleanupError: z.string().max(4000).optional(),
  })
  .refine(hasExecutionSubject, {
    message: 'Execution must have exactly one work-item or plan-version subject',
  });

export const createWorktreeRequestSchema = z.strictObject({
  executionScope: executionScopeSchema.optional(),
  repositoryId: sourceRepositoryIdSchema,
  /** Optional branch override; the daemon derives one from the work item otherwise. */
  branchName: gitBranchNameSchema.optional(),
});

export const createWorktreeResponseSchema = z.strictObject({
  worktree: worktreeSummarySchema,
});

export const removeWorktreeRequestSchema = z.strictObject({
  /**
   * Remove even though the worktree has uncommitted or untracked changes,
   * discarding them. Without it a dirty worktree is refused with its paths.
   */
  discardChanges: z.boolean().optional(),
});
export const removeWorktreeResponseSchema = z.strictObject({
  worktree: worktreeSummarySchema,
  changed: z.boolean(),
});

export const mergeWorktreeRequestSchema = z.strictObject({
  /**
   * Optional confirmation of the recorded integration target. A different target
   * requires an explicit retarget and fresh review before merging.
   */
  targetBranch: gitBranchNameSchema.optional(),
});

/**
 * Why a worktree can or cannot be merged right now. Computed by the daemon
 * from the worktree's runs; the browser only renders it.
 */
export const mergeGateSchema = z.strictObject({
  mergeable: z.boolean(),
  reason: z.enum([
    'ready',
    'no-review',
    'changes-requested',
    'review-pending',
    'automation-active',
    'superseded-by-later-run',
    'run-live',
    'worktree-removed',
    'scope-blocked',
    'scope-review-only',
    'branch-review-required',
    'merge-recovery-required',
  ]),
  reviewRunId: agentRunIdSchema.optional(),
});

export const mergeWorktreeResponseSchema = z.strictObject({
  worktree: worktreeSummarySchema,
  mergeSha: gitShaSchema,
  targetBranch: gitBranchNameSchema,
  createdTarget: z.boolean(),
  workItemCompleted: z.boolean(),
});

export const diffFileStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'untracked',
  'unmerged',
  'unknown',
]);

export const worktreeDiffFileSchema = z.strictObject({
  path: boundedUtf8(4096).min(1),
  previousPath: boundedUtf8(4096).min(1).optional(),
  status: diffFileStatusSchema,
  additions: nonNegativeSafeInteger,
  deletions: nonNegativeSafeInteger,
  binary: z.boolean(),
});

export const worktreeDiffResponseSchema = z.strictObject({
  worktree: worktreeSummarySchema,
  baseSha: gitShaSchema,
  headSha: gitShaSchema,
  /** Commits on the worktree branch since the base, newest first. */
  commits: z
    .array(
      z.strictObject({
        sha: gitShaSchema,
        subject: boundedUtf8(1000),
        authoredAt: z.iso.datetime(),
      }),
    )
    .max(200),
  files: z.array(worktreeDiffFileSchema).max(2000),
  /** Unified diff of the working tree against the base, including untracked files. */
  patch: z.string(),
  patchTruncated: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Agent runs                                                                  */
/* -------------------------------------------------------------------------- */

export const agentRunSummarySchema = z
  .strictObject({
    id: agentRunIdSchema,
    workspaceId: workspaceIdSchema,
    worktreeId: worktreeIdSchema,
    repositoryId: sourceRepositoryIdSchema,
    projectId: projectIdSchema,
    workItemId: workItemIdSchema.optional(),
    planVersionId: planVersionIdSchema.optional(),
    parentRunId: agentRunIdSchema.optional(),
    backend: z.enum(AGENT_BACKENDS),
    role: z.enum(AGENT_RUN_ROLES),
    status: z.enum(AGENT_RUN_STATUSES),
    permissionMode: z.enum(AGENT_PERMISSION_MODES),
    reasoningEffort: reasoningEffortSchema.optional(),
    profileSelection: profileSelectionSchema.optional(),
    model: z.string().min(1).max(100).optional(),
    resolvedModel: z.string().min(1).max(100).optional(),
    billing: z.enum(AGENT_BILLING_SOURCES).optional(),
    verdict: z.enum(AGENT_RUN_VERDICTS).optional(),
    reviewBranchContext: z
      .strictObject({
        headSha: gitShaSchema,
        targetBranch: gitBranchNameSchema,
        targetSha: gitShaSchema,
        worktreeVersion: positiveSafeInteger,
        repositoryPolicyVersion: positiveSafeInteger.optional(),
      })
      .optional(),
    backendSessionId: z.string().min(1).max(200).optional(),
    createdAt: z.iso.datetime(),
    createdByUserId: userIdSchema,
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    exitCode: z.number().int().optional(),
    outcomeSummary: boundedUtf8(OUTCOME_SUMMARY_LIMIT_BYTES).optional(),
    costUsd: z.number().nonnegative().optional(),
    turnCount: nonNegativeSafeInteger,
    version: positiveSafeInteger,
  })
  .refine(hasExecutionSubject, {
    message: 'Execution must have exactly one work-item or plan-version subject',
  });

export const runOutcomeSchema = z.strictObject({
  providerFailure: providerFailureSchema.optional(),
  sequence: nonNegativeSafeInteger,
  occurredAt: z.iso.datetime(),
  text: z.string(),
  outcome: z.enum(['success', 'error']),
  truncated: z.boolean(),
});
export const agentRunDetailResponseSchema = z.strictObject({
  completionIssue: z
    .strictObject({ reason: z.enum(AGENT_EXIT_REASONS), message: z.string().max(4000) })
    .optional(),
  latestOutcome: runOutcomeSchema.optional(),
  run: agentRunSummarySchema,
  worktree: worktreeSummarySchema,
  brief: z.string(),
  eventCount: nonNegativeSafeInteger,
  reviewReport: reviewReportAssessmentSchema.optional(),
});

export const startAgentRunRequestSchema = z.strictObject({
  reasoningEffort: reasoningEffortSchema.optional(),
  backend: z.enum(AGENT_BACKENDS).optional(),
  worktreeId: worktreeIdSchema,
  role: z.enum(AGENT_RUN_ROLES).default('implement'),
  permissionMode: z.enum(AGENT_PERMISSION_MODES).default('auto'),
  model: z.string().min(1).max(100).optional(),
  /** Free-form operator guidance appended to the composed brief. */
  instructions: boundedUtf8(20000).optional(),
  parentRunId: agentRunIdSchema.optional(),
});

/**
 * The operator's standing agent, model, and permission choice for one role.
 * The daemon answers with every role, marking which ones it stores; a request
 * carries only the roles to store, each at most once.
 */
export const agentRunProfileSchema = z.strictObject({
  reasoningEffort: reasoningEffortSchema.optional(),
  role: z.enum(AGENT_PROFILE_PURPOSES),
  backend: z.enum(AGENT_BACKENDS),
  model: z.string().min(1).max(100).optional(),
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
});

export const runProfilesResponseSchema = z.strictObject({
  profiles: z
    .array(agentRunProfileSchema.extend({ stored: z.boolean() }))
    .max(AGENT_PROFILE_PURPOSES.length),
});

export const saveRunProfilesRequestSchema = z.strictObject({
  profiles: z
    .array(agentRunProfileSchema)
    .max(AGENT_PROFILE_PURPOSES.length)
    .refine(
      (profiles) => new Set(profiles.map((profile) => profile.role)).size === profiles.length,
      {
        message: 'each role may appear at most once',
      },
    ),
});

export const startAgentRunResponseSchema = z.strictObject({
  run: agentRunSummarySchema,
});

export const sendAgentRunMessageRequestSchema = z.strictObject({
  text: boundedUtf8(50000).min(1),
});

export const agentRunCommandResponseSchema = z.strictObject({
  run: agentRunSummarySchema,
  accepted: z.boolean(),
});

export const endAgentRunRequestSchema = z.strictObject({});
export const cancelAgentRunRequestSchema = z.strictObject({});

/** Everything the work-item page needs to show delegation state. */
export const workItemExecutionResponseSchema = z.strictObject({
  workItemId: workItemIdSchema,
  worktrees: z.array(worktreeSummarySchema).max(100),
  runs: z.array(agentRunSummarySchema).max(200),
  /** One gate per active worktree, keyed by worktree id. */
  mergeGates: z.record(worktreeIdSchema, mergeGateSchema),
});

/** A run with enough context to be listed outside its work item. */
export const runOverviewSchema = agentRunSummarySchema.safeExtend({
  workItemSourceId: z.string().min(1).max(64),
  workItemTitle: z.string().min(1).max(300),
  projectName: z.string().min(1).max(120),
  branchName: gitBranchNameSchema,
});

export const workspaceRunsResponseSchema = z.strictObject({
  runs: z.array(runOverviewSchema).max(100),
  liveCount: nonNegativeSafeInteger,
});

/* -------------------------------------------------------------------------- */
/* Run events (per-run SSE)                                                    */
/* -------------------------------------------------------------------------- */

const runEventBaseSchema = z.strictObject({
  sequence: positiveSafeInteger,
  id: agentRunEventIdSchema,
  workspaceId: workspaceIdSchema,
  runId: agentRunIdSchema,
  occurredAt: z.iso.datetime(),
  raw: z.string().optional(),
});

export const runEventEnvelopeSchema = z.discriminatedUnion('kind', [
  runEventBaseSchema.extend({
    kind: z.literal('session-started'),
    payload: z.strictObject({
      backend: z.enum(AGENT_BACKENDS),
      backendSessionId: z.string().min(1).max(200),
      model: z.string().min(1).max(100),
      permissionMode: z.enum(AGENT_PERMISSION_MODES),
      cwd: sourceRepositoryPathSchema,
      billing: z.enum(AGENT_BILLING_SOURCES),
      loaded: z
        .strictObject({
          skills: z.array(z.string().max(200)).max(500),
          plugins: z.array(z.string().max(200)).max(500),
          mcpServers: z.array(z.string().max(200)).max(500),
        })
        .optional(),
    }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('user-message'),
    payload: z.strictObject({
      text: z.string(),
      handoffSources: z
        .array(z.strictObject({ runId: agentRunIdSchema, throughSequence: nonNegativeSafeInteger }))
        .max(1000)
        .optional(),
    }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('assistant-message'),
    payload: z.strictObject({ text: z.string(), truncated: z.boolean().optional() }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('tool-call'),
    payload: z.strictObject({
      toolUseId: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      input: jsonValueSchema,
      summary: z.string().max(2000),
    }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('tool-result'),
    payload: z.strictObject({
      toolUseId: z.string().min(1).max(200),
      content: z.string(),
      isError: z.boolean(),
      truncated: z.boolean(),
      body: z
        .strictObject({
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: positiveSafeInteger,
        })
        .optional(),
    }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('turn-completed'),
    payload: z.strictObject({
      providerFailure: providerFailureSchema.optional(),
      suspectedOutage: providerFailureSchema.optional(),
      outcome: z.enum(['success', 'error']),
      resultText: z.string(),
      truncated: z.boolean().optional(),
      reviewReport: reviewReportAssessmentSchema.optional(),
      costUsd: z.number().nonnegative().optional(),
      turns: nonNegativeSafeInteger,
      durationMs: nonNegativeSafeInteger,
      model: z.string().min(1).max(100).optional(),
      tokenUsage: z
        .strictObject({
          inputTokens: nonNegativeSafeInteger,
          cachedInputTokens: nonNegativeSafeInteger,
          outputTokens: nonNegativeSafeInteger,
          reasoningOutputTokens: nonNegativeSafeInteger,
          totalTokens: nonNegativeSafeInteger,
        })
        .optional(),
    }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('notice'),
    payload: z.strictObject({
      category: z.enum(AGENT_NOTICE_CATEGORIES),
      message: z.string().max(4000),
    }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('stderr'),
    payload: z.strictObject({ text: z.string() }),
  }),
  runEventBaseSchema.extend({
    kind: z.literal('run-finished'),
    payload: z.strictObject({
      reason: z.enum(AGENT_EXIT_REASONS).optional(),
      status: z.enum(['finished', 'failed', 'cancelled', 'interrupted']),
      exitCode: z.number().int().optional(),
      signal: z.string().max(20).optional(),
      message: z.string().max(4000).optional(),
    }),
  }),
]);

export const runEventPageResponseSchema = z.strictObject({
  events: z.array(runEventEnvelopeSchema).max(500),
  nextAfter: nonNegativeSafeInteger,
});

export type ExecutionStatusResponse = z.infer<typeof executionStatusResponseSchema>;
export type SourceRepositorySummary = z.infer<typeof sourceRepositorySummarySchema>;
export type RegisterSourceRepositoryRequest = z.infer<typeof registerSourceRepositoryRequestSchema>;
export type RegisterSourceRepositoryResponse = z.infer<
  typeof registerSourceRepositoryResponseSchema
>;
export type SourceRepositoryListResponse = z.infer<typeof sourceRepositoryListResponseSchema>;
export type RetireSourceRepositoryResponse = z.infer<typeof retireSourceRepositoryResponseSchema>;
export type WorktreeSummary = z.infer<typeof worktreeSummarySchema>;
export type CreateWorktreeRequest = z.infer<typeof createWorktreeRequestSchema>;
export type CreateWorktreeResponse = z.infer<typeof createWorktreeResponseSchema>;
export type RemoveWorktreeRequest = z.infer<typeof removeWorktreeRequestSchema>;
export type RemoveWorktreeResponse = z.infer<typeof removeWorktreeResponseSchema>;
export type MergeGate = z.infer<typeof mergeGateSchema>;
export type MergeWorktreeRequest = z.infer<typeof mergeWorktreeRequestSchema>;
export type RepositoryBranchesResponse = z.infer<typeof repositoryBranchesResponseSchema>;
export type MergeWorktreeResponse = z.infer<typeof mergeWorktreeResponseSchema>;
export type RunOverview = z.infer<typeof runOverviewSchema>;
export type WorkspaceRunsResponse = z.infer<typeof workspaceRunsResponseSchema>;
export type WorktreeDiffFile = z.infer<typeof worktreeDiffFileSchema>;
export type WorktreeDiffResponse = z.infer<typeof worktreeDiffResponseSchema>;
export type DiffFileStatus = z.infer<typeof diffFileStatusSchema>;
export type AgentRunSummary = z.infer<typeof agentRunSummarySchema>;
export type AgentRunDetailResponse = z.infer<typeof agentRunDetailResponseSchema>;
export type AgentRunProfileEntry = z.infer<typeof runProfilesResponseSchema>['profiles'][number];
export type RunProfilesResponse = z.infer<typeof runProfilesResponseSchema>;
export type SaveRunProfilesRequest = z.infer<typeof saveRunProfilesRequestSchema>;
export type StartAgentRunRequest = z.infer<typeof startAgentRunRequestSchema>;
export type StartAgentRunResponse = z.infer<typeof startAgentRunResponseSchema>;
export type SendAgentRunMessageRequest = z.infer<typeof sendAgentRunMessageRequestSchema>;
export type AgentRunCommandResponse = z.infer<typeof agentRunCommandResponseSchema>;
export type WorkItemExecutionResponse = z.infer<typeof workItemExecutionResponseSchema>;
export type RunEventEnvelope = z.infer<typeof runEventEnvelopeSchema>;
export type RunEventPageResponse = z.infer<typeof runEventPageResponseSchema>;

export const planBranchSettingsSchema = z.strictObject({
  manualMergeBranches: z.array(gitBranchNameSchema).max(30).readonly().optional(),
  workspaceId: workspaceIdSchema,
  planVersionId: planVersionIdSchema,
  repositoryId: sourceRepositoryIdSchema,
  integrationBranch: gitBranchNameSchema,
  updatedAt: z.iso.datetime(),
  updatedByUserId: userIdSchema,
  version: positiveSafeInteger,
});
export const planBranchSettingsResponseSchema = z.strictObject({
  integrationBranchRemoved: z.boolean().optional(),
  missingEvidence: z
    .array(z.strictObject({ workItemId: workItemIdSchema, sourceId: z.string() }))
    .max(1000)
    .default([]),
  settings: planBranchSettingsSchema.optional(),
  headSha: gitShaSchema.optional(),
  issues: z.array(z.string()).max(1000),
});
export const savePlanBranchSettingsRequestSchema = z.strictObject({
  manualMergeBranches: z.array(gitBranchNameSchema).max(30).readonly().optional(),
  repositoryId: sourceRepositoryIdSchema,
  integrationBranch: gitBranchNameSchema,
  expectedVersion: nonNegativeSafeInteger,
  /** Only this explicit action may create an integration branch. */
  createFromBranch: gitBranchNameSchema.optional(),
});
export const worktreeBranchStatusResponseSchema = z.strictObject({
  worktree: worktreeSummarySchema,
  headSha: gitShaSchema.optional(),
  targetSha: gitShaSchema.optional(),
  containsTarget: z.boolean().optional(),
  reviewCurrent: z.boolean(),
  issues: z.array(z.string()).max(1000),
});
export const retargetWorktreeRequestSchema = z.strictObject({
  integrationBranch: gitBranchNameSchema,
  expectedVersion: positiveSafeInteger,
});
export const updateWorktreeRequestSchema = z.strictObject({
  expectedVersion: positiveSafeInteger,
});
export type PlanBranchSettingsResponse = z.infer<typeof planBranchSettingsResponseSchema>;
export type SavePlanBranchSettingsRequest = z.infer<typeof savePlanBranchSettingsRequestSchema>;
export type WorktreeBranchStatusResponse = z.infer<typeof worktreeBranchStatusResponseSchema>;

export const recordIntegrationEvidenceRequestSchema = z.strictObject({ commitSha: gitShaSchema });
