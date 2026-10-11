import {
  type ApplyRoadmapAgents,
  roadmapAgentSettingsSchema,
  roadmapGraphSchema,
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
/** A roadmap's graph at one revision, which never changes (R-E3b). */
export const loadRoadmapGraph = (workspaceId: WorkspaceId, id: string, revision: number) =>
  request(`${base(workspaceId)}/${encodeURIComponent(id)}/graph/${revision}`, roadmapGraphSchema);
export const loadRoadmapStatus = (roadmap: Pick<Roadmap, 'workspaceId' | 'id'>) =>
  request(`${base(roadmap.workspaceId)}/${roadmap.id}/status`, roadmapStatusListSchema);
export const loadRoadmapHistory = (roadmap: Roadmap) =>
  request(`${base(roadmap.workspaceId)}/${roadmap.id}/history`, roadmapHistoryResponseSchema);
/** A roadmap's agents as its setup edits them, with their sources (R-E5b). */
export const loadRoadmapAgents = (workspaceId: WorkspaceId, id: string) =>
  request(
    `${base(workspaceId)}/${encodeURIComponent(id)}/agent-profiles`,
    roadmapAgentSettingsSchema,
  );
/**
 * Applies agents to entries as an ADR-064 assignment, the only way a roadmap's agents change
 * (R-E5b): one assignment per distinct selection set, in turn, each at the version the last left.
 * Answers the roadmap's agents after the last, or nothing when there was nothing to apply.
 */
export async function applyRoadmapAgents(
  workspaceId: WorkspaceId,
  id: string,
  expectedVersion: number,
  groups: readonly Omit<ApplyRoadmapAgents, 'expectedVersion'>[],
  csrfToken: string,
) {
  let version = expectedVersion;
  let latest: Awaited<ReturnType<typeof loadRoadmapAgents>> | undefined;
  for (const group of groups) {
    latest = await request(
      `${base(workspaceId)}/${encodeURIComponent(id)}/agent-profiles`,
      roadmapAgentSettingsSchema,
      mutation(csrfToken, { ...group, expectedVersion: version }),
    );
    version = latest.version;
  }
  return latest;
}
/** Entries' agent drafts as assignments: the entries that chose the same set share one. */
export function agentGroups(
  drafts: ReadonlyMap<string, ApplyRoadmapAgents['selections']>,
): Omit<ApplyRoadmapAgents, 'expectedVersion'>[] {
  const groups = new Map<string, Omit<ApplyRoadmapAgents, 'expectedVersion'>>();
  for (const [entryId, selections] of drafts) {
    const key = JSON.stringify(selections);
    const group = groups.get(key);
    groups.set(key, {
      selections,
      entryIds: [...(group?.entryIds ?? []), entryId],
    });
  }
  return [...groups.values()];
}
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
    `/api/workspaces/${encodeURIComponent(roadmap.workspaceId)}/roadmaps/${encodeURIComponent(roadmap.id)}/control`,
    roadmapViewSchema,
    mutation(csrfToken, {
      action,
      expectedVersion: roadmap.version,
      ...(entryId ? { entryId } : {}),
    }),
  );
