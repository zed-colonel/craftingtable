import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cycleAttentionSchema } from '@craftingtable/contracts';
import {
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CycleFixture,
  createCycleFixture,
  cycleProfiles,
  designDone,
  git,
  openQuestions,
  reviewText,
  startCycle,
  stepController,
  storedCycle,
} from './cycle-test-support.js';

/**
 * R-A3: the controller declares every stop with a typed code and keeps its owner current
 * while automation claims it; the notification service only reads what was declared.
 */

const fixtures: CycleFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function fixture(): Promise<CycleFixture> {
  const f = await createCycleFixture({ workers: false });
  fixtures.push(f);
  return f;
}

async function post(f: CycleFixture, url: string, payload: Record<string, unknown>) {
  const response = await f.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.workspaceId}${url}`,
    headers: f.headers,
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
}

function enableNotifications(f: CycleFixture) {
  const cookie = f.headers.cookie as string;
  const auth = f.services.authService.authenticate(cookie.slice(cookie.indexOf('=') + 1));
  f.services.notificationService.save(auth, f.workspaceId, {
    expectedVersion: 0,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
    applicationToken: 'a'.repeat(30),
    userKey: 'u'.repeat(30),
  });
}

/** The cycle's open attention items: what the inbox lists and pushes are sent from (R-A4). */
function cycleAlerts(f: CycleFixture, cycle: WorkCycle) {
  f.services.attention.flush();
  return f.context.storage.attention
    .open(f.workspaceId)
    .filter((item) => item.subjectKey === `cycle:${cycle.id}`);
}

/** Design, implementation and a clean review, stepped to the merge boundary. */
async function toMergeBoundary(f: CycleFixture): Promise<void> {
  f.backend.latest.release(designDone);
  await stepController(f.services, 3);
  const worktree = f.backend.latest.request.cwd;
  writeFileSync(join(worktree, 'change.txt'), 'implemented');
  git(['add', '.'], worktree);
  git(['commit', '--no-gpg-sign', '-m', 'implementation'], worktree);
  f.backend.latest.release('Implemented and checks passed.');
  await stepController(f.services, 3);
  f.backend.latest.release(reviewText());
  await stepController(f.services, 2);
}

describe('typed attention (R-A3)', () => {
  it('declares a stop with its code when the controller stops a step', async () => {
    const f = await fixture();
    const started = await startCycle(f);
    await stepController(f.services);
    f.backend.latest.release(openQuestions);
    await stepController(f.services, 2);
    expect(storedCycle(f, started.id)).toMatchObject({
      status: 'needs-attention',
      attention: { code: 'design-open-questions', owner: 'operator' },
    });
    // Leaving the stop clears it.
    const resumed = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/cycles/${started.id}/control`,
      headers: f.headers,
      payload: { action: 'stop', expectedVersion: storedCycle(f, started.id).version },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(storedCycle(f, started.id).attention).toBeUndefined();
  });

  it('marks a merge the roadmap will make itself as controller-owned until the roadmap pauses', async () => {
    const f = await fixture();
    const roadmapId = '00000000-0000-4000-8000-000000000020';
    await post(f, `/worktrees/${f.worktreeId}/remove`, {});
    await post(f, `/roadmaps/${roadmapId}`, {
      expectedVersion: 0,
      name: 'Automatic merges',
      automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
      entries: ['item-1', 'item-2'].map((workItemId, index) => ({
        id: `00000000-0000-4000-8000-00000000002${index + 1}`,
        workItemId,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
        instructions: '',
      })),
    });
    const roadmap = () => f.context.storage.roadmaps.find(f.workspaceId, roadmapId);
    await post(f, `/roadmaps/${roadmapId}/control`, {
      action: 'start',
      expectedVersion: roadmap()?.version,
    });
    await f.services.roadmapService.tick();
    await stepController(f.services);
    await toMergeBoundary(f);
    const cycle = f.context.storage.execution.cycles.listForWorkspace(
      f.workspaceId,
    )[0] as WorkCycle;
    expect(storedCycle(f, cycle.id)).toMatchObject({
      status: 'awaiting-merge',
      attention: { code: 'merge-approval', owner: 'controller', claim: 'roadmap-merge' },
    });
    enableNotifications(f);
    await f.services.notificationService.tick();
    expect(cycleAlerts(f, cycle)).toEqual([]);

    // Pausing the roadmap lapses the claim: the merge is the operator's again.
    await post(f, `/roadmaps/${roadmapId}/control`, {
      action: 'pause',
      expectedVersion: roadmap()?.version,
    });
    await stepController(f.services);
    expect(storedCycle(f, cycle.id).attention).toEqual({
      code: 'merge-approval',
      owner: 'operator',
    });
    await f.services.notificationService.tick();
    expect(cycleAlerts(f, cycle)).toMatchObject([{ kind: 'merge' }]);
    // The owner change is audited, so operator wait starts counting here (R-C1).
    const transitions = f.context.storage.audit
      .listCycleTransitions(
        f.workspaceId,
        new Date(0).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      )
      .filter((row) => row.cycleId === cycle.id);
    expect(transitions.at(-1)?.metadata).toMatchObject({
      action: 'attention-refreshed',
      status: 'awaiting-merge',
      attention: { code: 'merge-approval', owner: 'operator' },
    });
    expect(transitions.at(-2)?.metadata).toMatchObject({
      attention: { owner: 'controller', claim: 'roadmap-merge' },
    });
  });

  it('accepts on the wire only the owner a code or claim declares', () => {
    expect(
      cycleAttentionSchema.safeParse({ code: 'merge-approval', owner: 'operator' }).success,
    ).toBe(true);
    expect(
      cycleAttentionSchema.safeParse({ code: 'merge-approval', owner: 'controller' }).success,
    ).toBe(false);
    expect(
      cycleAttentionSchema.safeParse({
        code: 'merge-approval',
        owner: 'controller',
        claim: 'roadmap-merge',
      }).success,
    ).toBe(true);
    expect(cycleAttentionSchema.safeParse({ code: 'not-a-code', owner: 'operator' }).success).toBe(
      false,
    );
  });
});
