import {
  PROJECT_REPOSITORY_BINDING_STATUSES,
  REPOSITORY_STATUS_REASON_SETS,
  REPOSITORY_STATUSES,
  REPOSITORY_STATUS_REASONS,
  STORED_CORE_EVIDENCE_DIFFERENCES,
  STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES,
  STORED_REPOSITORY_INSPECTION_ERROR_CATEGORIES,
  STORED_REPOSITORY_INSPECTION_ERROR_CODES,
  STORED_REPOSITORY_INSPECTION_ERROR_SUBJECTS,
  STORED_REPOSITORY_INSPECTION_OPERATIONS,
  STORED_REPOSITORY_INSPECTION_RETRYABILITIES,
  STORED_REPOSITORY_RISK_SIGNALS,
  STORED_RISK_EVIDENCE_DIFFERENCES,
} from '@craftingtable/domain';
import { z } from 'zod';
import {
  projectIdSchema,
  projectRepositoryBindingIdSchema,
  repositoryIdSchema,
  repositoryInspectionIdSchema,
} from './ids.js';

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const boundedUtf8 = (maximum: number) =>
  z.string().refine((value) => utf8Length(value) <= maximum, {
    message: `must be at most ${maximum} UTF-8 bytes`,
  });
const positiveSafeInteger = z.number().int().positive().safe();
const lowerHexSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const hasNoControls = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });

export const requestedRepositoryPathSchema = boundedUtf8(4096)
  .min(1)
  .refine((value) => value.startsWith('/'), { message: 'must have absolute path shape' })
  .refine((value) => !value.includes('\0'), { message: 'must not contain NUL' });

export const repositoryDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(hasNoControls, { message: 'must not contain C0 or DEL controls' });

export const repositoryOperatorReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(hasNoControls, { message: 'must not contain C0 or DEL controls' });

export const registerRepositoryRequestSchema = z.strictObject({
  requestedPath: requestedRepositoryPathSchema,
  displayName: repositoryDisplayNameSchema.optional(),
});

export const inspectRepositoryRequestSchema = z.strictObject({
  expectedVersion: positiveSafeInteger,
});

export const reaffirmRepositoryEnvironmentRequestSchema = z.strictObject({
  expectedVersion: positiveSafeInteger,
  expectedLatestSuccessfulInspectionId: repositoryInspectionIdSchema,
  reason: repositoryOperatorReasonSchema,
});

export const retireRepositoryRequestSchema = z.strictObject({
  expectedVersion: positiveSafeInteger,
  reason: repositoryOperatorReasonSchema,
});

export const bindProjectRepositoryRequestSchema = z.strictObject({
  repositoryId: repositoryIdSchema,
  expectedRepositoryVersion: positiveSafeInteger,
});

export const retireProjectRepositoryBindingRequestSchema = z.strictObject({
  expectedVersion: positiveSafeInteger,
  reason: repositoryOperatorReasonSchema,
});

const boundedCanonicalPath = boundedUtf8(4096)
  .min(1)
  .refine((value) => value.startsWith('/') && !value.includes('\0'), {
    message: 'must have canonical absolute path shape',
  });

export const repositoryIdentitySummarySchema = z.strictObject({
  canonicalTopLevel: boundedCanonicalPath,
  objectFormat: z.enum(['sha1', 'sha256']),
  coreFingerprintSha256: lowerHexSha256,
});

export const repositoryAdministrativeIdentitySchema = z.strictObject({
  canonicalTopLevel: boundedCanonicalPath,
  canonicalGitDirectory: boundedCanonicalPath,
  canonicalCommonGitDirectory: boundedCanonicalPath,
  objectFormat: z.enum(['sha1', 'sha256']),
  coreFingerprintSha256: lowerHexSha256,
});

function sortedUniqueEnum<T extends readonly [string, ...string[]]>(values: T, maximum: number) {
  return z
    .array(z.enum(values))
    .max(maximum)
    .refine(
      (items) => items.every((item, index) => index === 0 || (items[index - 1] as string) < item),
      { message: 'must be sorted and unique' },
    );
}

const riskSignalsSchema = sortedUniqueEnum(STORED_REPOSITORY_RISK_SIGNALS, 14);
const coreDifferencesSchema = sortedUniqueEnum(STORED_CORE_EVIDENCE_DIFFERENCES, 7);
const environmentalDifferencesSchema = sortedUniqueEnum(
  STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES,
  2,
);
const riskDifferencesSchema = sortedUniqueEnum(STORED_RISK_EVIDENCE_DIFFERENCES, 3);

export const repositoryRiskSummarySchema = z
  .strictObject({
    classification: z.enum(['no-signals-in-scanned-set', 'signals-observed']),
    signals: riskSignalsSchema,
    observedAt: z.iso.datetime(),
  })
  .superRefine((risk, context) => {
    if ((risk.signals.length === 0) !== (risk.classification === 'no-signals-in-scanned-set')) {
      context.addIssue({
        code: 'custom',
        message: 'risk classification must agree with signal presence',
      });
    }
  });

export const repositoryEvidenceSummarySchema = z.strictObject({
  registrationInspectionId: repositoryInspectionIdSchema,
  acceptedEnvironmentInspectionId: repositoryInspectionIdSchema,
  latestInspectionId: repositoryInspectionIdSchema,
  latestInspectionAt: z.iso.datetime(),
  latestSuccessfulInspectionId: repositoryInspectionIdSchema,
  latestSuccessfulInspectionAt: z.iso.datetime(),
  risk: repositoryRiskSummarySchema,
});

function registeredRepositorySummaryWithIdentity(identity: z.ZodType) {
  return z
    .strictObject({
      id: repositoryIdSchema,
      displayName: repositoryDisplayNameSchema,
      status: z.enum(REPOSITORY_STATUSES),
      statusReason: z.enum(REPOSITORY_STATUS_REASONS),
      version: positiveSafeInteger,
      registeredAt: z.iso.datetime(),
      statusChangedAt: z.iso.datetime(),
      identity,
      evidence: repositoryEvidenceSummarySchema,
    })
    .superRefine((repository, context) => {
      const allowed: readonly string[] = REPOSITORY_STATUS_REASON_SETS[repository.status];
      if (!allowed.includes(repository.statusReason)) {
        context.addIssue({
          code: 'custom',
          message: 'repository status and reason do not agree',
        });
      }
    });
}

export const registeredRepositorySummarySchema = registeredRepositorySummaryWithIdentity(
  repositoryIdentitySummarySchema,
);
export const registeredRepositoryAdministrativeSummarySchema =
  registeredRepositorySummaryWithIdentity(repositoryAdministrativeIdentitySchema);

const inspectionSummaryBase = {
  sequence: positiveSafeInteger,
  id: repositoryInspectionIdSchema,
  createdAt: z.iso.datetime(),
};

export const successfulRepositoryInspectionSummarySchema = z
  .strictObject({
    ...inspectionSummaryBase,
    kind: z.enum(['registration', 'verification', 'reaffirmation']),
    outcome: z.literal('succeeded'),
    observedAt: z.iso.datetime(),
    observationSha256: lowerHexSha256,
    observationVersion: z.literal(1),
    inspectionPolicyVersion: positiveSafeInteger,
    coreDifferences: coreDifferencesSchema.optional(),
    environmentalDifferences: environmentalDifferencesSchema.optional(),
    riskDifferences: riskDifferencesSchema.optional(),
    acceptedAsEnvironmentBaseline: z.boolean(),
    risk: z.strictObject({
      classification: z.enum(['no-signals-in-scanned-set', 'signals-observed']),
      signals: riskSignalsSchema,
    }),
  })
  .superRefine((inspection, context) => {
    const fields = [
      inspection.coreDifferences,
      inspection.environmentalDifferences,
      inspection.riskDifferences,
    ];
    const present = fields.filter((field) => field !== undefined).length;
    if (inspection.kind === 'registration' ? present !== 0 : present !== 3) {
      context.addIssue({
        code: 'custom',
        message:
          'registration omits comparison arrays; verification and reaffirmation require all three',
      });
    }
  });

export const failedRepositoryInspectionSummarySchema = z.strictObject({
  ...inspectionSummaryBase,
  kind: z.enum(['verification', 'reaffirmation']),
  outcome: z.literal('failed'),
  error: z.strictObject({
    origin: z.enum(['a1', 'storage-integrity']),
    code: z.enum(STORED_REPOSITORY_INSPECTION_ERROR_CODES),
    subject: z.enum(STORED_REPOSITORY_INSPECTION_ERROR_SUBJECTS),
    category: z.enum(STORED_REPOSITORY_INSPECTION_ERROR_CATEGORIES),
    operation: z.enum(STORED_REPOSITORY_INSPECTION_OPERATIONS),
    retryability: z.enum(STORED_REPOSITORY_INSPECTION_RETRYABILITIES),
  }),
});

export const repositoryInspectionSummarySchema = z.discriminatedUnion('outcome', [
  successfulRepositoryInspectionSummarySchema,
  failedRepositoryInspectionSummarySchema,
]);

export const projectRepositoryBindingSummarySchema = z
  .strictObject({
    id: projectRepositoryBindingIdSchema,
    projectId: projectIdSchema,
    repositoryId: repositoryIdSchema,
    status: z.enum(PROJECT_REPOSITORY_BINDING_STATUSES),
    repositoryStatus: z.enum(REPOSITORY_STATUSES),
    repositoryStatusReason: z.enum(REPOSITORY_STATUS_REASONS),
    boundAt: z.iso.datetime(),
    retiredAt: z.iso.datetime().optional(),
    version: positiveSafeInteger,
  })
  .superRefine((binding, context) => {
    if ((binding.status === 'retired') !== (binding.retiredAt !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'binding retirement status and time do not agree',
      });
    }
    const allowed: readonly string[] = REPOSITORY_STATUS_REASON_SETS[binding.repositoryStatus];
    if (!allowed.includes(binding.repositoryStatusReason)) {
      context.addIssue({
        code: 'custom',
        message: 'projected repository status and reason do not agree',
      });
    }
  });

export const repositoryListResponseSchema = z.strictObject({
  repositories: z.array(registeredRepositorySummarySchema).max(100),
});
export const repositoryDetailResponseSchema = z.strictObject({
  repository: registeredRepositorySummarySchema,
  activeBindings: z.array(projectRepositoryBindingSummarySchema).max(100),
});
export const repositoryAdministrativeDetailResponseSchema = z.strictObject({
  repository: registeredRepositoryAdministrativeSummarySchema,
  activeBindings: z.array(projectRepositoryBindingSummarySchema).max(100),
});
export const repositoryInspectionListResponseSchema = z.strictObject({
  inspections: z.array(repositoryInspectionSummarySchema).max(100),
});
export const registerRepositoryResponseSchema = z.strictObject({
  repository: registeredRepositorySummarySchema,
  created: z.boolean(),
});
export const inspectRepositoryResponseSchema = z.strictObject({
  repository: registeredRepositorySummarySchema,
  inspection: repositoryInspectionSummarySchema,
  changed: z.boolean(),
});
export const reaffirmRepositoryEnvironmentResponseSchema = z.strictObject({
  repository: registeredRepositorySummarySchema,
  inspection: successfulRepositoryInspectionSummarySchema,
  changed: z.boolean(),
});
export const retireRepositoryResponseSchema = z.strictObject({
  repository: registeredRepositorySummarySchema,
  retiredBindingIds: z.array(projectRepositoryBindingIdSchema).max(100),
  changed: z.boolean(),
});
export const bindProjectRepositoryResponseSchema = z.strictObject({
  binding: projectRepositoryBindingSummarySchema,
  created: z.boolean(),
});
export const retireProjectRepositoryBindingResponseSchema = z.strictObject({
  binding: projectRepositoryBindingSummarySchema,
  changed: z.boolean(),
});

export type RegisterRepositoryRequest = z.infer<typeof registerRepositoryRequestSchema>;
export type InspectRepositoryRequest = z.infer<typeof inspectRepositoryRequestSchema>;
export type ReaffirmRepositoryEnvironmentRequest = z.infer<
  typeof reaffirmRepositoryEnvironmentRequestSchema
>;
export type RetireRepositoryRequest = z.infer<typeof retireRepositoryRequestSchema>;
export type BindProjectRepositoryRequest = z.infer<typeof bindProjectRepositoryRequestSchema>;
export type RetireProjectRepositoryBindingRequest = z.infer<
  typeof retireProjectRepositoryBindingRequestSchema
>;
export type RegisteredRepositorySummary = z.infer<typeof registeredRepositorySummarySchema>;
export type RepositoryInspectionSummary = z.infer<typeof repositoryInspectionSummarySchema>;
export type ProjectRepositoryBindingSummary = z.infer<typeof projectRepositoryBindingSummarySchema>;
export type RepositoryListResponse = z.infer<typeof repositoryListResponseSchema>;
export type RepositoryDetailResponse = z.infer<typeof repositoryDetailResponseSchema>;
export type RepositoryAdministrativeDetailResponse = z.infer<
  typeof repositoryAdministrativeDetailResponseSchema
>;
export type RepositoryInspectionListResponse = z.infer<
  typeof repositoryInspectionListResponseSchema
>;
export type RegisterRepositoryResponse = z.infer<typeof registerRepositoryResponseSchema>;
export type InspectRepositoryResponse = z.infer<typeof inspectRepositoryResponseSchema>;
export type ReaffirmRepositoryEnvironmentResponse = z.infer<
  typeof reaffirmRepositoryEnvironmentResponseSchema
>;
export type RetireRepositoryResponse = z.infer<typeof retireRepositoryResponseSchema>;
export type BindProjectRepositoryResponse = z.infer<typeof bindProjectRepositoryResponseSchema>;
export type RetireProjectRepositoryBindingResponse = z.infer<
  typeof retireProjectRepositoryBindingResponseSchema
>;
