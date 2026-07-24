import {
  admitWorkItemResponseSchema,
  type AdmitWorkItemResponse,
  planImportAttemptListResponseSchema,
  type PlanImportAttemptListResponse,
  planImportResponseSchema,
  type PlanImportResponse,
  planVersionDetailResponseSchema,
  type PlanVersionDetailResponse,
  projectDetailResponseSchema,
  type ProjectDetailResponse,
  projectListResponseSchema,
  type ProjectListResponse,
  workItemDetailResponseSchema,
  type WorkItemDetailResponse,
} from '@craftingtable/contracts';
import type {
  PlanArtifactId,
  PlanVersionId,
  ProjectId,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import { ApiError, request } from './api-client.js';

/** Every planning response is revalidated in the browser (ADR-003). */

const encode = encodeURIComponent;

export function loadProjects(workspaceId: WorkspaceId): Promise<ProjectListResponse> {
  return request(`/api/workspaces/${encode(workspaceId)}/projects`, projectListResponseSchema);
}

export function loadProject(
  workspaceId: WorkspaceId,
  projectId: ProjectId,
): Promise<ProjectDetailResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/projects/${encode(projectId)}`,
    projectDetailResponseSchema,
  );
}

export function loadPlanVersion(
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  planVersionId: PlanVersionId,
): Promise<PlanVersionDetailResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/projects/${encode(projectId)}/plan-versions/${encode(planVersionId)}`,
    planVersionDetailResponseSchema,
  );
}

export function loadWorkItem(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
): Promise<WorkItemDetailResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}`,
    workItemDetailResponseSchema,
  );
}

export function loadImportAttempts(
  workspaceId: WorkspaceId,
): Promise<PlanImportAttemptListResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/plan-imports`,
    planImportAttemptListResponseSchema,
  );
}

export function admitWorkItem(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  csrfToken: string,
): Promise<AdmitWorkItemResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/admit`,
    admitWorkItemResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({}),
    },
  );
}

/**
 * Fetches artifact bytes as text.
 *
 * The response is served as an attachment with sniffing disabled; the browser
 * renders it as escaped text, never as markup (CT03-A40, CT03-A65).
 */
export async function loadArtifactText(
  workspaceId: WorkspaceId,
  artifactId: PlanArtifactId,
): Promise<string> {
  const response = await fetch(
    `/api/workspaces/${encode(workspaceId)}/plan-artifacts/${encode(artifactId)}`,
    { credentials: 'same-origin' },
  );
  if (!response.ok) {
    throw new ApiError(response.status, 'not-found', 'The source artifact could not be loaded');
  }
  return response.text();
}

export interface PlanImportUpload {
  readonly projectName?: string;
  readonly projectId?: ProjectId;
  readonly files: readonly { readonly role: string; readonly file: File }[];
}

export async function importPlanBundle(
  workspaceId: WorkspaceId,
  upload: PlanImportUpload,
  csrfToken: string,
): Promise<PlanImportResponse> {
  const form = new FormData();
  if (upload.projectName !== undefined) {
    form.append('projectName', upload.projectName);
  }
  if (upload.projectId !== undefined) {
    form.append('projectId', upload.projectId);
  }
  for (const entry of upload.files) {
    // The multipart field name *is* the artifact role (CT-03 §5.1).
    form.append(entry.role, entry.file, entry.file.name);
  }
  const response = await fetch(`/api/workspaces/${encode(workspaceId)}/plan-imports`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: form,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(response.status, 'invalid-request', 'The plan import request was rejected');
  }
  return planImportResponseSchema.parse(body);
}
