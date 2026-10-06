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

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The client a request comes from, for counting sign-in failures (R-G9). Behind `tailscale
 * serve` every request comes from a loopback proxy, which names its client last in
 * `X-Forwarded-For`; a client that is not on loopback cannot choose its address that way.
 */
export function clientAddress(request: FastifyRequest): string {
  const peer = request.socket.remoteAddress ?? 'unknown';
  const forwarded = request.headers['x-forwarded-for'];
  const named =
    LOOPBACK_PEERS.has(peer) && typeof forwarded === 'string'
      ? forwarded.split(',').at(-1)?.trim()
      : undefined;
  return named || peer;
}

export function requireAllowedOrigin(request: FastifyRequest, config: ServerConfig): void {
  if (!isAllowedBrowserRequest(browserHeaders(request), config.publicOrigin)) {
    throw new ForbiddenError();
  }
}
