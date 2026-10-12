import {
  AGENT_BACKENDS,
  AGENT_RUN_ROLES,
  AGENT_RUN_STATUSES,
  type ConcurrencyDefinitionId,
  type RoadmapId,
  type WorkCycleId,
  type WorkItemSourceId,
} from '@craftingtable/domain';
import { z } from 'zod';
import {
  gitBranchNameSchema,
  gitShaSchema,
  sourceRepositoryDisplayNameSchema,
  sourceRepositoryPathSchema,
} from './execution.js';
import {
  agentRunIdSchema,
  branded,
  eventIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';

export const SSE_WORKSPACE_EVENT_NAME = 'workspace-event';
export const SSE_AUTHENTICATION_EXPIRED_EVENT_NAME = 'authentication-expired';

const workspaceEventBaseSchema = z.strictObject({
  id: eventIdSchema,
  sequence: z.number().int().positive().safe(),
  occurredAt: z.iso.datetime(),
  workspaceId: workspaceIdSchema,
  actorUserId: userIdSchema.optional(),
  projectId: projectIdSchema.optional(),
  workItemId: workItemIdSchema.optional(),
  runId: agentRunIdSchema.optional(),
  schemaVersion: z.literal(1),
});

const forbiddenCorrelationSchema = z.never().optional();
const positiveSafeIntegerSchema = z.number().int().positive().safe();

const workspaceCreatedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('workspace-created'),
  payload: z.strictObject({
    name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
});

const projectCreatedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('project-created'),
  payload: z.strictObject({
    projectId: projectIdSchema,
    name: z.string().min(1).max(120),
  }),
});

/**
 * One summary event per import, never one per imported work item: the
 * authoritative work-item table carries the detail (CT-03 §5.9).
 */
const planVersionImportedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('plan-version-imported'),
  payload: z.strictObject({
    projectId: projectIdSchema,
    planVersionId: planVersionIdSchema,
    versionNumber: z.number().int().positive().safe(),
    document: z.string().min(1).max(300),
    itemCount: z.number().int().nonnegative().safe(),
    requiredDependencyCount: z.number().int().nonnegative().safe(),
    warningCount: z.number().int().nonnegative().safe(),
  }),
});

const workItemAdmittedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('work-item-admitted'),
  payload: z.strictObject({
    projectId: projectIdSchema,
    planVersionId: planVersionIdSchema,
    workItemId: workItemIdSchema,
    sourceWorkItemId: branded<WorkItemSourceId>(z.string().min(1).max(64)),
  }),
});

const workItemRemovedFromAgendaEventSchema = workItemAdmittedEventSchema.extend({
  kind: z.literal('work-item-removed-from-agenda'),
  payload: workItemAdmittedEventSchema.shape.payload,
});

const sourceRepositoryRegisteredEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('source-repository-registered'),
  projectId: forbiddenCorrelationSchema,
  workItemId: forbiddenCorrelationSchema,
  runId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    sourceRepositoryId: sourceRepositoryIdSchema,
    displayName: sourceRepositoryDisplayNameSchema,
    rootPath: sourceRepositoryPathSchema,
    defaultBranch: gitBranchNameSchema,
  }),
});

const requireWorkItemAgreement = (
  event: { workItemId?: string; payload: { workItemId?: string; planVersionId?: string } },
  context: z.RefinementCtx,
): void => {
  if ((event.workItemId === undefined) === (event.payload.planVersionId === undefined))
    context.addIssue({
      code: 'custom',
      path: ['payload'],
      message: 'Execution requires exactly one work-item or plan subject',
    });
  if (event.workItemId !== event.payload.workItemId) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'workItemId'],
      message: 'payload workItemId must agree with structural workItemId',
    });
  }
};

const worktreeCreatedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('worktree-created'),
    projectId: projectIdSchema,
    workItemId: workItemIdSchema.optional(),
    runId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      planVersionId: planVersionIdSchema.optional(),
      worktreeId: worktreeIdSchema,
      sourceRepositoryId: sourceRepositoryIdSchema,
      workItemId: workItemIdSchema.optional(),
      branchName: gitBranchNameSchema,
      baseSha: gitShaSchema,
    }),
  })
  .superRefine(requireWorkItemAgreement);

const worktreeRemovedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('worktree-removed'),
    projectId: projectIdSchema,
    workItemId: workItemIdSchema.optional(),
    runId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      planVersionId: planVersionIdSchema.optional(),
      worktreeId: worktreeIdSchema,
      workItemId: workItemIdSchema.optional(),
      branchName: gitBranchNameSchema,
    }),
  })
  .superRefine(requireWorkItemAgreement);

const requireRunAgreement = (
  event: { runId: string; payload: { runId: string } },
  context: z.RefinementCtx,
): void => {
  if (event.runId !== event.payload.runId) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'runId'],
      message: 'payload runId must agree with structural runId',
    });
  }
};

const agentRunStartedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('agent-run-started'),
    projectId: projectIdSchema,
    workItemId: workItemIdSchema.optional(),
    runId: agentRunIdSchema,
    payload: z.strictObject({
      planVersionId: planVersionIdSchema.optional(),
      runId: agentRunIdSchema,
      worktreeId: worktreeIdSchema,
      workItemId: workItemIdSchema.optional(),
      backend: z.enum(AGENT_BACKENDS),
      role: z.enum(AGENT_RUN_ROLES),
    }),
  })
  .superRefine((event, context) => {
    requireWorkItemAgreement(event, context);
    requireRunAgreement(event, context);
  });

const agentRunStatusChangedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('agent-run-status-changed'),
    projectId: projectIdSchema,
    workItemId: workItemIdSchema.optional(),
    runId: agentRunIdSchema,
    payload: z.strictObject({
      planVersionId: planVersionIdSchema.optional(),
      runId: agentRunIdSchema,
      workItemId: workItemIdSchema.optional(),
      fromStatus: z.enum(AGENT_RUN_STATUSES),
      toStatus: z.enum(AGENT_RUN_STATUSES),
    }),
  })
  .superRefine((event, context) => {
    requireWorkItemAgreement(event, context);
    requireRunAgreement(event, context);
    if (event.payload.fromStatus === event.payload.toStatus) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'toStatus'],
        message: 'run status must change',
      });
    }
  });

const workspaceUpdatedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('workspace-updated'),
  projectId: forbiddenCorrelationSchema,
  workItemId: forbiddenCorrelationSchema,
  runId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    name: z.string().min(1).max(120),
    priorVersion: positiveSafeIntegerSchema,
    resultingVersion: positiveSafeIntegerSchema,
  }),
});

const workItemCompletedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('work-item-completed'),
    projectId: projectIdSchema,
    workItemId: workItemIdSchema,
    runId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      projectId: projectIdSchema,
      workItemId: workItemIdSchema,
      sourceWorkItemId: branded<WorkItemSourceId>(z.string().min(1).max(64)),
      worktreeId: worktreeIdSchema.optional(),
      mergeSha: gitShaSchema.optional(),
    }),
  })
  .superRefine(requireWorkItemAgreement);

const worktreeMergedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('worktree-merged'),
    projectId: projectIdSchema,
    workItemId: workItemIdSchema.optional(),
    runId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      planVersionId: planVersionIdSchema.optional(),
      worktreeId: worktreeIdSchema,
      workItemId: workItemIdSchema.optional(),
      branchName: gitBranchNameSchema,
      targetBranch: gitBranchNameSchema,
      mergeSha: gitShaSchema,
    }),
  })
  .superRefine(requireWorkItemAgreement);

const workCycleChangedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('work-cycle-changed'),
    projectId: projectIdSchema,
    workItemId: workItemIdSchema.optional(),
    runId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      planVersionId: planVersionIdSchema.optional(),
      cycleId: branded<WorkCycleId>(z.string().uuid()),
      status: z.enum([
        'running',
        'paused',
        'needs-attention',
        'awaiting-merge',
        'stopped',
        'completed',
      ]),
      step: z.enum(['design', 'implement', 'review', 'remediate']),
      reason: z.string().max(4000),
    }),
  })
  .superRefine((event, context) => {
    if ((event.workItemId === undefined) === (event.payload.planVersionId === undefined))
      context.addIssue({
        code: 'custom',
        path: ['payload'],
        message: 'Cycle requires a work-item or plan subject',
      });
  });

const branchesChangedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('branches-changed'),
  projectId: projectIdSchema,
  workItemId: forbiddenCorrelationSchema,
  runId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    planVersionId: planVersionIdSchema,
    action: z.enum(['configured', 'retargeted', 'update-requested', 'updated']),
  }),
});

const notificationsChangedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('notifications-changed'),
  projectId: forbiddenCorrelationSchema,
  workItemId: forbiddenCorrelationSchema,
  runId: forbiddenCorrelationSchema,
  payload: z.strictObject({ action: z.enum(['settings', 'attention', 'delivery', 'test']) }),
});

const attentionChangedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('attention-changed'),
  projectId: forbiddenCorrelationSchema,
  workItemId: forbiddenCorrelationSchema,
  runId: forbiddenCorrelationSchema,
  payload: z.strictObject({ open: z.number().int().nonnegative() }),
});

const roadmapChangedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('roadmap-changed'),
  projectId: forbiddenCorrelationSchema,
  workItemId: forbiddenCorrelationSchema,
  runId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    roadmapId: branded<RoadmapId>(z.string().uuid()),
    status: z.enum(['draft', 'running', 'paused', 'needs-attention', 'stopped', 'completed']),
    reason: z.string().max(4000),
  }),
});
const scopeEvidenceRecordedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('scope-evidence-recorded'),
  projectId: forbiddenCorrelationSchema,
  workItemId: forbiddenCorrelationSchema,
  runId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    workItemId: workItemIdSchema,
    worktreeId: worktreeIdSchema,
    sourceId: z.string().min(1).max(200),
    parentAccepted: z.boolean(),
  }),
});
export const workspaceEventEnvelopeSchema = z.discriminatedUnion('kind', [
  scopeEvidenceRecordedEventSchema.extend({
    kind: z.literal('runtime-evidence-changed'),
    payload: z.strictObject({
      definitionId: branded<ConcurrencyDefinitionId>(z.uuid()),
      message: z.string().min(1).max(500),
    }),
  }),
  scopeEvidenceRecordedEventSchema,
  scopeEvidenceRecordedEventSchema.extend({
    kind: z.literal('scope-scheduling-authorized'),
    payload: z.strictObject({ workItemId: workItemIdSchema, sourceId: z.string().min(1).max(200) }),
  }),
  notificationsChangedEventSchema,
  attentionChangedEventSchema,
  roadmapChangedEventSchema,
  workspaceCreatedEventSchema,
  projectCreatedEventSchema,
  planVersionImportedEventSchema,
  workItemAdmittedEventSchema,
  workItemRemovedFromAgendaEventSchema,
  sourceRepositoryRegisteredEventSchema,
  worktreeCreatedEventSchema,
  worktreeRemovedEventSchema,
  agentRunStartedEventSchema,
  agentRunStatusChangedEventSchema,
  workspaceUpdatedEventSchema,
  workItemCompletedEventSchema,
  worktreeMergedEventSchema,
  workCycleChangedEventSchema,
  branchesChangedEventSchema,
]);

export const authenticationExpiredEventSchema = z.strictObject({
  reason: z.literal('session-invalid'),
});

export type WorkspaceEventEnvelope = z.infer<typeof workspaceEventEnvelopeSchema>;
