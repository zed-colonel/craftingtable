import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizationsResponseSchema, finalizationViewSchema } from '@craftingtable/contracts';
import { asPlanVersionId, asProjectId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { cleanupExecutionFixtures, finalizationFixture } from './execution-test-support.js';
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
