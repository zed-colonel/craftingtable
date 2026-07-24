import type { DiagnosticSeverity } from '@craftingtable/domain';

/**
 * Stable machine-readable diagnostic codes (work-items/CT-03/CT-03.md §5.4).
 *
 * These are part of the import response contract: the browser groups by them
 * and acceptance tests assert them, so they must not be renamed casually.
 */
export const PLAN_DIAGNOSTIC_CODES = [
  /* Bundle and artifact shape. */
  'required-artifact-missing',
  'duplicate-artifact-role',
  'unknown-artifact-role',
  'duplicate-logical-filename',
  'invalid-logical-filename',
  'unsupported-media-type',
  'artifact-too-large',
  'too-many-artifacts',
  'total-size-exceeded',
  'empty-artifact',
  /* Source text safety. */
  'invalid-yaml',
  'multiple-yaml-documents',
  'unsafe-yaml-key',
  'unsupported-yaml-scalar',
  'yaml-too-complex',
  'checksum-mismatch',
  /* Work-breakdown structure. */
  'invalid-work-breakdown',
  'missing-work-items',
  'too-many-work-items',
  'duplicate-work-item-id',
  'invalid-work-item-id',
  'invalid-work-item-field',
  /* Dependency graph. */
  'missing-required-dependency',
  'self-dependency',
  'required-dependency-cycle',
  /* Warnings. */
  'duplicate-required-dependency',
  'unknown-recommended-dependency',
  'unrecognized-risk',
  'checksum-unmatched-entry',
] as const;

export type PlanDiagnosticCode = (typeof PLAN_DIAGNOSTIC_CODES)[number];

export function isPlanDiagnosticCode(value: unknown): value is PlanDiagnosticCode {
  return (PLAN_DIAGNOSTIC_CODES as readonly string[]).includes(value as string);
}

export interface PlanDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: PlanDiagnosticCode;
  readonly message: string;
  /** Logical filename of the artifact the diagnostic belongs to, if any. */
  readonly artifactName?: string;
  /** Dotted source path, e.g. `pull_requests[3].depends_on[0]`. */
  readonly path?: string;
  readonly workItemSourceId?: string;
  readonly line?: number;
  readonly column?: number;
}

export function error(
  code: PlanDiagnosticCode,
  message: string,
  detail: Omit<PlanDiagnostic, 'severity' | 'code' | 'message'> = {},
): PlanDiagnostic {
  return { severity: 'error', code, message, ...detail };
}

export function warning(
  code: PlanDiagnosticCode,
  message: string,
  detail: Omit<PlanDiagnostic, 'severity' | 'code' | 'message'> = {},
): PlanDiagnostic {
  return { severity: 'warning', code, message, ...detail };
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Total, content-derived ordering.
 *
 * Persisted diagnostics carry an ordinal, so the order must be reproducible
 * from the diagnostics themselves rather than from insertion order; otherwise
 * re-running the same import would renumber identical findings.
 */
export function sortDiagnostics(diagnostics: readonly PlanDiagnostic[]): readonly PlanDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const keys: readonly (keyof PlanDiagnostic)[] = [
      'code',
      'artifactName',
      'workItemSourceId',
      'path',
      'message',
    ];
    for (const key of keys) {
      const comparison = String(left[key] ?? '').localeCompare(String(right[key] ?? ''), 'en');
      if (comparison !== 0) {
        return comparison;
      }
    }
    return 0;
  });
}

export function countBySeverity(diagnostics: readonly PlanDiagnostic[]): {
  readonly errorCount: number;
  readonly warningCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      errorCount += 1;
    } else if (diagnostic.severity === 'warning') {
      warningCount += 1;
    }
  }
  return { errorCount, warningCount };
}

export function hasFatal(diagnostics: readonly PlanDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
