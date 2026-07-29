import { describe, expect, it } from 'vitest';
import {
  normalizeRepositoryErrorEvidence,
  reduceRepositoryState,
  REPOSITORY_STATUSES,
  type RepositoryObservationAssessment,
} from './repository.js';

describe('repository state reducer', () => {
  const assessments: readonly RepositoryObservationAssessment[] = [
    { kind: 'same' },
    { kind: 'risk-evidence-changed', differences: ['signals'] },
    { kind: 'environment-evidence-changed', differences: ['top-level-device'] },
    { kind: 'core-identity-changed', differences: ['fingerprint'] },
    { kind: 'unavailable', reason: 'path-unavailable' },
    { kind: 'evidence-invalid', reason: 'stored-evidence-invalid' },
    { kind: 'no-state-change-failure' },
  ];

  it('implements the complete ordinary assessment matrix (A2A-STATUS-001..014)', () => {
    expect(
      assessments.map((assessment) =>
        reduceRepositoryState('active', { kind: 'apply-assessment', assessment }),
      ),
    ).toMatchObject([
      { kind: 'unchanged', status: 'active' },
      { kind: 'unchanged', status: 'active' },
      { kind: 'transition', toStatus: 'identity-evidence-changed' },
      { kind: 'transition', toStatus: 'identity-mismatch' },
      { kind: 'transition', toStatus: 'unavailable' },
      { kind: 'transition', toStatus: 'evidence-blocked' },
      { kind: 'unchanged', status: 'active' },
    ]);
    expect(
      assessments.map((assessment) =>
        reduceRepositoryState('unavailable', { kind: 'apply-assessment', assessment }),
      ),
    ).toMatchObject([
      { kind: 'transition', toStatus: 'active' },
      { kind: 'transition', toStatus: 'active' },
      { kind: 'transition', toStatus: 'identity-evidence-changed' },
      { kind: 'transition', toStatus: 'identity-mismatch' },
      { kind: 'unchanged', status: 'unavailable' },
      { kind: 'transition', toStatus: 'evidence-blocked' },
      { kind: 'unchanged', status: 'unavailable' },
    ]);
    expect(
      assessments.map((assessment) =>
        reduceRepositoryState('identity-evidence-changed', {
          kind: 'apply-assessment',
          assessment,
        }),
      ),
    ).toMatchObject([
      { kind: 'transition', toStatus: 'active' },
      { kind: 'transition', toStatus: 'active' },
      { kind: 'unchanged', status: 'identity-evidence-changed' },
      { kind: 'transition', toStatus: 'identity-mismatch' },
      { kind: 'transition', toStatus: 'unavailable' },
      { kind: 'transition', toStatus: 'evidence-blocked' },
      { kind: 'unchanged', status: 'identity-evidence-changed' },
    ]);
  });

  it('requires environmental evidence for reaffirmation (A2A-STATUS-015)', () => {
    for (const assessment of assessments) {
      const result = reduceRepositoryState('identity-evidence-changed', {
        kind: 'reaffirm-environment',
        assessment,
      });
      if (assessment.kind === 'environment-evidence-changed') {
        expect(result).toMatchObject({
          kind: 'transition',
          toStatus: 'active',
          reason: 'environment-evidence-reaffirmed',
          baselineAdvanceRequired: true,
        });
      } else if (assessment.kind === 'same' || assessment.kind === 'risk-evidence-changed') {
        expect(result).toEqual({ kind: 'rejected', reason: 'reaffirmation-not-required' });
      }
    }
  });

  it('keeps mismatch and blocked terminal except for retirement', () => {
    for (const status of ['identity-mismatch', 'evidence-blocked'] as const) {
      expect(
        reduceRepositoryState(status, {
          kind: 'apply-assessment',
          assessment: { kind: 'same' },
        }),
      ).toEqual({ kind: 'rejected', reason: 'terminal-status' });
      expect(reduceRepositoryState(status, { kind: 'retire' })).toMatchObject({
        kind: 'transition',
        toStatus: 'retired',
      });
    }
    expect(REPOSITORY_STATUSES).toHaveLength(6);
  });

  it('throws for unknown states, commands, differences, reasons, and pairings (A2A-STATUS-014)', () => {
    expect(() =>
      reduceRepositoryState('invented' as never, {
        kind: 'apply-assessment',
        assessment: { kind: 'same' },
      }),
    ).toThrow(/Unsupported repository status/);
    expect(() => reduceRepositoryState('active', { kind: 'invented' } as never)).toThrow(
      /Unsupported repository state variant/,
    );
    expect(() =>
      reduceRepositoryState('active', {
        kind: 'apply-assessment',
        assessment: {
          kind: 'environment-evidence-changed',
          differences: ['invented'],
        } as never,
      }),
    ).toThrow(/environmental differences/);
    expect(() =>
      reduceRepositoryState('active', {
        kind: 'apply-assessment',
        assessment: { kind: 'unavailable', reason: 'invented' } as never,
      }),
    ).toThrow(/unavailable reason/);
    expect(() =>
      reduceRepositoryState('active', {
        kind: 'apply-assessment',
        assessment: { kind: 'risk-evidence-changed', differences: [] },
      }),
    ).toThrow(/risk differences/);
  });
});

describe('repository error evidence normalization', () => {
  it('sorts, filters, bounds, truncates, and never throws', () => {
    const normalized = normalizeRepositoryErrorEvidence({
      z: true,
      'bad-key': 'omitted',
      a: '🙂'.repeat(2000),
      n: 42,
    });
    expect(Object.keys(normalized)).toEqual(['a', 'n', 'z']);
    expect(new TextEncoder().encode(normalized.a as string).byteLength).toBe(2048);
    expect(JSON.stringify(normalized).length).toBeLessThanOrEqual(8192);
  });

  it('returns an accepted prefix when an accessor throws (A2A-INSP-017)', () => {
    const value = { a: 'kept' } as Record<string, string>;
    Object.defineProperty(value, 'z', {
      enumerable: true,
      get() {
        throw new Error('hostile accessor');
      },
    });
    expect(() => normalizeRepositoryErrorEvidence(value)).not.toThrow();
  });
});
