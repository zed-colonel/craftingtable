import {
  adoptMapResponseSchema,
  crossProjectViewSchema,
  roadmapViewSchema,
  type SaveCrossProjectRequest,
} from '@craftingtable/contracts';
import type { CrossProjectConfiguration, WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';
const base = (ws: WorkspaceId, id: string) =>
  `/api/workspaces/${encodeURIComponent(ws)}/concurrency-definitions/${encodeURIComponent(id)}/supervision`;
const post = (csrf: string, body: unknown) => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrf },
  body: JSON.stringify(body),
});
export const previewCrossProject = (
  ws: WorkspaceId,
  input: Pick<
    CrossProjectConfiguration,
    'definitionId' | 'bindingRevision' | 'targetId' | 'selection'
  >,
  csrf: string,
) => request(`${base(ws, input.definitionId)}/preview`, crossProjectViewSchema, post(csrf, input));
export const saveCrossProject = (ws: WorkspaceId, input: SaveCrossProjectRequest, csrf: string) =>
  request(
    `${base(ws, input.configuration.definitionId)}/roadmap`,
    roadmapViewSchema,
    post(csrf, input),
  );

export const adoptCrossProject = (
  ws: WorkspaceId,
  id: string,
  bindingRevision: number,
  decisionIds: readonly string[],
  rationale: string,
  csrf: string,
) =>
  request(
    `${base(ws, id)}/adopt`,
    adoptMapResponseSchema,
    post(csrf, { bindingRevision, decisionIds, rationale }),
  );
