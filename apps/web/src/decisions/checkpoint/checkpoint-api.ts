import {
  checkpointRecoverySchema,
  type prepareCheckpointRequestSchema,
  type RequestInput,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * CheckpointPreparation's command (R-A6): a checkpoint candidate prepared for review
 * (`runtime/prepare-checkpoint`). Private to this kind: only modules in its directory may import
 * it (R-A6; the operator kept the boundary structural in R-H5's review, 2026-10-11).
 */
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** `decisions/checkpoint/CheckpointPreparation`. */
export function prepareCheckpoint(
  base: string,
  input: RequestInput<typeof prepareCheckpointRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/prepare-checkpoint`, checkpointRecoverySchema, post(csrfToken, input));
}
