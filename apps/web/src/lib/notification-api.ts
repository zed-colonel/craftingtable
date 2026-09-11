import { notificationStatusSchema, type SaveNotificationsRequest } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';
const url = (workspaceId: WorkspaceId) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/notifications`;
export function loadNotifications(workspaceId: WorkspaceId) {
  return request(url(workspaceId), notificationStatusSchema);
}
export function saveNotifications(
  workspaceId: WorkspaceId,
  input: SaveNotificationsRequest,
  csrfToken: string,
) {
  return request(url(workspaceId), notificationStatusSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}
export function testNotifications(workspaceId: WorkspaceId, csrfToken: string) {
  return request(`${url(workspaceId)}/test`, notificationStatusSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: '{}',
  });
}
