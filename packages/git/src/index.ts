/**
 * Two Git boundaries live here:
 *
 * - `createRepositoryInspector`: the CT-04A1 observation-only inspector.
 * - `createGitOperations`: worktree creation, removal, and diffing for
 *   controlled agent worktrees.
 *
 * Both are process authorities with argument-array spawning and bounded
 * lifetimes; neither accepts caller-supplied argv.
 */
export {
  calculateCoreIdentityFingerprint,
  compareRepositoryObservations,
  parseRecordedObservation,
} from './comparison.js';
export type {
  BranchListing,
  DiffCommit,
  DiffFile,
  DiffFileStatus,
  GitFailure,
  GitFailureKind,
  GitOperations,
  GitOperationsOptions,
  GitResult,
  RepositoryIdentity,
  WorktreeDiff,
  WorktreeChanges,
} from './operations.js';
export { createGitOperations } from './operations.js';
export { createRepositoryInspector } from './repository-inspector.js';
export type {
  CoreEvidenceDifference,
  EnvironmentalEvidenceDifference,
  ParsedRepositoryObservation,
  RecordedObservationResult,
  RepositoryInspectionError,
  RepositoryInspectionErrorCategory,
  RepositoryInspectionErrorCode,
  RepositoryInspectionErrorSubject,
  RepositoryInspectionOperation,
  RepositoryInspectionRequest,
  RepositoryInspectionResult,
  RepositoryInspectionRetryability,
  RepositoryInspector,
  RepositoryInspectorCreationResult,
  RepositoryInspectorOptions,
  RepositoryObservationComparison,
  RepositoryObservationComparisonResult,
  RepositoryObservationShape,
  RepositoryRiskScanObservation,
  RepositoryRiskSignal,
  RiskScanDifference,
} from './types.js';
export {
  ALL_REPOSITORY_INSPECTION_ERROR_CODES,
  REPOSITORY_INSPECTION_ERROR_SUBJECTS,
  REPOSITORY_INSPECTION_POLICY_VERSION,
  REPOSITORY_OBSERVATION_VERSION,
  REPOSITORY_RISK_SCAN_PATTERN,
  REPOSITORY_RISK_SCAN_SCOPE_VERSION,
  REPOSITORY_RISK_SIGNALS,
} from './types.js';
