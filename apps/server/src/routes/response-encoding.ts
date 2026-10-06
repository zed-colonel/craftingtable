import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const gzipBody = promisify(gzip);

/** A read at least this large is gzipped for a client that accepts it (R-D5, PERF-16). */
export const COMPRESS_MIN_BYTES = 8 * 1024;

/**
 * Whether the client accepts gzip: named with a non-zero weight, or covered by `*` with one and
 * not refused by name (RFC 9110 §12.5.3).
 */
export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  const weights = new Map<string, number>();
  for (const part of header.split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(name.trim(), Number.isFinite(weight) ? weight : 0);
  }
  const named = weights.get('gzip') ?? weights.get('x-gzip');
  return named === undefined ? (weights.get('*') ?? 0) > 0 : named > 0;
}

/** Whether `If-None-Match` names this weak validator (weak comparison, RFC 9110 §13.1.2). */
function matches(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  const opaque = tag.slice(2);
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate.replace(/^W\//, '') === opaque);
}

/**
 * Encodes the API's successful JSON reads (R-D5, PERF-16):
 * - each carries a weak validator, a digest of its body, and a request naming it gets 304 with
 *   no body. Answers stay `no-store`: the browser app keeps the validator and the value in
 *   memory and sends it itself, so no authenticated answer reaches the browser's disk cache;
 * - one of at least `COMPRESS_MIN_BYTES` goes gzipped to a client that accepts it.
 *
 * Commands, errors and the event streams (which write the raw response) are left alone. Sign-in
 * answers carry the session's CSRF token and are never compressed, so no reflected input can
 * be compressed beside it.
 */
export function installResponseEncoding(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!encodes(request) || reply.statusCode !== 200) return payload;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    if (!String(reply.getHeader('content-type') ?? '').startsWith('application/json'))
      return payload;
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const tag = `W/"${createHash('sha256').update(body).digest('base64url')}"`;
    reply.header('etag', tag);
    const compressible = body.length >= COMPRESS_MIN_BYTES && !request.url.startsWith('/api/auth/');
    if (compressible) reply.header('vary', 'accept-encoding');
    if (matches(request.headers['if-none-match'], tag)) {
      reply.code(304);
      reply.removeHeader('content-type');
      reply.removeHeader('content-length');
      return '';
    }
    if (!compressible || !acceptsGzip(request.headers['accept-encoding'])) return payload;
    reply.header('content-encoding', 'gzip');
    return gzipBody(body);
  });
}

function encodes(request: FastifyRequest): boolean {
  return request.method === 'GET' && request.url.startsWith('/api/');
}
