import { z } from 'zod';
import {
  type AgentRunId,
  type CheckpointId,
  type ConcurrencyDefinitionId,
  type EvidenceProfileId,
  type EvidenceSubmissionId,
  type MapResourceId,
  type NativeVerificationApprovalId,
  PLAN_ACCEPTANCE_INPUTS,
  type MapCapabilityGap,
  type QualificationEnvironmentId,
  type RoadmapId,
  type RuntimeGenerationId,
  type SliceId,
  type UpstreamTransitionRecordId,
  type WorkCycleId,
  type WorktreeId,
} from '@craftingtable/domain';
import { equivalentSchema } from './type-equivalence.js';
import { architectureRecommendationSchema } from './design-report.js';
import { branded, sourceRepositoryIdSchema, userIdSchema, workspaceIdSchema } from './ids.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(16000);
const evidenceSubjectSchema = z.strictObject({
  kind: z.enum(['checkpoint', 'slice', 'parent']),
  sourceId: name,
});
const qualificationEnvironmentSchema = z.strictObject({
  id: branded<QualificationEnvironmentId>(name),
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
const cratePinSchema = z.strictObject({
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
  repositoryId: sourceRepositoryIdSchema,
  commitSha: name,
  treeSha: name,
  conformanceRevision: name,
  packages: z.array(cratePinSchema),
});
export const runtimeGenerationSchema = z.strictObject({
  id: branded<RuntimeGenerationId>(z.uuid()),
  workspaceId: workspaceIdSchema,
  definitionId: branded<ConcurrencyDefinitionId>(z.uuid()),
  bindingRevision: z.number(),
  generation: z.number(),
  digest,
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
  pins: z.array(runtimePinSchema),
  consumers: z.array(z.strictObject({ alias: name, upstreams: z.array(name) })),
  environments: z.array(qualificationEnvironmentSchema),
});
export const evidenceSubmissionRequestSchema = z
  .strictObject({
    runtimeId: branded<RuntimeGenerationId>(z.uuid()),
    subject: evidenceSubjectSchema,
    testedCode: z
      .array(z.strictObject({ alias: name, commitSha: z.string().regex(/^[a-f0-9]{40,64}$/) }))
      .max(20)
      .optional(),
    subjectCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    environmentId: branded<QualificationEnvironmentId>(name),
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
    sourceRunId: branded<AgentRunId>(z.string().min(1).max(100)).optional(),
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
  submissionId: branded<EvidenceSubmissionId>(z.uuid()),
  outcome: z.enum(['accepted', 'rejected']),
  rationale: text,
  checkpointReviewRoles: z.array(name).min(1).max(20).optional(),
});
const candidateCheckpointSchema = z.strictObject({
  kind: z.literal('reviewed-candidate-v1'),
  delegatedReview: z
    .strictObject({
      cycleId: branded<WorkCycleId>(z.uuid()),
      roadmapId: branded<RoadmapId>(z.uuid()),
      definitionRevision: z.number().int().positive(),
      roles: z.array(name).max(30),
    })
    .optional(),
  worktreeId: branded<WorktreeId>(z.uuid()),
  sliceId: branded<SliceId>(name),
  runId: branded<AgentRunId>(z.uuid()),
  reportDigest: digest,
  buildDigest: digest,
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  integrationSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  snapshotDigest: digest,
});
export const prepareCheckpointRequestSchema = z.strictObject({
  worktreeId: branded<WorktreeId>(z.uuid()),
  checkpointId: branded<CheckpointId>(name),
  snapshotDigest: digest,
});
const planAcceptanceInputSchema = z.enum(PLAN_ACCEPTANCE_INPUTS);
const generatedPlanEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('saved-plan-v1'),
    roadmapId: branded<RoadmapId>(z.uuid()),
    definitionRevision: z.number().int().positive(),
    snapshotDigest: digest,
  }),
  // R-C6 D3: bound to the plan-acceptance inputs, not to the definition revision.
  z.strictObject({
    kind: z.literal('saved-plan-v2'),
    roadmapId: branded<RoadmapId>(z.uuid()),
    definitionRevision: z.number().int().positive(),
    inputsDigest: digest,
    changedInputs: z.array(planAcceptanceInputSchema).max(PLAN_ACCEPTANCE_INPUTS.length),
  }),
]);
export const generatePlanEvidenceRequestSchema = z.strictObject({
  roadmapId: branded<RoadmapId>(z.uuid()),
  definitionRevision: z.number().int().positive(),
  snapshotDigest: digest,
});
const architectureDecisionInputSchema = z.strictObject({
  coverage: z.enum(['full', 'clauses']),
  proposal: text,
  sourceReferences: z.string().trim().min(1).max(65536),
  retainedObligations: z.string().trim().max(16000),
  consumers: z
    .array(
      z.strictObject({
        sliceId: branded<SliceId>(name),
        phase: z.enum(['start', 'merge']),
        replacesFullCheckpoint: z.boolean(),
      }),
    )
    .max(30),
});
export const proposeArchitectureDecisionSchema = architectureDecisionInputSchema
  .extend({
    checkpointId: branded<CheckpointId>(name),
    bindingRevision: z.number().int().positive(),
    sourceRunId: branded<AgentRunId>(z.uuid()).optional(),
    sourceReportDigest: digest.optional(),
  })
  .refine(
    (v) => !v.sourceReportDigest || !!v.sourceRunId,
    'A report digest requires its source run.',
  );
export type ProposeArchitectureDecision = z.infer<typeof proposeArchitectureDecisionSchema>;
const architectureDecisionSchema = architectureDecisionInputSchema.extend({
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
  id: branded<EvidenceSubmissionId>(z.uuid()),
  workspaceId: workspaceIdSchema,
  definitionId: branded<ConcurrencyDefinitionId>(z.uuid()),
  bindingRevision: z.number(),
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
  artifacts: z.array(z.strictObject({ name, content: z.string(), digest })),
  sourceRunDigest: digest.optional(),
  sourceRunCommit: name.optional(),
  sliceMergeSha: name.optional(),
});
/**
 * A submission's stored head (R-H4): the record with each artifact's contents replaced by
 * their size in UTF-8 bytes and whether they are blank. Storage keeps one beside each record.
 */
export const evidenceSubmissionHeadSchema = z.strictObject({
  ...evidenceSubmissionSchema.shape,
  artifacts: z.array(
    z.strictObject({
      name,
      digest,
      bytes: z.number().int().nonnegative(),
      blank: z.boolean(),
    }),
  ),
});
/**
 * A submission as the evidence view lists it (R-H4, LIVE-29): the record without its bodies,
 * which are the artifact contents and an architecture decision's text. The full record is
 * `GET …/runtime/submissions/:submissionId`.
 */
export const evidenceSubmissionSummarySchema = z.strictObject({
  ...evidenceSubmissionSchema.shape,
  artifacts: z.array(z.strictObject({ name, digest, bytes: z.number().int().nonnegative() })),
  architectureDecision: architectureDecisionSchema
    .pick({ kind: true, coverage: true, consumers: true, bindingDigest: true })
    .optional(),
});
export type EvidenceSubmissionRecord = z.infer<typeof evidenceSubmissionSchema>;
export const evidenceDecisionSchema = z.strictObject({
  checkpointReviewRoles: z.array(name).readonly().optional(),
  id: z.uuid(),
  workspaceId: workspaceIdSchema,
  submissionId: branded<EvidenceSubmissionId>(z.uuid()),
  outcome: z.enum(['accepted', 'rejected']),
  rationale: text,
  decidedAt: z.iso.datetime(),
  decidedByUserId: userIdSchema,
  carriedFrom: z.uuid().optional(),
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
      /** Prerequisite checkpoints still without accepted evidence (typed; issues are text). */
      prerequisiteCheckpoints: z.array(name).optional(),
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
      /** Slices stopped now until this decision is settled (LIVE-18); computed, never stored. */
      stoppedSlices: z.array(name).optional(),
      /** Slices an accepted clause-level decision settles it for (LIVE-22); computed. */
      settledFor: z.array(name).optional(),
      /** Consumer slices it is not settled for whose requiring phase is still ahead (LIVE-22). */
      stillNeededBy: z.array(name).optional(),
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
/** A native audit's request: it carries nothing; the daemon audits the map's current runtime. */
export const nativeAuditRequestSchema = z.strictObject({});
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
  runtimeId: branded<RuntimeGenerationId>(z.uuid()),
  expectedApprovalId: z.string().nullable(),
  approved: z.boolean(),
  auditDigest: digest,
  rationale: text,
});
export type NativeApprovalRequest = z.infer<typeof nativeApprovalRequestSchema>;
export const nativeApprovalSchema = z.strictObject({
  id: branded<NativeVerificationApprovalId>(z.uuid()),
  workspaceId: workspaceIdSchema,
  definitionId: branded<ConcurrencyDefinitionId>(z.string()),
  bindingRevision: z.number(),
  runtimeId: branded<RuntimeGenerationId>(z.string()),
  approved: z.boolean(),
  hostDigest: digest,
  auditDigest: digest,
  audit: z.string(),
  rationale: z.string(),
  createdAt: z.string(),
  createdByUserId: userIdSchema,
});
/** ADR-069: the consumer slice whose merge moves one consumer→upstream link to the current pin. */
const upstreamTransitionSchema = z.strictObject({
  consumer: name,
  upstream: name,
  slice: name,
});
export const upstreamTransitionRecordSchema = z.strictObject({
  id: branded<UpstreamTransitionRecordId>(z.uuid()),
  workspaceId: workspaceIdSchema,
  definitionId: branded<ConcurrencyDefinitionId>(z.string()),
  transitions: z.array(upstreamTransitionSchema).min(1).max(200),
  rationale: z.string(),
  createdAt: z.string(),
  createdByUserId: userIdSchema,
});
export const upstreamTransitionRequestSchema = z.strictObject({
  expectedRecordIds: z.array(z.uuid()).max(200),
  transitions: z.array(upstreamTransitionSchema).min(1).max(20),
  rationale: text,
});
export type UpstreamTransitionRequest = z.infer<typeof upstreamTransitionRequestSchema>;
const runtimePinStatusSchema = z.strictObject({
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
/**
 * What the controller cannot automate on a map (R-F2 part 5), as `mapCapabilities` types it:
 * each gap names the fields or ids at fault, and a reader branches on `code`.
 */
const mapCapabilityGapSchema = equivalentSchema<MapCapabilityGap>()(
  z.discriminatedUnion('code', [
    z.strictObject({
      code: z.literal('plan-checkpoint-ambiguous'),
      checkpointIds: z.array(branded<CheckpointId>(z.string())).max(2000),
    }),
    z.strictObject({
      code: z.literal('plan-owner-unrecognized'),
      checkpointId: branded<CheckpointId>(z.string()),
      owner: z.string(),
    }),
    z.strictObject({
      code: z.literal('plan-contract-changed'),
      checkpointId: branded<CheckpointId>(z.string()),
      fields: z
        .array(
          z.enum([
            'requires',
            'evidence_profile',
            'required_evidence',
            'pass_criteria',
            'reviewer_roles',
            'acceptance_coverage',
          ]),
        )
        .max(10),
    }),
    z.strictObject({
      code: z.literal('decision-contract-changed'),
      checkpointId: branded<CheckpointId>(z.string()),
      profileId: branded<EvidenceProfileId>(z.string()),
      fields: z
        .array(
          z.enum([
            'evidence_profile',
            'independence_required',
            'required_evidence',
            'reviewer_roles',
            'acceptance_coverage',
          ]),
        )
        .max(10),
    }),
    z.strictObject({ code: z.literal('security-role-undeclared') }),
    z.strictObject({
      code: z.literal('recovery-profile-unrecognized'),
      checkpointIds: z.array(branded<CheckpointId>(z.string())).max(2000),
    }),
    z.strictObject({
      code: z.literal('resource-adapter-missing'),
      resourceId: branded<MapResourceId>(z.string()),
    }),
    z.strictObject({
      code: z.literal('resource-adapter-unusable'),
      resourceId: branded<MapResourceId>(z.string()),
      adapter: z.enum(['development-workspace', 'native-test-host']),
      fields: z
        .array(
          z.enum([
            'resource_profile',
            'requires_hardware_virtualization',
            'fixture_authorization_required',
          ]),
        )
        .max(10),
    }),
  ]),
);
/**
 * A map's recognized capabilities as the daemon reads them (R-F2 part 5): its typed gaps, and
 * each slice's build classification (ADR-053), which a reworded maturity word can move to a
 * current-upstream build. Derived on each read, never stored.
 */
export const mapCapabilitiesViewSchema = z.strictObject({
  // Sized from the map's own bounds: 2,000 checkpoints, resources and slices, 16,000-character ids.
  gaps: z.array(mapCapabilityGapSchema).max(10000),
  builds: z
    .array(
      z.strictObject({
        sliceId: z.string().min(1).max(16000),
        mode: z.enum(['scoped-checks', 'current-upstream-build']),
      }),
    )
    .max(2000),
});
export type MapCapabilitiesView = z.infer<typeof mapCapabilitiesViewSchema>;
export const runtimeEvidenceViewSchema = z.strictObject({
  capabilities: mapCapabilitiesViewSchema.optional(),
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
  upstreamTransitions: z
    .strictObject({
      records: z.array(upstreamTransitionRecordSchema),
      links: z.array(
        z.strictObject({
          consumer: name,
          upstream: name,
          slice: name.optional(),
          declaredBy: z.enum(['map', 'record']).optional(),
          recordId: z.uuid().optional(),
          candidates: z.array(name),
        }),
      ),
    })
    .optional(),
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
      checkpoint: name,
      roadmaps: z.array(
        z.strictObject({
          roadmapId: z.uuid(),
          name: z.string(),
          definitionRevision: z.number().int().positive(),
          snapshotDigest: digest,
          issues: z.array(z.string()),
          state: z.enum(['not-ready', 'ready-to-generate', 'awaiting-review', 'accepted']),
          submissionId: z.uuid().optional(),
          /**
           * An acceptance the operator's own commands carried (R-C6 D2): when the operator last
           * reviewed the plan, and every input changed since.
           */
          carried: z
            .strictObject({
              reviewedAt: z.iso.datetime(),
              changedInputs: z.array(planAcceptanceInputSchema),
            })
            .optional(),
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
      /** `agent`: frozen from a file the agent could write, before R-G4. */
      receiptAuthority: z.enum(['daemon', 'agent']),
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
      submission: evidenceSubmissionSummarySchema,
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
