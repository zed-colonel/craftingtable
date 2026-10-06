import type { FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.js';
import { type BrowserSecurityHeaders, isAllowedBrowserRequest } from '../security/origin-policy.js';
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

export function requireAllowedOrigin(request: FastifyRequest, config: ServerConfig): void {
  if (!isAllowedBrowserRequest(browserHeaders(request), config.publicOrigin)) {
    throw new ForbiddenError();
  }
}
