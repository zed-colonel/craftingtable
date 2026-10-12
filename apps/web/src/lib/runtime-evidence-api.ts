import {
  checkpointRecoverySchema,
  type configureRuntimeSchema,
  type discoverRuntimeRequestSchema,
  discoverRuntimeResponseSchema,
  evidenceSubmissionSchema,
  type inspectDependencyRequestSchema,
  inspectDependencyResponseSchema,
  runtimeEvidenceViewSchema,
} from '@craftingtable/contracts';
import type { RequestInput } from '@craftingtable/contracts';
import { request } from './api-client.js';

/**
 * A map's dependency environment (its runtime evidence): its reads and its configuration (R-H5).
 * Its decision commands live in their kinds' own modules under `decisions/` (R-A6).
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
