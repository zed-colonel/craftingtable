import {
  evidenceSubmissionSchema,
  evidenceSubmissionSummarySchema,
} from '@craftingtable/contracts';
import type { EvidenceSubmission } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { expect, it } from 'vitest';
import { submissionSummary, viewGit } from '../../src/services/runtime-evidence-service.js';

const sha = (c: string) => c.repeat(40);
const digest = (c: string) => c.repeat(64);
const decision = evidenceSubmissionSchema.parse({
  id: '12345678-1234-4234-8234-123456789abc',
  workspaceId: 'workspace',
  definitionId: '22345678-1234-4234-8234-123456789abc',
  bindingRevision: 1,
  runtimeId: '32345678-1234-4234-8234-123456789abc',
  subject: { kind: 'checkpoint', sourceId: 'ADR-1' },
  environmentId: 'local',
  executedBy: 'operator',
  executedAt: '2026-09-30T00:00:00.000Z',
  createdAt: '2026-09-30T00:00:00.000Z',
  createdByUserId: '42345678-1234-4234-8234-123456789abc',
  reviewers: [],
  requirements: [{ requirement: 'Decision text', artifact: 'proposal' }],
  cases: [],
  subjectCommit: sha('a'),
  artifacts: [
    { name: 'proposal', content: 'Use the queue — ünïcode counts in bytes.', digest: digest('b') },
  ],
  architectureDecision: {
    kind: 'architecture-decision-v1',
    coverage: 'clauses',
    proposal: 'The proposal text.',
    sourceReferences: 'docs/adr/ADR-1.md',
    retainedObligations: 'Full checkpoint stays.',
    consumers: [{ sliceId: 'wi/WI-01/domain', phase: 'merge', replacesFullCheckpoint: false }],
    bindingDigest: digest('c'),
  },
}) as unknown as EvidenceSubmission;

it('lists a submission without its bodies, and keeps everything else (R-H4)', () => {
  const summary = submissionSummary(decision);
  expect(evidenceSubmissionSummarySchema.parse(summary)).toEqual(summary);
  expect(summary.artifacts).toEqual([
    {
      name: 'proposal',
      digest: digest('b'),
      bytes: Buffer.byteLength('Use the queue — ünïcode counts in bytes.'),
    },
  ]);
  expect(summary.architectureDecision).toEqual({
    kind: 'architecture-decision-v1',
    coverage: 'clauses',
    consumers: decision.architectureDecision!.consumers,
    bindingDigest: digest('c'),
  });
  const { artifacts: _a, architectureDecision: _d, ...rest } = decision;
  const { artifacts: _sa, architectureDecision: _sd, ...summaryRest } = summary;
  expect(summaryRest).toEqual(rest);
  expect(JSON.stringify(summary)).not.toMatch(/proposal text|ADR-1\.md|Full checkpoint|queue/);
});

it('asks each distinct Git read once within a view, and passes other calls through', async () => {
  const calls: string[] = [];
  const git = new Proxy({} as GitOperations, {
    get:
      (_target, method) =>
      async (...args: unknown[]) => {
        calls.push(`${String(method)}:${JSON.stringify(args)}`);
        return { ok: true, value: calls.length };
      },
  });
  const view = viewGit(git);
  const first = await view.resolveCommit('/repo', 'main');
  expect(await view.resolveCommit('/repo', 'main')).toBe(first);
  await view.resolveCommit('/repo', 'other');
  await view.isAncestor('/repo', sha('a'), sha('b'));
  await view.isAncestor('/repo', sha('a'), sha('b'));
  await view.listBaselineTags('/repo');
  await view.listBaselineTags('/repo');
  expect(calls).toEqual([
    'resolveCommit:["/repo","main"]',
    'resolveCommit:["/repo","other"]',
    `isAncestor:["/repo","${sha('a')}","${sha('b')}"]`,
    'listBaselineTags:["/repo"]',
    'listBaselineTags:["/repo"]',
  ]);
});
