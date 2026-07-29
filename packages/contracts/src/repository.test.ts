import { describe, expect, it } from 'vitest';
import {
  bindProjectRepositoryRequestSchema,
  inspectRepositoryResponseSchema,
  reaffirmRepositoryEnvironmentRequestSchema,
  registeredRepositorySummarySchema,
  registerRepositoryRequestSchema,
  repositoryAdministrativeIdentitySchema,
  repositoryIdentitySummarySchema,
  retireProjectRepositoryBindingRequestSchema,
  retireRepositoryRequestSchema,
} from './repository.js';

const repositorySummary = {
  id: 'repository-1',
  displayName: 'Repo',
  status: 'active',
  statusReason: 'registration-accepted',
  version: 1,
  registeredAt: '2026-07-24T00:00:00.000Z',
  statusChangedAt: '2026-07-24T00:00:00.000Z',
  identity: {
    canonicalTopLevel: '/source/repo',
    objectFormat: 'sha1',
    coreFingerprintSha256: 'a'.repeat(64),
  },
  evidence: {
    registrationInspectionId: 'inspection-1',
    acceptedEnvironmentInspectionId: 'inspection-1',
    latestInspectionId: 'inspection-1',
    latestInspectionAt: '2026-07-24T00:00:00.000Z',
    latestSuccessfulInspectionId: 'inspection-1',
    latestSuccessfulInspectionAt: '2026-07-24T00:00:00.000Z',
    risk: {
      classification: 'no-signals-in-scanned-set',
      signals: [],
      observedAt: '2026-07-24T00:00:00.000Z',
    },
  },
} as const;

describe('repository public contracts', () => {
  it('accepts bounded command-free requests and rejects authority fields (A2A-CON-001/002)', () => {
    expect(registerRepositoryRequestSchema.parse({ requestedPath: '/source/repo' })).toEqual({
      requestedPath: '/source/repo',
    });
    for (const field of [
      'command',
      'argv',
      'environment',
      'cwd',
      'worktree',
      'branch',
      'ref',
      'remote',
      'gitExecutable',
      'ready',
      'approved',
      'mergeable',
    ]) {
      expect(
        registerRepositoryRequestSchema.safeParse({
          requestedPath: '/source/repo',
          [field]: true,
        }).success,
        field,
      ).toBe(false);
    }
    expect(
      bindProjectRepositoryRequestSchema.safeParse({
        repositoryId: 'repository-1',
        expectedRepositoryVersion: 1,
        executable: true,
      }).success,
    ).toBe(false);
  });

  it('separates reader identity from owner-only Git directory disclosure (A2A-CON-009)', () => {
    const reader = {
      canonicalTopLevel: '/source/repo',
      objectFormat: 'sha1',
      coreFingerprintSha256: 'a'.repeat(64),
    };
    expect(repositoryIdentitySummarySchema.parse(reader)).toEqual(reader);
    expect(
      repositoryIdentitySummarySchema.safeParse({
        ...reader,
        canonicalGitDirectory: '/source/repo/.git',
      }).success,
    ).toBe(false);
    expect(
      repositoryAdministrativeIdentitySchema.safeParse({
        ...reader,
        canonicalGitDirectory: '/source/repo/.git',
        canonicalCommonGitDirectory: '/source/repo/.git',
      }).success,
    ).toBe(true);
  });

  it('rejects readiness terminology on repository summaries (A2A-CON-004/005)', () => {
    expect(
      registeredRepositorySummarySchema.safeParse({
        ...repositorySummary,
        ready: true,
      }).success,
    ).toBe(false);
  });

  it('accepts complete evidence recency and rejects every missing latest field (A2A-CON-004/010)', () => {
    expect(registeredRepositorySummarySchema.safeParse(repositorySummary).success).toBe(true);
    for (const field of [
      'latestInspectionId',
      'latestInspectionAt',
      'latestSuccessfulInspectionId',
      'latestSuccessfulInspectionAt',
    ]) {
      const evidence = { ...repositorySummary.evidence } as Record<string, unknown>;
      delete evidence[field];
      expect(
        registeredRepositorySummarySchema.safeParse({
          ...repositorySummary,
          evidence,
        }).success,
        field,
      ).toBe(false);
    }
  });

  it('rejects raw inspection diagnostics and false response claims (A2A-CON-005/006)', () => {
    const inspection = {
      sequence: 2,
      id: 'inspection-2',
      kind: 'verification',
      outcome: 'failed',
      createdAt: '2026-07-24T00:00:01.000Z',
      error: {
        origin: 'a1',
        code: 'path-unavailable',
        subject: 'repository-unavailable',
        category: 'path-policy',
        operation: 'inspect-path',
        retryability: 'retryable',
      },
    };
    expect(
      inspectRepositoryResponseSchema.safeParse({
        repository: repositorySummary,
        inspection: { ...inspection, stderr: 'secret', environment: { PATH: 'secret' } },
        changed: false,
      }).success,
    ).toBe(false);
    expect(
      inspectRepositoryResponseSchema.safeParse({
        repository: { ...repositorySummary, executable: true },
        inspection,
        changed: false,
      }).success,
    ).toBe(false);
  });

  it('requires exact reaffirm, retire, and unbind command shapes (A2A-CON-007/008)', () => {
    expect(
      reaffirmRepositoryEnvironmentRequestSchema.safeParse({
        expectedVersion: 2,
        expectedLatestSuccessfulInspectionId: 'inspection-2',
        reason: 'Accept device move',
      }).success,
    ).toBe(true);
    expect(
      reaffirmRepositoryEnvironmentRequestSchema.safeParse({
        expectedVersion: 2,
        reason: 'Missing inspection',
      }).success,
    ).toBe(false);
    expect(
      retireRepositoryRequestSchema.safeParse({
        expectedVersion: 2,
        reason: 'Retire',
        delete: true,
      }).success,
    ).toBe(false);
    expect(
      retireProjectRepositoryBindingRequestSchema.safeParse({
        expectedVersion: 1,
        reason: 'Unbind',
        repositoryId: 'repository-1',
      }).success,
    ).toBe(false);
  });

  it('rejects unsafe optional display names at the public boundary (A2A-CON-003 A2A-REP-014)', () => {
    for (const displayName of ['', '  ', 'bad\u0000name', 'x'.repeat(121)]) {
      expect(
        registerRepositoryRequestSchema.safeParse({
          requestedPath: '/source/repo',
          displayName,
        }).success,
      ).toBe(false);
    }
  });
});
