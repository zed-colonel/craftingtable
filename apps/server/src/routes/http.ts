import {
  apiErrorResponseSchema,
  type AuthenticatedSessionResponse,
  type SessionSummary,
} from '@craftingtable/contracts';
import type { StoredSession, StoredUser } from '@craftingtable/storage';
import type { FastifyReply } from 'fastify';
import type { ServerConfig } from '../config.js';

export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

export function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  code:
    | 'invalid-request'
    | 'invalid-credentials'
    | 'unauthenticated'
    | 'forbidden'
    | 'not-found'
    | 'conflict'
    | 'internal-error',
  message: string,
): FastifyReply {
  return noStore(reply)
    .code(statusCode)
    .send(apiErrorResponseSchema.parse({ error: { code, message } }));
}

export function sessionSummary(
  session: StoredSession,
  currentSessionId: StoredSession['id'],
): SessionSummary {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    status: session.status,
    current: session.id === currentSessionId,
    ...(session.userAgent === undefined ? {} : { userAgent: session.userAgent }),
  };
}

export function authenticatedResponse(
  user: StoredUser,
  session: StoredSession,
): AuthenticatedSessionResponse {
  return {
    user: { id: user.id, username: user.username, status: user.status },
    session: { ...sessionSummary(session, session.id), current: true },
    csrfToken: session.csrfToken,
  };
}

export function cookieOptions(config: ServerConfig, expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: config.secureCookies,
    expires,
    maxAge: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)),
  };
}
