import { storageStatusSchema, type SaveStorageRequest } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';
const url = (id: WorkspaceId) => `/api/workspaces/${encodeURIComponent(id)}/storage`;
export const loadStorage = (id: WorkspaceId) => request(url(id), storageStatusSchema);
export function saveStorage(id: WorkspaceId, input: SaveStorageRequest, csrfToken: string) {
  return request(url(id), storageStatusSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}
export function storageCommand(
  id: WorkspaceId,
  action: 'scan' | 'clean' | 'backup',
  csrfToken: string,
  scanId?: string,
) {
  return request(`${url(id)}/${action}`, storageStatusSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(scanId ? { scanId } : {}),
  });
}
