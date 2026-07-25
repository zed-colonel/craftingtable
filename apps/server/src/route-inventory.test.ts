import { describe, expect, it } from 'vitest';
import { createTestContext } from './test-support.js';

/**
 * CT03-A59 and CT03-A41.
 *
 * The registered route table is an allowlist. Adding any route — especially one
 * that could approve a contract, create a change request, create a worktree,
 * start an agent, run a command, or merge — fails this test rather than passing
 * review unnoticed.
 */

const EXPECTED_ROUTES = [
  'GET /api/auth/session',
  'GET /api/auth/sessions',
  'GET /api/health',
  'GET /api/workspaces',
  'GET /api/workspaces/:workspaceId/audit',
  'GET /api/workspaces/:workspaceId/events',
  'GET /api/workspaces/:workspaceId/plan-artifacts/:artifactId',
  'GET /api/workspaces/:workspaceId/plan-imports',
  'GET /api/workspaces/:workspaceId/projects',
  'GET /api/workspaces/:workspaceId/projects/:projectId',
  'GET /api/workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId',
  'GET /api/workspaces/:workspaceId/snapshot',
  'GET /api/workspaces/:workspaceId/work-items/:workItemId',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/sessions/:sessionId/revoke',
  'POST /api/workspaces/:workspaceId/plan-imports',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/admit',
] as const;

/** Capabilities that belong to CT-04 or later and must not exist yet. */
const FORBIDDEN_ROUTE_FRAGMENTS = [
  'repositor',
  'worktree',
  'branch',
  'commit',
  'diff',
  'merge',
  'change-request',
  'generation',
  'agent',
  'run',
  'exec',
  'command',
  'process',
  'shell',
  'check',
  'verification',
  'review',
  'remediation',
  'readiness',
  'approve',
  'approval',
  'planning-studio',
  'activate',
] as const;

/**
 * Rebuilds full route paths from Fastify's prefix-nested route tree.
 *
 * Each nesting level is four characters of indent, and each node contributes a
 * path fragment that must be concatenated with its ancestors.
 */
function routeTable(printed: string): readonly string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of printed.split('\n')) {
    const match =
      /^([\u2502\s]*)(?:\u251c\u2500\u2500|\u2514\u2500\u2500)\s(\S*)\s\(([^)]+)\)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const depth = (match[1] as string).length / 4;
    stack.length = depth;
    stack[depth] = match[2] as string;
    const url = stack.join('');
    for (const method of (match[3] as string).split(', ')) {
      if (method !== 'HEAD' && method !== 'OPTIONS') {
        routes.push(`${method} ${url}`);
      }
    }
  }
  return routes;
}

describe('route inventory', () => {
  it('registers exactly the accepted CT-01 to CT-03 routes', async () => {
    const context = await createTestContext();
    try {
      await context.app.ready();
      expect(routeTable(context.app.printRoutes({ commonPrefix: false })).toSorted()).toEqual(
        [...EXPECTED_ROUTES].toSorted(),
      );
    } finally {
      await context.cleanup();
    }
  });

  it('exposes no route that could execute, review, or merge work (CT03-A59)', async () => {
    const context = await createTestContext();
    try {
      await context.app.ready();
      const urls = routeTable(context.app.printRoutes({ commonPrefix: false })).map(
        (route) => route.split(' ')[1]?.toLowerCase() ?? '',
      );
      for (const url of urls) {
        for (const fragment of FORBIDDEN_ROUTE_FRAGMENTS) {
          expect(url.includes(fragment), `${url} contains "${fragment}"`).toBe(false);
        }
      }
    } finally {
      await context.cleanup();
    }
  });

  it('accepts no host path, external URL, or archive as a plan source (CT03-A41)', async () => {
    const context = await createTestContext();
    try {
      await context.app.ready();
      // The import surface is multipart only: there is no JSON body schema that
      // could carry a path or URL, and no route accepts one.
      const table = context.app.printRoutes({ commonPrefix: false }).toLowerCase();
      expect(table).not.toContain('url');
      expect(table).not.toContain('path');
      expect(table).not.toContain('zip');
      expect(table).not.toContain('archive');
    } finally {
      await context.cleanup();
    }
  });
});
