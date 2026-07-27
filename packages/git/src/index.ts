/**
 * CT-01's simulated seam remains available for the existing test package.
 * CT-04A1 adds a separate, observation-only local Git boundary. It cannot
 * mutate repositories and is not composed into the daemon in this slice.
 */
export interface RepositorySnapshot {
  name: string;
  branch: string;
  headShaAbbrev: string;
  clean: boolean;
  /** CT-01 snapshots are always simulated. */
  simulated: true;
}

export interface GitService {
  describeRepository(): Promise<RepositorySnapshot>;
}

export {
  compareRepositoryObservations,
  parseRecordedObservation,
} from './comparison.js';
export { createRepositoryInspector } from './repository-inspector.js';
export {
  ALL_REPOSITORY_INSPECTION_ERROR_CODES,
  REPOSITORY_INSPECTION_ERROR_SUBJECTS,
  REPOSITORY_INSPECTION_POLICY_VERSION,
  REPOSITORY_OBSERVATION_VERSION,
  REPOSITORY_RISK_SCAN_PATTERN,
  REPOSITORY_RISK_SCAN_SCOPE_VERSION,
  REPOSITORY_RISK_SIGNALS,
} from './types.js';
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
  RepositoryInspector,
  RepositoryInspectorCreationResult,
  RepositoryInspectorOptions,
  RepositoryInspectionRetryability,
  RepositoryObservationComparison,
  RepositoryObservationComparisonResult,
  RepositoryObservationShape,
  RepositoryRiskScanObservation,
  RepositoryRiskSignal,
  RiskScanDifference,
} from './types.js';
