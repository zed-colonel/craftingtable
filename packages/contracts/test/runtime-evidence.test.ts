import { type EvidenceSubmission, submissionHead } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { evidenceSubmissionHeadSchema, evidenceSubmissionSchema } from '../src/runtime-evidence.js';
import { equivalentSchema } from '../src/type-equivalence.js';

const record = evidenceSubmissionSchema.parse({
  id: '12345678-1234-4234-8234-123456789abc',
  workspaceId: 'workspace',
  definitionId: '22345678-1234-4234-8234-123456789abc',
  bindingRevision: 1,
  runtimeId: '32345678-1234-4234-8234-123456789abc',
  subject: { kind: 'slice', sourceId: 'wi/WI-01/domain' },
  environmentId: 'local',
  executedBy: 'implementer',
  executedAt: '2026-10-07T00:00:00.000Z',
  createdAt: '2026-10-07T00:00:00.000Z',
  createdByUserId: '42345678-1234-4234-8234-123456789abc',
  reviewers: [{ identity: 'reviewer', roles: ['code'], artifact: 'review' }],
  requirements: [],
  cases: [],
  artifacts: [
    { name: 'review', content: 'Reviewed: no findings.', digest: 'a'.repeat(64) },
    { name: 'log', content: '  \n', digest: 'b'.repeat(64) },
  ],
}) as unknown as EvidenceSubmission;

// The schema describes the domain head exactly.
equivalentSchema<ReturnType<typeof submissionHead>>()(evidenceSubmissionHeadSchema);

it("accepts a record's head and refuses a head that still carries contents (R-H4)", () => {
  const head = submissionHead(record);
  expect(evidenceSubmissionHeadSchema.parse(head)).toEqual(head);
  expect(head.artifacts.map((a) => a.blank)).toEqual([false, true]);
  expect(evidenceSubmissionHeadSchema.safeParse(record).success).toBe(false);
  expect(
    evidenceSubmissionHeadSchema.safeParse({
      ...head,
      artifacts: head.artifacts.map((a) => ({ ...a, content: 'kept' })),
    }).success,
  ).toBe(false);
  expect(
    evidenceSubmissionHeadSchema.safeParse({
      ...head,
      artifacts: head.artifacts.map((a) => ({ ...a, bytes: -1 })),
    }).success,
  ).toBe(false);
});
