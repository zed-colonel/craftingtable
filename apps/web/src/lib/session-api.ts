import {
  type AuthenticatedSessionResponse,
  authenticatedSessionResponseSchema,
  type ChangePasswordResponse,
  changePasswordResponseSchema,
  type LoginRequest,
  logoutResponseSchema,
  revokeSessionResponseSchema,
  type SessionListResponse,
  sessionListResponseSchema,
} from '@craftingtable/contracts';
import type { SessionId } from '@craftingtable/domain';
import { ApiError, forgetValidators, request } from './api-client.js';

/** The operator's session: signing in and out, the session list and the password (R-H5). */

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
  forgetValidators();
  return request('/api/auth/login', authenticatedSessionResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function loadSessions(): Promise<SessionListResponse> {
  return request('/api/auth/sessions', sessionListResponseSchema);
}

export async function logout(csrfToken: string): Promise<void> {
  try {
    await request('/api/auth/logout', logoutResponseSchema, {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({}),
    });
  } finally {
    forgetValidators();
  }
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
