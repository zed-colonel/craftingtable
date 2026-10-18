import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COMPLETION_POLICY, asRoadmapId } from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it } from 'vitest';
import { createServices, type ServiceSet } from '../src/composition.js';
import { daemonStop } from '../src/daemon-start.js';
import { openDaemonStorage } from '../src/persisted-records.js';
import {
  createCycleFixture,
  type CycleFixture,
  runFinished,
  storedCycle,
  storedRun,
} from './cycle-test-support.js';
import {
  cleanupExecutionFixtures,
  stepPermissions,
  useStepModels,
  declareFixtureChecks,
  designDone,
  git,
  implementationDone,
  reviewText,
  startCycle,
  stepDaemon,
} from './execution-test-support.js';
import { DRAIN_REQUEST_FILE, DRAIN_STATUS_FILE } from '../src/services/daemon-drain.js';
import { FastTestPasswordHasher } from './test-support.js';

/**
 * R-B9: a restart drains live agent turns, and after a clean restart an interrupted cycle
 * step resumes its vendor session with no operator action. Crashes, lost sessions and
 * failed resumes keep the explicit operator resume. Everything is stepped: the first
 * daemon's controller runs only when the test ticks it, and so does the restarted one.
 */

const restarted: ServiceSet[] = [];
afterEach(async () => {
  // A restarted daemon has no server of its own; the rest of the daemon's close applies.
  for (const services of restarted.splice(0)) {
    await services.daemonDrain.drain(0);
    await services.checkRequestService.closeAll();
  }
  await cleanupExecutionFixtures();
});

async function fixture(): Promise<CycleFixture> {
  const f = await createCycleFixture();
  return f;
}

/** Starts a cycle and steps the controller until its first step's turn is live. */
async function startLiveCycle(f: CycleFixture) {
  const started = await startCycle(f, f.worktreeId);
  await stepDaemon(f.services);
  expect(storedRun(f, storedCycle(f, started.id).currentRunId)?.status).toBe('running');
  return started;
}

/** Starts a second daemon on the same database, as a restart does after the first stops. */
async function restart(f: CycleFixture): Promise<ServiceSet> {
  const services = await createServices(f.context.storage, f.context.config, {
    notificationTransport: { send: async () => ({ status: 'accepted' }) },
    passwordHasher: new FastTestPasswordHasher(),
    gitOperations: createGitOperations({ gitExecutable: 'git' }),
    agentBackends: new Map([[f.backend.kind, f.backend]]),
  });
  restarted.push(services);
  return services;
}

describe('restart drain and automatic resume (R-B9)', () => {
  it('interrupts a long turn at the bound and resumes its session after a clean restart', async () => {
    const f = await fixture();
    const started = await startLiveCycle(f);
    const interruptedId = storedCycle(f, started.id).currentRunId;

    expect(await f.services.daemonDrain.drain(0)).toBe(1);
    expect(storedRun(f, interruptedId)?.status).toBe('interrupted');
    expect(runFinished(f, interruptedId)).toMatchObject({ reason: 'daemon-drain' });
    // The cycle is not stopped for the operator: the restart continues it.
    expect(storedCycle(f, started.id).status).toBe('running');

    const services = await restart(f);
    // First pass reserves the resumed step; the second launches it.
    await stepDaemon(services, 2);
    expect(f.backend.sessions).toHaveLength(2);
    const resumed = f.backend.launches[1];
    expect(resumed).toMatchObject({
      resumeSessionId: 'vendor-session-1',
      model: 'design-model',
      permissionMode: 'auto',
      deadlineAt: started.runDeadlineAt,
    });
    expect(resumed?.prompt).toContain('CraftingTable restarted while this step was in progress');
    expect(resumed?.additionalDirectories).toContain(
      join(f.context.config.execution.runsRoot, interruptedId),
    );
    const current = storedCycle(f, started.id);
    expect(current).toMatchObject({
      status: 'running',
      step: 'design',
      parentRunId: interruptedId,
    });
    expect(current.reason).toContain('Resuming the design session');
    expect(storedRun(f, current.currentRunId)?.status).toBe('running');

    // The resumed session finishes the step and the cycle moves on without the operator.
    f.backend.latest.release(designDone);
    await stepDaemon(services, 2);
    expect(storedCycle(f, started.id).step).toBe('implement');
  });

  it('gives a resumed session the guidance the operator added while its step was interrupted', async () => {
    const f = await fixture();
    const started = await startCycle(f, f.worktreeId);
    await stepDaemon(f.services);
    f.backend.latest.release(designDone);
    await stepDaemon(f.services, 3);
    const interruptedId = storedCycle(f, started.id).currentRunId;
    expect(storedRun(f, interruptedId)).toMatchObject({ role: 'implement', status: 'running' });
    expect(await f.services.daemonDrain.drain(0)).toBe(1);

    const services = await restart(f);
    const auth = services.authService.authenticate(
      f.headers.cookie!.split('=').slice(1).join('='),
    )!;
    // The operator pauses before the restart resumes the step, then continues it with guidance.
    await services.workCycleService.control(
      auth,
      f.workspaceId,
      started.id,
      'pause',
      storedCycle(f, started.id).version,
    );
    const guidance = 'Use the queue in module B.';
    await services.workCycleService.control(
      auth,
      f.workspaceId,
      started.id,
      'resume',
      storedCycle(f, started.id).version,
      guidance,
    );
    await stepDaemon(services, 2);
    const resumed = f.backend.launches.at(-1);
    expect(resumed?.resumeSessionId).toBe('vendor-session-2');
    expect(resumed?.prompt).toContain(guidance);
    expect(resumed?.prompt).not.toContain(
      'instructions, your permissions and its deadline are unchanged',
    );
  });

  it('lets a turn that finishes within the bound complete instead of interrupting it', async () => {
    const f = await fixture();
    const started = await startLiveCycle(f);
    const designRunId = storedCycle(f, started.id).currentRunId;

    const draining = f.services.daemonDrain.drain(60_000);
    expect(f.services.agentRunService.busyRunCount()).toBe(1);
    f.backend.latest.release(designDone);
    // The draining controller still classifies the finished turn.
    await stepDaemon(f.services, 3);
    expect(await draining).toBe(0);
    expect(storedRun(f, designRunId)?.status).toBe('finished');
    // The next step was reserved but not launched while draining.
    expect(storedCycle(f, started.id).step).toBe('implement');
    expect(f.backend.sessions).toHaveLength(1);

    const services = await restart(f);
    await stepDaemon(services);
    expect(f.backend.sessions).toHaveLength(2);
    expect(f.backend.launches[1]).toMatchObject({ model: 'implement-model' });
    expect(f.backend.launches[1]?.resumeSessionId).toBeUndefined();
  });

  it('resumes an interrupted review on its pinned review baseline', async () => {
    const f = await fixture();
    const started = await startLiveCycle(f);
    f.backend.latest.release(designDone);
    await stepDaemon(f.services, 3);
    const worktree = f.backend.latest.request.cwd;
    writeFileSync(join(worktree, 'change.txt'), 'implemented');
    git(['add', '.'], worktree);
    git(['commit', '--no-gpg-sign', '-m', 'implementation'], worktree);
    f.backend.latest.release(implementationDone);
    await stepDaemon(f.services, 3);
    expect(f.backend.sessions).toHaveLength(3);
    const review = storedRun(f, storedCycle(f, started.id).currentRunId);
    expect(review).toMatchObject({ role: 'review', status: 'running' });

    expect(await f.services.daemonDrain.drain(0)).toBe(1);
    const services = await restart(f);
    await stepDaemon(services, 2);
    expect(f.backend.launches[3]).toMatchObject({
      resumeSessionId: 'vendor-session-3',
      model: 'review-model',
    });
    const resumed = storedRun(f, storedCycle(f, started.id).currentRunId);
    expect(resumed?.role).toBe('review');
    expect(resumed?.reviewBranchContext?.headSha).toBe(review?.reviewBranchContext?.headSha);
    f.backend.latest.release({ resultText: reviewText() });
    await stepDaemon(services, 2);
    expect(storedCycle(f, started.id).status).toBe('awaiting-merge');
  });

  it('refuses new runs while draining', async () => {
    const f = await fixture();
    f.services.agentRunService.beginDrain();
    const response = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/work-items/item-1/runs`,
      headers: f.headers,
      payload: { worktreeId: f.worktreeId },
    });
    expect(response.statusCode, response.body).toBe(503);
    expect(f.backend.sessions).toHaveLength(0);
  });

  it('keeps the explicit resume after a crash', async () => {
    const f = await fixture();
    const started = await startLiveCycle(f);
    // A crash: the process dies and no drain records a clean stop.
    // The live sessions are in the supervisor's state (R-B7 increment 10).
    (
      f.services.agentRunService as unknown as { state: { live: Map<string, unknown> } }
    ).state.live.clear();

    const services = await restart(f);
    expect(storedCycle(f, started.id)).toMatchObject({ status: 'needs-attention' });
    expect(storedCycle(f, started.id).reason).toContain('Daemon restarted');
    await stepDaemon(services, 2);
    expect(f.backend.sessions).toHaveLength(1);
  });

  it('asks the operator when the interrupted run never reported a session', async () => {
    const f = await fixture();
    f.backend.withoutSessionId = true;
    const started = await startCycle(f, f.worktreeId);
    await stepDaemon(f.services);
    await f.services.daemonDrain.drain(0);
    const services = await restart(f);
    await stepDaemon(services);
    expect(storedCycle(f, started.id).status).toBe('needs-attention');
    expect(storedCycle(f, started.id).reason).toContain(
      'before its agent session could be resumed',
    );
    expect(f.backend.sessions).toHaveLength(1);
  });

  it('asks the operator when the resume fails', async () => {
    const f = await fixture();
    const started = await startLiveCycle(f);
    await f.services.daemonDrain.drain(0);
    f.backend.failResumes = true;
    const services = await restart(f);
    await stepDaemon(services, 3);
    expect(storedCycle(f, started.id).status).toBe('needs-attention');
    expect(storedRun(f, storedCycle(f, started.id).currentRunId)?.status).toBe('failed');
  });

  it('keeps a running roadmap running across a clean restart', async () => {
    const f = await fixture();
    const roadmapId = '00000000-0000-4000-8000-000000000010';
    // A roadmap's cycles in a repository without adopted checks stop (R-G13 increment 4).
    declareFixtureChecks(f);
    const inject = async (url: string, payload: Record<string, unknown>) => {
      const response = await f.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.workspaceId}${url}`,
        headers: f.headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await inject(`/worktrees/${f.worktreeId}/control`, { action: 'remove' });
    await useStepModels(f);
    await inject(`/roadmaps/${roadmapId}`, {
      expectedVersion: 0,
      name: 'Restart roadmap',
      entries: ['item-1', 'item-2'].map((workItemId, index) => ({
        id: `00000000-0000-4000-8000-00000000001${index + 1}`,
        workItemId,
        permissions: stepPermissions,
        policy: DEFAULT_COMPLETION_POLICY,
        instructions: '',
      })),
    });
    const roadmap = () => f.context.storage.roadmaps.find(f.workspaceId, asRoadmapId(roadmapId));
    await inject(`/roadmaps/${roadmapId}/control`, {
      action: 'start',
      expectedVersion: roadmap()?.version,
    });
    await f.services.roadmapService.tick();
    await stepDaemon(f.services);
    expect(f.backend.sessions).toHaveLength(1);

    expect(await f.services.daemonDrain.drain(0)).toBe(1);
    const services = await restart(f);
    expect(roadmap()?.status).toBe('running');
    await services.roadmapService.tick();
    await stepDaemon(services, 2);
    expect(f.backend.sessions).toHaveLength(2);
    expect(f.backend.launches[1]?.resumeSessionId).toBe('vendor-session-1');
    expect(roadmap()?.status).toBe('running');
  });

  it('drains on a deploy request, and a withdrawn request resumes admissions', async () => {
    const f = await fixture();
    await startLiveCycle(f);
    const drain = f.services.daemonDrain;
    const dataDir = f.context.config.dataDir;
    const status = () => JSON.parse(readFileSync(join(dataDir, DRAIN_STATUS_FILE), 'utf8'));
    let stranded = 0;
    drain.whenStranded(() => stranded++, 0);

    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r1', mode: 'when-idle' }),
    );
    drain.poll();
    expect(status()).toMatchObject({ requestId: 'r1', state: 'draining', busyRuns: 1 });
    expect(f.services.agentRunService.isDraining()).toBe(true);

    rmSync(join(dataDir, DRAIN_REQUEST_FILE));
    drain.poll();
    // The drain notices the withdrawal on its next poll (every 250 ms).
    for (let turn = 0; turn < 100 && drain.isDraining(); turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drain.isDraining()).toBe(false);
    expect(f.services.agentRunService.isDraining()).toBe(false);
    expect(existsSync(join(dataDir, DRAIN_STATUS_FILE))).toBe(false);
    // A withdrawn drain never asks to be restarted (R-B9 review M-3, 2026-10-13).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stranded).toBe(0);

    // Once a stop signal joins a requested drain, withdrawing the request no longer cancels it.
    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r2', mode: 'when-idle' }),
    );
    drain.poll();
    const stopping = drain.drain(60_000);
    rmSync(join(dataDir, DRAIN_REQUEST_FILE));
    drain.poll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drain.isDraining()).toBe(true);
    drain.expedite();
    expect(await stopping).toBe(1);
    expect(status()).toMatchObject({ requestId: 'r2', state: 'drained', interruptedRuns: 1 });
    // A deploy's drain that finished does, if no restart follows.
    for (let turn = 0; turn < 100 && stranded === 0; turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stranded).toBe(1);
  });

  it('interrupts at a deploy request’s own bound', async () => {
    const f = await fixture();
    await startLiveCycle(f);
    const dataDir = f.context.config.dataDir;
    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r3', mode: 'bounded', timeoutSeconds: 0 }),
    );
    f.services.daemonDrain.poll();
    const status = () => JSON.parse(readFileSync(join(dataDir, DRAIN_STATUS_FILE), 'utf8'));
    for (let turn = 0; turn < 100 && status().state !== 'drained'; turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(status()).toMatchObject({ requestId: 'r3', interruptedRuns: 1 });
  });

  it('treats a signal-killed agent as a failure during a deploy drain, and as the restart on a stop signal', async () => {
    const f = await fixture();
    const first = await startLiveCycle(f);
    const dataDir = f.context.config.dataDir;
    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r4', mode: 'when-idle' }),
    );
    f.services.daemonDrain.poll();
    // A deploy's drain stops nothing else: a killed agent failed.
    const firstRun = storedCycle(f, first.id).currentRunId as string;
    f.backend.sessions[0]?.killedBy('SIGKILL');
    await f.services.agentRunService.quiesce();
    expect(storedRun(f, firstRun)?.status).toBe('failed');
    expect(runFinished(f, firstRun)?.reason).toBeUndefined();

    // A stop signal drains too, and then the service manager's signal is the restart.
    const g = await fixture();
    const second = await startLiveCycle(g);
    const secondRun = storedCycle(g, second.id).currentRunId as string;
    const stopping = g.services.daemonDrain.drain(60_000);
    g.backend.sessions[0]?.killedBy('SIGTERM');
    await stopping;
    expect(storedRun(g, secondRun)?.status).toBe('interrupted');
    expect(runFinished(g, secondRun)).toMatchObject({ reason: 'daemon-drain' });
  });

  it('waits out a SIGTERM drain longer than Fastify’s plugin timeout and ends with the clean stop, so the restart resumes the step (R-B9 live finding 2026-10-13)', async () => {
    // Fastify fails a close hook still running after its plugin timeout, 10 s by default; the
    // live stop of 2026-10-13 crashed there. This bound is past it, and the turn never ends.
    const f = await createCycleFixture({ env: { CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '11' } });
    const started = await startLiveCycle(f);
    const interruptedId = storedCycle(f, started.id).currentRunId as string;
    let released = false;
    const stop = daemonStop({
      runtime: f.context.daemon,
      lock: {
        release: async () => {
          released = true;
        },
      },
    });

    const signalledAt = Date.now();
    const stopping = stop('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // While it drains, the server serves on, and launches are refused (503, as "refuses new runs
    // while draining" shows), as during a deploy's drain.
    expect((await f.context.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(
      200,
    );
    expect(f.services.agentRunService.isDraining()).toBe(true);
    await stopping;
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(11_000);
    expect(released).toBe(true);

    // The daemon closed its database; the next start opens it again and resumes the step's
    // session with no operator action, as after a deploy's drain.
    const storage = openDaemonStorage(f.context.config.databasePath);
    try {
      const run = storage.execution.runs.find(f.workspaceId, interruptedId as never);
      expect(run?.status).toBe('interrupted');
      const finished = storage.execution.runEvents.latestOfKind(
        f.workspaceId,
        interruptedId as never,
        'run-finished',
      );
      expect(finished?.kind === 'run-finished' ? finished.payload : undefined).toMatchObject({
        reason: 'daemon-drain',
      });
      const services = await createServices(storage, f.context.config, {
        notificationTransport: { send: async () => ({ status: 'accepted' }) },
        passwordHasher: new FastTestPasswordHasher(),
        gitOperations: createGitOperations({ gitExecutable: 'git' }),
        agentBackends: new Map([[f.backend.kind, f.backend]]),
      });
      try {
        await stepDaemon(services, 2);
        expect(f.backend.launches[1]).toMatchObject({ resumeSessionId: 'vendor-session-1' });
        expect(storage.execution.cycles.find(f.workspaceId, started.id as never)).toMatchObject({
          status: 'running',
          parentRunId: interruptedId,
        });
      } finally {
        await services.daemonDrain.drain(0);
        await services.checkRequestService.closeAll();
      }
    } finally {
      storage.close();
    }
  }, 60_000);

  it('interrupts at once on a second stop signal, and each signal waits for the stop to finish', async () => {
    const f = await createCycleFixture({ env: { CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '600' } });
    const started = await startLiveCycle(f);
    const interruptedId = storedCycle(f, started.id).currentRunId as string;
    let released = false;
    const stop = daemonStop({
      runtime: f.context.daemon,
      lock: {
        release: async () => {
          released = true;
        },
      },
    });

    const first = stop('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.context.services.agentRunService.busyRunCount()).toBe(1);
    const signalledAt = Date.now();
    await stop('SIGINT');
    expect(Date.now() - signalledAt).toBeLessThan(10_000);
    expect(released).toBe(true);
    await first;
    const storage = openDaemonStorage(f.context.config.databasePath);
    try {
      expect(storage.execution.runs.find(f.workspaceId, interruptedId as never)?.status).toBe(
        'interrupted',
      );
    } finally {
      storage.close();
    }
  }, 30_000);

  it('asks to be restarted when a deploy drained it and no restart followed', async () => {
    const f = await fixture();
    await startLiveCycle(f);
    const dataDir = f.context.config.dataDir;
    let stranded = 0;
    f.services.daemonDrain.whenStranded(() => stranded++, 0);
    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r5', mode: 'bounded', timeoutSeconds: 0 }),
    );
    f.services.daemonDrain.poll();
    for (let turn = 0; turn < 100 && stranded === 0; turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stranded).toBe(1);
  });
});
