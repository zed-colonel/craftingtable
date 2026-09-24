/**
 * Status vocabulary of the retired CT-04A2 repository registry. Only the workspace-event
 * journal still names it: its `repository-*` event kinds and their correlation columns stay
 * in the schema (the tables they reference cannot be dropped without rebuilding the
 * journal), although nothing writes them any more (R-B8).
 */
export const REPOSITORY_STATUSES = [
  'active',
  'unavailable',
  'identity-evidence-changed',
  'identity-mismatch',
  'evidence-blocked',
  'retired',
] as const;
export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

export const REPOSITORY_STATUS_REASONS = [
  'registration-accepted',
  'evidence-matches',
  'environment-evidence-changed',
  'core-identity-changed',
  'repository-class-changed',
  'path-unavailable',
  'metadata-unreadable',
  'stored-evidence-digest-mismatch',
  'stored-evidence-invalid',
  'unsupported-observation-version',
  'inspection-policy-version-mismatch',
  'environment-evidence-reaffirmed',
  'operator-retired',
] as const;
export type RepositoryStatusReason = (typeof REPOSITORY_STATUS_REASONS)[number];

export const REPOSITORY_STATUS_REASON_SETS = {
  active: ['registration-accepted', 'evidence-matches', 'environment-evidence-reaffirmed'],
  unavailable: ['path-unavailable', 'metadata-unreadable'],
  'identity-evidence-changed': ['environment-evidence-changed'],
  'identity-mismatch': ['core-identity-changed', 'repository-class-changed'],
  'evidence-blocked': [
    'stored-evidence-digest-mismatch',
    'stored-evidence-invalid',
    'unsupported-observation-version',
    'inspection-policy-version-mismatch',
  ],
  retired: ['operator-retired'],
} as const satisfies Readonly<Record<RepositoryStatus, readonly RepositoryStatusReason[]>>;
