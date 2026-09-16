import { z } from 'zod';
export const executionScopeSchema = z.strictObject({
  kind: z.enum(['slice', 'slice-verification', 'parent-acceptance']),
  definitionId: z.uuid(),
  bindingRevision: z.number().int().positive().safe(),
  sourceId: z.string().min(1).max(200),
});
export const scopeReviewEvidenceSchema = z.strictObject({
  scope: executionScopeSchema,
  requirements: z
    .array(
      z.strictObject({
        requirement: z.string().min(1).max(16000),
        evidence: z.string().min(1).max(20000),
      }),
    )
    .max(200),
  caseIds: z.array(z.string().min(1).max(200)).max(1000),
});
export const executionScopeChoiceSchema = z.strictObject({
  scope: executionScopeSchema,
  repositoryId: z.uuid().optional(),
  title: z.string(),
  description: z.string(),
  excludes: z.array(z.string()),
  blockers: z.array(z.string()),
  status: z.enum(['not-started', 'prepared', 'started', 'merged', 'verified', 'accepted']),
  worktreeIds: z.array(z.uuid()),
});
export const executionScopeChoicesSchema = z.strictObject({
  choices: z.array(executionScopeChoiceSchema),
});
export const recordScopeReceiptRequestSchema = z.strictObject({
  expectedWorktreeVersion: z.number().int().positive().safe(),
});
export const recordScopeReceiptResponseSchema = z.strictObject({
  recorded: z.boolean(),
  workItemCompleted: z.boolean(),
});

export type ExecutionScopeChoice = z.infer<typeof executionScopeChoiceSchema>;
