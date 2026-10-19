import { cycleDefaultsResponseSchema } from '@craftingtable/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  mutationHeaders,
  type Ready,
  ready,
} from './execution-test-support.js';

/**
 * R-C17 part 4, decisions 8 and 9: a workspace's default step time limit for new cycles and roadmap
 * entries, which the browser's forms seed from. No row means 120 minutes, as before. Saving it
 * changes no stored cycle or entry.
 */

afterEach(cleanupExecutionFixtures);

const read = async (state: Ready) => {
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/cycle-defaults`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return cycleDefaultsResponseSchema.parse(response.json());
};
const save = (state: Ready, payload: Record<string, unknown>) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycle-defaults`,
    headers: mutationHeaders(state),
    payload,
  });

it('reads 120 minutes until a default is saved, then the saved one, audited (R-C17 part 4)', async () => {
  const state = await ready();
  expect(await read(state)).toEqual({ maxRunMinutes: 120, stored: false });
  const saved = await save(state, { maxRunMinutes: 45 });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(cycleDefaultsResponseSchema.parse(saved.json())).toEqual({
    maxRunMinutes: 45,
    stored: true,
  });
  expect(await read(state)).toEqual({ maxRunMinutes: 45, stored: true });
  expect((await save(state, { maxRunMinutes: 300 })).statusCode).toBe(200);
  expect(await read(state)).toEqual({ maxRunMinutes: 300, stored: true });
  const audit = state.context.storage.audit
    .listWorkspace({ workspaceId: state.workspaceId, limit: 50 })
    .filter((event) => event.action === 'cycle-defaults.updated');
  expect(audit.map((event) => event.metadata)).toEqual(
    expect.arrayContaining([
      { maxRunMinutes: { from: 120, to: 45 } },
      { maxRunMinutes: { from: 45, to: 300 } },
    ]),
  );
  expect(audit.every((event) => event.targetType === 'workspace')).toBe(true);
});

it('refuses a limit out of bounds or anything beside it (R-C17 part 4)', async () => {
  const state = await ready();
  for (const payload of [
    { maxRunMinutes: 0 },
    { maxRunMinutes: 1441 },
    { maxRunMinutes: 1.5 },
    {},
    { maxRunMinutes: 60, maxNits: 3 },
  ])
    expect((await save(state, payload)).statusCode, JSON.stringify(payload)).toBe(400);
  expect(await read(state)).toEqual({ maxRunMinutes: 120, stored: false });
});
