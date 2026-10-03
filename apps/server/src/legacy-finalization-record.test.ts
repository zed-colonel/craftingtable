import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizationsResponseSchema, finalizationViewSchema } from '@craftingtable/contracts';
import { asPlanVersionId, asProjectId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  directories,
  finalizationFixture,
  git,
  mutationHeaders,
} from './execution-test-support.js';
import { recordIssues } from './persisted-records.js';

afterEach(cleanupExecutionFixtures);

/**
 * The one completed legacy (improvement-round) finalization on the live database, 2026-09-13
 * (R-B10). New finalizations are staged; this record must stay readable after the legacy
 * controller branches are removed. The web test renders the same fixture; the route test reads
 * it back through `FinalizationService.view()`.
 */
const record = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/records/legacy-finalization-2026-09-13.json', import.meta.url),
    'utf8',
  ),
);

it('keeps the completed legacy finalization and its cycle valid persisted records', () => {
  expect(record.finalization.stages).toBeUndefined();
  expect(record.finalization.rounds).toHaveLength(2);
  expect(recordIssues('finalization', record.finalization)).toEqual([]);
  expect(recordIssues('work-cycle', record.cycle)).toEqual([]);
  expect(
    finalizationViewSchema.parse({
      finalization: record.finalization,
      cycle: record.cycle,
      runs: [],
      mergeRecoveryPending: false,
    }).cycle?.polishPhase,
  ).toBe('final-review');
});

it('serves the completed legacy finalization through the finalization list route', async () => {
  const fixture = await finalizationFixture();
  const { state, repository } = fixture;
  const ws = state.workspaceId;
  const owned = {
    workspaceId: ws,
    planVersionId: asPlanVersionId('version-1'),
    projectId: asProjectId('project-1'),
    createdByUserId: state.userId,
  };
  const finalization = { ...record.finalization, ...owned, repositoryId: repository.id };
  const cycle = { ...record.cycle, ...owned };
  state.context.storage.transaction((tx) => {
    tx.execution.worktrees.insert({
      id: finalization.worktreeId,
      workspaceId: ws,
      repositoryId: repository.id,
      projectId: owned.projectId,
      planVersionId: owned.planVersionId,
      branchName: `ct/finalize-${finalization.id}`,
      baseSha: finalization.integrationSha,
      baseBranch: finalization.integrationBranch,
      integrationBranch: finalization.targetBranch,
      path: join(tmpdir(), `legacy-finalization-${finalization.id}`),
      createdAt: finalization.createdAt,
      createdByUserId: state.userId,
    });
    tx.execution.cycles.insert(cycle);
    expect(tx.execution.finalizations.save(finalization, 0)).toBe(true);
  });
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${ws}/plans/version-1/finalizations`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  const view = finalizationsResponseSchema
    .parse(response.json())
    .finalizations.find((v) => v.finalization.id === finalization.id);
  expect(view?.finalization).toMatchObject({
    status: 'completed',
    rounds: record.finalization.rounds,
  });
  expect(view?.finalization.stages).toBeUndefined();
  expect(view?.cycle).toMatchObject({ polishPhase: 'final-review', polishRound: 2 });
});

it('refuses to start a finalization with improvement rounds (R-B10)', async () => {
  const fixture = await finalizationFixture();
  const response = await fixture.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fixture.state.workspaceId}/plans/version-1/finalizations`,
    headers: mutationHeaders(fixture.state),
    payload: fixture.legacyInput,
  });
  expect(response.statusCode, response.body).toBe(400);
  expect(fixture.state.context.storage.execution.finalizations.list()).toHaveLength(0);
});

it('lets an open finalization with improvement rounds only stop (R-B10)', async () => {
  const fixture = await finalizationFixture();
  const { state, repository } = fixture;
  const ws = state.workspaceId;
  const owned = {
    workspaceId: ws,
    planVersionId: asPlanVersionId('version-1'),
    projectId: asProjectId('project-1'),
    createdByUserId: state.userId,
  };
  // The 2026-09-13 record as it was before promotion: active, its cycle stopped for review.
  const { integrationCleanup: _cleanup, ...open } = record.finalization;
  // A real worktree at the fixture's integration commit, so a resume reaches the launch.
  const path = join(tmpdir(), `legacy-finalization-${randomUUID()}`);
  git(['worktree', 'add', '-b', `ct/finalize-${open.id}`, path, fixture.integration], fixture.root);
  // Removed with the fixtures: it lived on in TMPDIR after every run (R-I2).
  directories.push(path);
  const finalization = {
    ...open,
    ...owned,
    repositoryId: repository.id,
    integrationBranch: 'revision',
    integrationSha: fixture.integration,
    status: 'active',
    version: 1,
    reason: 'Finalization running.',
  };
  const cycle = {
    ...record.cycle,
    ...owned,
    status: 'needs-attention',
    version: 1,
    attention: { code: 'review-needs-attention', owner: 'operator' },
  };
  state.context.storage.transaction((tx) => {
    tx.execution.worktrees.insert({
      id: finalization.worktreeId,
      workspaceId: ws,
      repositoryId: repository.id,
      projectId: owned.projectId,
      planVersionId: owned.planVersionId,
      branchName: `ct/finalize-${finalization.id}`,
      baseSha: finalization.integrationSha,
      baseBranch: finalization.integrationBranch,
      integrationBranch: finalization.targetBranch,
      path,
      createdAt: finalization.createdAt,
      createdByUserId: state.userId,
    });
    tx.execution.cycles.insert(cycle);
    expect(tx.execution.finalizations.save(finalization, 0)).toBe(true);
  });
  const command = (action: string, extra: Record<string, unknown> = {}) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/finalizations/${finalization.id}/control`,
      headers: mutationHeaders(state),
      payload: { action, expectedVersion: 1, expectedCycleVersion: 1, ...extra },
    });
  for (const [action, extra] of [
    ['resume', {}],
    ['authorize-remediation', { additionalRounds: 1 }],
  ] as const) {
    const refused = await command(action, extra);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain('retired improvement rounds');
  }
  // The generic cycle control is refused too: no run launches for a stage-less finalization.
  const launches = fixture.backend.launches.length;
  const resumed = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'resume', expectedVersion: 1 },
  });
  expect(resumed.statusCode, resumed.body).toBe(409);
  expect(resumed.body).toContain('retired improvement rounds');
  expect(fixture.backend.launches).toHaveLength(launches);
  // Service retries and continuations are decided before the controller's legacy check; the
  // launch itself refuses, so none of them can start a run either.
  const { attention: _attention, ...stopped } = state.context.storage.execution.cycles.find(
    ws,
    cycle.id,
  )!;
  const running = state.context.storage.execution.cycles.replace(
    {
      ...stopped,
      status: 'running',
      version: stopped.version + 1,
      reason: 'Retrying the step.',
      runDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    stopped.version,
  )!;
  await expect(state.context.services.agentRunService.startForCycle(running)).rejects.toThrow(
    'retired improvement rounds',
  );
  expect(fixture.backend.launches).toHaveLength(launches);
  const stoppedResponse = await command('stop', {
    expectedCycleVersion: state.context.storage.execution.cycles.find(ws, cycle.id)!.version,
  });
  expect(stoppedResponse.statusCode, stoppedResponse.body).toBe(200);
  expect(state.context.storage.execution.finalizations.find(ws, finalization.id)?.status).toBe(
    'stopped',
  );
});
