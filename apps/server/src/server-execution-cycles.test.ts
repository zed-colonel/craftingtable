import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest, AgentSession } from '@craftingtable/agents';
import { workCycleResponseSchema, workCyclesResponseSchema } from '@craftingtable/contracts';
import {
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
} from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { openCraftingTableStorage } from '@craftingtable/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  admit,
  CycleBackend,
  cleanupExecutionFixtures,
  controlCycle,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  fixtureRepository,
  git,
  implementationDone,
  mutationHeaders,
  present,
  ready,
  registerAndWorktree,
  reviewText,
  runToFinish,
  ScriptedBackend,
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

  it('prepares historical sources without launching an agent, then carries collection tools into bounded recovery', async () => {
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
        baselinePreparation: { ...present(beforeRestart.baselinePreparation), status: 'preparing' },
      },
      beforeRestart.version,
    );
    state.context.services.workCycleService.recoverInterrupted();
    expect(currentCycle(state, cycle).baselinePreparation?.status).toBe('failed');
    expect(currentCycle(state, cycle).baselinePreparation?.message).toContain(
      'interrupted by restart',
    );
    expect(backend.launches).toHaveLength(2);
  });

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

  it.each([
    [
      'unstructured review',
      { resultText: 'VERDICT: mergeable' },
      DEFAULT_COMPLETION_POLICY,
      'structured',
    ],
    [
      'truncated review',
      { resultText: reviewText([]), truncated: true },
      DEFAULT_COMPLETION_POLICY,
      'complete successful',
    ],
    [
      'remediation budget',
      { resultText: reviewText([structuredFinding]) },
      { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
      'limit reached',
    ],
  ] as const)(
    'pauses for %s and never merges through it',
    async (_name, review, policy, reason) => {
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        implementationDone,
        review,
      ]);
      const cycle = await startCycle(state, worktree.id, { policy });
      await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', reason);
      expect(currentCycle(state, cycle).reason).toContain(reason);
      // Only the unstructured report is a format fault the agent gets two repairs for (R-C2).
      expect(backend.repairs).toBe(reason === 'structured' ? 2 : 0);
      expect(backend.launches).toHaveLength(3 + backend.repairs);
      const merge = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
        headers: mutationHeaders(state),
        payload: {},
      });
      expect(merge.statusCode).toBe(409);
    },
  );

  it('extends an exhausted work-item cycle explicitly without resetting history or accepting duplicate grants', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Verified regression fix.' },
        ]),
      },
    ]);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 1 },
      instructions: 'Keep the approved API.',
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'exhausted cycle');
    const paused = currentCycle(state, cycle);
    const payload = {
      action: 'authorize-remediation',
      expectedVersion: paused.version,
      additionalRounds: 1,
      instructions: 'Concentrate on the remaining regression.',
    };
    const authorize = (body: typeof payload) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload: body,
      });
    const results = await Promise.all([authorize(payload), authorize(payload)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const granted = workCycleResponseSchema.parse(
      present(results.find((r) => r.statusCode === 200)).json(),
    ).cycle;
    expect(granted).toMatchObject({
      remediationRounds: 2,
      additionalRemediationRounds: 1,
      policy: { maxRemediationRounds: 1 },
      parentRunId: paused.currentRunId,
      worktreeId: worktree.id,
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'review after recovery',
    );
    expect(backend.launches).toHaveLength(7);
    expect(backend.launches[5]?.prompt).toContain('Keep the approved API.');
    expect(backend.launches[5]?.prompt).toContain('Concentrate on the remaining regression.');
    // The grant's guidance was for that remediation; the following review keeps only the
    // cycle's own instructions.
    expect(backend.launches[6]?.prompt).toContain('Keep the approved API.');
    expect(backend.launches[6]?.prompt).not.toContain('Concentrate on the remaining regression.');
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)).toMatchObject({
        remediationRounds: 2,
        additionalRemediationRounds: 1,
        policy: { maxRemediationRounds: 1 },
      });
    } finally {
      reopened.close();
    }
    expect((await authorize(payload)).statusCode).toBe(409);
    const audits = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 1000 })
      .filter((e) => e.metadata?.action === 'authorize-remediation');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: 'user',
      actorUserId: state.userId,
      metadata: {
        initialRemediationAllowance: 1,
        additionalRemediationRounds: 1,
        remediationAllowance: 2,
      },
    });
  });

  it.each(['questions', 'invalid', 'truncated', 'branch'] as const)(
    'does not grant a work-item allowance across a %s checkpoint',
    async (checkpoint) => {
      const review =
        checkpoint === 'invalid'
          ? 'Review missing report.'
          : `${checkpoint === 'questions' ? '## Open questions\nWhich API should be changed?\n\n## Review report\n' : ''}${reviewText([structuredFinding])}`;
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        implementationDone,
        { resultText: review, truncated: checkpoint === 'truncated' },
      ]);
      const cycle = await startCycle(state, worktree.id, {
        policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
      });
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'review checkpoint',
      );
      if (checkpoint === 'branch') git(['checkout', '-b', 'unexpected'], worktree.path);
      const before = currentCycle(state, cycle);
      const response = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload: {
          action: 'authorize-remediation',
          expectedVersion: before.version,
          additionalRounds: 1,
        },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(currentCycle(state, cycle)).toEqual(before);
      // A missing report is repaired twice before the stop (R-C2); questions are not.
      expect(backend.repairs).toBe(checkpoint === 'invalid' ? 2 : 0);
      expect(backend.launches).toHaveLength(3 + backend.repairs);
    },
  );

  it('stops after two unchanged remediation rounds even with remaining budget', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Verified after guidance.' },
        ]),
      },
    ]);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 10 },
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'stalled reviews');
    expect(currentCycle(state, cycle).reason).toContain('Two remediation rounds');
    expect(backend.launches).toHaveLength(7);
    const before = currentCycle(state, cycle);
    const payload = {
      action: 'resume',
      expectedVersion: before.version,
      instructions: 'Use the supported controller launcher for supplementary checks.',
    };
    const recover = () =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload,
      });
    const response = await recover();
    expect(response.statusCode, response.body).toBe(200);
    expect((await recover()).statusCode).toBe(409);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'guided stalled recovery',
    );
    const after = currentCycle(state, cycle);
    expect(after.remediationRounds).toBe(before.remediationRounds + 1);
    expect(after.additionalRemediationRounds ?? 0).toBe(0);
    expect(after.policy).toEqual(before.policy);
    expect(backend.launches[7]?.prompt).toContain(payload.instructions);
  });

  it.each([0, 3])(
    'stops operator questions until explicit guidance with initial allowance %s',
    async (allowance) => {
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        {
          resultText: 'Prepared the change.\n\n## Open questions\nApprove the verification policy?',
        },
        implementationDone,
        {
          resultText: `## Open questions\nWhich boundary should the fix preserve?\n\n## Review report\n${reviewText([structuredFinding])}`,
        },
        implementationDone,
        {
          resultText: reviewText([
            {
              ...structuredFinding,
              status: 'resolved',
              disposition: 'Verified fix within approved boundary.',
            },
          ]),
        },
      ]);
      const cycle = await startCycle(state, worktree.id, {
        policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: allowance },
      });
      const resume = (instructions?: string) =>
        state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
          headers: mutationHeaders(state),
          payload: {
            action: 'resume',
            expectedVersion: currentCycle(state, cycle).version,
            ...(instructions === undefined ? {} : { instructions }),
          },
        });
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'implementation question',
      );
      expect(currentCycle(state, cycle).step).toBe('implement');
      expect(backend.launches).toHaveLength(2);
      expect((await resume()).statusCode).toBe(409);
      expect(
        (await resume('Use the controller policy and preserve required checks.')).statusCode,
      ).toBe(200);
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'review question',
      );
      expect(currentCycle(state, cycle).step).toBe('review');
      expect(currentCycle(state, cycle).remediationRounds).toBe(0);
      expect(backend.launches).toHaveLength(4);
      expect(backend.launches[2]?.prompt).toContain('Use the controller policy');
      expect(backend.launches[3]?.prompt).not.toContain('Use the controller policy');
      expect((await resume()).statusCode).toBe(409);
      const guidance = 'Preserve the approved API boundary.';
      if (allowance === 0) {
        expect(currentCycle(state, cycle).reason).toContain('Remediation limit reached.');
        const grant = await state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
          headers: mutationHeaders(state),
          payload: {
            action: 'authorize-remediation',
            expectedVersion: currentCycle(state, cycle).version,
            additionalRounds: 1,
            instructions: guidance,
          },
        });
        expect(grant.statusCode, grant.body).toBe(200);
      } else expect((await resume(guidance)).statusCode).toBe(200);
      await waitFor(
        () => currentCycle(state, cycle).status === 'awaiting-merge',
        'answered review',
      );
      expect(currentCycle(state, cycle).remediationRounds).toBe(1);
      expect(backend.launches[4]?.prompt).toContain('Preserve the approved API boundary.');
      expect(backend.launches[5]?.prompt).not.toContain('Preserve the approved API boundary.');
    },
  );

  it('scopes guidance given on a review retry to that review only', async () => {
    const retryGuidance = 'For this retry of the review only, restate the report in full.';
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      {
        resultText: `## Open questions\nShould the report restate the boundary?\n\n## Review report\n${reviewText([])}`,
      },
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Verified regression case.' },
        ]),
      },
    ]);
    const cycle = await startCycle(state, worktree.id, { instructions: 'Keep the approved API.' });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'review question');
    expect(currentCycle(state, cycle).step).toBe('review');
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'resume',
        expectedVersion: currentCycle(state, cycle).version,
        instructions: retryGuidance,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'remediated');
    const prompts = backend.launches.map((launch) => launch.prompt);
    expect(prompts).toHaveLength(6);
    expect(prompts[3]).toContain(`## Operator guidance for this step\n\n${retryGuidance}`);
    // The following implement (remediation) brief and the next review do not inherit it.
    for (const later of prompts.slice(4)) {
      expect(later).not.toContain(retryGuidance);
      expect(later).toContain('Keep the approved API.');
    }
    expect(currentCycle(state, cycle)).toMatchObject({ instructions: 'Keep the approved API.' });
    expect(currentCycle(state, cycle).stepGuidance).toBeUndefined();
    // Controller-authored rules are labelled as such; the operator section holds only operator text.
    const operator = prompts[4]?.split('## Operator instructions\n\n')[1]?.split('\n## ')[0];
    expect(operator?.trim()).toBe('Keep the approved API.');
    expect(prompts[4]).toContain('## Step rules (from the controller)');
  });

  it('does not treat disappearing finding IDs as resolution', async () => {
    const { state, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'missing finding');
    expect(currentCycle(state, cycle).reason).toContain('structured');
  });

  it('rejects a stale reviewed commit at operator merge', async () => {
    const { state, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'merge approval');
    writeFileSync(join(worktree.path, 'later.txt'), 'unreviewed');
    git(['add', '.'], worktree.path);
    git(['commit', '-m', 'later'], worktree.path);
    const merge = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(merge.statusCode).toBe(409);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it('rejects duplicate starts, stale controls, missing CSRF and foreign-workspace controls', async () => {
    const { state, worktree } = await cycleFixture([{ resultText: '## Open questions\nQuestion' }]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'questions');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`;
    const stale = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: cycle.version },
    });
    expect(stale.statusCode).toBe(409);
    const csrf = await state.context.app.inject({
      method: 'POST',
      url,
      headers: { cookie: state.cookie, origin: state.context.config.publicOrigin },
      payload: { action: 'resume', expectedVersion: currentCycle(state, cycle).version },
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/foreign/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'stop', expectedVersion: currentCycle(state, cycle).version },
    });
    expect(foreign.statusCode).toBe(404);
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
      headers: mutationHeaders(state),
      payload: {
        worktreeId: worktree.id,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('recovers a durable reservation without replaying it after restart', async () => {
    const { state, backend, worktree } = await cycleFixture([designDone]);
    await state.context.services.workCycleService.shutdown();
    const cycle = await startCycle(state, worktree.id);
    expect(backend.launches).toHaveLength(0);
    state.context.services.workCycleService.recoverInterrupted();
    expect(currentCycle(state, cycle).status).toBe('needs-attention');
    expect(currentCycle(state, cycle).reason).toContain('restarted');
    expect(backend.launches).toHaveLength(0);
    const stopped = await controlCycle(state, currentCycle(state, cycle), 'stop');
    expect(stopped.status).toBe('stopped');
    // Manual flow remains available after the cycle has relinquished ownership.
    await runToFinish(state, worktree.id, { role: 'design' });
    expect(backend.launches).toHaveLength(1);
  });

  it('requires completed required predecessors, while admission remains manual', async () => {
    const { state, backend, worktree } = await cycleFixture([designDone]);
    state.context.storage.planning.workItems.insertMany([
      {
        id: asWorkItemId('predecessor'),
        workspaceId: state.workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: 'AQ-00',
        ordinal: 1,
        title: 'Prerequisite',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'Done',
        sourceFields: {},
      },
    ]);
    state.context.storage.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('dependency-1'),
        workspaceId: state.workspaceId,
        planVersionId: asPlanVersionId('version-1'),
        predecessorWorkItemId: asWorkItemId('predecessor'),
        successorWorkItemId: state.workItemId,
        kind: 'required',
        ordinal: 0,
      },
    ]);
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
      headers: mutationHeaders(state),
      payload: {
        worktreeId: worktree.id,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('AQ-00');
    expect(backend.launches).toHaveLength(0);
  });
});

describe('cycle supervision and operator races', () => {
  it('cancels a timed-out run and leaves the quality gate closed', async () => {
    let time = new Date();
    const { state, backend, worktree } = await cycleFixture([designDone], () => time);
    const cycle = await startCycle(state, worktree.id, { instructions: 'DEFER-TURNS' });
    await waitFor(() => backend.launches.length === 1, 'launch');
    time = new Date(time.getTime() + 121 * 60_000);
    state.context.services.workspaceEventNotifier.notify();
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'timeout');
    expect(currentCycle(state, cycle).reason).toContain('time limit');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'cancelled process',
    );
    expect(backend.launches).toHaveLength(1);
  });

  it('allows manual control only after pausing and resumes through the completed design', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id, { instructions: 'DEFER-TURNS' });
    await waitFor(() => backend.launches.length === 1, 'design launch');
    const blocked = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id },
    });
    expect(blocked.statusCode).toBe(409);
    const paused = await controlCycle(state, currentCycle(state, cycle), 'pause');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'waiting',
      'manual waiting session',
    );
    expect(backend.launches).toHaveLength(1);
    const ended = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${cycle.currentRunId}/end`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(ended.statusCode).toBe(200);
    await controlCycle(state, paused, 'resume');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'resumed cycle');
    expect(backend.launches).toHaveLength(3);
  });

  it('kills a delayed launch when the operator stops its reservation', async () => {
    let release: (() => void) | undefined;
    let launching = false;
    class DelayedBackend extends ScriptedBackend {
      override async launch(request: AgentLaunchRequest): Promise<AgentSession> {
        launching = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return super.launch(request);
      }
    }
    const backend = new DelayedBackend();
    const state = await ready({ backend });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => launching, 'pending launch');
    try {
      await controlCycle(state, currentCycle(state, cycle), 'stop');
    } finally {
      release?.();
    }
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'delayed process cancellation',
    );
    expect(currentCycle(state, cycle).status).toBe('stopped');
    expect(backend.launches).toHaveLength(1);
  });
});

it('does not lose earlier cycle findings when an unrelated manual run is resumed', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
  ]);
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'policy stop');
  await runToFinish(state, worktree.id, { role: 'implement' });
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'resume', expectedVersion: currentCycle(state, cycle).version },
  });
  expect(response.statusCode).toBe(409);
  expect(response.body).toContain('handoff lineage');
  expect(backend.launches).toHaveLength(4);
});

it('refreshes a phase wait when its blockers change and records nothing for a controller write that changes nothing', {
  timeout: 10000,
}, async () => {
  const { state, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'approval');
  const cycleEvents = () =>
    state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 1000 })
      .filter((e) => e.kind === 'work-cycle-changed').length;
  const { PhaseGateError } = await import('./services/phase-resources.js');
  const service = state.context.services.workCycleService as unknown as {
    reconcile: (cycle: WorkCycle) => Promise<void>;
    change: (cycle: WorkCycle, changes: Partial<WorkCycle>) => WorkCycle;
  };
  let blockers: import('@craftingtable/domain').PhaseBlocker[] = [
    { kind: 'resource', message: 'Resource build capacity is in use.' },
  ];
  vi.spyOn(service, 'reconcile').mockImplementation(async () => {
    throw new PhaseGateError(blockers);
  });
  await waitFor(
    () => currentCycle(state, cycle).phaseWait?.blockers[0]?.kind === 'resource',
    'wait',
  );
  const first = currentCycle(state, cycle);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(currentCycle(state, cycle).version).toBe(first.version);
  blockers = [{ kind: 'dependency', message: 'Predecessor AQ-00 is not merged yet.' }];
  await waitFor(
    () => currentCycle(state, cycle).phaseWait?.blockers[0]?.kind === 'dependency',
    'refreshed wait',
  );
  const refreshed = currentCycle(state, cycle);
  expect(refreshed).toMatchObject({
    status: 'awaiting-merge',
    reason: 'Predecessor AQ-00 is not merged yet.',
    phaseWait: { startedAt: first.phaseWait?.startedAt, blockers },
  });
  const events = cycleEvents();
  expect(
    service.change(refreshed, { reason: refreshed.reason, phaseWait: refreshed.phaseWait }),
  ).toBe(refreshed);
  expect(currentCycle(state, cycle).version).toBe(refreshed.version);
  expect(cycleEvents()).toBe(events);
});

it.each(['pause', 'stop'] as const)(
  'honors %s while Git preflight is pending without launching an agent',
  async (action) => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    let blocking = false;
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = await ready({
      gitOperations: {
        ...realGit,
        resolveBranch: async (path, branch) => {
          if (blocking) {
            entered = true;
            await gate;
          }
          return realGit.resolveBranch(path, branch);
        },
      },
    });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    blocking = true;
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => entered, 'Git preflight began');
    try {
      await controlCycle(state, currentCycle(state, cycle), action);
    } finally {
      release();
    }
    await state.context.services.workCycleService.shutdown();
    expect(state.backend.launches).toHaveLength(0);
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    ).toBeUndefined();
    expect(currentCycle(state, cycle).status).toBe(action === 'pause' ? 'paused' : 'stopped');
  },
);

it('finalizes an implementer’s tracked edits and staged new source before the first review', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    expect(request.temporaryDirectory).toBeTruthy();
    expect(request.temporaryDirectory?.startsWith(worktree.path)).toBe(false);
    expect(request.prompt).toContain('Do not redirect temporary files to the worktree root');
    writeFileSync(join(request.temporaryDirectory ?? '', 'generated-test.wal'), 'temporary');
    if (request.model === 'implement-model') {
      writeFileSync(join(worktree.path, 'README.md'), 'implementation edit');
      writeFileSync(join(worktree.path, 'added.ts'), 'intended new source');
      git(['add', '--', 'added.ts'], worktree.path);
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'checkpoint then review',
    6000,
  );
  const settled = currentCycle(state, cycle);
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
  ]);
  expect(settled.checkpoint?.paths).toEqual(['README.md', 'added.ts']);
  expect(settled.checkpoint?.commitSha).toBe(settled.reviewHeadSha);
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  expect(git(['log', '-1', '--format=%s'], worktree.path)).toContain('CraftingTable: finalize run');
});

it('hands dirty negative review findings directly to remediation', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Verified fix.' },
      ]),
    },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model' && backend.launches.length === 2)
      writeFileSync(join(worktree.path, 'review-test.wal'), 'review-generated');
    if (request.model === 'remediate-model') {
      expect(request.prompt).toContain('F-001');
      expect(request.prompt).toContain('Never blindly commit untracked files');
      rmSync(join(worktree.path, 'review-test.wal'));
      writeFileSync(join(worktree.path, 'README.md'), 'remediated source');
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'dirty review remediation',
    6000,
  );
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'remediate-model',
    'review-model',
  ]);
  expect(currentCycle(state, cycle).remediationRounds).toBe(1);
  expect(git(['ls-files'], worktree.path)).not.toContain('.wal');
});

it('routes unclassified new files through bounded remediation without checkpointing them blindly', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'unknown.wal'), 'test artifact');
    if (request.model === 'remediate-model') {
      expect(git(['ls-files'], worktree.path)).not.toContain('unknown.wal');
      rmSync(join(worktree.path, 'unknown.wal'));
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'classified files',
    6000,
  );
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'remediate-model',
    'review-model',
  ]);
});

it('resumes an older dirty negative review directly into remediation', {
  timeout: 15000,
}, async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let rejectOnce = true;
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Verified after remediation.' },
      ]),
    },
  ]);
  const state = await ready({
    backend,
    gitOperations: {
      ...real,
      inspectWorktreeChanges: async (path) => {
        const result = await real.inspectWorktreeChanges(path);
        if (
          rejectOnce &&
          backend.launches.at(-1)?.model === 'review-model' &&
          result.ok &&
          result.value.untracked.length
        ) {
          rejectOnce = false;
          return {
            ok: false,
            failure: { kind: 'git-failed', message: 'Simulated pre-fix dirty review stop' },
          };
        }
        return result;
      },
    },
  });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  await admit(state);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model' && backend.launches.length === 2)
      writeFileSync(join(worktree.path, 'review.wal'), 'generated');
    if (request.model === 'remediate-model') {
      expect(request.prompt).toContain('F-001');
      expect(request.prompt).toContain('Remove only confirmed generated test artifacts');
      rmSync(join(worktree.path, 'review.wal'));
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'old review stop');
  expect(currentCycle(state, cycle).step).toBe('review');
  await controlCycle(state, currentCycle(state, cycle), 'resume');
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'resumed remediation',
    6000,
  );
  expect(backend.launches.map((request) => request.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'remediate-model',
    'review-model',
  ]);
});

it('a stop during an automatic checkpoint cannot launch a late review', async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const state = await ready({
    backend,
    gitOperations: {
      ...real,
      checkpointWorktree: async (input) => {
        const result = await real.checkpointWorktree(input);
        entered?.();
        await barrier;
        return result;
      },
    },
  });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  await admit(state);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'README.md'), 'source change');
  };
  const cycle = await startCycle(state, worktree.id);
  try {
    await waiting;
    expect(currentCycle(state, cycle).checkpoint?.commitSha).toBeUndefined();
    expect(currentCycle(state, cycle).checkpoint?.paths).toEqual(['README.md']);
    await controlCycle(state, currentCycle(state, cycle), 'stop');
  } finally {
    release?.();
  }
  await state.context.services.workCycleService.shutdown();
  expect(currentCycle(state, cycle).status).toBe('stopped');
  expect(backend.launches.map((request) => request.model)).toEqual([
    'design-model',
    'implement-model',
  ]);
  expect(git(['log', '-1', '--format=%s'], worktree.path)).toContain('CraftingTable: finalize run');
});

it.each(['untracked artifact', 'index-only change'])(
  'requires cleanup and a fresh review after a positive review leaves an %s',
  { timeout: 15000 },
  async (kind) => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const original = readFileSync(join(worktree.path, 'README.md'), 'utf8');
    backend.onLaunch = (request) => {
      if (request.model === 'review-model' && backend.launches.length === 2) {
        if (kind === 'untracked artifact')
          writeFileSync(join(worktree.path, 'review.wal'), 'temporary');
        else {
          writeFileSync(join(worktree.path, 'README.md'), 'staged change');
          git(['add', 'README.md'], worktree.path);
          writeFileSync(join(worktree.path, 'README.md'), original);
        }
      }
      if (request.model === 'remediate-model') {
        expect(request.prompt).toContain('The prior approval is invalid');
        if (kind === 'untracked artifact') rmSync(join(worktree.path, 'review.wal'));
        else git(['add', 'README.md'], worktree.path);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'fresh clean review',
      6000,
    );
    expect(backend.launches.map((request) => request.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'remediate-model',
      'review-model',
    ]);
    expect(currentCycle(state, cycle).remediationRounds).toBe(1);
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  },
);
