import { startAgentRunResponseSchema } from '@craftingtable/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  mutationHeaders,
  startCycle,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/** What Codex's catalog listed on 2026-10-02 for LIVE-34's model. */
const CATALOG = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', section: 'main', hidden: false },
  { id: 'gpt-5.5', label: 'GPT-5.5', section: 'main', hidden: true },
];

it("stops a cycle before launch when its model is a catalog entry's display name (LIVE-34)", async () => {
  const { state, backend, worktree } = await cycleFixture([designDone]);
  backend.models = CATALOG;
  const cycle = await startCycle(state, worktree.id, {
    profiles: { ...cycleProfiles, design: { ...cycleProfiles.design, model: 'GPT-6.1-Sol' } },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'typed stop');
  const stopped = currentCycle(state, cycle);
  expect(stopped.attention?.code).toBe('agent-model-misnamed');
  // The stop names the id to choose; nothing reached the agent.
  expect(stopped.reason).toContain('gpt-6.1-sol');
  expect(backend.launches).toHaveLength(0);
  const run = state.context.storage.execution.runs.find(
    state.workspaceId,
    stopped.currentRunId ?? '',
  );
  expect(run?.status).toBe('failed');
  expect(
    state.context.storage.attention.open(state.workspaceId).map((item) => item.code),
  ).toContain('agent-model-misnamed');
});

it('refuses a manual run whose model is another spelling of a catalog id, and launches the id (LIVE-34)', async () => {
  const { state, backend, worktree } = await cycleFixture([]);
  backend.models = CATALOG;
  const launch = (model: string) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, permissionMode: 'auto', model },
    });
  const misnamed = await launch('GPT-6.1-SOL');
  expect(misnamed.statusCode, misnamed.body).toBe(200);
  const { run } = startAgentRunResponseSchema.parse(misnamed.json());
  await waitFor(
    () => state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'failed',
    'refused before launch',
  );
  expect(backend.launches).toHaveLength(0);
  // A hidden catalog id and an id the catalog does not list are both sent as typed: a catalog
  // can lag a release.
  for (const model of ['gpt-5.5', 'gpt-7-preview']) {
    const started = await launch(model);
    expect(started.statusCode, started.body).toBe(200);
    await waitFor(
      () => backend.launches.some((request) => request.model === model),
      `${model} launched`,
    );
    const { run: sent } = startAgentRunResponseSchema.parse(started.json());
    await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${sent.id}/cancel`,
      headers: mutationHeaders(state),
      payload: {},
    });
    await waitFor(
      () =>
        !['starting', 'running', 'waiting'].includes(
          state.context.storage.execution.runs.find(state.workspaceId, sent.id)?.status ?? '',
        ),
      `${model} ended`,
    );
  }
});
