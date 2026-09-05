import {
  authenticatedSessionResponseSchema,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  loginRequestSchema,
  logoutRequestSchema,
  logoutResponseSchema,
  revokeSessionRequestSchema,
  revokeSessionResponseSchema,
  sessionIdSchema,
  sessionListResponseSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE_NAME, type ServerConfig } from '../config.js';
import { isAllowedBrowserRequest } from '../security/origin-policy.js';
import type { AuthService } from '../services/auth-service.js';
import { NotFoundError, UnauthenticatedError } from '../services/errors.js';
import {
  authenticatedResponse,
  cookieOptions,
  noStore,
  sendApiError,
  sessionSummary,
} from './http.js';
import { authenticate, authorizeMutation, browserHeaders } from './request-security.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  config: ServerConfig,
): void {
  app.post('/api/auth/login', async (request, reply) => {
    if (
      !request.headers['content-type']?.toLowerCase().startsWith('application/json') ||
      !isAllowedBrowserRequest(browserHeaders(request), config.publicOrigin)
    ) {
      return sendApiError(reply, 400, 'invalid-request', 'Invalid authentication request');
    }
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(reply, 400, 'invalid-request', 'Invalid authentication request');
    }
    const result = await authService.login({
      ...parsed.data,
      ...(request.headers['user-agent'] === undefined
        ? {}
        : { userAgent: request.headers['user-agent'] }),
      requestId: request.id,
    });
    reply.setCookie(
      SESSION_COOKIE_NAME,
      result.rawSessionToken,
      cookieOptions(config, new Date(result.session.expiresAt)),
    );
    return noStore(reply).send(
      authenticatedSessionResponseSchema.parse(authenticatedResponse(result.user, result.session)),
    );
  });

  app.get('/api/auth/session', async (request, reply) => {
    const context = authenticate(request, authService);
    return noStore(reply).send(
      authenticatedSessionResponseSchema.parse(
        authenticatedResponse(context.user, context.session),
      ),
    );
  });

  app.get('/api/auth/sessions', async (request, reply) => {
    const context = authenticate(request, authService);
    return noStore(reply).send(
      sessionListResponseSchema.parse({
        sessions: authService
          .listSessions(context)
          .map((session) => sessionSummary(session, context.session.id)),
      }),
    );
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const context = authorizeMutation(request, authService, config);
    if (!logoutRequestSchema.safeParse(request.body).success) {
      return sendApiError(reply, 400, 'invalid-request', 'Invalid logout request');
    }
    authService.logout(context, request.id);
    reply.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: config.secureCookies,
    });
    return noStore(reply).send(logoutResponseSchema.parse({ success: true }));
  });

  app.post('/api/auth/password', async (request, reply) => {
    const context = authorizeMutation(request, authService, config);
    const parsed = changePasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(reply, 400, 'invalid-request', 'Invalid password change request');
    }
    const result = await authService.changePassword(context, parsed.data, request.id);
    return noStore(reply).send(
      changePasswordResponseSchema.parse({
        success: true,
        revokedSessionCount: result.revokedSessionCount,
      }),
    );
  });

  app.post<{ Params: { sessionId: string } }>(
    '/api/auth/sessions/:sessionId/revoke',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      if (!revokeSessionRequestSchema.safeParse(request.body).success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid session revocation request');
      }
      const parsedSessionId = sessionIdSchema.safeParse(request.params.sessionId);
      if (!parsedSessionId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const result = authService.revokeSession(context, parsedSessionId.data, request.id);
      if (result.currentSessionRevoked) {
        reply.clearCookie(SESSION_COOKIE_NAME, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          secure: config.secureCookies,
        });
      }
      return noStore(reply).send(
        revokeSessionResponseSchema.parse({
          revokedSessionId: result.revokedSessionId,
          currentSessionRevoked: result.currentSessionRevoked,
        }),
      );
    },
  );
}

export function isAuthRouteError(error: unknown): error is UnauthenticatedError | NotFoundError {
  return error instanceof UnauthenticatedError || error instanceof NotFoundError;
}
