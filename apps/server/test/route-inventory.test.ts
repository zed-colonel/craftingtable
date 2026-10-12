import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routeInventory } from './route-inventory.js';
import { declaredRoutes, type RouteAccess } from '../src/routes/route-access.js';
import { createTestContext, routeTable } from './test-support.js';

/**
 * The registered route table is an allowlist: `docs/api-routes.md`, generated from it (R-H5,
 * H5-4). A new route, a changed access, tag, step-up rule or body schema changes that file, so it
 * is added deliberately and reviewed in its diff. Who may call each route is declared with the
 * route and swept in route-access.test.ts (R-I3). Regenerate with `pnpm routes:inventory`.
 */
const INVENTORY = fileURLToPath(new URL('../../../docs/api-routes.md', import.meta.url));

/** Every route before R-H5, with its access and whether it declared a step-up rule. */
const BEFORE = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../fixtures/routes/before-r-h5.json', import.meta.url)),
      'utf8',
    ),
  ) as {
    routes: readonly {
      method: string;
      path: string;
      access: RouteAccess;
      stepUp: boolean;
    }[];
  }
).routes;
/** Where each route R-H5 renamed or folded went (`METHOD path`); a route not named kept its key. */
const W = '/api/workspaces/:workspaceId';
const MOVED: Readonly<Record<string, string>> = {
  // H5-1: API nouns follow the domain and contract names, with one `imports/` prefix.
  [`GET ${W}/plans/:planVersionId/finalizations`]: `GET ${W}/plan-versions/:planVersionId/finalizations`,
  [`POST ${W}/plans/:planVersionId/finalizations`]: `POST ${W}/plan-versions/:planVersionId/finalizations`,
  [`POST ${W}/plan-imports`]: `POST ${W}/imports/plans`,
  [`POST ${W}/plan-archives/preview`]: `POST ${W}/imports/plan-archives/preview`,
  [`POST ${W}/plan-archives/import`]: `POST ${W}/imports/plan-archives`,
  [`GET ${W}/concurrency-imports`]: `GET ${W}/imports/concurrency-definitions`,
  [`POST ${W}/concurrency-imports`]: `POST ${W}/imports/concurrency-definitions`,
  [`GET ${W}/import-archives/:id`]: `GET ${W}/imports/archives/:id`,
  // H5-2: commands with the same access and no authority of their own, folded into one union.
  [`POST ${W}/runs/:runId/messages`]: `POST ${W}/runs/:runId/control`,
  [`POST ${W}/runs/:runId/end`]: `POST ${W}/runs/:runId/control`,
  [`POST ${W}/runs/:runId/cancel`]: `POST ${W}/runs/:runId/control`,
  [`POST ${W}/worktrees/:worktreeId/retarget`]: `POST ${W}/worktrees/:worktreeId/control`,
  [`POST ${W}/worktrees/:worktreeId/update`]: `POST ${W}/worktrees/:worktreeId/control`,
  [`POST ${W}/worktrees/:worktreeId/remove`]: `POST ${W}/worktrees/:worktreeId/control`,
  [`POST ${W}/work-items/:workItemId/admit`]: `POST ${W}/work-items/:workItemId/control`,
  [`POST ${W}/work-items/:workItemId/remove-from-agenda`]: `POST ${W}/work-items/:workItemId/control`,
  [`POST ${W}/work-items/:workItemId/complete`]: `POST ${W}/work-items/:workItemId/control`,
  [`POST ${W}/storage/scan`]: `POST ${W}/storage/control`,
  [`POST ${W}/storage/clean`]: `POST ${W}/storage/control`,
  [`POST ${W}/storage/backup`]: `POST ${W}/storage/control`,
  [`POST ${W}/cycles/:cycleId/investigation/end`]: `POST ${W}/cycles/:cycleId/investigation`,
  [`POST ${W}/cycles/:cycleId/investigation/acknowledge-change`]: `POST ${W}/cycles/:cycleId/investigation`,
};
/** Routes R-H5 retired, each with the reason. */
const RETIRED: Readonly<Record<string, string>> = {
  // Reads the browser no longer makes, superseded by the view models (R-D5) and the snapshot.
  [`GET ${W}/projects`]: 'the workspace snapshot carries the projects; no page read the list',
  [`GET ${W}/plan-imports`]: 'no page lists import attempts; each import answers with its own',
  [`GET ${W}/work-items/:workItemId`]: "the work item page's view carries its detail",
  [`GET ${W}/work-items/:workItemId/execution`]: "the work item page's view carries its execution",
};
const RANK: Readonly<Record<RouteAccess, number>> = {
  public: 0,
  session: 1,
  member: 2,
  editor: 3,
  owner: 4,
  installation: 5,
};

describe('route inventory', () => {
  it('registers exactly the routes the committed inventory lists, as it lists them', async () => {
    const context = await createTestContext();
    try {
      await context.app.ready();
      const generated = routeInventory(context.app);
      if (process.env.UPDATE_ROUTE_INVENTORY === '1') writeFileSync(INVENTORY, generated);
      expect(generated).toBe(readFileSync(INVENTORY, 'utf8'));
      // The inventory holds every route the server answers.
      const declared = [...declaredRoutes(context.app).keys()].toSorted();
      expect(
        routeTable(context.app.printRoutes({ commonPrefix: false }))
          .filter((r) => r.includes(' /api/'))
          .toSorted(),
      ).toEqual(declared);
    } finally {
      await context.cleanup();
    }
  });

  it("weakens no route's access or step-up since R-H5 began (H5-2)", async () => {
    const context = await createTestContext();
    try {
      await context.app.ready();
      const routes = declaredRoutes(context.app);
      const lost: string[] = [];
      for (const before of BEFORE) {
        const key = `${before.method} ${before.path}`;
        if (key in RETIRED) {
          if (routes.has(key)) lost.push(`${key} is retired but still registered`);
          continue;
        }
        const now = routes.get(MOVED[key] ?? key);
        if (now === undefined) lost.push(`${key} is gone without a move or a retirement`);
        else if (RANK[now.access] < RANK[before.access])
          lost.push(`${key} admits ${now.access}, below ${before.access}`);
        else if (before.stepUp && now.stepUp === undefined) lost.push(`${key} lost its step-up`);
      }
      expect(lost).toEqual([]);
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
