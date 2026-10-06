import {
  type SaveRoadmapRequest,
  type ScopeRecoveryPolicyRequest,
  roadmapDefinitionSchema,
  roadmapPageSchema,
  roadmapSummariesSchema,
  roadmapsResponseSchema,
  roadmapViewSchema,
  roadmapHistoryResponseSchema,
  roadmapStatusListSchema,
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
export const configureScopeRecovery = (
  roadmap: Roadmap,
  input: ScopeRecoveryPolicyRequest,
  csrfToken: string,
) =>
  request(
    `${base(roadmap.workspaceId)}/${roadmap.id}/scope-recovery`,
    roadmapViewSchema,
    mutation(csrfToken, input),
  );
export const loadRoadmaps = (workspaceId: WorkspaceId) =>
  request(base(workspaceId), roadmapsResponseSchema);
/** The roadmaps list page's light rows (R-D5). */
export const loadRoadmapSummaries = (workspaceId: WorkspaceId) =>
  request(`${base(workspaceId)}/summaries`, roadmapSummariesSchema);
/** A roadmap page's region in one read: its view without the definition, and its status (R-D5). */
export const loadRoadmapPage = (workspaceId: WorkspaceId, id: string) =>
  request(`${base(workspaceId)}/${encodeURIComponent(id)}/view`, roadmapPageSchema);
/** One revision of a roadmap's definition, which never changes (R-D5). */
export const loadRoadmapDefinition = (workspaceId: WorkspaceId, id: string, revision: number) =>
  request(
    `${base(workspaceId)}/${encodeURIComponent(id)}/definitions/${revision}`,
    roadmapDefinitionSchema,
  );
export const loadRoadmapStatus = (roadmap: Pick<Roadmap, 'workspaceId' | 'id'>) =>
  request(`${base(roadmap.workspaceId)}/${roadmap.id}/status`, roadmapStatusListSchema);
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
  action: 'start' | 'pause' | 'resume' | 'stop' | 'reverify',
  csrfToken: string,
  entryId?: string,
) =>
  request(
    `${base(roadmap.workspaceId)}/${roadmap.id}/control`,
    roadmapViewSchema,
    mutation(csrfToken, {
      action,
      expectedVersion: roadmap.version,
      ...(entryId ? { entryId } : {}),
    }),
  );
