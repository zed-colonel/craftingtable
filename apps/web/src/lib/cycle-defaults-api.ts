import {
  type CycleDefaultsResponse,
  cycleDefaultsResponseSchema,
  type SaveCycleDefaultsRequest,
} from '@craftingtable/contracts';
import { DEFAULT_COMPLETION_POLICY, type WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';

/**
 * The workspace's default step time limit for new cycles and roadmap entries (R-C17 part 4,
 * decisions 8 and 9): the Settings page edits it, and the forms that start work seed from it.
 */
const url = (workspaceId: WorkspaceId) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/cycle-defaults`;

export function loadCycleDefaults(workspaceId: WorkspaceId): Promise<CycleDefaultsResponse> {
  return request(url(workspaceId), cycleDefaultsResponseSchema);
}

export function saveCycleDefaults(
  workspaceId: WorkspaceId,
  input: SaveCycleDefaultsRequest,
  csrfToken: string,
): Promise<CycleDefaultsResponse> {
  return request(url(workspaceId), cycleDefaultsResponseSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}

/**
 * The minutes a new cycle's or entry's form starts with: the workspace's default, or the completion
 * policy's own when none is saved or it cannot be read (the form still works; the operator can
 * change the field).
 */
export async function cycleDefaultMinutes(workspaceId: WorkspaceId): Promise<number> {
  try {
    return (await loadCycleDefaults(workspaceId)).maxRunMinutes;
  } catch {
    return DEFAULT_COMPLETION_POLICY.maxRunMinutes;
  }
}
