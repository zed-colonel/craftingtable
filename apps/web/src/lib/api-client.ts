import {
  apiErrorResponseSchema,
  authenticatedSessionResponseSchema,
  type AuthenticatedSessionResponse,
  type LoginRequest,
  logoutResponseSchema,
  revokeSessionResponseSchema,
  sessionListResponseSchema,
  type SessionListResponse,
  workspaceAuditPageResponseSchema,
  type WorkspaceAuditPageResponse,
  workspaceListResponseSchema,
  type WorkspaceListResponse,
  workspaceSnapshotResponseSchema,
  type WorkspaceSnapshotResponse,
} from '@craftingtable/contracts';
import type { SessionId, WorkspaceId } from '@craftingtable/domain';

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
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
    throw new ApiError(
      response.status,
      error.success ? error.data.error.code : 'internal-error',
      error.success ? error.data.error.message : 'The server returned an invalid error response',
    );
  }
  return schema.parse(body);
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
