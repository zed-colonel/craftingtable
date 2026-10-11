import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routeInventory } from '../src/route-inventory.js';
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
const MOVED: Readonly<Record<string, string>> = {};
/** Routes R-H5 retired, each with the reason. */
const RETIRED: Readonly<Record<string, string>> = {};
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
