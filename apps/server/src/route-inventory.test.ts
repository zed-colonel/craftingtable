import { describe, expect, it } from 'vitest';
import { createTestContext, routeTable } from './test-support.js';

/**
 * The registered route table is an allowlist. A new route must be added here
 * deliberately, which keeps the daemon's command surface reviewable. Who may call
 * each route is declared with the route and swept in route-access.test.ts (R-I3).
 */

const EXPECTED_ROUTES = [
  'GET /api/workspaces/:workspaceId/roadmaps/agent-profiles',
  'POST /api/workspaces/:workspaceId/protected-ref-moves/acknowledge',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/delegation',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/prepare-decision',
  'GET /api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparations',
  'GET /api/workspaces/:workspaceId/roadmaps/capacities',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/capacity',
  'GET /api/workspaces/:workspaceId/host-scheduling',
  'POST /api/workspaces/:workspaceId/host-scheduling',
  'GET /api/workspaces/:workspaceId/operator-wait',
  'GET /api/workspaces/:workspaceId/attention',
  'GET /api/workspaces/:workspaceId/cycles/:cycleId/baseline-evidence',
  'GET /api/workspaces/:workspaceId/cycles/:cycleId/baseline-preparation',
  'POST /api/workspaces/:workspaceId/cycles/:cycleId/baseline-preparation',
  'GET /api/workspaces/:workspaceId/roadmaps/:roadmapId/amendments',
  'GET /api/workspaces/:workspaceId/roadmaps/:roadmapId/finalization-readiness',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/amendments/preview',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/amendments',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/amendments/decision',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/preview',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/adopt',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/roadmap',
  'POST /api/workspaces/:workspaceId/plan-archives/preview',
  'POST /api/workspaces/:workspaceId/plan-archives/import',
  'GET /api/workspaces/:workspaceId/concurrency-imports',
  'POST /api/workspaces/:workspaceId/concurrency-imports',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/checkpoint-recovery/:worktreeId',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/prepare-checkpoint',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/runs/:runId/build-record',
  'GET /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/submissions/:submissionId',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/configure',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/preview-refresh',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/refresh',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/audit-native',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/authorize-native',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/declare-transitions',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/inspect',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/discover',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/propose-decision',
  'POST /api/workspaces/:workspaceId/concurrency-definitions/:id/runtime/generate-plan',
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
  'GET /api/workspaces/:workspaceId/roadmaps/:roadmapId/status',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/control',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery',
  'POST /api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparation-grant',
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
  'GET /api/workspaces/:workspaceId/diagnostics',
  'GET /api/workspaces/:workspaceId/events',
  'GET /api/workspaces/:workspaceId/plan-artifacts/:artifactId',
  'GET /api/workspaces/:workspaceId/plan-imports',
  'GET /api/workspaces/:workspaceId/projects',
  'GET /api/workspaces/:workspaceId/projects/:projectId',
  'GET /api/workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId',
  'GET /api/workspaces/:workspaceId/repositories',
  'GET /api/workspaces/:workspaceId/repositories/:repositoryId/branches',
  'GET /api/workspaces/:workspaceId/repositories/:repositoryId/checks',
  'POST /api/workspaces/:workspaceId/repositories/:repositoryId/checks/preview',
  'POST /api/workspaces/:workspaceId/repositories/:repositoryId/checks/adopt',
  'GET /api/workspaces/:workspaceId/run-profiles',
  'GET /api/workspaces/:workspaceId/runs',
  'GET /api/workspaces/:workspaceId/runs/:runId',
  'GET /api/workspaces/:workspaceId/runs/:runId/event-page',
  'GET /api/workspaces/:workspaceId/runs/:runId/tool-results/:digest',
  'GET /api/workspaces/:workspaceId/runs/:runId/events',
  'GET /api/workspaces/:workspaceId/snapshot',
  'GET /api/workspaces/:workspaceId/work-items',
  'GET /api/workspaces/:workspaceId/work-items/:workItemId',
  'GET /api/workspaces/:workspaceId/work-items/:workItemId/execution',
  'GET /api/workspaces/:workspaceId/worktrees/:worktreeId/diff',
  'GET /api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
  'POST /api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
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
  'GET /api/workspaces/:workspaceId/cycles/:cycleId/design-recovery',
  'POST /api/workspaces/:workspaceId/cycles/:cycleId/design-recovery',
  'GET /api/workspaces/:workspaceId/cycles/:cycleId/scope-repair',
  'POST /api/workspaces/:workspaceId/cycles/:cycleId/scope-repair',
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
