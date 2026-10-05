import type { AgentBackend } from '@craftingtable/agents';
import {
  executionStatusResponseSchema,
  startAgentRunResponseSchema,
} from '@craftingtable/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_CATALOG_REFRESH_MS,
  ModelCatalogService,
} from '../src/services/model-catalog-service.js';
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

it('reads the catalog at daemon start, and offers a model added to it after "Refresh models" (R-G15)', async () => {
  const { state, backend } = await cycleFixture([]);
  // The daemon's start read it once, without waiting for it.
  await waitFor(() => backend.modelLooks >= 1, 'catalog read at start');
  const status = async () => {
    const response = await state.context.app.inject({
      method: 'GET',
      url: '/api/execution-status',
      headers: { cookie: state.cookie },
    });
    return executionStatusResponseSchema.parse(response.json());
  };
  expect((await status()).backends[0]?.models.map((model) => model.id)).toEqual(['scripted-model']);
  // A model added to the CLI's catalog, with no code or configuration change.
  backend.models = [...CATALOG, ...backend.models];
  const looks = backend.modelLooks;
  const refreshed = await state.context.app.inject({
    method: 'POST',
    url: '/api/execution-status/refresh-models',
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(refreshed.statusCode, refreshed.body).toBe(200);
  expect(backend.modelLooks).toBe(looks + 1);
  const answered = executionStatusResponseSchema.parse(refreshed.json());
  expect(answered.backends[0]?.models).toContainEqual(CATALOG[0]);
  expect(answered.backends[0]?.catalog).toEqual({ source: 'catalog' });
  expect((await status()).backends[0]?.models).toContainEqual(CATALOG[0]);
  // A command like any other: the CSRF token is required.
  const forged = await state.context.app.inject({
    method: 'POST',
    url: '/api/execution-status/refresh-models',
    headers: { cookie: state.cookie, 'content-type': 'application/json' },
    payload: {},
  });
  expect(forged.statusCode).toBe(403);
});

describe('the model catalog timer (R-G15)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads every catalog at start and about hourly, until stopped', async () => {
    vi.useFakeTimers();
    const looks: string[] = [];
    const backend = (kind: 'claude-code' | 'codex') =>
      ({
        kind,
        listModels: () => {
          looks.push(kind);
          return Promise.resolve({ models: [], status: { source: 'catalog' as const } });
        },
      }) as unknown as AgentBackend;
    const service = new ModelCatalogService(
      new Map([
        ['claude-code', backend('claude-code')],
        ['codex', backend('codex')],
      ]),
    );
    service.start();
    expect(looks).toEqual(['claude-code', 'codex']);
    await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_MS - 1);
    expect(looks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(looks).toHaveLength(4);
    expect(MODEL_CATALOG_REFRESH_MS).toBe(60 * 60 * 1000);
    service.stop();
    await vi.advanceTimersByTimeAsync(3 * MODEL_CATALOG_REFRESH_MS);
    expect(looks).toHaveLength(4);
  });

  it('logs a catalog that was not read by its code, and goes on with the others', async () => {
    const warnings: { message: string; detail?: Readonly<Record<string, unknown>> }[] = [];
    const service = new ModelCatalogService(
      new Map([
        [
          'codex',
          {
            kind: 'codex',
            listModels: () =>
              Promise.resolve({
                models: [],
                status: { source: 'fallback' as const, issue: 'catalog-request-failed' as const },
                detail: 'Codex app-server timed out: model/list',
              }),
          } as unknown as AgentBackend,
        ],
        [
          'claude-code',
          {
            kind: 'claude-code',
            listModels: () => Promise.reject(new Error('unexpected')),
          } as unknown as AgentBackend,
        ],
      ]),
      { warn: (message, detail) => warnings.push({ message, ...(detail ? { detail } : {}) }) },
    );
    await service.refresh();
    expect(warnings.map((warning) => warning.detail)).toEqual([
      {
        backend: 'codex',
        issue: 'catalog-request-failed',
        source: 'fallback',
        detail: 'Codex app-server timed out: model/list',
      },
      { backend: 'claude-code', detail: 'unexpected' },
    ]);
  });
});
