import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { sendApiError } from './http.js';

/**
 * What the browser may load and run for the app (R-G9, SEC-07): its own scripts, styles and
 * requests only, no plugins, no other base, and no framing. The app has no inline script or
 * style element; React sets styles through the DOM, which the policy does not govern.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // The page's icon is a `data:` URL.
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** The headers every answer carries, unless its route set its own. */
export const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ['content-security-policy', CONTENT_SECURITY_POLICY],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['cross-origin-opener-policy', 'same-origin'],
];

/**
 * An event stream's response headers. A stream writes its own response, past the hook that adds
 * the security headers to every other answer, so it names them itself (R-G9 review).
 */
export function eventStreamHeaders(): Record<string, string> {
  return {
    ...Object.fromEntries(SECURITY_HEADERS),
    'content-type': 'text/event-stream',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The host a `Host` header names, without its port, lower-cased; undefined if malformed. */
export function headerHostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end < 0 ? undefined : value.slice(0, end + 1);
  }
  const [name] = value.split(':');
  return name || undefined;
}

/**
 * Whether a request's `Host` names this daemon: the public origin's host, a loopback name, or
 * the address it listens on.
 * Anything else is a page that resolved its own name to this address (DNS rebinding) or a
 * misdirected request, and is refused before any route runs (R-G9, SEC-07).
 */
export function allowedHost(host: string | undefined, config: ServerConfig): boolean {
  const name = headerHostname(host);
  if (name === undefined) return false;
  return (
    LOOPBACK_NAMES.has(name) ||
    name === new URL(config.publicOrigin).hostname.toLowerCase() ||
    // The address it listens on, unless a wildcard (R-G9 review: the deploy's health check).
    (!WILDCARD_HOSTS.has(config.host) && name === config.host.toLowerCase())
  );
}

/** Installs the Host check and the security headers every answer carries (R-G9, SEC-07). */
export function installBrowserSecurity(app: FastifyInstance, config: ServerConfig): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!allowedHost(request.headers.host, config))
      return sendApiError(reply, 421, 'forbidden', 'This daemon does not serve that host.');
  });
  // A route that sets one of these more strictly keeps its own (raw sources are sandboxed).
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of SECURITY_HEADERS)
      if (!reply.hasHeader(name)) reply.header(name, value);
    return payload;
  });
}
