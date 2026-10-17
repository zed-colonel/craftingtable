import {
  type cleanupRequestSchema,
  repositoryCleanupViewSchema,
  roadmapWindDownViewSchema,
  type windDownRequestSchema,
  type applyRoadmapAgentsSchema,
  decisionPreparationSettingsSchema,
  roadmapCapacitiesSchema,
  type saveRoadmapCapacitySchema,
  crossProjectFinalizationSchema,
  type RequestInput,
  type RoadmapAgentSettings,
  roadmapAgentSettingsSchema,
  roadmapGraphSchema,
  type saveRoadmapRequestSchema,
  type ReverificationGrantRequest,
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
const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmaps`;
/** A roadmap's save as the browser sends it. */
export type RoadmapSave = RequestInput<typeof saveRoadmapRequestSchema>;
/** An ADR-064 agent assignment as the browser sends it, without the version it applies at. */
type AgentAssignment = Omit<RequestInput<typeof applyRoadmapAgentsSchema>, 'expectedVersion'>;
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
/** The standing grant to re-verify stale evidence automatically (R-C10's follow-up, decision 4). */
export const configureReverification = (
  roadmap: Roadmap,
  input: ReverificationGrantRequest,
  csrfToken: string,
) =>
  request(
    `${base(roadmap.workspaceId)}/${roadmap.id}/reverification`,
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
  groups: readonly AgentAssignment[],
  csrfToken: string,
  /**
   * Told of each group as it is applied, with the roadmap's agents after it, so a caller whose
   * later group is refused knows what already took effect (review LOW-1).
   */
  onApplied?: (group: AgentAssignment, latest: RoadmapAgentSettings) => void,
) {
  let version = expectedVersion;
  let latest: RoadmapAgentSettings | undefined;
  for (const group of groups) {
    latest = await request(
      `${base(workspaceId)}/${encodeURIComponent(id)}/agent-profiles`,
      roadmapAgentSettingsSchema,
      mutation(csrfToken, { ...group, expectedVersion: version }),
    );
    version = latest.version;
    onApplied?.(group, latest);
  }
  return latest;
}
/** Entries' agent drafts as assignments: the entries that chose the same set share one. */
export function agentGroups(
  drafts: ReadonlyMap<string, AgentAssignment['selections']>,
): AgentAssignment[] {
  const groups = new Map<string, AgentAssignment>();
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
  input: RoadmapSave,
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

/** A roadmap's address, which its amendment commands and reads extend. */
export const roadmapAddress = (workspaceId: string, roadmapId: string) =>
  `${base(workspaceId)}/${encodeURIComponent(roadmapId)}`;
/** A map roadmap's final promotion readiness (R-A6: shown beside its amendments). */
export const loadFinalizationReadiness = (address: string) =>
  request(`${address}/finalization-readiness`, crossProjectFinalizationSchema);

/** Each roadmap's admission limits, for Settings' capacity page. */
export const loadRoadmapCapacities = (workspaceId: string) =>
  request(`${base(workspaceId)}/capacities`, roadmapCapacitiesSchema);
export const saveRoadmapCapacity = (
  workspaceId: string,
  roadmapId: string,
  input: RequestInput<typeof saveRoadmapCapacitySchema>,
  csrfToken: string,
) =>
  request(
    `${roadmapAddress(workspaceId, roadmapId)}/capacity`,
    roadmapCapacitiesSchema,
    mutation(csrfToken, input),
  );

/** A roadmap's decision-preparation settings: its version, decisions' agents and preparations. */
export const loadDecisionPreparations = (workspaceId: string, roadmapId: string) =>
  request(
    `${roadmapAddress(workspaceId, roadmapId)}/decision-preparations`,
    decisionPreparationSettingsSchema,
  );

/** A roadmap's settlement record and what winding it down would do now (R-B11, ADR-073). */
export const loadRoadmapWindDown = (workspaceId: string, roadmapId: string) =>
  request(`${roadmapAddress(workspaceId, roadmapId)}/wind-down`, roadmapWindDownViewSchema);
/** Stops or winds the roadmap down; retiring a version asks for the password again. */
export const windDownRoadmap = (
  workspaceId: string,
  roadmapId: string,
  input: RequestInput<typeof windDownRequestSchema>,
  csrfToken: string,
) =>
  request(
    `${roadmapAddress(workspaceId, roadmapId)}/wind-down`,
    roadmapWindDownViewSchema,
    mutation(csrfToken, input),
  );
/** A wound-down roadmap's cleanup: running, latest, or what one would do now (R-B11). */
export const loadRoadmapCleanup = (workspaceId: string, roadmapId: string) =>
  request(`${roadmapAddress(workspaceId, roadmapId)}/cleanup`, repositoryCleanupViewSchema);
/** Cleans up the repositories, or resumes the cleanup running; always asks for the password. */
export const cleanUpRoadmap = (
  workspaceId: string,
  roadmapId: string,
  input: RequestInput<typeof cleanupRequestSchema>,
  csrfToken: string,
) =>
  request(
    `${roadmapAddress(workspaceId, roadmapId)}/cleanup`,
    repositoryCleanupViewSchema,
    mutation(csrfToken, input),
  );
