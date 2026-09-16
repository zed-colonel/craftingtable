import {
  apiErrorResponseSchema,
  archivePlanImportResponseSchema,
  concurrencyDetailSchema,
  concurrencyImportResponseSchema,
  concurrencyListSchema,
  planArchivePreviewSchema,
  type SaveConcurrencyBindings,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { ApiError, request } from './api-client.js';

const base = (workspaceId: WorkspaceId) => `/api/workspaces/${encodeURIComponent(workspaceId)}`;
async function upload<T>(
  url: string,
  file: File,
  fields: Record<string, string>,
  csrfToken: string,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('archive', file, file.name);
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: form,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(body);
    throw new ApiError(
      response.status,
      'invalid-request',
      error.success ? error.data.error.message : 'The package request failed.',
    );
  }
  return schema.parse(body);
}
export const previewPlanZip = (
  workspaceId: WorkspaceId,
  file: File,
  csrfToken: string,
  selection?: { implementationPlan: string; workBreakdown: string },
) =>
  upload(
    `${base(workspaceId)}/plan-archives/preview`,
    file,
    selection ?? {},
    csrfToken,
    planArchivePreviewSchema,
  );
export const importPlanZip = (
  workspaceId: WorkspaceId,
  file: File,
  fields: Record<string, string>,
  csrfToken: string,
) =>
  upload(
    `${base(workspaceId)}/plan-archives/import`,
    file,
    fields,
    csrfToken,
    archivePlanImportResponseSchema,
  );
export const importConcurrencyZip = (workspaceId: WorkspaceId, file: File, csrfToken: string) =>
  upload(
    `${base(workspaceId)}/concurrency-imports`,
    file,
    {},
    csrfToken,
    concurrencyImportResponseSchema,
  );
export const loadConcurrencyImports = (workspaceId: WorkspaceId) =>
  request(`${base(workspaceId)}/concurrency-imports`, concurrencyListSchema);
export const loadConcurrencyDefinition = (workspaceId: WorkspaceId, id: string) =>
  request(
    `${base(workspaceId)}/concurrency-definitions/${encodeURIComponent(id)}`,
    concurrencyDetailSchema,
  );
export const saveConcurrencyBindings = (
  workspaceId: WorkspaceId,
  id: string,
  input: SaveConcurrencyBindings,
  csrfToken: string,
) =>
  request(
    `${base(workspaceId)}/concurrency-definitions/${encodeURIComponent(id)}/bindings`,
    concurrencyDetailSchema,
    { method: 'POST', headers: { 'x-craftingtable-csrf': csrfToken }, body: JSON.stringify(input) },
  );
export const archiveDownloadPath = (workspaceId: WorkspaceId, id: string) =>
  `${base(workspaceId)}/import-archives/${encodeURIComponent(id)}`;
