import {
  crossProjectViewSchema,
  type mapSelectionSchema,
  type RequestInput,
  roadmapViewSchema,
  type saveCrossProjectSchema,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
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
  input: RequestInput<typeof mapSelectionSchema>,
  csrf: string,
) => request(`${base(ws, input.definitionId)}/preview`, crossProjectViewSchema, post(csrf, input));
export const saveCrossProject = (
  ws: WorkspaceId,
  input: RequestInput<typeof saveCrossProjectSchema>,
  csrf: string,
) =>
  request(
    `${base(ws, input.configuration.definitionId)}/roadmap`,
    roadmapViewSchema,
    post(csrf, input),
  );
