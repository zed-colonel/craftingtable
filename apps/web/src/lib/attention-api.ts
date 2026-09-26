import { attentionFeedSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';

/** The workspace's open attention items, most blocking first (R-A5). */
export function loadAttention(workspaceId: WorkspaceId) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/attention`,
    attentionFeedSchema,
  );
}
