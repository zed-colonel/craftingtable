import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '../src/bounded-text.js';
import { type EvidenceSubmission, submissionHead } from '../src/runtime-evidence.js';

const submission = {
  id: 'submission',
  workspaceId: 'workspace',
  definitionId: 'definition',
  bindingRevision: 1,
  runtimeId: 'runtime',
  subject: { kind: 'checkpoint', sourceId: 'ADR-1' },
  environmentId: 'local',
  executedBy: 'operator',
  executedAt: '2026-10-07T00:00:00.000Z',
  reviewers: [{ identity: 'reviewer', roles: ['architecture'], artifact: 'review' }],
  requirements: [{ requirement: 'Decision text', artifact: 'proposal' }],
  cases: [],
  artifacts: [
    { name: 'proposal', content: 'Use the queue — ünïcode 😀 counts in bytes.', digest: 'd1' },
    { name: 'review', content: ' \n\t  ﻿　 ', digest: 'd2' },
    { name: 'empty', content: '', digest: 'd3' },
  ],
  architectureDecision: {
    kind: 'architecture-decision-v1',
    bindingDigest: 'binding',
    coverage: 'clauses',
    proposal: 'The proposal text.',
    sourceReferences: 'docs/adr/ADR-1.md',
    retainedObligations: 'Full checkpoint stays.',
    consumers: [{ sliceId: 'wi/WI-01/domain', phase: 'merge', replacesFullCheckpoint: false }],
  },
  createdAt: '2026-10-07T00:00:00.000Z',
  createdByUserId: 'user',
} as unknown as EvidenceSubmission;

describe('submissionHead (R-H4)', () => {
  it('keeps everything but the artifact contents, which become their size and blankness', () => {
    const head = submissionHead(submission);
    expect(head.artifacts).toEqual([
      {
        name: 'proposal',
        digest: 'd1',
        bytes: Buffer.byteLength('Use the queue — ünïcode 😀 counts in bytes.', 'utf8'),
        blank: false,
      },
      // Blank as `trim()` sees it: every JavaScript whitespace and line terminator.
      { name: 'review', digest: 'd2', bytes: 15, blank: true },
      { name: 'empty', digest: 'd3', bytes: 0, blank: true },
    ]);
    const { artifacts: _artifacts, ...rest } = submission;
    const { artifacts: _heads, ...headRest } = head;
    // The decision text stays in the head.
    expect(headRest).toEqual(rest);
    expect(JSON.stringify(head)).not.toMatch(/queue|ünïcode/);
    // The record is not changed.
    expect(submission.artifacts[0]?.content).toContain('queue');
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes as Buffer.byteLength does, a lone surrogate as its replacement', () => {
    for (const text of ['', 'plain', 'ünïcode', '→', '😀', 'a😀b', '\ud800', 'x\udc00y', '\u0000'])
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(Buffer.byteLength(text, 'utf8'));
  });
});
