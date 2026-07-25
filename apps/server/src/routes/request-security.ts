import type { FastifyRequest } from 'fastify';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME, type ServerConfig } from '../config.js';
import { csrfTokensEqual } from '../security/csrf.js';
import { type BrowserSecurityHeaders, isAllowedBrowserRequest } from '../security/origin-policy.js';
import type { AuthContext, AuthService } from '../services/auth-service.js';
import { ForbiddenError } from '../services/errors.js';

/**
 * Shared browser-request security.
 *
 * Extracted from `routes/auth.ts` so CT-03's mutations apply the *same* chain
 * as CT-02's rather than a parallel reimplementation of it.
 */

export function browserHeaders(request: FastifyRequest): BrowserSecurityHeaders {
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  return {
    ...(typeof origin === 'string' ? { origin } : {}),
    ...(typeof fetchSite === 'string' ? { secFetchSite: fetchSite } : {}),
  };
}

export function authenticate(request: FastifyRequest, authService: AuthService): AuthContext {
  return authService.authenticate(request.cookies[SESSION_COOKIE_NAME]);
}

export function requireAllowedOrigin(request: FastifyRequest, config: ServerConfig): void {
  if (!isAllowedBrowserRequest(browserHeaders(request), config.publicOrigin)) {
    throw new ForbiddenError();
  }
}

/**
 * Authenticates, then requires a session-bound CSRF token and an allowed
 * origin. Authentication runs first so an unauthenticated request always
 * receives 401 regardless of its other headers (CT-02 finding F5).
 */
export function authorizeMutation(
  request: FastifyRequest,
  authService: AuthService,
  config: ServerConfig,
): AuthContext {
  const context = authenticate(request, authService);
  const csrf = request.headers[CSRF_HEADER_NAME];
  if (
    typeof csrf !== 'string' ||
    !csrfTokensEqual(context.session.csrfToken, csrf) ||
    !isAllowedBrowserRequest(browserHeaders(request), config.publicOrigin)
  ) {
    throw new ForbiddenError();
  }
  return context;
}
