import {
  type applyRuntimeRefreshSchema,
  checkpointRecoverySchema,
  type configureRuntimeSchema,
  type discoverRuntimeRequestSchema,
  discoverRuntimeResponseSchema,
  type evidenceDecisionRequestSchema,
  type evidenceSubmissionRequestSchema,
  evidenceSubmissionSchema,
  type generatePlanEvidenceRequestSchema,
  type inspectDependencyRequestSchema,
  inspectDependencyResponseSchema,
  type nativeApprovalRequestSchema,
  nativeAuditSchema,
  type prepareCheckpointRequestSchema,
  type proposeArchitectureDecisionSchema,
  runtimeEvidenceViewSchema,
  runtimeRefreshPreviewSchema,
  type runtimeRefreshRequestSchema,
  type upstreamTransitionRequestSchema,
} from '@craftingtable/contracts';
import type { RequestInput } from '@craftingtable/contracts';
import { request } from './api-client.js';

/**
 * A map's dependency environment (its runtime evidence): its reads, its configuration, and the
 * decision commands on it (R-H5). Each decision command is posted from its one component in
 * `decisions/` (R-A6), which alone imports its function here; the boundary test checks both.
 */
const encode = encodeURIComponent;
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** A map's runtime address, which every read and command below extends. */
export const runtimeAddress = (workspaceId: string, definitionId: string): string =>
  `/api/workspaces/${encode(workspaceId)}/concurrency-definitions/${encode(definitionId)}/runtime`;

export function readRuntime(workspaceId: string, definitionId: string) {
  return request(runtimeAddress(workspaceId, definitionId), runtimeEvidenceViewSchema);
}
export function readSubmission(base: string, submissionId: string) {
  return request(`${base}/submissions/${encode(submissionId)}`, evidenceSubmissionSchema);
}
export function readCheckpointRecovery(base: string, worktreeId: string) {
  return request(`${base}/checkpoint-recovery/${encode(worktreeId)}`, checkpointRecoverySchema);
}
/** A build's record, downloaded as a file from a link. */
export function buildRecordAddress(base: string, runId: string): string {
  return `${base}/runs/${encode(runId)}/build-record`;
}

// Configuration: what the environment is and what it depends on.
export function configureRuntime(
  base: string,
  input: RequestInput<typeof configureRuntimeSchema>,
  csrfToken: string,
) {
  return request(`${base}/configure`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
export function discoverRuntime(
  base: string,
  input: RequestInput<typeof discoverRuntimeRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/discover`, discoverRuntimeResponseSchema, post(csrfToken, input));
}
export function inspectDependency(
  base: string,
  input: RequestInput<typeof inspectDependencyRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/inspect`, inspectDependencyResponseSchema, post(csrfToken, input));
}

// Decision commands, one owner each (R-A6).
/** `decisions/evidence/EvidenceDecision`. */
export function decideEvidence(
  base: string,
  input: RequestInput<typeof evidenceDecisionRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/decide`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
/** `decisions/evidence/SubmitEvidence`. */
export function submitEvidence(
  base: string,
  input: RequestInput<typeof evidenceSubmissionRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/submit`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
/** `decisions/architecture/SaveProposal`. */
export function proposeDecision(
  base: string,
  input: RequestInput<typeof proposeArchitectureDecisionSchema>,
  csrfToken: string,
) {
  return request(`${base}/propose-decision`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
/** `decisions/checkpoint/CheckpointPreparation`. */
export function prepareCheckpoint(
  base: string,
  input: RequestInput<typeof prepareCheckpointRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/prepare-checkpoint`, checkpointRecoverySchema, post(csrfToken, input));
}
/** `decisions/plan-acceptance/PlanAcceptance`. */
export function generatePlanEvidence(
  base: string,
  input: RequestInput<typeof generatePlanEvidenceRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/generate-plan`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
/** `decisions/environment/EnvironmentApproval`: the audit its approval names. */
export function auditNative(base: string, csrfToken: string) {
  return request(`${base}/audit-native`, nativeAuditSchema, post(csrfToken, {}));
}
/** `decisions/environment/EnvironmentApproval`. */
export function authorizeNative(
  base: string,
  // Sent as the form holds them: a revocation without a current runtime or audit is refused by
  // the daemon with its message, as it always was.
  input: Omit<RequestInput<typeof nativeApprovalRequestSchema>, 'runtimeId' | 'auditDigest'> & {
    readonly runtimeId: string | undefined;
    readonly auditDigest: string | undefined;
  },
  csrfToken: string,
) {
  return request(`${base}/authorize-native`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
/** `decisions/upstream/UpstreamTransitions`. */
export function declareTransitions(
  base: string,
  input: RequestInput<typeof upstreamTransitionRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/declare-transitions`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
/** `decisions/refresh/DependencyRefresh`: the refresh's preview. */
export function previewRefresh(
  base: string,
  input: RequestInput<typeof runtimeRefreshRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/preview-refresh`, runtimeRefreshPreviewSchema, post(csrfToken, input));
}
/** `decisions/refresh/DependencyRefresh`. */
export function applyRefresh(
  base: string,
  input: RequestInput<typeof applyRuntimeRefreshSchema>,
  csrfToken: string,
) {
  return request(`${base}/refresh`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
