import {
  type ApiErrorResponse,
  type AuthenticatedSessionResponse,
  apiErrorResponseSchema,
  authenticatedSessionResponseSchema,
  type ChangePasswordResponse,
  type CreateWorkspaceResponse,
  changePasswordResponseSchema,
  createWorkspaceResponseSchema,
  type LoginRequest,
  logoutResponseSchema,
  type RenameWorkspaceResponse,
  renameWorkspaceResponseSchema,
  revokeSessionResponseSchema,
  type SessionListResponse,
  sessionListResponseSchema,
  type WorkspaceAuditPageResponse,
  type WorkspaceListResponse,
  type WorkspaceSnapshotResponse,
  workspaceAuditPageResponseSchema,
  workspaceListResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import type { SessionId, WorkspaceId } from '@craftingtable/domain';

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

/** The machine-readable part of an error beyond its code, when the daemon sends one. */
export interface ApiErrorDetail {
  readonly reason?: ApiErrorResponse['error']['reason'];
  readonly paths?: readonly string[];
  readonly pathCount?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: ApiErrorDetail = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(
  url: string,
  schema: ResponseSchema<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(body);
    if (!error.success)
      throw new ApiError(
        response.status,
        'internal-error',
        'The server returned an invalid error response',
      );
    const { code, message, ...detail } = error.data.error;
    throw new ApiError(response.status, code, message, detail);
  }
  return parseAnswer(url, schema, body);
}

/**
 * Reads a successful answer through its contract. An answer the contract refuses is a defect
 * between the daemon and the app, not a state a page can explain, so it is also said in the
 * browser console, where the e2e suite fails on it (TS-M15); the read fails as before.
 * `body` is undefined when it could not be read, as when a navigation abandons the read
 * partway: that read fails without a word, since nothing broke the contract.
 */
export function parseAnswer<T>(url: string, schema: ResponseSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (error) {
    if (body !== undefined)
      console.error(`The daemon's answer to ${url} does not match its contract.`, error);
    throw error;
  }
}

export async function loadSession(): Promise<AuthenticatedSessionResponse | undefined> {
  try {
    return await request('/api/auth/session', authenticatedSessionResponseSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return undefined;
    }
    throw error;
  }
}

export function login(input: LoginRequest): Promise<AuthenticatedSessionResponse> {
  return request('/api/auth/login', authenticatedSessionResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function loadSessions(): Promise<SessionListResponse> {
  return request('/api/auth/sessions', sessionListResponseSchema);
}

export async function logout(csrfToken: string): Promise<void> {
  await request('/api/auth/logout', logoutResponseSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify({}),
  });
}

export async function revokeSession(sessionId: SessionId, csrfToken: string): Promise<boolean> {
  const response = await request(
    `/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`,
    revokeSessionResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({}),
    },
  );
  return response.currentSessionRevoked;
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

export function changePassword(
  input: { currentPassword: string; newPassword: string },
  csrfToken: string,
): Promise<ChangePasswordResponse> {
  return request('/api/auth/password', changePasswordResponseSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
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
