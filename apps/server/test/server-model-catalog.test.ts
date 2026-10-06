import type { AgentBackend } from '@craftingtable/agents';
import {
  executionStatusResponseSchema,
  startAgentRunResponseSchema,
} from '@craftingtable/contracts';
import { DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_CATALOG_REFRESH_MS,
  ModelCatalogService,
} from '../src/services/model-catalog-service.js';
import {
  cleanupExecutionFixtures,
  controlCycle,
  entryIds,
  present,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  storedRoadmap,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  mutationHeaders,
  implementationDone,
  startCycle,
  waitFor,
  withinHangGuard,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/** What Codex's catalog listed on 2026-10-02 for LIVE-34's model. */
const CATALOG = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', section: 'main', hidden: false },
  { id: 'gpt-5.5', label: 'GPT-5.5', section: 'main', hidden: true },
];

it("stops a cycle before launch when its saved model became a catalog entry's display name (LIVE-34)", async () => {
  const { state, backend, worktree } = await cycleFixture([designDone, implementationDone]);
  // A refresh while the design runs learns the model, under its id.
  backend.onLaunch = () => {
    backend.models = CATALOG;
  };
  // Saved while the catalog did not list the model: unlisted models are sent as typed.
  const cycle = await startCycle(state, worktree.id, {
    profiles: {
      ...cycleProfiles,
      implement: { ...cycleProfiles.implement, model: 'GPT-6.1-Sol' },
    },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'typed stop');
  const stopped = currentCycle(state, cycle);
  expect(stopped.attention?.code).toBe('agent-model-misnamed');
  expect(stopped.step).toBe('implement');
  // The stop names the id to choose; only the design reached the agent.
  expect(stopped.reason).toContain('gpt-6.1-sol');
  expect(backend.launches.map((request) => request.model)).toEqual(['design-model']);
  const run = state.context.storage.execution.runs.find(
    state.workspaceId,
    stopped.currentRunId ?? '',
  );
  expect(run?.status).toBe('failed');
  expect(
    state.context.storage.attention.open(state.workspaceId).map((item) => item.code),
  ).toContain('agent-model-misnamed');
});

it('refuses a display name when a cycle starts or profiles are saved, naming the id (LIVE-34)', async () => {
  const { state, backend, worktree } = await cycleFixture([designDone]);
  backend.models = CATALOG;
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
    headers: mutationHeaders(state),
    payload: {
      worktreeId: worktree.id,
      profiles: { ...cycleProfiles, review: { ...cycleProfiles.review, model: 'GPT-6.1-Sol' } },
      policy: DEFAULT_COMPLETION_POLICY,
    },
  });
  expect(started.statusCode).toBe(400);
  expect(started.json().error.message).toContain('"gpt-6.1-sol"');
  expect(backend.launches).toHaveLength(0);
  const saved = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/run-profiles`,
    headers: mutationHeaders(state),
    payload: {
      profiles: [
        { role: 'review', backend: 'claude-code', model: 'gpt-6.1-SOL', permissionMode: 'auto' },
      ],
    },
  });
  expect(saved.statusCode).toBe(400);
  expect(saved.json().error.message).toContain('"gpt-6.1-sol"');
  // An unlisted id and a hidden one are saved as typed.
  const kept = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/run-profiles`,
    headers: mutationHeaders(state),
    payload: {
      profiles: [
        { role: 'review', backend: 'claude-code', model: 'gpt-7-preview', permissionMode: 'auto' },
        { role: 'design', backend: 'claude-code', model: 'gpt-5.5', permissionMode: 'auto' },
      ],
    },
  });
  expect(kept.statusCode, kept.body).toBe(200);
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

it("stops a roadmap's cycle, not its scheduler, on a saved display name, and the profiles' id carries it on (LIVE-34)", async () => {
  const { state, backend } = await roadmapFixture([designDone]);
  const known = backend.models;
  // Saved while the catalog did not list the model, so it was sent as typed.
  backend.models = [];
  const input = roadmapInput(state, [state.workItemId]);
  const misnamed = {
    ...input,
    entries: input.entries.map((entry) => ({
      ...entry,
      profiles: {
        ...entry.profiles,
        design: { ...entry.profiles.design, model: 'Scripted model' },
      },
    })),
  };
  expect((await saveRoadmapRequest(state, misnamed)).statusCode).toBe(200);
  // A refresh then learns it as the display name of scripted-model.
  backend.models = known;
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).attempts.length === 1, 'entry started');
  const attempt = present(storedRoadmap(state).attempts[0]);
  const cycle = () =>
    present(state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId));
  await waitFor(() => cycle().attention?.code === 'agent-model-misnamed', 'typed stop');
  expect(backend.launches).toHaveLength(0);
  // The fix the stop names: the id in the roadmap's agent profiles, then resume.
  await waitFor(() => storedRoadmap(state).status !== 'running', 'roadmap held');
  const selection = (model: string) => ({ backend: 'claude-code' as const, model });
  const applied = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/agent-profiles`,
    headers: mutationHeaders(state),
    payload: {
      expectedVersion: storedRoadmap(state).version,
      entryIds: [entryIds[0]],
      selections: {
        design: selection('scripted-model'),
        implement: selection('implement-model'),
        review: selection('review-model'),
        remediate: selection('remediate-model'),
      },
    },
  });
  expect(applied.statusCode, applied.body).toBe(200);
  await controlCycle(state, cycle(), 'resume');
  await waitFor(() => backend.launches.length === 1, 'relaunched with the id');
  expect(backend.launches[0]?.model).toBe('scripted-model');
});

it('lets a saved display name stay through other changes, while a new one is refused (R-G15)', async () => {
  const { state, backend } = await cycleFixture([]);
  const save = (profiles: readonly Record<string, unknown>[]) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/run-profiles`,
      headers: mutationHeaders(state),
      payload: { profiles },
    });
  const review = {
    role: 'review',
    backend: 'claude-code',
    model: 'GPT-6.1-Sol',
    permissionMode: 'auto',
  };
  // Saved before the catalog listed the model.
  expect((await save([review])).statusCode).toBe(200);
  backend.models = CATALOG;
  // Another change saves; the saved name is a warning, not a block.
  const design = {
    role: 'design',
    backend: 'claude-code',
    model: 'gpt-5.5',
    permissionMode: 'auto',
  };
  const kept = await save([review, design]);
  expect(kept.statusCode, kept.body).toBe(200);
  // A display name newly entered is refused, even one another role already saved.
  const entered = await save([review, { ...design, model: 'GPT-5.5' }]);
  expect(entered.statusCode).toBe(400);
  expect(entered.json().error.message).toContain('"gpt-5.5"');
  const copied = await save([review, { ...design, model: 'GPT-6.1-Sol' }]);
  expect(copied.statusCode).toBe(400);
});

it('waits for the first catalog look before checking a launch after a start (R-G15)', async () => {
  const { state, backend, worktree } = await cycleFixture([]);
  // The daemon has only the release's list, and its first look is still under way.
  let release: (() => void) | undefined;
  let read = false;
  const describe = backend.describe.bind(backend);
  backend.describe = () =>
    read ? describe() : { ...describe(), models: [], catalog: { source: 'fallback' as const } };
  let asked: () => void = () => undefined;
  const askedForCatalog = new Promise<void>((resolve) => {
    asked = resolve;
  });
  backend.listModels = () =>
    new Promise((resolve) => {
      asked();
      release = () => {
        read = true;
        backend.models = CATALOG;
        resolve({ models: CATALOG, status: { source: 'catalog' } });
      };
    });
  // The start answers once its launch has gone through the check, so it is awaited after.
  const starting = state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, permissionMode: 'auto', model: 'GPT-6.1-Sol' },
  });
  await withinHangGuard(askedForCatalog, 'the launch asked for the catalog');
  release?.();
  const started = await starting;
  expect(started.statusCode, started.body).toBe(200);
  const { run } = startAgentRunResponseSchema.parse(started.json());
  await waitFor(
    () => state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'failed',
    'refused once the catalog was read',
  );
  expect(backend.launches).toHaveLength(0);
});

it('refuses a display name entered on a roadmap, and keeps one it already saved (R-G15)', async () => {
  const { state, backend } = await roadmapFixture([designDone]);
  const known = backend.models;
  const input = roadmapInput(state, [state.workItemId]);
  const withDesign = (model: string, version = 0) => ({
    ...input,
    expectedVersion: version,
    entries: input.entries.map((entry) => ({
      ...entry,
      profiles: { ...entry.profiles, design: { ...entry.profiles.design, model } },
    })),
  });
  const refused = await saveRoadmapRequest(state, withDesign('Scripted model'));
  expect(refused.statusCode).toBe(400);
  expect(refused.json().error.message).toContain('"scripted-model"');
  // Saved while the catalog did not list it, then kept through another save.
  backend.models = [];
  expect((await saveRoadmapRequest(state, withDesign('Scripted model'))).statusCode).toBe(200);
  backend.models = known;
  const resaved = await saveRoadmapRequest(state, {
    ...withDesign('Scripted model', storedRoadmap(state).version),
    name: 'Renamed',
  });
  expect(resaved.statusCode, resaved.body).toBe(200);
});
