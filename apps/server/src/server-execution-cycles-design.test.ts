import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workCycleResponseSchema, workCyclesResponseSchema } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  cleanupExecutionFixtures,
  controlCycle,
  currentCycle,
  cycleFixture,
  designDone,
  git,
  implementationDone,
  itNeedsCargo,
  mutationHeaders,
  present,
  type Ready,
  reviewText,
  runToFinish,
  startCycle,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

describe('single work-item automation', () => {
  it('remediates mergeable minor findings, preserves lineage and models, and stops for operator merge', async () => {
    const { state, backend, worktree, root } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Boundary regression passed.' },
        ]),
      },
    ]);
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model') {
        writeFileSync(join(worktree.path, 'implemented.txt'), 'review this change');
        git(['add', '.'], worktree.path);
        git(['commit', '-m', 'implementation'], worktree.path);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'merge approval');
    expect(existsSync(join(root, 'implemented.txt'))).toBe(false);
    const settled = currentCycle(state, cycle);
    expect(backend.launches.map((launch) => launch.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'remediate-model',
      'review-model',
    ]);
    expect(settled.remediationRounds).toBe(1);
    expect(settled.reviewHeadSha).toBe(git(['rev-parse', 'HEAD'], worktree.path).trim());
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    expect(existsSync(worktree.path)).toBe(true);
    const runs = state.context.storage.execution.runs
      .listForWorktree(state.workspaceId, worktree.id)
      .toReversed();
    expect(runs.map((run) => run.role)).toEqual([
      'design',
      'implement',
      'review',
      'implement',
      'review',
    ]);
    for (let index = 1; index < runs.length; index++)
      expect(runs[index]?.parentRunId).toBe(runs[index - 1]?.id);
    expect(runs[3]?.brief).toContain('F-001');
    const listing = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/cycles`,
      headers: { cookie: state.cookie },
    });
    expect(workCyclesResponseSchema.parse(listing.json()).cycles[0]?.status).toBe('awaiting-merge');
    const events = state.context.storage.workspaceEvents.listAfter({
      workspaceId: state.workspaceId,
      after: 0,
      limit: 500,
    });
    expect(
      events.some(
        (event) => event.kind === 'work-cycle-changed' && event.payload.status === 'awaiting-merge',
      ),
    ).toBe(true);
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => currentCycle(state, cycle).status === 'completed', 'cycle completion');
    expect(git(['branch', '--show-current'], root).trim()).toBe('main');
    expect(readFileSync(join(root, 'implemented.txt'), 'utf8')).toBe('review this change');
  });

  it('pauses for design questions and adopts a manual resolution on explicit resume', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich storage format?' },
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'design questions',
    );
    expect(backend.launches).toHaveLength(1);
    await runToFinish(state, worktree.id, {
      role: 'design',
      parentRunId: currentCycle(state, cycle).currentRunId,
    });
    await controlCycle(state, currentCycle(state, cycle), 'resume');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'resolved design');
    expect(backend.launches).toHaveLength(4);
  });

  itNeedsCargo(
    'prepares historical sources without launching an agent, then carries collection tools into bounded recovery',
    async () => {
      const { state, backend, worktree } = await cycleFixture([
        { resultText: '## Open questions\nCollect the historical baseline.' },
        designDone,
      ]);
      const cycle = await startCycle(state, worktree.id);
      await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
      const base = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}`;
      const preview = await state.context.app.inject({
        method: 'GET',
        url: `${base}/baseline-preparation`,
        headers: { cookie: state.cookie },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const value = preview.json();
      expect(value.sources[0].ref).toBe(worktree.baseSha);
      const payload = {
        expectedVersion: value.expectedVersion,
        contextDigest: value.contextDigest,
        sources: value.sources.map((source: { alias: string; ref: string }) => ({
          alias: source.alias,
          ref: source.ref,
        })),
      };
      const noCsrf = await state.context.app.inject({
        method: 'POST',
        url: `${base}/baseline-preparation`,
        headers: { cookie: state.cookie },
        payload,
      });
      expect(noCsrf.statusCode).toBe(403);
      const prepared = await state.context.app.inject({
        method: 'POST',
        url: `${base}/baseline-preparation`,
        headers: mutationHeaders(state),
        payload,
      });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const saved = workCycleResponseSchema.parse(prepared.json()).cycle;
      expect(saved.baselinePreparation?.status).toBe('prepared');
      expect(saved.status).toBe('needs-attention');
      expect(backend.launches).toHaveLength(1);
      const source = present(saved.baselinePreparation?.sources[0]);
      expect(
        existsSync(
          join(present(saved.baselinePreparation).directory, source.directoryName, 'README.md'),
        ),
      ).toBe(true);
      const stale = await state.context.app.inject({
        method: 'POST',
        url: `${base}/baseline-preparation`,
        headers: mutationHeaders(state),
        payload,
      });
      expect(stale.statusCode).toBe(409);
      const discovery = await state.context.app.inject({
        method: 'GET',
        url: `${base}/design-recovery`,
        headers: { cookie: state.cookie },
      });
      const recovery = discovery.json();
      const response = await state.context.app.inject({
        method: 'POST',
        url: `${base}/design-recovery`,
        headers: mutationHeaders(state),
        payload: {
          expectedVersion: saved.version,
          snapshotDigest: recovery.snapshotDigest,
          mode: 'investigate',
          profile: { backend: 'claude-code' },
          instructions: 'Collect results; I retain all architectural decisions.',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(
        () =>
          backend.launches.length === 2 && currentCycle(state, cycle).status === 'needs-attention',
        'bounded collection ends',
      );
      const launch = present(backend.launches[1]);
      expect(launch.prompt).toContain('historical-cargo');
      expect(launch.prompt).toContain('Genuine architectural/implementation decisions remain');
      expect(launch.cwd).toBe(worktree.path);
      const directory = present(launch.additionalDirectories?.[0]);
      const logs = join(directory, 'historical-evidence');
      writeFileSync(
        join(logs, 'commands.jsonl'),
        '{"success":false,"currentRuntimeVerification":false}\n',
      );
      writeFileSync(join(logs, '123-456.log'), 'Recorded historical dependency failure');
      const evidence = await state.context.app.inject({
        method: 'GET',
        url: `${base}/baseline-evidence`,
        headers: { cookie: state.cookie },
      });
      expect(evidence.statusCode, evidence.body).toBe(200);
      expect(
        evidence
          .json()
          .artifacts.some((a: { content: string }) =>
            a.content.includes('Recorded historical dependency failure'),
          ),
      ).toBe(true);
      expect(currentCycle(state, cycle).status).toBe('needs-attention');
      expect(currentCycle(state, cycle).remediationRounds).toBe(0);
      const beforeRestart = currentCycle(state, cycle);
      state.context.storage.execution.cycles.replace(
        {
          ...beforeRestart,
          version: beforeRestart.version + 1,
          baselinePreparation: {
            ...present(beforeRestart.baselinePreparation),
            status: 'preparing',
          },
        },
        beforeRestart.version,
      );
      state.context.services.workCycleService.recoverInterrupted();
      expect(currentCycle(state, cycle).baselinePreparation?.status).toBe('failed');
      expect(currentCycle(state, cycle).baselinePreparation?.message).toContain(
        'interrupted by restart',
      );
      expect(backend.launches).toHaveLength(2);
    },
  );

  it('recovers design with guidance and attachments in the same worktree and keeps review authority separate', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich storage format?' },
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const preview = await state.context.app.inject({
      method: 'GET',
      url,
      headers: { cookie: state.cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const snapshot = preview.json();
    expect(snapshot.questions).toContain('Which storage format?');
    expect(backend.launches).toHaveLength(1);
    const payload = {
      expectedVersion: snapshot.expectedVersion,
      snapshotDigest: snapshot.snapshotDigest,
      mode: 'continue',
      profile: { backend: 'claude-code', model: 'recovery-model' },
      instructions: 'Use SQLite; I own the storage decision.',
      attachments: [{ name: '../../decision.md', content: 'Operator supplied storage decision.' }],
    };
    const missingCsrf = await state.context.app.inject({
      method: 'POST',
      url,
      headers: { cookie: state.cookie },
      payload,
    });
    expect(missingCsrf.statusCode).toBe(403);
    const stale = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { ...payload, snapshotDigest: '0'.repeat(64) },
    });
    expect(stale.statusCode).toBe(409);
    const invalid = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { ...payload, profile: { ...payload.profile, permissionMode: 'bypass' } },
    });
    expect(invalid.statusCode).toBe(400);
    const launched = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload,
    });
    expect(launched.statusCode, launched.body).toBe(200);
    const reserved = workCycleResponseSchema.parse(launched.json()).cycle;
    expect(reserved.worktreeId).toBe(worktree.id);
    expect(reserved.designRecovery?.sourceRunId).toBe(snapshot.sourceRunId);
    expect(reserved.remediationRounds).toBe(0);
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'recovered design');
    expect(backend.launches).toHaveLength(4);
    const request = present(backend.launches[1]);
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, reserved.currentRunId)?.role,
    ).toBe('design');
    expect(request.model).toBe('recovery-model');
    expect(request.prompt).toContain('Use SQLite');
    expect(request.prompt).toContain('Which storage format?');
    expect(backend.launches[2]?.model).toBe('implement-model');
    const path = join(
      present(request.temporaryDirectory),
      '..',
      'design-recovery',
      'operator-1.txt',
    );
    expect(readFileSync(path, 'utf8')).toContain('Operator supplied storage decision.');
    const implementation = present(backend.launches[2]);
    expect(
      readFileSync(
        join(present(implementation.temporaryDirectory), '..', 'design-recovery', 'operator-1.txt'),
        'utf8',
      ),
    ).toContain('Operator supplied storage decision.');
    expect(implementation.prompt).toContain('design-recovery/manifest.json');
    expect(currentCycle(state, cycle).status).toBe('awaiting-merge');
  });

  it('stops a design investigation even with no questions and continues only on a new explicit request', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nCollect baseline measurements.' },
      designDone,
      { resultText: '## Open questions\nWho approves the remaining decision?' },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'investigation completed',
    );
    expect(currentCycle(state, cycle).reason).toContain('investigation finished');
    expect(backend.launches).toHaveLength(2);
    // A plain resume cannot bypass the review: it is refused up front (R-A7).
    const refused = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: currentCycle(state, cycle).version },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('Resolve design questions');
    expect(currentCycle(state, cycle).status).toBe('needs-attention');
    expect(backend.launches).toHaveLength(2);
    const next = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const continued = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: next.expectedVersion,
        snapshotDigest: next.snapshotDigest,
        mode: 'continue',
        profile: { backend: 'claude-code' },
        instructions: 'Use the collected measurements.',
      },
    });
    expect(continued.statusCode, continued.body).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'genuine question retained',
    );
    expect(backend.launches).toHaveLength(3);
    expect(currentCycle(state, cycle).step).toBe('design');
  });

  it('continues the design once after an investigation that answered every question with sources (R-C3a)', async () => {
    const answered = {
      version: 1,
      items: [
        {
          kind: 'resolved',
          question: 'Where do the baseline measurements come from?',
          answer: 'The committed benchmark report.',
          sources: ['bench/report.md'],
        },
      ],
    };
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhere do the baseline measurements come from?' },
      {
        resultText: `Investigated.\n\n\`\`\`craftingtable-design\n${JSON.stringify(answered)}\n\`\`\`\n\n## Open questions\nnone`,
      },
      designDone,
      implementationDone,
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code', model: 'investigation-model' },
        instructions: 'Check the benchmark report.',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const investigation = response.json().cycle.currentRunId;
    await waitFor(() => backend.launches.length >= 4, 'continued design, then implementation');
    const continued = present(backend.launches[2]);
    // The design agent, not the investigation's, continues from the investigation's evidence
    // and the operator's guidance.
    expect(continued.model).toBe('design-model');
    expect(continued.prompt).toContain('Apply the operator answers and supporting evidence');
    expect(continued.prompt).toContain('design-recovery/manifest.json');
    expect(present(backend.launches[3]).model).toBe('implement-model');
    expect(currentCycle(state, cycle).designRecovery).toMatchObject({
      mode: 'continue',
      automatic: true,
      sourceRunId: investigation,
      instructions: 'Check the benchmark report.',
      profile: { model: 'design-model' },
    });
    expect(currentCycle(state, cycle).attention?.code).not.toBe('design-investigation-finished');
  });

  const answeredInvestigation = `Investigated.\n\n\`\`\`craftingtable-design\n${JSON.stringify({
    version: 1,
    items: [
      {
        kind: 'resolved',
        question: 'Where do the baseline measurements come from?',
        answer: 'The committed benchmark report.',
        sources: ['bench/report.md'],
      },
    ],
  })}\n\`\`\`\n\n## Open questions\nnone`;
  async function investigate(state: Ready, cycle: WorkCycle) {
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code', model: 'investigation-model' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  it('starts the automatic design continue as a new step, not a service retry of the investigation (R-C3a review)', async () => {
    let now = new Date('2026-09-25T12:00:00Z');
    const { state, backend, worktree } = await cycleFixture(
      [
        { resultText: '## Open questions\nWhere do the baseline measurements come from?' },
        {
          resultText: 'At capacity.',
          providerFailure: { kind: 'capacity', message: 'At capacity.', safeToRetry: true },
        },
        { resultText: answeredInvestigation },
        designDone,
        implementationDone,
      ],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    await investigate(state, cycle);
    await waitFor(
      () => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt,
      'investigation service retry',
    );
    now = new Date('2026-09-25T12:02:00Z');
    await waitFor(() => backend.launches.length >= 5, 'continued design, then implementation');
    const continued = present(backend.launches[3]);
    expect(continued.model).toBe('design-model');
    expect(continued.prompt).not.toContain('service retry');
    expect(currentCycle(state, cycle).designRecovery).toMatchObject({ automatic: true });
  });

  it('keeps the investigation stop when the design cannot continue automatically (R-C3a review)', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhere do the baseline measurements come from?' },
      { resultText: answeredInvestigation },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    await investigate(state, cycle);
    // The design agent's backend goes away while the investigation runs.
    const runs = state.context.services.agentRunService;
    await waitFor(() => backend.launches.length === 2, 'investigation launched');
    runs.hasBackend = () => false;
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'fallback stop');
    expect(currentCycle(state, cycle)).toMatchObject({
      attention: { code: 'design-investigation-finished' },
      designRecovery: { mode: 'investigate' },
      reason: expect.stringContaining('could not continue automatically'),
    });
    expect(backend.launches).toHaveLength(2);
  });

  it('can adopt a manual design after an investigation without retaining the investigation stop', async () => {
    const { state, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich owner?' },
      designDone,
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'investigation pause',
    );
    await runToFinish(state, worktree.id, {
      role: 'design',
      parentRunId: currentCycle(state, cycle).currentRunId,
    });
    await controlCycle(state, currentCycle(state, cycle), 'resume');
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'manual design adopted',
    );
  });

  it('preserves an unlaunched design recovery across restart without replaying it', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich owner?' },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    await state.context.services.workCycleService.shutdown();
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const result = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'continue',
        profile: { backend: 'claude-code' },
        instructions: 'I own the decision.',
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    state.context.services.workCycleService.recoverInterrupted();
    const recovered = currentCycle(state, cycle);
    expect(recovered.status).toBe('needs-attention');
    expect(recovered.designRecovery?.instructions).toBe('I own the decision.');
    expect(backend.launches).toHaveLength(1);
    const fresh = await state.context.app.inject({
      method: 'GET',
      url,
      headers: { cookie: state.cookie },
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json().sourceRunId).toBe(snapshot.sourceRunId);
  });
});
