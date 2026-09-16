import { describe, expect, it } from 'vitest';
import { createTestContext } from './test-support.js';

/**
 * The registered route table is an allowlist. A new route must be added here
 * deliberately, which keeps the daemon's command surface reviewable.
 */

const EXPECTED_ROUTES = [
  'POST /api/workspaces/:workspaceId/plan-archives/preview',
  'POST /api/workspaces/:workspaceId/plan-archives/import',
  'GET /api/workspaces/:workspaceId/concurrency-imports',
  'POST /api/workspaces/:workspaceId/concurrency-imports',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/runs/:runId/build-record',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/configure',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/inspect',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/submit',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/decide',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/bindings',
  'GET /api/workspaces/:workspaceId/import-archives/:id',
  'GET /api/workspaces/:workspaceId/storage',
  'POST /api/workspaces/:workspaceId/storage',
  'POST /api/workspaces/:workspaceId/storage/scan',
  'POST /api/workspaces/:workspaceId/storage/clean',
  'POST /api/workspaces/:workspaceId/storage/backup',
  'GET /api/workspaces/:workspaceId/plans/:planVersionId/finalizations',
  'POST /api/workspaces/:workspaceId/plans/:planVersionId/finalizations',
  'POST /api/workspaces/:workspaceId/finalizations/:finalizationId/control',
  'GET /api/workspaces/:workspaceId/roadmaps',
  'GET /api/workspaces/:workspaceId/roadmaps/:roadmapId/history',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/control',
  'GET /api/workspaces/:workspaceId/notifications',
  'POST /api/workspaces/:workspaceId/notifications',
  'POST /api/workspaces/:workspaceId/notifications/test',
  'GET /api/auth/session',
  'GET /api/auth/sessions',
  'GET /api/execution-status',
  'GET /api/health',
  'GET /api/workspaces',
  'GET /api/workspaces/:workspaceId/audit',
  'GET /api/workspaces/:workspaceId/cycles',
  'GET /api/workspaces/:workspaceId/events',
  'GET /api/workspaces/:workspaceId/plan-artifacts/:artifactId',
  'GET /api/workspaces/:workspaceId/plan-imports',
  'GET /api/workspaces/:workspaceId/projects',
  'GET /api/workspaces/:workspaceId/projects/:projectId',
  'GET /api/workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId',
  'GET /api/workspaces/:workspaceId/repositories',
  'GET /api/workspaces/:workspaceId/repositories/:repositoryId/branches',
  'GET /api/workspaces/:workspaceId/run-profiles',
  'GET /api/workspaces/:workspaceId/runs',
  'GET /api/workspaces/:workspaceId/runs/:runId',
  'GET /api/workspaces/:workspaceId/runs/:runId/event-page',
  'GET /api/workspaces/:workspaceId/runs/:runId/events',
  'GET /api/workspaces/:workspaceId/snapshot',
  'GET /api/workspaces/:workspaceId/work-items',
  'GET /api/workspaces/:workspaceId/work-items/:workItemId',
  'GET /api/workspaces/:workspaceId/work-items/:workItemId/execution',
  'GET /api/workspaces/:workspaceId/worktrees/:worktreeId/diff',
  'GET /api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
  'POST /api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
  'GET /api/workspaces/:workspaceId/worktrees/:worktreeId/branch-status',
  'POST /api/workspaces/:workspaceId/worktrees/:worktreeId/retarget',
  'POST /api/workspaces/:workspaceId/worktrees/:worktreeId/update',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/password',
  'POST /api/auth/sessions/:sessionId/revoke',
  'POST /api/workspaces',
  'POST /api/workspaces/:workspaceId/cycles/:cycleId/control',
  'POST /api/workspaces/:workspaceId/cycles/:cycleId/integration-resolution',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/cycles',
  'POST /api/workspaces/:workspaceId/plan-imports',
  'POST /api/workspaces/:workspaceId/repositories',
  'POST /api/workspaces/:workspaceId/rename',
  'POST /api/workspaces/:workspaceId/run-profiles',
  'POST /api/workspaces/:workspaceId/repositories/:repositoryId/retire',
  'POST /api/workspaces/:workspaceId/runs/:runId/cancel',
  'POST /api/workspaces/:workspaceId/runs/:runId/end',
  'POST /api/workspaces/:workspaceId/runs/:runId/messages',
  'GET /api/workspaces/:workspaceId/work-items/:workItemId/execution-scopes',
  'POST /api/workspaces/:workspaceId/worktrees/:worktreeId/scope-evidence',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/scope-scheduling',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/admit',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/remove-from-agenda',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/complete',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/integration-evidence',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/runs',
  'POST /api/workspaces/:workspaceId/work-items/:workItemId/worktrees',
  'POST /api/workspaces/:workspaceId/worktrees/:worktreeId/merge',
  'POST /api/workspaces/:workspaceId/worktrees/:worktreeId/remove',
] as const;

/**
 * Capabilities the browser must never be able to reach directly. Merging is
 * deliberately not in this list any more: the single merge route takes no
 * arguments and the daemon refuses it unless a review run returned a
 * mergeable verdict (see ExecutionService.mergeWorktree).
 */
const FORBIDDEN_ROUTE_FRAGMENTS = ['exec/', 'command', 'shell', 'approve'] as const;

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
    const match = /^([│\s]*)(?:├──|└──)\s(\S*)\s\(([^)]+)\)\s*$/.exec(line);
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
  it('registers exactly the accepted routes', async () => {
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

  it('exposes no route that could run a command or approve', async () => {
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

  it('accepts no host path or external URL in a route (ZIP support: ADR-043)', async () => {
    const context = await createTestContext();
    try {
      await context.app.ready();
      const table = context.app.printRoutes({ commonPrefix: false }).toLowerCase();
      expect(table).not.toContain('url');
      expect(table).not.toContain('path');
      expect(table).not.toContain('zip');
    } finally {
      await context.cleanup();
    }
  });
});
