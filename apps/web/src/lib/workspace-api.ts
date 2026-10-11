import {
  type CreateWorkspaceResponse,
  createWorkspaceResponseSchema,
  type HostSchedulingStatus,
  hostSchedulingSchema,
  operatorWaitReportSchema,
  type RequestInput,
  type RenameWorkspaceResponse,
  renameWorkspaceResponseSchema,
  type saveHostSchedulingSchema,
  type WorkspaceAuditPageResponse,
  type WorkspaceListResponse,
  type WorkspaceSnapshotResponse,
  workspaceAuditPageResponseSchema,
  workspaceListResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';

/** A workspace's own reads and settings, and its event stream's address (R-H5). */
const encode = encodeURIComponent;
const workspaceUrl = (workspaceId: string) => `/api/workspaces/${encode(workspaceId)}`;

/** The workspace's event stream, read with an `EventSource` from the given sequence. */
export function workspaceEventsAddress(workspaceId: WorkspaceId, after: number): string {
  return `${workspaceUrl(workspaceId)}/events?after=${after}`;
}

/** Hours the workspace's work waited on the operator, over the last `days` days (R-C1). */
export function loadOperatorWait(workspaceId: string, days: number) {
  return request(
    `${workspaceUrl(workspaceId)}/operator-wait?days=${days}`,
    operatorWaitReportSchema,
  );
}

/** The workstation's capacities, for the owner of the installation. */
export function loadHostScheduling(workspaceId: string): Promise<HostSchedulingStatus> {
  return request(`${workspaceUrl(workspaceId)}/host-scheduling`, hostSchedulingSchema);
}
export function saveHostScheduling(
  workspaceId: string,
  input: RequestInput<typeof saveHostSchedulingSchema>,
  csrfToken: string,
): Promise<HostSchedulingStatus> {
  return request(`${workspaceUrl(workspaceId)}/host-scheduling`, hostSchedulingSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}

export function loadWorkspaces(): Promise<WorkspaceListResponse> {
  return request('/api/workspaces', workspaceListResponseSchema);
}

export function createWorkspace(name: string, csrfToken: string): Promise<CreateWorkspaceResponse> {
  return request('/api/workspaces', createWorkspaceResponseSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify({ name }),
  });
}

export function renameWorkspace(
  workspaceId: WorkspaceId,
  name: string,
  csrfToken: string,
): Promise<RenameWorkspaceResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/rename`,
    renameWorkspaceResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ name }),
    },
  );
}

export function loadWorkspaceSnapshot(
  workspaceId: WorkspaceId,
): Promise<WorkspaceSnapshotResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`,
    workspaceSnapshotResponseSchema,
  );
}

export function loadWorkspaceAudit(workspaceId: WorkspaceId): Promise<WorkspaceAuditPageResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/audit?limit=25`,
    workspaceAuditPageResponseSchema,
  );
}
