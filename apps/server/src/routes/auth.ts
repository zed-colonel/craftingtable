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
  stepUpRequestSchema,
  stepUpResponseSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE_NAME, type ServerConfig, sessionCookieName } from '../config.js';
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
import { browserHeaders, clientAddress } from './request-security.js';
import { type BodyOf, contextOf } from './route-access.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  config: ServerConfig,
): void {
  app.post<{ Body: BodyOf<typeof loginRequestSchema> }>(
    '/api/auth/login',
    {
      config: {
        access: 'public',
        tag: 'control',
        body: loginRequestSchema,
        invalidBody: 'Invalid authentication request',
      },
      // The origin and the media type are checked before the body is read, and so before the
      // daemon parses it with the declared schema (R-H5).
      onRequest: async (request, reply) => {
        if (!isAllowedBrowserRequest(browserHeaders(request), config.publicOrigin))
          return sendApiError(
            reply,
            403,
            'forbidden',
            `Sign-in is only allowed from ${config.publicOrigin}. Open that address and try again.`,
          );
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
          return sendApiError(reply, 400, 'invalid-request', 'Invalid authentication request');
      },
    },
    async (request, reply) => {
      const result = await authService.login({
        ...request.body,
        ...(request.headers['user-agent'] === undefined
          ? {}
          : { userAgent: request.headers['user-agent'] }),
        requestId: request.id,
        address: clientAddress(request),
      });
      reply.setCookie(
        sessionCookieName(config),
        result.rawSessionToken,
        cookieOptions(config, new Date(result.session.expiresAt)),
      );
      // A cookie under the plain name, from before the `__Host-` prefix, no longer signs anyone
      // in; it goes at the next sign-in.
      if (config.secureCookies)
        reply.clearCookie(SESSION_COOKIE_NAME, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          secure: true,
        });
      return noStore(reply).send(
        authenticatedSessionResponseSchema.parse(
          authenticatedResponse(result.user, result.session),
        ),
      );
    },
  );

  app.get('/api/auth/session', { config: { access: 'session' } }, async (request, reply) => {
    const context = contextOf(request);
    return noStore(reply).send(
      authenticatedSessionResponseSchema.parse(
        authenticatedResponse(context.user, context.session),
      ),
    );
  });

  app.get('/api/auth/sessions', { config: { access: 'session' } }, async (request, reply) => {
    const context = contextOf(request);
    return noStore(reply).send(
      sessionListResponseSchema.parse({
        sessions: authService
          .listSessions(context)
          .map((session) => sessionSummary(session, context.session.id)),
      }),
    );
  });

  app.post<{ Body: BodyOf<typeof logoutRequestSchema> }>(
    '/api/auth/logout',
    {
      config: {
        access: 'session',
        tag: 'control',
        body: logoutRequestSchema,
        invalidBody: 'Invalid logout request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      authService.logout(context, request.id);
      reply.clearCookie(sessionCookieName(config), {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: config.secureCookies,
      });
      return noStore(reply).send(logoutResponseSchema.parse({ success: true }));
    },
  );

  // The current password again, before an unrestricted run or a final promotion (R-G9).
  app.post<{ Body: BodyOf<typeof stepUpRequestSchema> }>(
    '/api/auth/step-up',
    {
      config: {
        access: 'session',
        tag: 'control',
        body: stepUpRequestSchema,
        invalidBody: 'Invalid step-up',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const until = await authService.stepUp(context, request.body.password, request.id);
      return noStore(reply).send(
        stepUpResponseSchema.parse({ steppedUpUntil: until.toISOString() }),
      );
    },
  );

  app.post<{ Body: BodyOf<typeof changePasswordRequestSchema> }>(
    '/api/auth/password',
    {
      config: {
        access: 'session',
        tag: 'control',
        body: changePasswordRequestSchema,
        invalidBody: 'Invalid password change request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const result = await authService.changePassword(context, request.body, request.id);
      return noStore(reply).send(
        changePasswordResponseSchema.parse({
          success: true,
          revokedSessionCount: result.revokedSessionCount,
        }),
      );
    },
  );

  app.post<{ Params: { sessionId: string }; Body: BodyOf<typeof revokeSessionRequestSchema> }>(
    '/api/auth/sessions/:sessionId/revoke',
    {
      config: {
        access: 'session',
        tag: 'control',
        body: revokeSessionRequestSchema,
        invalidBody: 'Invalid session revocation request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const parsedSessionId = sessionIdSchema.safeParse(request.params.sessionId);
      if (!parsedSessionId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const result = authService.revokeSession(context, parsedSessionId.data, request.id);
      if (result.currentSessionRevoked) {
        reply.clearCookie(sessionCookieName(config), {
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
