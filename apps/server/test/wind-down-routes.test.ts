import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  mutationHeaders,
  type Ready,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  saveRoadmapRequest,
  stepUp,
} from './execution-test-support.js';

/**
 * The wind-down and cleanup routes (R-B11, ADR-073, decision 5): `control` routes; the wind-down
 * is an editor's and asks for the password again only when it retires a plan version; the
 * cleanup is an owner's and always asks. Who may call each is swept in route-access.test.ts.
 */

afterEach(cleanupExecutionFixtures);

const path = (state: Ready, command: 'wind-down' | 'cleanup') =>
  `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/${command}`;

describe('the wind-down and cleanup routes (R-B11)', () => {
  it('asks for the password again only to retire, and always to clean up', async () => {
    const { state } = await roadmapFixture();
    expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    await awaitRoadmapMerge(state, 0);
    const read = async (command: 'wind-down' | 'cleanup', cookie = state.cookie) => {
      const response = await state.context.app.inject({
        method: 'GET',
        url: path(state, command),
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const post = (
      command: 'wind-down' | 'cleanup',
      payload: Record<string, unknown>,
      headers = mutationHeaders(state),
    ) => state.context.app.inject({ method: 'POST', url: path(state, command), headers, payload });

    // A stop retires nothing and needs no step-up.
    const first = await read('wind-down');
    expect(first.preview.versions).toEqual([
      expect.objectContaining({ planVersionId: 'version-1', active: false }),
    ]);
    const stopped = await post('wind-down', {
      expectedDigest: first.preview.digest,
      retire: [],
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json().record).toMatchObject({ status: 'settled', retire: [] });
    // A stale preview is refused by code.
    const stale = await post('wind-down', { expectedDigest: '0'.repeat(64), retire: [] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { reason: 'preview-stale' } });
    // Retiring asks first; after the password, the settled record takes the retirement.
    const second = await read('wind-down');
    const retire = [{ planVersionId: 'version-1', disposition: 'parked' }];
    const asked = await post('wind-down', { expectedDigest: second.preview.digest, retire });
    expect(asked.statusCode).toBe(403);
    expect(asked.json()).toMatchObject({ error: { reason: 'step-up-required' } });
    await stepUp(state);
    const retired = await post('wind-down', { expectedDigest: second.preview.digest, retire });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json().record).toMatchObject({ status: 'settled', retire });
    expect(retired.json().preview.versions[0]).toMatchObject({ retired: 'parked' });

    // The cleanup always asks, even of a session that stepped up for nothing yet.
    const fresh = await state.context.login();
    const freshHeaders = {
      cookie: fresh.cookie,
      origin: state.context.config.publicOrigin,
      'x-craftingtable-csrf': fresh.csrfToken,
    };
    const plan = await read('cleanup', fresh.cookie);
    expect(plan.preview.refusals).toEqual([]);
    const body = { expectedDigest: plan.preview.digest, discardDirty: false };
    const unasked = await post('cleanup', body, freshHeaders);
    expect(unasked.statusCode).toBe(403);
    expect(unasked.json()).toMatchObject({ error: { reason: 'step-up-required' } });
    expect(
      state.context.storage.windDowns.latestCleanup(state.workspaceId, roadmapId),
    ).toBeUndefined();
    await stepUp({ ...state, cookie: fresh.cookie, csrfToken: fresh.csrfToken });
    const cleaned = await post('cleanup', body, freshHeaders);
    expect(cleaned.statusCode, cleaned.body).toBe(200);
    expect(cleaned.json().latest).toMatchObject({ status: 'done' });
  });
});
