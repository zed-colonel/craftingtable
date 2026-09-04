import { describe, expect, it } from 'vitest';
import {
  calculateCoreIdentityFingerprint,
  compareRepositoryObservations,
  createParsedObservation,
  parseRecordedObservation,
} from '../src/comparison.js';
import {
  ALL_REPOSITORY_INSPECTION_ERROR_CODES,
  REPOSITORY_INSPECTION_ERROR_SUBJECTS,
  REPOSITORY_RISK_SCAN_PATTERN,
} from '../src/index.js';
import type {
  ParsedRepositoryObservation,
  RepositoryObservationShape,
  RepositoryRiskSignal,
} from '../src/index.js';

function observation(
  overrides: {
    readonly policyVersion?: number;
    readonly top?: string;
    readonly git?: string;
    readonly common?: string;
    readonly objectFormat?: 'sha1' | 'sha256';
    readonly topInode?: string;
    readonly commonInode?: string;
    readonly topDevice?: string;
    readonly commonDevice?: string;
    readonly signals?: readonly RepositoryRiskSignal[];
  } = {},
): ParsedRepositoryObservation {
  const top = overrides.top ?? '/source/repository';
  const git = overrides.git ?? `${top}/.git`;
  const signals = [...(overrides.signals ?? [])].sort();
  return createParsedObservation({
    observationVersion: 1,
    inspectionPolicyVersion: overrides.policyVersion ?? 1,
    observedAt: '2026-07-26T12:00:00.000Z',
    gitVersion: { major: 2, minor: 54, patch: 0 },
    canonicalTopLevel: top,
    canonicalGitDirectory: git,
    canonicalCommonGitDirectory: overrides.common ?? git,
    objectFormat: overrides.objectFormat ?? 'sha1',
    coreIdentity: {
      topLevelInode: overrides.topInode ?? '101',
      commonDirectoryInode: overrides.commonInode ?? '202',
    },
    environmentalEvidence: {
      topLevelDevice: overrides.topDevice ?? '1',
      commonDirectoryDevice: overrides.commonDevice ?? '1',
    },
    riskScan: {
      scanScopeVersion: 1,
      scannedKeyPattern: REPOSITORY_RISK_SCAN_PATTERN,
      classification: signals.length === 0 ? 'no-signals-in-scanned-set' : 'signals-observed',
      signals,
    },
  });
}

function serialized(value: ParsedRepositoryObservation): RepositoryObservationShape {
  return JSON.parse(JSON.stringify(value)) as RepositoryObservationShape;
}

describe('recorded observation parsing', () => {
  it('round-trips a valid serialized observation and recomputes its fingerprint', () => {
    const original = observation();
    const parsed = parseRecordedObservation(serialized(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.observation).toEqual(original);
      expect(calculateCoreIdentityFingerprint(parsed.observation)).toBe(
        parsed.observation.coreIdentity.fingerprintSha256,
      );
    }
  });

  it('rejects missing, truncated, number-encoded, fingerprint-altered, and extended records', () => {
    const base = serialized(observation());
    const missing = structuredClone(base) as unknown as Record<string, unknown>;
    delete (missing.coreIdentity as Record<string, unknown>).topLevelInode;

    const numberInode = structuredClone(base);
    (numberInode.coreIdentity as { topLevelInode: unknown }).topLevelInode = 101;

    const fingerprint = structuredClone(base) as unknown as {
      coreIdentity: { fingerprintSha256: string };
    };
    fingerprint.coreIdentity.fingerprintSha256 = '0'.repeat(64);

    const extended = structuredClone(base) as unknown as Record<string, unknown>;
    extended.unreviewed = true;

    for (const candidate of [
      missing,
      numberInode,
      fingerprint,
      extended,
      { observationVersion: 1 },
    ]) {
      const parsed = parseRecordedObservation(candidate);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('recorded-observation-invalid');
      }
    }
  });

  it('returns a distinct failure for unknown observation versions', () => {
    const candidate = serialized(observation()) as {
      observationVersion: number;
    };
    candidate.observationVersion = 2;
    const parsed = parseRecordedObservation(candidate);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('unsupported-observation-version');
    }
  });

  it('is total for hostile values', () => {
    for (const candidate of [
      undefined,
      null,
      true,
      1,
      'observation',
      [],
      {
        get observationVersion() {
          throw new Error('hostile getter');
        },
      },
    ]) {
      expect(() => parseRecordedObservation(candidate)).not.toThrow();
      expect(parseRecordedObservation(candidate).ok).toBe(false);
    }
  });
});

describe('observation comparison', () => {
  it('returns empty difference tiers for identical parsed observations', () => {
    const current = observation();
    const result = compareRepositoryObservations(current, current);
    expect(result).toEqual({
      ok: true,
      comparison: {
        coreDifferences: [],
        environmentalDifferences: [],
        riskScanDifferences: [],
        sameCoreIdentity: true,
        sameEnvironmentalEvidence: true,
        sameRiskScanEvidence: true,
      },
    });
  });

  it('reports each core identity dimension by name', () => {
    const recorded = observation();
    const cases = [
      [observation({ top: '/source/other' }), 'canonical-top-level'],
      [observation({ git: '/source/repository/.different-git' }), 'canonical-git-directory'],
      [observation({ common: '/source/repository/.common' }), 'canonical-common-git-directory'],
      [observation({ objectFormat: 'sha256' }), 'object-format'],
      [observation({ topInode: '999' }), 'top-level-inode'],
      [observation({ commonInode: '999' }), 'common-directory-inode'],
    ] as const;
    for (const [current, difference] of cases) {
      const result = compareRepositoryObservations(recorded, current);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.comparison.coreDifferences).toContain(difference);
        expect(result.comparison.sameCoreIdentity).toBe(false);
      }
    }
  });

  it('keeps device-only and risk-only differences out of core identity', () => {
    const recorded = observation();
    const device = compareRepositoryObservations(
      recorded,
      observation({ topDevice: '2', commonDevice: '3' }),
    );
    expect(device.ok).toBe(true);
    if (device.ok) {
      expect(device.comparison.sameCoreIdentity).toBe(true);
      expect(device.comparison.environmentalDifferences).toEqual([
        'top-level-device',
        'common-directory-device',
      ]);
    }

    const risk = compareRepositoryObservations(
      recorded,
      observation({ signals: ['core-hooks-path'] }),
    );
    expect(risk.ok).toBe(true);
    if (risk.ok) {
      expect(risk.comparison.sameCoreIdentity).toBe(true);
      expect(risk.comparison.riskScanDifferences).toEqual(['signals']);
    }
  });

  it('refuses to compare evidence collected under a different policy version', () => {
    const result = compareRepositoryObservations(observation(), observation({ policyVersion: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('inspection-policy-version-mismatch');
      expect(result).not.toHaveProperty('comparison.sameCoreIdentity');
    }
  });

  it('uses length-prefixing so concatenation boundaries cannot collide', () => {
    const left = observation({ top: '/source/ab', common: '/source/c' });
    const right = observation({ top: '/source/a', common: '/source/bc' });
    expect(left.coreIdentity.fingerprintSha256).not.toBe(right.coreIdentity.fingerprintSha256);
  });
});

describe('failure taxonomy exhaustiveness', () => {
  it('has one subject for every public error code and no extra mappings', () => {
    expect([...ALL_REPOSITORY_INSPECTION_ERROR_CODES].sort()).toEqual(
      Object.keys(REPOSITORY_INSPECTION_ERROR_SUBJECTS).sort(),
    );
    expect(new Set(ALL_REPOSITORY_INSPECTION_ERROR_CODES).size).toBe(
      ALL_REPOSITORY_INSPECTION_ERROR_CODES.length,
    );
  });
});
