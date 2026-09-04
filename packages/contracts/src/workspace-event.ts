import {
  REPOSITORY_STATUS_REASON_SETS,
  REPOSITORY_STATUSES,
  REPOSITORY_STATUS_REASONS,
} from '@craftingtable/domain';
import { z } from 'zod';
import {
  agentRunIdSchema,
  eventIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  projectRepositoryBindingIdSchema,
  repositoryIdSchema,
  repositoryInspectionIdSchema,
  userIdSchema,
  workContractDraftIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from './ids.js';
import { repositoryDisplayNameSchema } from './repository.js';

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

export const workspaceCreatedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('workspace-created'),
  repositoryId: forbiddenCorrelationSchema,
  repositoryInspectionId: forbiddenCorrelationSchema,
  repositoryBindingId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
});

export const projectCreatedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('project-created'),
  repositoryId: forbiddenCorrelationSchema,
  repositoryInspectionId: forbiddenCorrelationSchema,
  repositoryBindingId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    projectId: projectIdSchema,
    name: z.string().min(1).max(120),
  }),
});

/**
 * One summary event per import, never one per imported work item: the
 * authoritative work-item table carries the detail (CT-03 §5.9).
 */
export const planVersionImportedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('plan-version-imported'),
  repositoryId: forbiddenCorrelationSchema,
  repositoryInspectionId: forbiddenCorrelationSchema,
  repositoryBindingId: forbiddenCorrelationSchema,
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

export const workItemAdmittedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('work-item-admitted'),
  repositoryId: forbiddenCorrelationSchema,
  repositoryInspectionId: forbiddenCorrelationSchema,
  repositoryBindingId: forbiddenCorrelationSchema,
  payload: z.strictObject({
    projectId: projectIdSchema,
    planVersionId: planVersionIdSchema,
    workItemId: workItemIdSchema,
    sourceWorkItemId: z.string().min(1).max(64),
    workContractDraftId: workContractDraftIdSchema,
  }),
});

export const repositoryRegisteredEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('repository-registered'),
    projectId: forbiddenCorrelationSchema,
    workItemId: forbiddenCorrelationSchema,
    runId: forbiddenCorrelationSchema,
    repositoryId: repositoryIdSchema,
    repositoryInspectionId: repositoryInspectionIdSchema,
    repositoryBindingId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      repositoryId: repositoryIdSchema,
      inspectionId: repositoryInspectionIdSchema,
      displayName: repositoryDisplayNameSchema,
      status: z.literal('active'),
      statusReason: z.literal('registration-accepted'),
      version: z.literal(1),
    }),
  })
  .superRefine((event, context) => {
    if (event.repositoryId !== event.payload.repositoryId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'repositoryId'],
        message: 'payload repositoryId must agree with structural repositoryId',
      });
    }
    if (event.repositoryInspectionId !== event.payload.inspectionId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'inspectionId'],
        message: 'payload inspectionId must agree with structural repositoryInspectionId',
      });
    }
  });

export const repositoryStatusChangedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('repository-status-changed'),
    projectId: forbiddenCorrelationSchema,
    workItemId: forbiddenCorrelationSchema,
    runId: forbiddenCorrelationSchema,
    repositoryId: repositoryIdSchema,
    repositoryInspectionId: repositoryInspectionIdSchema.optional(),
    repositoryBindingId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      repositoryId: repositoryIdSchema,
      inspectionId: repositoryInspectionIdSchema.optional(),
      displayName: repositoryDisplayNameSchema,
      fromStatus: z.enum(REPOSITORY_STATUSES),
      toStatus: z.enum(REPOSITORY_STATUSES),
      statusReason: z.enum(REPOSITORY_STATUS_REASONS),
      priorVersion: positiveSafeIntegerSchema,
      resultingVersion: positiveSafeIntegerSchema,
    }),
  })
  .superRefine((event, context) => {
    if (event.repositoryId !== event.payload.repositoryId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'repositoryId'],
        message: 'payload repositoryId must agree with structural repositoryId',
      });
    }
    if (event.payload.fromStatus === event.payload.toStatus) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'toStatus'],
        message: 'repository status must change',
      });
    }
    const allowedReasons: readonly string[] = REPOSITORY_STATUS_REASON_SETS[event.payload.toStatus];
    if (!allowedReasons.includes(event.payload.statusReason)) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'statusReason'],
        message: 'repository status and reason do not agree',
      });
    }
    if (event.payload.resultingVersion !== event.payload.priorVersion + 1) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'resultingVersion'],
        message: 'resultingVersion must equal priorVersion plus one',
      });
    }

    const retirement =
      event.payload.toStatus === 'retired' && event.payload.statusReason === 'operator-retired';
    if (retirement) {
      if (event.repositoryInspectionId !== undefined || event.payload.inspectionId !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['repositoryInspectionId'],
          message: 'operator retirement must not carry an inspection correlation',
        });
      }
    } else if (
      event.repositoryInspectionId === undefined ||
      event.payload.inspectionId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['repositoryInspectionId'],
        message: 'non-retirement status changes require an inspection correlation',
      });
    } else if (event.repositoryInspectionId !== event.payload.inspectionId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'inspectionId'],
        message: 'payload inspectionId must agree with structural repositoryInspectionId',
      });
    }
  });

export const repositoryEvidenceChangedEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('repository-evidence-changed'),
    projectId: forbiddenCorrelationSchema,
    workItemId: forbiddenCorrelationSchema,
    runId: forbiddenCorrelationSchema,
    repositoryId: repositoryIdSchema,
    repositoryInspectionId: repositoryInspectionIdSchema,
    repositoryBindingId: forbiddenCorrelationSchema,
    payload: z.strictObject({
      repositoryId: repositoryIdSchema,
      inspectionId: repositoryInspectionIdSchema,
      displayName: repositoryDisplayNameSchema,
      evidenceClass: z.literal('risk-scan'),
      repositoryVersion: positiveSafeIntegerSchema,
    }),
  })
  .superRefine((event, context) => {
    if (event.repositoryId !== event.payload.repositoryId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'repositoryId'],
        message: 'payload repositoryId must agree with structural repositoryId',
      });
    }
    if (event.repositoryInspectionId !== event.payload.inspectionId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'inspectionId'],
        message: 'payload inspectionId must agree with structural repositoryInspectionId',
      });
    }
  });

export const projectRepositoryBoundEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('project-repository-bound'),
    projectId: projectIdSchema,
    workItemId: forbiddenCorrelationSchema,
    runId: forbiddenCorrelationSchema,
    repositoryId: repositoryIdSchema,
    repositoryInspectionId: forbiddenCorrelationSchema,
    repositoryBindingId: projectRepositoryBindingIdSchema,
    payload: z.strictObject({
      projectId: projectIdSchema,
      repositoryId: repositoryIdSchema,
      bindingId: projectRepositoryBindingIdSchema,
      repositoryDisplayName: repositoryDisplayNameSchema,
      bindingVersion: z.literal(1),
    }),
  })
  .superRefine((event, context) => {
    if (event.projectId !== event.payload.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'projectId'],
        message: 'payload projectId must agree with structural projectId',
      });
    }
    if (event.repositoryId !== event.payload.repositoryId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'repositoryId'],
        message: 'payload repositoryId must agree with structural repositoryId',
      });
    }
    if (event.repositoryBindingId !== event.payload.bindingId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'bindingId'],
        message: 'payload bindingId must agree with structural repositoryBindingId',
      });
    }
  });

export const projectRepositoryBindingRetiredEventSchema = workspaceEventBaseSchema
  .extend({
    kind: z.literal('project-repository-binding-retired'),
    projectId: projectIdSchema,
    workItemId: forbiddenCorrelationSchema,
    runId: forbiddenCorrelationSchema,
    repositoryId: repositoryIdSchema,
    repositoryInspectionId: forbiddenCorrelationSchema,
    repositoryBindingId: projectRepositoryBindingIdSchema,
    payload: z.strictObject({
      projectId: projectIdSchema,
      repositoryId: repositoryIdSchema,
      bindingId: projectRepositoryBindingIdSchema,
      repositoryDisplayName: repositoryDisplayNameSchema,
      priorVersion: positiveSafeIntegerSchema,
      resultingVersion: positiveSafeIntegerSchema,
    }),
  })
  .superRefine((event, context) => {
    if (event.projectId !== event.payload.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'projectId'],
        message: 'payload projectId must agree with structural projectId',
      });
    }
    if (event.repositoryId !== event.payload.repositoryId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'repositoryId'],
        message: 'payload repositoryId must agree with structural repositoryId',
      });
    }
    if (event.repositoryBindingId !== event.payload.bindingId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'bindingId'],
        message: 'payload bindingId must agree with structural repositoryBindingId',
      });
    }
    if (event.payload.resultingVersion !== event.payload.priorVersion + 1) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'resultingVersion'],
        message: 'resultingVersion must equal priorVersion plus one',
      });
    }
  });

export const workspaceEventEnvelopeSchema = z.discriminatedUnion('kind', [
  workspaceCreatedEventSchema,
  projectCreatedEventSchema,
  planVersionImportedEventSchema,
  workItemAdmittedEventSchema,
  repositoryRegisteredEventSchema,
  repositoryStatusChangedEventSchema,
  repositoryEvidenceChangedEventSchema,
  projectRepositoryBoundEventSchema,
  projectRepositoryBindingRetiredEventSchema,
]);

export const authenticationExpiredEventSchema = z.strictObject({
  reason: z.literal('session-invalid'),
});

export type WorkspaceEventEnvelope = z.infer<typeof workspaceEventEnvelopeSchema>;
export type WorkspaceCreatedEventEnvelope = z.infer<typeof workspaceCreatedEventSchema>;
export type RepositoryRegisteredEventEnvelope = z.infer<typeof repositoryRegisteredEventSchema>;
export type RepositoryStatusChangedEventEnvelope = z.infer<
  typeof repositoryStatusChangedEventSchema
>;
export type RepositoryEvidenceChangedEventEnvelope = z.infer<
  typeof repositoryEvidenceChangedEventSchema
>;
export type ProjectRepositoryBoundEventEnvelope = z.infer<typeof projectRepositoryBoundEventSchema>;
export type ProjectRepositoryBindingRetiredEventEnvelope = z.infer<
  typeof projectRepositoryBindingRetiredEventSchema
>;
