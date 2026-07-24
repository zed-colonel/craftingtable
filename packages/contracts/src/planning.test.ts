import { describe, expect, it } from 'vitest';
import {
  planImportResponseSchema,
  workContractDraftDocumentSchema,
  workContractDraftSummarySchema,
} from './planning.js';

/**
 * CT03-R3 regression cover.
 *
 * The first review found the draft document typed as `z.unknown()`, so the
 * shared boundary validated nothing about the artifact whose entire purpose is
 * to be unmistakably incomplete and non-executable. These assert the strict
 * schema directly.
 */

const VALID_DOCUMENT = {
  schemaVersion: 1,
  status: 'draft',
  completeness: 'incomplete',
  source: {
    projectId: 'project-1',
    planVersionId: 'version-1',
    workItemId: 'item-1',
    sourceWorkItemId: 'AQ-01',
  },
  objective: {
    title: 'Freeze evidence and establish the development contract',
    exitGate: 'Baseline green; contract, archive, and boundary checks installed.',
  },
  classification: { risk: 'medium', primaryAreas: ['contract', 'conformance'] },
  dependencies: {
    required: [{ sourceId: 'AQ-00', title: 'Predecessor', status: 'proposed', kind: 'required' }],
    recommended: [],
  },
  repository: { status: 'unresolved' },
  baseRevision: { status: 'unresolved' },
  scope: { status: 'unresolved', writable: [], forbidden: [] },
  verification: { status: 'unresolved', checkIds: [] },
  review: {
    requiredPerspectives: ['specification', 'correctness'],
    maxRemediationGenerations: 3,
  },
  merge: { humanAuthorizationRequired: true },
  missing: ['registered-repository', 'exact-base-revision'],
};

describe('work contract draft document contract', () => {
  it('accepts the document the admission service produces', () => {
    expect(workContractDraftDocumentSchema.safeParse(VALID_DOCUMENT).success).toBe(true);
  });

  it.each([
    'schemaVersion',
    'status',
    'completeness',
    'source',
    'objective',
    'classification',
    'dependencies',
    'repository',
    'baseRevision',
    'scope',
    'verification',
    'review',
    'merge',
    'missing',
  ])('rejects a document missing %s', (field) => {
    const { [field]: _removed, ...without } = VALID_DOCUMENT as Record<string, unknown>;
    expect(workContractDraftDocumentSchema.safeParse(without).success).toBe(false);
  });

  it.each([
    ['approved', true],
    ['executable', true],
    ['ready', true],
    ['authorized', true],
    ['status', 'approved'],
    ['completeness', 'complete'],
  ])('rejects an authorization-looking %s field', (field, value) => {
    expect(
      workContractDraftDocumentSchema.safeParse({ ...VALID_DOCUMENT, [field]: value }).success,
    ).toBe(false);
  });

  it('refuses to make human merge authorization optional', () => {
    expect(
      workContractDraftDocumentSchema.safeParse({
        ...VALID_DOCUMENT,
        merge: { humanAuthorizationRequired: false },
      }).success,
    ).toBe(false);
    expect(
      workContractDraftDocumentSchema.safeParse({ ...VALID_DOCUMENT, merge: {} }).success,
    ).toBe(false);
  });

  it('refuses to mark any unresolved section resolved', () => {
    const sections = VALID_DOCUMENT as unknown as Record<string, Record<string, unknown>>;
    for (const section of ['repository', 'baseRevision', 'scope', 'verification'] as const) {
      expect(
        workContractDraftDocumentSchema.safeParse({
          ...VALID_DOCUMENT,
          [section]: { ...sections[section], status: 'resolved' },
        }).success,
        section,
      ).toBe(false);
    }
  });

  it('requires at least one named unresolved field', () => {
    expect(
      workContractDraftDocumentSchema.safeParse({ ...VALID_DOCUMENT, missing: [] }).success,
    ).toBe(false);
    // An unknown placeholder is not an acceptable stand-in for a real one.
    expect(
      workContractDraftDocumentSchema.safeParse({ ...VALID_DOCUMENT, missing: ['something-else'] })
        .success,
    ).toBe(false);
  });

  it('rejects mistyped nested values', () => {
    expect(
      workContractDraftDocumentSchema.safeParse({
        ...VALID_DOCUMENT,
        classification: { risk: 'apocalyptic', primaryAreas: [] },
      }).success,
    ).toBe(false);
    expect(
      workContractDraftDocumentSchema.safeParse({
        ...VALID_DOCUMENT,
        dependencies: { required: [{ sourceId: 'AQ-00' }], recommended: [] },
      }).success,
    ).toBe(false);
    expect(
      workContractDraftDocumentSchema.safeParse({
        ...VALID_DOCUMENT,
        objective: { title: '', exitGate: 'x' },
      }).success,
    ).toBe(false);
  });

  it('validates the document through the draft summary the routes return', () => {
    const summary = {
      id: 'draft-1',
      schemaVersion: 1,
      status: 'draft',
      completeness: 'incomplete',
      createdAt: '2026-07-24T00:00:00.000Z',
      document: VALID_DOCUMENT,
    };
    expect(workContractDraftSummarySchema.safeParse(summary).success).toBe(true);
    // The summary no longer waves an arbitrary document through.
    expect(
      workContractDraftSummarySchema.safeParse({ ...summary, document: { anything: true } })
        .success,
    ).toBe(false);
    expect(workContractDraftSummarySchema.safeParse({ ...summary, document: null }).success).toBe(
      false,
    );
  });
});

describe('plan import response contract', () => {
  it('requires diagnostics on a failed validation outcome', () => {
    expect(
      planImportResponseSchema.safeParse({
        importAttemptId: 'attempt-1',
        outcome: 'failed-validation',
        diagnostics: [{ severity: 'error', code: 'invalid-yaml', message: 'bad' }],
      }).success,
    ).toBe(true);
    expect(
      planImportResponseSchema.safeParse({
        importAttemptId: 'attempt-1',
        outcome: 'failed-validation',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown outcome', () => {
    expect(
      planImportResponseSchema.safeParse({ importAttemptId: 'a', outcome: 'approved' }).success,
    ).toBe(false);
  });
});
