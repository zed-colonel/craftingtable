import {
  type applyRuntimeRefreshSchema,
  type RequestInput,
  runtimeEvidenceViewSchema,
  runtimeRefreshPreviewSchema,
  type runtimeRefreshRequestSchema,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * DependencyRefresh's commands (R-A6): a dependency refresh's preview and its application
 * (`runtime/preview-refresh`, `runtime/refresh`). Private to this kind: only modules in its
 * directory may import it (R-A6; the operator kept the boundary structural in R-H5's review,
 * 2026-10-11).
 */
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

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
