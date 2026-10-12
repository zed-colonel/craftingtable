import {
  type nativeApprovalRequestSchema,
  nativeAuditSchema,
  type RequestInput,
  runtimeEvidenceViewSchema,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * EnvironmentApproval's commands (R-A6): the native audit its approval names, and the approval
 * (`runtime/audit-native`, `runtime/authorize-native`). Private to this kind: only modules in its
 * directory may import it (R-A6; the operator kept the boundary structural in R-H5's review,
 * 2026-10-11).
 */
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

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
