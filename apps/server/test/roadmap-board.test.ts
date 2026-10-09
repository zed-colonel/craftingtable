import { roadmapPageSchema } from '@craftingtable/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  roadmapId,
  supervisedMapFixture,
} from './execution-test-support.js';

/**
 * R-E3b: a cross-project roadmap's board. Its page read evaluates the map once, and the board's
 * every state, actor and count comes from the daemon.
 */

const mapEvaluations = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/services/cross-project-service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/services/cross-project-service.js')>();
  return {
    ...original,
    crossProjectState: (...args: Parameters<typeof original.crossProjectState>) => {
      mapEvaluations.count += 1;
      return original.crossProjectState(...args);
    },
  };
});

afterEach(cleanupExecutionFixtures);

/** A GET of the daemon's API as the fixture's user. */
async function read(f: Awaited<ReturnType<typeof supervisedMapFixture>>, path: string) {
  const response = await f.state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${f.state.workspaceId}${path}`,
    headers: { cookie: f.state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

it('evaluates the map once per roadmap page read, for the view and the status list together (R-E3b 2)', async () => {
  const f = await supervisedMapFixture(true);
  f.service.save(f.auth, f.state.workspaceId, f.input);
  await adoptSupervisedMap(f);
  mapEvaluations.count = 0;
  const page = roadmapPageSchema.parse(await read(f, `/roadmaps/${roadmapId}/view`));
  expect(page.status.entries.length).toBeGreaterThan(0);
  expect(mapEvaluations.count).toBe(1);
});
