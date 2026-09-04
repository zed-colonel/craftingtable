import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Serves the built browser app from the daemon so one origin carries both the
 * API and the UI. That is what makes LAN use a single TLS listener rather than
 * a Vite dev server plus a proxy.
 *
 * Deliberately minimal: a closed media-type table, a normalized path that must
 * stay inside the dist directory, and the SPA fallback for deep links. Anything
 * under /api is never served from here.
 */

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveWithin(root: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) {
    return undefined;
  }
  const candidate = resolve(root, `.${normalize(`/${decoded}`)}`);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : undefined;
}

export function registerStaticWebRoutes(app: FastifyInstance, distDir: string): void {
  const root = resolve(distDir);
  const index = join(root, 'index.html');

  const sendFile = (path: string, reply: FastifyReply) => {
    const extension = extname(path).toLowerCase();
    const mediaType = MEDIA_TYPES[extension];
    if (mediaType === undefined) {
      return reply.code(404).send();
    }
    const immutable = /\/assets\//.test(path.slice(root.length).split(sep).join('/'));
    return reply
      .header('content-type', mediaType)
      .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(path));
  };

  app.get('/*', (request, reply) => {
    const requestPath = request.url.split('?')[0] ?? '/';
    if (requestPath === '/api' || requestPath.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not-found', message: 'Resource not found' } });
    }
    const candidate = resolveWithin(root, requestPath);
    if (candidate !== undefined) {
      try {
        if (statSync(candidate).isFile()) {
          return sendFile(candidate, reply);
        }
      } catch {
        // Fall through to the SPA index.
      }
    }
    return sendFile(index, reply);
  });
}
