import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asWorkItemId, cycleActions, DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { createWorktreeResponseSchema, workCycleResponseSchema } from '@craftingtable/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CycleFixture,
  createCycleFixture,
  cycleProfiles,
  git,
  startCycle,
  stepController,
  storedCycle,
} from './cycle-test-support.js';

/**
 * R-A7: commands accept only actions that can make progress. These replay the shapes of
 * the recorded live sequences: a design stop resumed three times into the same stop
 * (cycle d148f0a4) and a resumed step whose predecessor's merge was absent from the
 * integration branch, which bounced 1.6 s later (cycle 2f1ab211).
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

function control(f: CycleFixture, id: string, action: 'resume' | 'stop') {
  return f.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.workspaceId}/cycles/${id}/control`,
    headers: f.headers,
    payload: { action, expectedVersion: storedCycle(f, id).version },
  });
}

describe('offer only actions that can make progress (R-A7)', () => {
  it('refuses a resume that would reclassify the same design, naming the control to use', async () => {
    const f = await fixture();
    const started = await startCycle(f);
    await stepController(f.services);
    // The same invalid classification survives the two automatic repairs (R-C2).
    for (let turn = 0; turn < 3; turn += 1) {
      f.backend.latest.release(
        'Design.\n\n```craftingtable-design\n{"version":1,"items":[{}]}\n```',
      );
      await stepController(f.services, 3);
    }
    const stopped = storedCycle(f, started.id);
    expect(stopped.attention).toMatchObject({ code: 'design-report-invalid', repairAttempts: 2 });
    expect(cycleActions(stopped)).toEqual(['resolve-design', 'stop']);

    const resumed = await control(f, started.id, 'resume');
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json().error.message).toContain('Use Resolve design questions');
    expect(storedCycle(f, started.id).version).toBe(stopped.version);
    await stepController(f.services, 2);
    expect(f.backend.sessions).toHaveLength(3);
    expect((await control(f, started.id, 'stop')).statusCode).toBe(200);
  });

  it('checks predecessor ancestry when a failed step is resumed, before accepting', async () => {
    const f = await fixture();
    const user = f.context.storage.users.findByNormalizedUsername('test-user');
    const root = f.context.storage.execution.sourceRepositories.find(
      f.workspaceId,
      f.repositoryId as never,
    )?.rootPath as string;
    // AQ-01 is complete with a merge on the integration branch, so AQ-02 can start.
    writeFileSync(join(root, 'aq-01.txt'), 'merged predecessor');
    git(['add', '.'], root);
    git(['commit', '--no-gpg-sign', '-m', 'AQ-01'], root);
    const mergeSha = git(['rev-parse', 'HEAD'], root).trim();
    f.context.storage.planning.workItems.complete({
      workItemId: asWorkItemId('item-1'),
      workspaceId: f.workspaceId,
      projectId: 'project-1' as never,
      completedAt: new Date().toISOString(),
      completedByUserId: user!.id,
      mergeSha,
    });
    const created = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/work-items/item-2/worktrees`,
      headers: f.headers,
      payload: { repositoryId: f.repositoryId },
    });
    expect(created.statusCode, created.body).toBe(200);
    const worktree = createWorktreeResponseSchema.parse(created.json()).worktree;
    const admitted = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/work-items/item-2/admit`,
      headers: f.headers,
      payload: {},
    });
    expect(admitted.statusCode, admitted.body).toBe(200);
    const response = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/work-items/item-2/cycles`,
      headers: f.headers,
      payload: {
        worktreeId: worktree.id,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const cycle = workCycleResponseSchema.parse(response.json()).cycle;
    await stepController(f.services);
    f.backend.latest.crash();
    await stepController(f.services, 2);
    expect(storedCycle(f, cycle.id).attention?.code).toBe('step-incomplete');

    // The predecessor's merge leaves the integration branch.
    git(['reset', '--hard', 'HEAD~1'], root);
    const resumed = await control(f, cycle.id, 'resume');
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json().error.message).toContain("AQ-01's merge is absent");
    expect(storedCycle(f, cycle.id).status).toBe('needs-attention');
    expect(f.backend.sessions).toHaveLength(1);
  });
});
