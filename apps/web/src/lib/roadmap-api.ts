import {
  type SaveRoadmapRequest,
  roadmapsResponseSchema,
  roadmapViewSchema,
  roadmapHistoryResponseSchema,
} from '@craftingtable/contracts';
import type { Roadmap, WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';
const base = (workspaceId: WorkspaceId) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmaps`;
const mutation = (csrfToken: string, body: unknown) => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
export const loadRoadmaps = (workspaceId: WorkspaceId) =>
  request(base(workspaceId), roadmapsResponseSchema);
export const loadRoadmapHistory = (roadmap: Roadmap) =>
  request(`${base(roadmap.workspaceId)}/${roadmap.id}/history`, roadmapHistoryResponseSchema);
export const saveRoadmap = (
  workspaceId: WorkspaceId,
  id: string,
  input: SaveRoadmapRequest,
  csrfToken: string,
) => request(`${base(workspaceId)}/${id}`, roadmapViewSchema, mutation(csrfToken, input));
export const controlRoadmap = (
  roadmap: Roadmap,
  action: 'start' | 'pause' | 'resume' | 'stop',
  csrfToken: string,
) =>
  request(
    `${base(roadmap.workspaceId)}/${roadmap.id}/control`,
    roadmapViewSchema,
    mutation(csrfToken, { action, expectedVersion: roadmap.version }),
  );
