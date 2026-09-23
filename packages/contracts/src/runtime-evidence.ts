import { z } from 'zod';
import { architectureRecommendationSchema } from './design-report.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(16000);
export const evidenceSubjectSchema = z.strictObject({
  kind: z.enum(['checkpoint', 'slice', 'parent']),
  sourceId: name,
});
export const qualificationEnvironmentSchema = z.strictObject({
  id: name,
  kind: z.enum(['local-development', 'external-native', 'external-kata']),
  identityDigest: digest,
  fixtureDigest: digest,
  toolchainDigest: digest,
  authorization: text,
  discovery: z
    .strictObject({
      kind: z.literal('local-discovery-v1'),
      environment: z.string().max(65536),
      fixtures: z.string().max(262144),
      toolchains: z.string().max(65536),
    })
    .optional(),
});
export const cratePinSchema = z.strictObject({
  version: name.optional(),
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(100),
  path: z
    .string()
    .max(300)
    .regex(/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$|^$/)
    .refine((p) => !p.split('/').some((x) => x === '.' || x === '..' || x === '.git')),
});
export const configureRuntimeSchema = z.strictObject({
  bindingRevision: z.number().int().positive(),
  expectedGeneration: z.number().int().nonnegative(),
  pins: z
    .array(
      z.strictObject({
        alias: name,
        ref: z.string().min(1).max(200),
        expectedCommitSha: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .optional(),
        conformanceRevision: name,
        packages: z.array(cratePinSchema).max(150),
      }),
    )
    .max(20),
  consumers: z.array(z.strictObject({ alias: name, upstreams: z.array(name).max(20) })).max(20),
  environments: z.array(qualificationEnvironmentSchema).min(1).max(20),
});
const runtimePinSchema = z.strictObject({
  alias: name,
  ref: name,
  repositoryId: z.string(),
  commitSha: name,
  treeSha: name,
  conformanceRevision: name,
  packages: z.array(cratePinSchema),
});
export const runtimeGenerationSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.string(),
  definitionId: z.uuid(),
  bindingRevision: z.number(),
  generation: z.number(),
  digest,
  createdAt: z.iso.datetime(),
  createdByUserId: z.string(),
  pins: z.array(runtimePinSchema),
  consumers: z.array(z.strictObject({ alias: name, upstreams: z.array(name) })),
  environments: z.array(qualificationEnvironmentSchema),
});
export const evidenceSubmissionRequestSchema = z
  .strictObject({
    runtimeId: z.uuid(),
    subject: evidenceSubjectSchema,
    testedCode: z
      .array(z.strictObject({ alias: name, commitSha: z.string().regex(/^[a-f0-9]{40,64}$/) }))
      .max(20)
      .optional(),
    subjectCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    environmentId: name,
    executedBy: name,
    executedAt: z.iso.datetime(),
    reviewers: z
      .array(
        z.strictObject({ identity: name, roles: z.array(name).min(1).max(20), artifact: name }),
      )
      .min(1)
      .max(20),
    requirements: z.array(z.strictObject({ requirement: text, artifact: name })).max(250),
    cases: z
      .array(
        z.strictObject({
          id: name,
          sourceRecordDigest: digest,
          result: z.enum(['passed', 'failed']),
          artifact: name,
        }),
      )
      .max(1000),
    artifacts: z
      .array(
        z.strictObject({
          name,
          content: z
            .string()
            .min(1)
            .max(512 * 1024),
        }),
      )
      .min(1)
      .max(50),
    sourceRunId: z.string().min(1).max(100).optional(),
    kata: z
      .strictObject({
        runtime: z.literal('kata'),
        hostIdentity: name,
        vmIdentity: name,
        imageDigest: digest,
        configurationDigest: digest,
        observationArtifact: name,
        noNativeFallback: z.literal(true),
      })
      .optional(),
  })
  .superRefine((v, c) => {
    if (
      v.artifacts.reduce((n, a) => n + new TextEncoder().encode(a.content).length, 0) >
      4 * 1024 * 1024
    )
      c.addIssue({ code: 'custom', message: 'Evidence artifacts exceed 4 MiB.' });
  });
export const evidenceDecisionRequestSchema = z.strictObject({
  submissionId: z.uuid(),
  outcome: z.enum(['accepted', 'rejected']),
  rationale: text,
  checkpointReviewRoles: z.array(name).min(1).max(20).optional(),
});
export const candidateCheckpointSchema = z.strictObject({
  kind: z.literal('reviewed-candidate-v1'),
  delegatedReview: z
    .strictObject({
      cycleId: z.uuid(),
      roadmapId: z.uuid(),
      definitionRevision: z.number().int().positive(),
      roles: z.array(name).max(30),
    })
    .optional(),
  worktreeId: z.uuid(),
  sliceId: name,
  runId: z.uuid(),
  reportDigest: digest,
  buildDigest: digest,
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  integrationSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  snapshotDigest: digest,
});
export const prepareCheckpointRequestSchema = z.strictObject({
  worktreeId: z.uuid(),
  checkpointId: name,
  snapshotDigest: digest,
});
export const generatedPlanEvidenceSchema = z.strictObject({
  kind: z.literal('saved-plan-v1'),
  roadmapId: z.uuid(),
  definitionRevision: z.number().int().positive(),
  snapshotDigest: digest,
});
export const generatePlanEvidenceRequestSchema = z.strictObject({
  roadmapId: z.uuid(),
  definitionRevision: z.number().int().positive(),
  snapshotDigest: digest,
});
export const architectureDecisionInputSchema = z.strictObject({
  coverage: z.enum(['full', 'clauses']),
  proposal: text,
  sourceReferences: z.string().trim().min(1).max(65536),
  retainedObligations: z.string().trim().max(16000),
  consumers: z
    .array(
      z.strictObject({
        sliceId: name,
        phase: z.enum(['start', 'merge']),
        replacesFullCheckpoint: z.boolean(),
      }),
    )
    .max(30),
});
export const proposeArchitectureDecisionSchema = architectureDecisionInputSchema
  .extend({
    checkpointId: name,
    bindingRevision: z.number().int().positive(),
    sourceRunId: z.uuid().optional(),
    sourceReportDigest: digest.optional(),
  })
  .refine(
    (v) => !v.sourceReportDigest || !!v.sourceRunId,
    'A report digest requires its source run.',
  );
export type ProposeArchitectureDecision = z.infer<typeof proposeArchitectureDecisionSchema>;
export const architectureDecisionSchema = architectureDecisionInputSchema.extend({
  kind: z.literal('architecture-decision-v1'),
  bindingDigest: digest,
});
export const evidenceSubmissionSchema = evidenceSubmissionRequestSchema.safeExtend({
  candidateCheckpoint: candidateCheckpointSchema.optional(),
  architectureDecision: architectureDecisionSchema.optional(),
  generatedPlan: generatedPlanEvidenceSchema.optional(),
  reviewers: z
    .array(z.strictObject({ identity: name, roles: z.array(name).min(1).max(20), artifact: name }))
    .max(20),
  id: z.uuid(),
  workspaceId: z.string(),
  definitionId: z.uuid(),
  bindingRevision: z.number(),
  createdAt: z.iso.datetime(),
  createdByUserId: z.string(),
  artifacts: z.array(z.strictObject({ name, content: z.string(), digest })),
  sourceRunDigest: digest.optional(),
  sourceRunCommit: name.optional(),
  sliceMergeSha: name.optional(),
});
export const evidenceDecisionSchema = z.strictObject({
  checkpointReviewRoles: z.array(name).readonly().optional(),
  id: z.uuid(),
  workspaceId: z.string(),
  submissionId: z.uuid(),
  outcome: z.enum(['accepted', 'rejected']),
  rationale: text,
  decidedAt: z.iso.datetime(),
  decidedByUserId: z.string(),
});
export const checkpointRecoverySchema = z.strictObject({
  worktreeId: z.uuid(),
  candidates: z.array(
    z.strictObject({
      checkpointId: name,
      title: z.string(),
      requirements: z.array(z.string()),
      reviewerRoles: z.array(z.string()),
      cases: z.array(z.strictObject({ id: name, sourceRecordDigest: digest })),
      laterCases: z.array(z.strictObject({ id: name, sliceId: name })),
      issues: z.array(z.string()),
      snapshotDigest: digest,
      runId: z.string().optional(),
      headSha: z.string().optional(),
      integrationSha: z.string().optional(),
      report: z.string(),
      buildReceipts: z.string(),
      submission: evidenceSubmissionSchema.optional(),
      decision: evidenceDecisionSchema.optional(),
    }),
  ),
});
export type CheckpointRecovery = z.infer<typeof checkpointRecoverySchema>;
export const architectureDecisionInboxSchema = z.strictObject({
  workspaceId: z.string(),
  definitionId: z.uuid(),
  bindingRevision: z.number().int().nonnegative(),
  blockers: z.array(z.string()),
  decisions: z.array(
    z.strictObject({
      checkpointId: name,
      title: z.string(),
      requirements: z.array(z.string()),
      blockers: z.array(z.string()),
      sourceReferences: z.string(),
      consumers: z.array(
        z.strictObject({ sliceId: name, phase: z.enum(['start', 'merge', 'verify']) }),
      ),
      recommendation: z
        .strictObject({
          sourceRunId: z.string(),
          sourceReportDigest: digest,
          investigation: z.boolean().optional(),
          classificationIssue: z.string().optional(),
          workItemId: z.string().optional(),
          sliceId: name.optional(),
          question: z.string(),
          answer: z.string(),
          sources: z.array(z.string()),
          brief: architectureRecommendationSchema.optional(),
        })
        .optional(),
      records: z.array(
        z.strictObject({
          id: z.uuid(),
          proposal: architectureDecisionSchema,
          decision: evidenceDecisionSchema.optional(),
          issues: z.array(z.string()),
          applicable: z.boolean(),
        }),
      ),
    }),
  ),
});
export type ArchitectureDecisionInbox = z.infer<typeof architectureDecisionInboxSchema>;
export const nativeAuditSchema = z.strictObject({
  hostDigest: digest,
  auditDigest: digest,
  ready: z.boolean(),
  facts: z.string().max(65536),
  issues: z.array(z.string()),
  kata: z.strictObject({ installed: z.boolean(), kvmAvailable: z.boolean(), message: z.string() }),
});
export type NativeAudit = z.infer<typeof nativeAuditSchema>;
export const nativeApprovalRequestSchema = z.strictObject({
  bindingRevision: z.number().int().positive(),
  runtimeId: z.uuid(),
  expectedApprovalId: z.string().nullable(),
  approved: z.boolean(),
  auditDigest: digest,
  rationale: text,
});
export type NativeApprovalRequest = z.infer<typeof nativeApprovalRequestSchema>;
export const nativeApprovalSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.string(),
  definitionId: z.string(),
  bindingRevision: z.number(),
  runtimeId: z.string(),
  approved: z.boolean(),
  hostDigest: digest,
  auditDigest: digest,
  audit: z.string(),
  rationale: z.string(),
  createdAt: z.string(),
  createdByUserId: z.string(),
});
export const runtimePinStatusSchema = z.strictObject({
  alias: name,
  ref: name,
  savedCommitSha: name,
  currentCommitSha: name.optional(),
  issue: z.string().optional(),
});
export type RuntimePinStatus = z.infer<typeof runtimePinStatusSchema>;
export const runtimeRefreshRequestSchema = z.strictObject({
  bindingRevision: z.number().int().positive(),
  expectedGeneration: z.number().int().positive(),
});
export const applyRuntimeRefreshSchema = runtimeRefreshRequestSchema.extend({
  snapshotDigest: digest,
  rationale: text,
});
export const runtimeRefreshPreviewSchema = runtimeRefreshRequestSchema.extend({
  snapshotDigest: digest,
  pins: z.array(
    z.strictObject({ alias: name, ref: name, before: name, after: name, changed: z.boolean() }),
  ),
  evidence: z.array(
    z.strictObject({
      id: z.string(),
      sourceId: name,
      kind: z.string(),
      generation: z.number().int().positive().optional(),
      disposition: z.enum(['retained', 'reverify', 'already-stale']),
      reasons: z.array(z.string()),
    }),
  ),
  reviews: z.array(
    z.strictObject({
      roadmapId: z.string(),
      attemptId: z.string(),
      sourceId: name,
      action: z.enum(['queue', 'existing-recovery', 'manual']),
      reason: z.string(),
    }),
  ),
  nativeApproval: z.enum(['retained', 'needs-approval']),
  blockers: z.array(z.string()),
});
export type RuntimeRefreshPreview = z.infer<typeof runtimeRefreshPreviewSchema>;
export type ApplyRuntimeRefresh = z.infer<typeof applyRuntimeRefreshSchema>;
export const runtimeEvidenceViewSchema = z.strictObject({
  decisionInbox: architectureDecisionInboxSchema.optional(),
  architectureDecisions: z
    .object({
      checkpoints: z.array(
        z.object({
          id: name,
          title: z.string(),
          requirements: z.array(z.string()),
          sourceReferences: z.string(),
        }),
      ),
      slices: z.array(z.object({ id: name, title: z.string(), checkpoints: z.array(name) })),
      designRuns: z.array(
        z.object({
          id: z.string(),
          checkpointIds: z.array(name),
          title: z.string(),
          report: z.string(),
        }),
      ),
    })
    .optional(),
  pinStatus: z.array(runtimePinStatusSchema).optional(),
  nativeVerification: z
    .strictObject({
      approval: nativeApprovalSchema.optional(),
      current: z.boolean(),
      requirements: z.array(
        z.strictObject({
          resource: z.string(),
          slices: z.array(z.string()),
          supported: z.boolean(),
        }),
      ),
    })
    .optional(),
  planAcceptance: z
    .strictObject({
      checkpoint: z.literal('STACK-PLAN-ACCEPTED'),
      roadmaps: z.array(
        z.strictObject({
          roadmapId: z.uuid(),
          name: z.string(),
          definitionRevision: z.number().int().positive(),
          snapshotDigest: digest,
          issues: z.array(z.string()),
          state: z.enum(['not-ready', 'ready-to-generate', 'awaiting-review', 'accepted']),
          submissionId: z.uuid().optional(),
        }),
      ),
    })
    .optional(),
  issues: z.array(z.string()),
  builds: z.array(
    z.strictObject({
      runId: z.string(),
      runtimeId: z.uuid(),
      digest,
      successfulBuilds: z.number().int().nonnegative(),
      error: z.string().optional(),
    }),
  ),
  bindingRevision: z.number().int().nonnegative(),
  current: runtimeGenerationSchema.optional(),
  history: z.array(runtimeGenerationSchema),
  repositories: z.array(
    z.strictObject({
      alias: name,
      role: z.enum(['implemented_upstream', 'planned_application']),
      configured: z.boolean(),
      integrationBranch: z.string().optional(),
      requiredUpstreams: z.array(name).default([]),
      conformanceRevision: name.optional(),
    }),
  ),
  subjects: z.array(
    z.strictObject({
      subject: evidenceSubjectSchema,
      title: z.string(),
      profile: z.string(),
      requirements: z.array(z.string()),
      reviewerRoles: z.array(z.string()),
      testedRepositories: z.array(z.string()),
      cases: z.array(
        z.strictObject({ id: name, sourceRecordDigest: digest, requiresKata: z.boolean() }),
      ),
      issues: z.array(z.string()),
    }),
  ),
  submissions: z.array(
    z.strictObject({
      submission: evidenceSubmissionSchema,
      decision: evidenceDecisionSchema.optional(),
      issues: z.array(z.string()),
    }),
  ),
  upstreamHistory: z.array(
    z.strictObject({ alias: name, runId: z.string(), headSha: z.string(), label: z.string() }),
  ),
});
export const inspectDependencyRequestSchema = z.strictObject({
  bindingRevision: z.number().int().positive(),
  alias: name,
  ref: z.string().min(1).max(200),
});
export const inspectDependencyResponseSchema = z.strictObject({
  commitSha: name,
  treeSha: name,
  packages: z.array(cratePinSchema),
});
export type ConfigureRuntime = z.infer<typeof configureRuntimeSchema>;
export type EvidenceSubmissionRequest = z.infer<typeof evidenceSubmissionRequestSchema>;
export type RuntimeEvidenceView = z.infer<typeof runtimeEvidenceViewSchema>;

export const discoverRuntimeRequestSchema = z.strictObject({
  bindingRevision: z.number().int().positive(),
  refs: z.array(z.strictObject({ alias: name, ref: z.string().trim().min(1).max(200) })).max(20),
});
export const discoverRuntimeResponseSchema = z.strictObject({
  configuration: configureRuntimeSchema,
  notes: z.array(z.string()),
});
