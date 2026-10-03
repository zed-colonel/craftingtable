import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import type { AgentLaunchRequest, PinnedCargoManifest } from '@craftingtable/agents';
import type { DeclaredCheck } from '@craftingtable/domain';
import { afterEach, expect, vi } from 'vitest';
import {
  checkGate,
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  declareFixtureChecks,
  designDone,
  git,
  HOST_GIT,
  implementationDone,
  itNeedsCargo,
  mutationHeaders,
  processRunning,
  runLauncher,
  runToFinish,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  waitFor,
  waitUntil,
  withinHangGuard,
  withoutDaemonChecks,
} from './execution-test-support.js';
import { CheckDefinitionChangedError } from './services/errors.js';

afterEach(cleanupExecutionFixtures);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * An independent implementation slice with a pinned environment, so its reviews are scoped,
 * and adopted `checks` for its repository unless `checks` is null (R-G13).
 */
async function scopedRuntimeFixture(
  checks?: DeclaredCheck[] | null,
  definitionDigests?: Record<string, string>,
  /** More slices of `local/AQ-01`, for tests that need more scoped worktrees at once. */
  extraSlices: readonly string[] = [],
) {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: [
      ...source.slices,
      ...extraSlices.map((id) => ({
        ...source.slices[0]!,
        id,
        title: id,
        scope: `Complete ${id}`,
      })),
    ].map((s) => ({ ...s, mode: 'implementation' })),
    work_items: source.work_items.map((w) => ({
      ...w,
      repository: 'local',
      ...(w.id === 'local/AQ-01'
        ? {
            required_slices: [...w.required_slices, ...extraSlices],
            acceptance_requires: [
              ...w.acceptance_requires,
              ...extraSlices.map((id) => ({
                kind: 'slice' as const,
                id,
                state: 'verified' as const,
              })),
            ],
          }
        : {}),
    })),
  }));
  const svc = f.state.context.services.runtimeEvidenceService;
  if (checks !== null) declareFixtureChecks(f.state, checks, definitionDigests);
  await svc.configure(f.auth, f.state.workspaceId, f.parentScope.definitionId, {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [
      {
        id: 'local',
        kind: 'local-development' as const,
        identityDigest: '1'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Local development checks',
      },
    ],
  });
  const tree = await scopeTree(f, f.scopes[0]!);
  commitFile(tree.path, 'slice.txt', 'slice implementation');
  return { ...f, svc, tree };
}

/**
 * Appends a receipt line exactly as a check launcher would, with every field a gate compares,
 * from files the run can read. Any agent can do this (SEC-01).
 */
function appendReceipt(request: AgentLaunchRequest, fields: Record<string, unknown>) {
  const raw = readFileSync(
    join(request.buildEnvironment!.binDirectory, '../manifest.json'),
    'utf8',
  );
  const m = JSON.parse(raw) as PinnedCargoManifest;
  const headSha = execFileSync(HOST_GIT, ['rev-parse', 'HEAD'], {
    cwd: request.cwd,
    encoding: 'utf8',
  }).trim();
  appendFileSync(
    m.receiptPath,
    `${JSON.stringify({
      kind: 'scoped-check',
      runtimeId: m.runtimeId,
      runId: m.runId,
      manifestDigest: sha(raw),
      verificationMode: m.verification?.mode,
      policyDigest: m.verification && sha(JSON.stringify(m.verification)),
      headSha,
      clean: true,
      command: 'true',
      args: [],
      success: true,
      exitCode: 0,
      diagnostic: '',
      at: new Date().toISOString(),
      ...fields,
    })}\n`,
  );
}

itNeedsCargo(
  'a scoped review needs a scoped check; a local CI receipt alone does not satisfy it (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const review = (kind: string) => {
      f.backend.replyForRequest = (request) => {
        appendReceipt(request, { kind });
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      return runToFinish(f.state, f.tree.id, { role: 'review' });
    };
    const ciOnly = await review('local-ci');
    const environment = f.state.context.storage.runtimeEvidence.run(f.state.workspaceId, ciOnly);
    expect(
      (JSON.parse(readFileSync(environment!.manifestPath, 'utf8')) as PinnedCargoManifest)
        .verification?.mode,
    ).toBe('scoped-checks');
    expect(() => f.svc.assertRun(f.tree, ciOnly)).toThrow('ct-check --declared fixture');
  },
);

itNeedsCargo(
  'the brief names each adopted check and the command that runs it, which the gate needs (LIVE-23, R-G13)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'fixture', argv: ['git', 'diff', '--check', 'HEAD'], definitionPaths: [] },
      { id: 'lint', argv: ['git', 'status'], definitionPaths: [] },
    ]);
    let prompt = '';
    f.backend.replyForRequest = (request) => {
      prompt = request.prompt;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    await runToFinish(f.state, f.tree.id, { role: 'review' });
    const bin = /Use the controller Cargo launcher (\S+)\/cargo/.exec(prompt)?.[1];
    expect(bin).toBeTruthy();
    expect(prompt).toContain(`${bin}/ct-check --declared fixture`);
    expect(prompt).toContain(`${bin}/ct-check --declared lint`);
    // Daemon-run builds use their own build directory; CARGO_TARGET_DIR is the agent's (LIVE-26).
    expect(prompt).toContain(
      "Builds and checks CraftingTable runs for you (the Cargo launcher's builds, ct-check, ct-act, ct-native) use a build directory CraftingTable chooses, and the launcher's other Cargo commands use the manifest's (the run’s scratch/target)",
    );
    // The earlier section says the same, so the two do not contradict each other.
    if (prompt.includes('this worktree’s build cache'))
      expect(prompt).toContain(
        'The supplied Cargo launcher and CraftingTable’s checks use their own build directories instead',
      );
    // A reviewer runs them read-only on the reviewed head, and is not told to commit.
    expect(prompt).toContain("this review's gate needs a successful run of EACH");
    expect(prompt).not.toContain('After committing');
    expect(prompt).toContain('The adopted checks below are required');
    // An implementing run uses them early; a design run changes nothing and is told nothing.
    for (const role of ['implement', 'design'] as const) {
      await runToFinish(f.state, f.tree.id, { role });
      if (role === 'implement') {
        expect(prompt).toContain('After committing, run them to check your work early');
        expect(prompt).not.toContain("this review's gate needs");
      } else expect(prompt).not.toContain('ct-check --declared');
    }
  },
);

itNeedsCargo(
  "the daemon runs a review's adopted checks before the reviewer starts, and they meet the gate without the agent (R-G13 increment 3, LIVE-23)",
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'fixture', argv: ['git', 'diff', '--check', 'HEAD'], definitionPaths: [] },
      {
        id: 'broken',
        argv: ['git', 'rev-parse', '--verify', 'refs/heads/no-such-branch'],
        definitionPaths: [],
      },
    ]);
    const storage = f.state.context.storage;
    let prompt = '';
    let receiptsAtLaunch = -1;
    f.backend.replyForRequest = (request) => {
      prompt = request.prompt;
      receiptsAtLaunch = storage.runtimeEvidence.checkReceipts(
        f.state.workspaceId,
        request.environment?.CRAFTINGTABLE_RUN_NAMESPACE ?? '',
      ).length;
      // The reviewer runs nothing itself.
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    // Both ran, and were recorded, before the reviewer started.
    expect(receiptsAtLaunch).toBe(2);
    const receipts = storage.runtimeEvidence
      .checkReceipts(f.state.workspaceId, run)
      .map((r) => JSON.parse(r.receipt));
    expect(receipts.map((r) => [r.declaredCheck?.id, r.origin, r.success]).sort()).toEqual([
      ['broken', 'daemon', false],
      ['fixture', 'daemon', true],
    ]);
    expect(prompt).toContain(
      'Adopted checks CraftingTable ran on the reviewed head before this review:',
    );
    expect(prompt).toContain('- fixture: exited 0.');
    const failed = /- broken: failed \(exit \d+\)\..* Output: (\S+)/.exec(prompt);
    expect(failed).toBeTruthy();
    expect(existsSync(failed![1]!)).toBe(true);
    // The failure is the gate's, not a missing run: only the broken check is still owed.
    expect(() => f.svc.assertRun(f.tree, run)).toThrow('ct-check --declared broken.');
  },
);

itNeedsCargo(
  "a review's checks run in the background: its start returns at once, and a drain during them starts no agent (R-G13 increment 3)",
  async () => {
    // The check waits on a gate, so it runs until the test opens it (R-I2, LF F4).
    const gate = checkGate();
    const f = await scopedRuntimeFixture([
      { id: 'slow', argv: [...gate.command], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    const launched = () => f.backend.launches.length;
    const before = launched();
    const start = async () => {
      const response = await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
        headers: mutationHeaders(f.state),
        payload: { worktreeId: f.tree.id, role: 'review' },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().run.id as string;
    };
    // The request answers while the check still runs; the run is starting.
    const first = await start();
    expect(storage.execution.runs.find(f.state.workspaceId, first as never)?.status).toBe(
      'starting',
    );
    expect(launched()).toBe(before);
    // Its check is running: the reviewer starts only once the check ends.
    await waitUntil(() => gate.pids().length === 1, 'the first check running');
    expect(storage.execution.runs.find(f.state.workspaceId, first as never)?.status).toBe(
      'starting',
    );
    expect(launched()).toBe(before);
    gate.open();
    await waitFor(
      () => storage.execution.runs.find(f.state.workspaceId, first as never)?.status === 'waiting',
      'the reviewer started after its check',
    );
    expect(launched()).toBe(before + 1);
    expect(storage.runtimeEvidence.checkReceipts(f.state.workspaceId, first)).toHaveLength(1);
    await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/runs/${first}/end`,
      headers: mutationHeaders(f.state),
      payload: {},
    });
    await waitFor(
      () => storage.execution.runs.find(f.state.workspaceId, first as never)?.status === 'finished',
      'finish',
    );
    // A restart drain during the checks cancels them and starts no reviewer.
    const second = await start();
    // A manual start in the same worktree waits for the review (the worktree is held).
    const refused = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
      headers: mutationHeaders(f.state),
      payload: { worktreeId: f.tree.id, role: 'review' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('its adopted checks are running');
    await waitUntil(() => gate.pids().length === 2, 'the second check running');
    const check = gate.pids()[1]!;
    // The drain has recorded the interruption by the time it returns, before storage could
    // close (R-G13 increment 3 review, H1). The gate stays shut, so a drain that waited for
    // the check would never return: it stopped the check instead.
    expect(
      await withinHangGuard(
        f.state.context.services.agentRunService.interruptForRestart(),
        'the drain',
      ),
    ).toBe(1);
    expect(storage.execution.runs.find(f.state.workspaceId, second as never)?.status).toBe(
      'interrupted',
    );
    await waitUntil(() => !processRunning(check), 'the stopped check to exit');
    expect(launched()).toBe(before + 1);
  },
);

itNeedsCargo(
  "pausing a cycle during its review's checks stops them at once and starts no reviewer (R-G13 increment 3 review)",
  async () => {
    // The check waits on a gate the test never opens (R-I2, LF F4).
    const gate = checkGate();
    const f = await scopedRuntimeFixture([
      { id: 'slow', argv: [...gate.command], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    f.backend.replyForRequest = async (request) => {
      if (request.model === 'design-model') return designDone;
      if (request.model !== 'review-model') {
        commitFile(request.cwd, 'more.txt', 'implemented');
        return implementationDone;
      }
      return {
        resultText: `## Open questions\nnone\n\n## Review report\n${scopeReport(f.state, f.tree.executionScope!)}`,
      };
    };
    const reviewsLaunched = () =>
      f.backend.launches.filter((l) => l.model === 'review-model').length;
    const cycle = await startCycle(f.state, f.tree.id);
    // Step without `quiesce`, which waits for the checks, to see the review while it starts.
    const services = f.state.context.services;
    const reviewRun = () => {
      const current = currentCycle(f.state, cycle);
      return current.step === 'review'
        ? storage.execution.runs.find(f.state.workspaceId, current.currentRunId as never)
        : undefined;
    };
    await waitFor(() => reviewRun()?.status === 'starting', 'the review starting its checks', {
      step: () => services.workCycleService.tick(),
    });
    const starting = reviewRun()!;
    await waitUntil(() => gate.pids().length === 1, 'the check running');
    await controlCycle(f.state, currentCycle(f.state, cycle), 'pause');
    const ended = () => storage.execution.runs.find(f.state.workspaceId, starting.id)?.status;
    // The gate stays shut, so only stopping the check can end the review.
    await waitUntil(() => ended() !== 'starting', 'the paused review to end');
    expect(ended()).toBe('cancelled');
    await waitUntil(() => !processRunning(gate.pids()[0]!), 'the stopped check to exit');
    expect(reviewsLaunched()).toBe(0);
    expect(services.checkRequestService.inFlight(starting.id)).toEqual([]);
  },
);

itNeedsCargo(
  'a restart ends a reviewer that launched during it, and records a review whose checks outlast its grace (R-G13 increment 3 verification)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'quick', argv: ['git', 'status'], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    const services = f.state.context.services;
    const start = async () => {
      const response = await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
        headers: mutationHeaders(f.state),
        payload: { worktreeId: f.tree.id, role: 'review' },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().run.id as string;
    };
    const status = (id: string) =>
      storage.execution.runs.find(f.state.workspaceId, id as never)?.status;
    // The reviewer's launch is under way when the restart begins ending sessions.
    let release!: () => void;
    const launching = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inLaunch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.backend.replyForRequest = async () => {
      entered();
      await launching;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await start();
    await inLaunch;
    const draining = services.agentRunService.interruptForRestart();
    release();
    expect(await draining).toBe(1);
    expect(status(run)).toBe('interrupted');
    expect(storage.execution.runs.listLive()).toEqual([]);
  },
);

itNeedsCargo(
  'a drain records a review whose checks outlast its grace, and counts it once (R-G13 increment 3 verification)',
  async () => {
    // A check that never ends unless stopped: its gate is never opened (R-I2).
    const gate = checkGate();
    const f = await scopedRuntimeFixture([
      { id: 'endless', argv: [...gate.command], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    const services = f.state.context.services;
    // The checks ignore the cancellation, as a slow clone does before the command runs.
    vi.spyOn(services.checkRequestService, 'close').mockResolvedValue(undefined);
    const response = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
      headers: mutationHeaders(f.state),
      payload: { worktreeId: f.tree.id, role: 'review' },
    });
    const run = response.json().run.id as string;
    expect(await services.agentRunService.interruptForRestart()).toBe(1);
    expect(storage.execution.runs.find(f.state.workspaceId, run as never)?.status).toBe(
      'interrupted',
    );
    expect(storage.execution.runs.listLive()).toEqual([]);
    vi.restoreAllMocks();
    await services.checkRequestService.close(run);
  },
);

itNeedsCargo(
  'a manual review whose worktree is retired during its checks starts no reviewer (R-G13 increment 3 verification)',
  async () => {
    // The check ends when the test opens its gate, after the worktree is retired (R-I2).
    const gate = checkGate();
    const f = await scopedRuntimeFixture([
      { id: 'slow', argv: [...gate.command], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    const before = f.backend.launches.length;
    const response = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
      headers: mutationHeaders(f.state),
      payload: { worktreeId: f.tree.id, role: 'review' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json().run.id as string;
    const find = () => storage.execution.runs.find(f.state.workspaceId, run as never);
    expect(find()?.status).toBe('starting');
    // An amendment retires the worktree while the checks run; amendments take no worktree hold.
    vi.spyOn(storage.amendments, 'retired').mockReturnValue(true);
    try {
      gate.open();
      await waitFor(() => find()?.status !== 'starting', 'the launch ended after its checks');
      expect(find()?.status).toBe('cancelled');
      expect(find()?.outcomeSummary ?? '').toContain('retired by a reviewed amendment');
      expect(f.backend.launches.length).toBe(before);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

itNeedsCargo(
  'a drain counts only the reviews it stopped: one whose checks failed to run is not counted (R-G13 increment 3 verification)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'quick', argv: ['git', 'status'], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    const services = f.state.context.services;
    let fail!: (error: Error) => void;
    vi.spyOn(services.checkRequestService, 'runDeclared').mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    try {
      const response = await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
        headers: mutationHeaders(f.state),
        payload: { worktreeId: f.tree.id, role: 'review' },
      });
      const run = response.json().run.id as string;
      const draining = services.agentRunService.interruptForRestart();
      fail(new Error('the check service failed'));
      expect(await draining).toBe(0);
      expect(storage.execution.runs.find(f.state.workspaceId, run as never)?.status).toBe('failed');
    } finally {
      vi.restoreAllMocks();
    }
  },
);

itNeedsCargo(
  'a drain waits for a manual review still preparing its launch, and no run starts after it (R-G13 increment 3 verification)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'quick', argv: ['git', 'status'], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    const services = f.state.context.services;
    const agentRuns = services.agentRunService;
    // The launch is past its first drain check, pinning its evidence, when the drain begins.
    const evidence = services.runtimeEvidenceService;
    const prepare = evidence.prepare.bind(evidence);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inPrepare = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(evidence, 'prepare').mockImplementation(async (...args) => {
      entered();
      await held;
      return prepare(...args);
    });
    const runsBefore = storage.execution.runs.listForWorktree(f.state.workspaceId, f.tree.id);
    const before = f.backend.launches.length;
    try {
      const request = f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
        headers: mutationHeaders(f.state),
        payload: { worktreeId: f.tree.id, role: 'review' },
      });
      await inPrepare;
      // A drain waits for it rather than seeing nothing in flight.
      expect(agentRuns.busyRunCount()).toBe(1);
      const draining = agentRuns.interruptForRestart();
      release();
      expect(await draining).toBe(0);
      expect((await request).statusCode).not.toBe(200);
      expect(storage.execution.runs.listForWorktree(f.state.workspaceId, f.tree.id)).toEqual(
        runsBefore,
      );
      expect(f.backend.launches.length).toBe(before);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

itNeedsCargo(
  'a drain records a run whose launch outlasts its grace, and the session it gets is ended (R-G13 increment 3 verification)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'quick', argv: ['git', 'status'], definitionPaths: [] },
    ]);
    const storage = f.state.context.storage;
    const agentRuns = f.state.context.services.agentRunService;
    // An implementing run has no checks: its launch is the backend's, which hangs here.
    const launch = f.backend.launch.bind(f.backend);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inLaunch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(f.backend, 'launch').mockImplementation(async (request) => {
      entered();
      await held;
      return launch(request);
    });
    try {
      const request = f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
        headers: mutationHeaders(f.state),
        payload: { worktreeId: f.tree.id, role: 'implement' },
      });
      await inLaunch;
      const [run] = storage.execution.runs
        .listForWorktree(f.state.workspaceId, f.tree.id)
        .filter((r) => r.status === 'starting');
      expect(run).toBeDefined();
      expect(agentRuns.busyRunCount()).toBe(1);
      expect(await agentRuns.interruptForRestart()).toBe(1);
      const status = () => storage.execution.runs.find(f.state.workspaceId, run!.id)?.status;
      expect(status()).toBe('interrupted');
      release();
      await request;
      expect(status()).toBe('interrupted');
      // The session the backend returned after the drain was ended, not left running.
      const session = f.backend.sessions.at(-1);
      expect(session).toBeDefined();
      expect(Reflect.get(session!, 'closed')).toBe(true);
      expect(storage.execution.runs.listLive()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

itNeedsCargo(
  'a receipt an agent writes to the launcher file satisfies no gate; the daemon runs and records the check (R-G4, SEC-01)',
  async () => {
    // The check reports where it ran; the launcher only relays the daemon's output.
    const f = await scopedRuntimeFixture([
      {
        id: 'where',
        argv: [
          'node',
          '-e',
          'console.log("checked in", process.cwd(), "agent", process.env.CT_AGENT_ONLY ?? "absent", "cargo", process.env.CARGO_HOME, "target", process.env.CARGO_TARGET_DIR)',
        ],
        definitionPaths: [],
      },
    ]);
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    f.backend.replyForRequest = (request) => {
      // Every kind the daemon runs, written by the agent instead.
      for (const kind of ['scoped-check', 'local-ci', 'native-check', undefined])
        appendReceipt(request, { kind, recordedBy: 'daemon' });
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const forged = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(storage.runtimeEvidence.run(f.state.workspaceId, forged)?.receiptAuthority).toBe(
      'daemon',
    );
    expect(storage.runtimeEvidence.build(f.state.workspaceId, forged)?.receipts).toBe('');
    expect(() => f.svc.assertRun(f.tree, forged)).toThrow('ct-check --declared where');

    let output = '';
    f.backend.replyForRequest = async (request) => {
      output = (await runLauncher(request, 'ct-check', ['--declared', 'where'])).stdout;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    process.env.CT_AGENT_ONLY = 'inherited';
    let checked: string;
    try {
      checked = await runToFinish(f.state, f.tree.id, { role: 'review' });
    } finally {
      delete process.env.CT_AGENT_ONLY;
    }
    // It runs in a private clone of the reviewed commit, never the agent's worktree, with a
    // fresh Cargo home of its own made from the daemon's downloads, never the operator's or the
    // shared one (R-G5 review; R-G13 review, operator decision 2026-09-29), and build outputs
    // that are the daemon's, one directory per reviewed commit.

    const { checkLogRoot } = f.state.context.config.execution;
    const head = git(['rev-parse', 'HEAD'], f.tree.path).trim();
    const location = new RegExp(
      `checked in ${checkLogRoot}/${checked}/([^/ ]+)\\.private/tree agent absent cargo ${checkLogRoot}/${checked}/cargo-home-0 target ${checkLogRoot}/${checked}/declared-target/${head}`,
    ).exec(output);
    expect(location, output).not.toBeNull();
    // The daemon names the clone's directory, never the request.
    const replies = readdirSync(join(checkLogRoot, checked, 'replies'));
    expect(replies.some((name) => name.startsWith(location![1]!))).toBe(false);
    // Once the run's checks close, the clones and build outputs are gone; the logs stay.
    const kept = readdirSync(join(checkLogRoot, checked));
    expect(
      kept.filter(
        (name) =>
          name === 'declared-target' || name.endsWith('.private') || name.startsWith('cargo-home-'),
      ),
    ).toEqual([]);
    expect(kept.some((name) => name.endsWith('.log'))).toBe(true);
    const [recorded] = storage.runtimeEvidence.checkReceipts(f.state.workspaceId, checked);
    expect(JSON.parse(recorded!.receipt)).toMatchObject({
      kind: 'scoped-check',
      recordedBy: 'daemon',
      success: true,
      clean: true,
      headSha: git(['rev-parse', 'HEAD'], f.tree.path).trim(),
      declaredCheck: { id: 'where' },
    });
    expect(() => f.svc.assertRun(f.tree, checked)).not.toThrow();
  },
);

itNeedsCargo(
  'a check still running when its run ends is stopped and records nothing (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    let pending: Promise<unknown> | undefined;
    f.backend.replyForRequest = (request) => {
      // Not awaited: the agent ends its turn while its check is still running.
      pending = runLauncher(request, 'ct-check', [
        '--',
        process.execPath,
        '-e',
        'setTimeout(() => console.log("finished late"), 60000)',
      ]).then(
        () => 0,
        (error: { code?: number }) => error.code,
      );
      const checks = f.state.context.services.checkRequestService;
      const runId = request.buildEnvironment!.namespace!;
      // The turn ends once the daemon is running the check.
      const release = (async () => {
        while (checks.inFlight(runId).length === 0) await new Promise((r) => setTimeout(r, 20));
      })();
      return { resultText: scopeReport(f.state, f.tree.executionScope!), release };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(await pending).not.toBe(0);
    expect(storage.runtimeEvidence.checkReceipts(f.state.workspaceId, run)).toEqual([]);
    expect(storage.runtimeEvidence.build(f.state.workspaceId, run)?.receipts).toBe('');
  },
);

/** An operator local CI configuration whose act prints and then sleeps for `seconds`. */
function fakeLocalCi(root: string, seconds: number) {
  const tool = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const config = join(root, 'act.json');
  writeFileSync(
    config,
    JSON.stringify({
      actExecutable: tool('act', `echo "act ran"; sleep ${seconds}`),
      dockerExecutable: tool('docker', 'exit 0'),
      dockerHost: 'unix:///run/user/1000/docker.sock',
      image: `image@sha256:${'a'.repeat(64)}`,
      cacheRoot: join(root, 'cache'),
    }),
  );
  return config;
}

itNeedsCargo(
  'ct-act runs in the daemon; a local CI line an agent writes is dropped, and CI still running at the end invalidates the record (R-G4, LIVE-03)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    const root = mkdtempSync(join(tmpdir(), 'ct-receipt-gates-ci-'));
    mkdirSync(join(f.tree.path, '.github/workflows'), { recursive: true });
    writeFileSync(join(f.tree.path, '.github/workflows/ci.yml'), 'name: CI\non: push\n');
    git(['add', '.'], f.tree.path);
    git(['commit', '-m', 'workflow'], f.tree.path);
    const previous = process.env.CRAFTINGTABLE_ACT_CONFIG;
    process.env.CRAFTINGTABLE_ACT_CONFIG = fakeLocalCi(root, 0);
    try {
      let output = '';
      f.backend.replyForRequest = async (request) => {
        appendReceipt(request, { kind: 'local-ci' });
        output = (await runLauncher(request, 'ct-act', ['-W', '.github/workflows/ci.yml'])).stdout;
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      const ran = await runToFinish(f.state, f.tree.id, { role: 'review' });
      expect(output).toContain('act ran');
      const frozen = storage.runtimeEvidence.build(f.state.workspaceId, ran)!.receipts;
      // Only the daemon's own receipt: the appended line is gone.
      expect(
        frozen
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      ).toEqual([
        expect.objectContaining({ kind: 'local-ci', recordedBy: 'daemon', success: true }),
      ]);

      process.env.CRAFTINGTABLE_ACT_CONFIG = fakeLocalCi(root, 60);
      f.backend.replyForRequest = (request) => {
        void runLauncher(request, 'ct-act', ['-W', '.github/workflows/ci.yml']).catch(() => {});
        const checks = f.state.context.services.checkRequestService;
        const runId = request.buildEnvironment!.namespace!;
        const release = (async () => {
          while (!checks.inFlight(runId).includes('ct-act'))
            await new Promise((r) => setTimeout(r, 20));
        })();
        return { resultText: scopeReport(f.state, f.tree.executionScope!), release };
      };
      const unfinished = await runToFinish(f.state, f.tree.id, { role: 'review' });
      expect(storage.runtimeEvidence.build(f.state.workspaceId, unfinished)?.error).toContain(
        'Local CI did not finish collection',
      );
    } finally {
      if (previous === undefined) delete process.env.CRAFTINGTABLE_ACT_CONFIG;
      else process.env.CRAFTINGTABLE_ACT_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

itNeedsCargo(
  'the daemon uses the manifest it verified at launch; a rewritten copy changes nothing (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    f.backend.replyForRequest = async (request) => {
      const manifest = join(request.buildEnvironment!.binDirectory, '../manifest.json');
      chmodSync(manifest, 0o600);
      writeFileSync(manifest, '{"workspacePath":"/","cargoExecutable":"/bin/false"}');
      await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    const build = storage.runtimeEvidence.build(f.state.workspaceId, run)!;
    expect(build.error).toBeUndefined();
    expect(JSON.parse(build.receipts)).toMatchObject({ success: true, recordedBy: 'daemon' });
    expect(() => f.svc.assertRun(f.tree, run)).not.toThrow();
  },
);

/**
 * A review run whose agent asked for one check running `command`, live and waiting while its
 * check runs. For the tests of what closing the daemon waits for.
 */
async function runWithOneCheck(command: readonly string[]) {
  const f = await scopedRuntimeFixture();
  // The agent's own request: the daemon's runs before a review are tested on their own.
  withoutDaemonChecks(f.state);
  let runId = '';
  f.backend.replyForRequest = (request) => {
    runId = request.buildEnvironment!.namespace!;
    writeFileSync(
      join(request.buildEnvironment!.binDirectory, '../requests', `${CHECK_ID}.request`),
      JSON.stringify({ version: 1, tool: 'ct-check', args: ['--', ...command] }),
    );
    return { resultText: 'Check requested.' };
  };
  const started = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
    headers: mutationHeaders(f.state),
    payload: { worktreeId: f.tree.id, role: 'review' },
  });
  expect(started.statusCode, started.body).toBe(200);
  const run = started.json().run.id as string;
  await waitFor(
    () =>
      f.state.context.storage.execution.runs.find(f.state.workspaceId, run as never)?.status ===
      'waiting',
    'turn',
  );
  return { f, runId, checks: f.state.context.services.checkRequestService };
}
const CHECK_ID = '00000000-0000-4000-8000-000000000000';

itNeedsCargo(
  'closing the daemon waits for the checks of a run that just ended, and their logs (R-I2, TS-M14)',
  async () => {
    const gate = checkGate();
    const { f, runId, checks } = await runWithOneCheck(gate.command);
    await waitUntil(() => gate.pids().length === 1, 'the check running');
    // A run that ends closes its checks without anyone awaiting it, as the run service does.
    void checks.close(runId);
    await withinHangGuard(checks.closeAll(), 'the daemon closing');
    // Closed only once the stopped check has exited and its log is written.
    expect(processRunning(gate.pids()[0]!)).toBe(false);
    expect(
      existsSync(join(f.state.context.config.execution.checkLogRoot, runId, `${CHECK_ID}.log`)),
    ).toBe(true);
  },
);

itNeedsCargo(
  'closing the daemon does not wait without bound for a check that outlives its stop (R-I2)',
  async () => {
    // The check starts a process in a session of its own, which the stop cannot reach and
    // which keeps the check's output open: the check never reports that it ended. That process
    // waits on the gate, which the test's cleanup closes.
    const gate = checkGate();
    const escapes = `require('node:child_process').spawn('setsid', ${JSON.stringify(gate.command)}, { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    const { runId, checks } = await runWithOneCheck(['node', '-e', escapes]);
    await waitUntil(() => gate.pids().length === 1, 'the escaped process running');
    void checks.close(runId);
    await withinHangGuard(checks.closeAll(), 'the daemon closing');
    // Closed although the stop has not finished: the escaped process still holds the output.
    expect(processRunning(gate.pids()[0]!)).toBe(true);
  },
);

itNeedsCargo(
  'the daemon runs at most eight checks at once across its runs (R-G4 review)',
  async () => {
    const f = await scopedRuntimeFixture(undefined, undefined, ['local/AQ-01/c']);
    // The agents' own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const checks = f.state.context.services.checkRequestService;
    // Every check waits on the gate, so none finishes before the test says (R-I2).
    const gate = checkGate();
    // Three scoped runs at once need three development slots.
    f.state.context.storage.phaseScheduling.setCapacity('local-development', 3);
    const third = { ...f.scopes[0]!, sourceId: 'local/AQ-01/c' };
    const trees = [f.tree, await scopeTree(f, f.scopes[1]!), await scopeTree(f, third)];
    for (const tree of trees.slice(1)) commitFile(tree.path, 'slice.txt', 'slice implementation');
    const served: { runId: string; spool: string }[] = [];
    f.backend.replyForRequest = (request) => {
      const runId = request.buildEnvironment!.namespace!;
      const spool = join(request.buildEnvironment!.binDirectory, '../requests');
      served.push({ runId, spool });
      // Four per run, as many as one run may run at once: twelve in all, against eight.
      for (let i = 0; i < 4; i++)
        writeFileSync(
          join(spool, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}.request`),
          JSON.stringify({ version: 1, tool: 'ct-check', args: ['--', ...gate.command] }),
        );
      // The report is not what this tests: the runs stay live, waiting, while their checks run.
      return { resultText: 'Checks requested.' };
    };
    const runs: string[] = [];
    for (const tree of trees) {
      const started = await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
        headers: mutationHeaders(f.state),
        payload: { worktreeId: tree.id, role: 'review' },
      });
      expect(started.statusCode, started.body).toBe(200);
      runs.push(started.json().run.id as string);
    }
    const status = (run: string) =>
      f.state.context.storage.execution.runs.find(f.state.workspaceId, run as never)?.status;
    await waitFor(() => runs.every((run) => status(run) === 'waiting'), 'three turns');
    expect(served).toHaveLength(3);
    // Once every request is claimed, the bounds alone decide what runs.
    await waitUntil(
      () => served.every(({ spool }) => !readdirSync(spool).some((n) => n.endsWith('.request'))),
      'every request claimed',
    );
    const running = () => served.map(({ runId }) => checks.inFlight(runId).length);
    const total = () => running().reduce((sum, n) => sum + n, 0);
    expect(total()).toBe(8);
    expect(Math.max(...running())).toBeLessThanOrEqual(4);
    // Released one at a time: each time a check ends, the next starts in its slot, and the
    // count is checked once the daemon has settled, never by sampling.
    const exits = ({ runId }: { runId: string }) => {
      try {
        return readdirSync(
          join(f.state.context.config.execution.checkLogRoot, runId, 'replies'),
        ).filter((n) => n.endsWith('.exit')).length;
      } catch {
        return 0;
      }
    };
    const ended = () => served.reduce((sum, run) => sum + exits(run), 0);
    for (let released = 1; released <= 12; released++) {
      gate.open(1);
      const expected = Math.min(8, 12 - released);
      await waitUntil(
        () => ended() === released && total() >= expected,
        `check ${released} ended and the next started`,
      );
      expect(total()).toBe(expected);
      expect(Math.max(...running())).toBeLessThanOrEqual(4);
    }
    expect(gate.pids()).toHaveLength(12);
    for (const run of runs)
      await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/runs/${run}/end`,
        headers: mutationHeaders(f.state),
        payload: {},
      });
    await waitFor(() => runs.every((run) => status(run) === 'finished'), 'every run finished');
  },
);

itNeedsCargo(
  'the daemon runs at most four checks of a run at once and refuses more than 32 waiting (R-G4 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const checks = f.state.context.services.checkRequestService;
    // Every check waits on the gate, so none can finish before the test says (R-I2, TS-H2).
    const gate = checkGate();
    let runId = '';
    let spool = '';
    f.backend.replyForRequest = (request) => {
      runId = request.buildEnvironment!.namespace!;
      spool = join(request.buildEnvironment!.binDirectory, '../requests');
      // Forty requests at once, written as a launcher would.
      for (let i = 0; i < 40; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        writeFileSync(
          join(spool, `${id}.request`),
          JSON.stringify({ version: 1, tool: 'ct-check', args: ['--', ...gate.command] }),
        );
      }
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const started = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
      headers: mutationHeaders(f.state),
      payload: { worktreeId: f.tree.id, role: 'review' },
    });
    expect(started.statusCode, started.body).toBe(200);
    const run = started.json().run.id as string;
    const status = () =>
      f.state.context.storage.execution.runs.find(f.state.workspaceId, run as never)?.status;
    // The turn ends at once; the run stays live while its checks run.
    await waitFor(() => status() === 'waiting', 'turn');
    const replies = join(f.state.context.config.execution.checkLogRoot, runId, 'replies');
    const exits = () => {
      try {
        return readdirSync(replies)
          .filter((n) => n.endsWith('.exit'))
          .map((n) => JSON.parse(readFileSync(join(replies, n), 'utf8')));
      } catch {
        return []; // No check has answered yet.
      }
    };
    // The daemon claims each request (renaming it) and queues, starts or refuses it in one
    // pass. Nothing can finish, so once none is left unclaimed the bounds alone decide.
    await waitUntil(
      () => !readdirSync(spool).some((name) => name.endsWith('.request')),
      'every request claimed',
    );
    expect(checks.inFlight(runId)).toHaveLength(4);
    expect(exits().map((e) => e.diagnostic)).toEqual(
      Array(4).fill(expect.stringContaining('Too many checks')),
    );
    // Released, the waiting checks run in turn, never more than four at once.
    let peak = 0;
    gate.open(36);
    await waitUntil(() => {
      peak = Math.max(peak, checks.inFlight(runId).length);
      return exits().length === 40;
    }, 'every check');
    expect(peak).toBeLessThanOrEqual(4);
    expect(exits().filter((e) => e.exitCode === 0)).toHaveLength(36);
    expect(gate.pids()).toHaveLength(36);
    await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/runs/${run}/end`,
      headers: mutationHeaders(f.state),
      payload: {},
    });
    await waitFor(() => status() === 'finished', 'finish');
    expect(
      f.state.context.storage.runtimeEvidence.checkReceipts(f.state.workspaceId, run),
    ).toHaveLength(36);
  },
);

itNeedsCargo(
  'a daemon-recorded run that ends has its labelled CI containers removed, even with no CI check running (R-G4 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    const root = mkdtempSync(join(tmpdir(), 'ct-receipt-gates-cleanup-'));
    const calls = join(root, 'docker.log');
    const config = join(root, 'act.json');
    const tool = (name: string, body: string) => {
      writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      return join(root, name);
    };
    writeFileSync(
      config,
      JSON.stringify({
        actExecutable: tool('act', 'exit 0'),
        dockerExecutable: tool('docker', `echo "$@" >> ${calls}; exit 0`),
        dockerHost: 'unix:///run/user/1000/docker.sock',
        image: `image@sha256:${'a'.repeat(64)}`,
        cacheRoot: join(root, 'cache'),
      }),
    );
    const previous = process.env.CRAFTINGTABLE_ACT_CONFIG;
    process.env.CRAFTINGTABLE_ACT_CONFIG = config;
    try {
      f.backend.replyForRequest = () => ({
        resultText: scopeReport(f.state, f.tree.executionScope!),
      });
      const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
      // The removal runs the docker stub after the run ends: a process, not a step (R-I2).
      await waitUntil(() => existsSync(calls), 'the container removal');
      expect(readFileSync(calls, 'utf8')).toContain(
        `ps -aq --filter label=craftingtable.run=${run}`,
      );
    } finally {
      if (previous === undefined) delete process.env.CRAFTINGTABLE_ACT_CONFIG;
      else process.env.CRAFTINGTABLE_ACT_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

itNeedsCargo(
  'only the adopted check meets a scoped gate: a command the agent chooses is supplemental, even the same one, and the agent cannot change what the check runs (R-G13)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    const failures: string[] = [];
    f.backend.replyForRequest = async (request) => {
      // The adopted command, but chosen by the agent: it runs and is recorded, and counts for nothing.
      await runLauncher(request, 'ct-check', ['--', 'git', 'diff', '--check', 'HEAD']);
      await runLauncher(request, 'ct-check', ['--', 'true']);
      for (const args of [
        ['--declared', 'fixture', '--', 'true'],
        ['--declared', 'other'],
        ['--declared'],
      ])
        failures.push(
          await runLauncher(request, 'ct-check', args).then(
            () => 'ran',
            (error: { stdout: string; stderr: string }) => error.stdout + error.stderr,
          ),
        );
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const chosen = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(failures[0]).toContain('Usage: ct-check --declared <check>');
    expect(failures[1]).toContain('other is not a declared check of this repository');
    expect(failures[1]).toContain('Declared: fixture');
    expect(failures[2]).toContain('Usage: ct-check --declared <check>');
    const receipts = storage.runtimeEvidence
      .checkReceipts(f.state.workspaceId, chosen)
      .map((r) => JSON.parse(r.receipt));
    expect(receipts.filter((r) => r.success)).toHaveLength(2);
    expect(receipts.some((r) => r.declaredCheck)).toBe(false);
    expect(() => f.svc.assertRun(f.tree, chosen)).toThrow(
      'The review needs a successful run of each declared check on its exact clean reviewed commit: ct-check --declared fixture.',
    );

    f.backend.replyForRequest = async (request) => {
      await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const declared = await runToFinish(f.state, f.tree.id, { role: 'review' });
    const environment = storage.runtimeEvidence.run(f.state.workspaceId, declared)!;
    const adopted = storage.runtimeEvidence.checkDeclarations(
      f.state.workspaceId,
      f.tree.repositoryId,
    )[0]!;
    // The run was held to the adoption current when it was prepared.
    expect(environment.checkDeclarationId).toBe(adopted.id);
    const [receipt] = storage.runtimeEvidence.checkReceipts(f.state.workspaceId, declared);
    expect(JSON.parse(receipt!.receipt)).toMatchObject({
      command: 'git',
      args: ['--declared', 'fixture'],
      success: true,
      declaredCheck: { id: 'fixture', declarationId: adopted.id, definitionDigests: {} },
    });
    expect(() => f.svc.assertRun(f.tree, declared)).not.toThrow();
  },
);

itNeedsCargo(
  'a declared check whose definition the slice edited stops as check-definition-changed until the edit is adopted or reverted (R-G13)',
  async () => {
    const adopted = '#!/bin/sh\necho adopted check\n';
    const f = await scopedRuntimeFixture(
      [{ id: 'script', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] }],
      { 'scripts/check.sh': sha(adopted) },
    );
    const commitScript = (content: string) => {
      mkdirSync(join(f.tree.path, 'scripts'), { recursive: true });
      writeFileSync(join(f.tree.path, 'scripts/check.sh'), content, { mode: 0o755 });
      chmodSync(join(f.tree.path, 'scripts/check.sh'), 0o755);
      git(['add', 'scripts/check.sh'], f.tree.path);
      git(['commit', '-m', 'check script'], f.tree.path);
    };
    let output = '';
    f.backend.replyForRequest = async (request) => {
      output = (await runLauncher(request, 'ct-check', ['--declared', 'script'])).stdout;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    commitScript(adopted);
    const same = await runToFinish(f.state, f.tree.id, { role: 'review' });
    // The repository's own program runs from the worktree under review.
    expect(output).toContain('adopted check');
    const [receipt] = f.state.context.storage.runtimeEvidence.checkReceipts(
      f.state.workspaceId,
      same,
    );
    expect(JSON.parse(receipt!.receipt).command).toMatch(
      new RegExp(
        `^${f.state.context.config.execution.checkLogRoot}/${same}/[^/]+\\.private/tree/scripts/check\\.sh$`,
      ),
    );
    expect(() => f.svc.assertRun(f.tree, same)).not.toThrow();

    // The slice rewrites the check so it passes whatever it does.
    commitScript('#!/bin/sh\necho weakened check\n');
    const edited = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(output).toContain('weakened check');
    expect(() => f.svc.assertRun(f.tree, edited)).toThrow(CheckDefinitionChangedError);
    expect(() => f.svc.assertRun(f.tree, edited)).toThrow(
      'The declared check script ran with definitions that differ from the adopted ones (scripts/check.sh).',
    );
    try {
      f.svc.assertRun(f.tree, edited);
    } catch (error) {
      expect(error).toMatchObject({ repositoryId: f.tree.repositoryId, checkId: 'script' });
    }

    // Restoring the adopted file in the worktree, hidden from Git, does not hide the commit's.
    writeFileSync(join(f.tree.path, 'scripts/check.sh'), adopted, { mode: 0o755 });
    git(['update-index', '--skip-worktree', 'scripts/check.sh'], f.tree.path);
    const hidden = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(() => f.svc.assertRun(f.tree, hidden)).toThrow(CheckDefinitionChangedError);
    git(['update-index', '--no-skip-worktree', 'scripts/check.sh'], f.tree.path);
    git(['checkout', '--', 'scripts/check.sh'], f.tree.path);

    // A definition replaced by a link is not the adopted file either.
    rmSync(join(f.tree.path, 'scripts/check.sh'));
    writeFileSync(join(f.tree.path, 'scripts/real.sh'), adopted, { mode: 0o755 });
    execFileSync('ln', ['-s', 'real.sh', join(f.tree.path, 'scripts/check.sh')]);
    git(['add', '-A', 'scripts'], f.tree.path);
    git(['commit', '-m', 'linked check'], f.tree.path);
    const linked = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(output).toContain('adopted check');
    expect(() => f.svc.assertRun(f.tree, linked)).toThrow(CheckDefinitionChangedError);
  },
);

itNeedsCargo(
  'a scoped slice in a repository with no adopted checks stops before any run as repository-checks-undeclared (R-G13, fail closed)',
  async () => {
    const f = await scopedRuntimeFixture(null);
    const cycle = await startCycle(f.state, f.tree.id);
    await waitFor(() => currentCycle(f.state, cycle).status === 'needs-attention', 'check stop');
    expect(currentCycle(f.state, cycle).attention).toMatchObject({
      code: 'repository-checks-undeclared',
      owner: 'operator',
      refs: { repositoryId: f.tree.repositoryId },
    });
    expect(currentCycle(f.state, cycle).reason).toContain('has no adopted checks');
    expect(f.backend.launches).toHaveLength(0);
    // Its item opens the repository's checks, where they are adopted.
    const item = f.state.context.storage.attention
      .open(f.state.workspaceId)
      .find((i) => i.subjectKey === `cycle:${cycle.id}`);
    expect(item).toMatchObject({
      code: 'repository-checks-undeclared',
      path: `/workspaces/${f.state.workspaceId}/repositories#repository-checks-${f.tree.repositoryId}`,
    });
  },
);

itNeedsCargo(
  'a declared check never runs a program the agent planted on the run PATH (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    let output = '';
    f.backend.replyForRequest = async (request) => {
      // The launchers' directory is in the run directory, which the agent can write.
      const bin = request.buildEnvironment!.binDirectory;
      chmodSync(bin, 0o700);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\necho PLANTED "$@"\nexit 0\n', { mode: 0o755 });
      output = (await runLauncher(request, 'ct-check', ['--declared', 'fixture'])).stdout;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(output).not.toContain('PLANTED');
    const [receipt] = f.state.context.storage.runtimeEvidence.checkReceipts(
      f.state.workspaceId,
      run,
    );
    expect(JSON.parse(receipt!.receipt)).toMatchObject({ success: true, command: 'git' });
    expect(() => f.svc.assertRun(f.tree, run)).not.toThrow();
  },
);

itNeedsCargo(
  'a declared check runs on the reviewed commit: what the agent writes in its worktree, even hidden from Git, does not reach it (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'result', argv: ['grep', '-q', 'ok', 'result.txt'], definitionPaths: [] },
    ]);
    commitFile(f.tree.path, 'result.txt', 'fail');
    let exit: number | undefined;
    f.backend.replyForRequest = async (request) => {
      writeFileSync(join(request.cwd, 'result.txt'), 'ok');
      git(['update-index', '--skip-worktree', 'result.txt'], request.cwd);
      exit = await runLauncher(request, 'ct-check', ['--declared', 'result']).then(
        () => 0,
        (error: { code?: number }) => error.code,
      );
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(exit).not.toBe(0);
    const [receipt] = f.state.context.storage.runtimeEvidence.checkReceipts(
      f.state.workspaceId,
      run,
    );
    expect(JSON.parse(receipt!.receipt)).toMatchObject({ success: false });
    expect(() => f.svc.assertRun(f.tree, run)).toThrow('ct-check --declared result');
  },
);

itNeedsCargo(
  'a declared check counts only when the worktree was clean and still at the reviewed commit (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const review = (after: (cwd: string) => void, before?: (cwd: string) => void) => {
      f.backend.replyForRequest = async (request) => {
        before?.(request.cwd);
        await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
        after(request.cwd);
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      return runToFinish(f.state, f.tree.id, { role: 'review' });
    };
    // An untracked file while the check ran.
    const dirty = await review(
      (cwd) => rmSync(join(cwd, 'notes.txt')),
      (cwd) => writeFileSync(join(cwd, 'notes.txt'), 'scratch'),
    );
    expect(() => f.svc.assertRun(f.tree, dirty)).toThrow('ct-check --declared fixture');
    // A commit before the check: it ran on a commit other than the one under review.
    const moved = await review(
      () => {},
      (cwd) => commitFile(cwd, 'later.txt', 'not the reviewed commit'),
    );
    expect(() => f.svc.assertRun(f.tree, moved)).toThrow('ct-check --declared fixture');
    const clean = await review(() => {});
    expect(() => f.svc.assertRun(f.tree, clean)).not.toThrow();
  },
);

itNeedsCargo(
  'check-definition-changed stops the cycle, and adopting the new definition then resuming passes a fresh review (R-G13 review)',
  async () => {
    const adopted = '#!/bin/sh\necho adopted check\n';
    const weakened = '#!/bin/sh\necho weakened check\n';
    const f = await scopedRuntimeFixture(
      [{ id: 'script', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] }],
      { 'scripts/check.sh': sha(adopted) },
    );
    const commitScript = (cwd: string, content: string) => {
      mkdirSync(join(cwd, 'scripts'), { recursive: true });
      writeFileSync(join(cwd, 'scripts/check.sh'), content, { mode: 0o755 });
      git(['add', 'scripts/check.sh'], cwd);
      git(['commit', '-m', 'check script'], cwd);
    };
    commitScript(f.tree.path, adopted);
    f.backend.replyForRequest = async (request) => {
      if (request.model === 'design-model') return designDone;
      if (request.model !== 'review-model') {
        commitScript(request.cwd, weakened);
        return implementationDone;
      }
      await runLauncher(request, 'ct-check', ['--declared', 'script']);
      return {
        resultText: `## Open questions\nnone\n\n## Review report\n${scopeReport(f.state, f.tree.executionScope!)}`,
      };
    };
    const cycle = await startCycle(f.state, f.tree.id);
    await waitFor(
      () => currentCycle(f.state, cycle).status === 'needs-attention',
      'definition stop',
    );
    const stopped = currentCycle(f.state, cycle);
    expect(stopped.attention).toMatchObject({
      code: 'check-definition-changed',
      owner: 'operator',
      refs: { repositoryId: f.tree.repositoryId, checkId: 'script' },
    });
    expect(stopped.reason).toContain('then resume for a fresh review');
    const item = f.state.context.storage.attention
      .open(f.state.workspaceId)
      .find((i) => i.subjectKey === `cycle:${cycle.id}`);
    expect(item?.path).toBe(
      `/workspaces/${f.state.workspaceId}/repositories#repository-checks-${f.tree.repositoryId}`,
    );
    // The operator adopts the edited definition, as the Repositories page would.
    const storage = f.state.context.storage;
    const current = storage.runtimeEvidence.checkDeclarations(
      f.state.workspaceId,
      f.tree.repositoryId,
    )[0]!;
    storage.runtimeEvidence.addCheckDeclaration({
      ...current,
      id: randomUUID(),
      version: 2,
      definitionDigests: { 'scripts/check.sh': sha(weakened) },
      rationale: 'The slice improved the check.',
    });
    // The stopped review ran exactly what is now adopted, so it would merge as it is.
    expect(() => f.svc.assertRun(f.tree, stopped.currentRunId!)).not.toThrow();
    await controlCycle(f.state, stopped, 'resume');
    await waitFor(
      () => currentCycle(f.state, cycle).status === 'awaiting-merge',
      'fresh review passes',
    );
  },
);

itNeedsCargo(
  'a declared check refuses an object the agent rewrote in the shared store, which Git never re-hashes on read (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'result', argv: ['grep', '-q', 'ok', 'result.txt'], definitionPaths: [] },
    ]);
    commitFile(f.tree.path, 'result.txt', 'fail');
    const common = git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      f.tree.path,
    ).trim();
    const blob = git(['rev-parse', 'HEAD:result.txt'], f.tree.path).trim();
    const object = join(common, 'objects', blob.slice(0, 2), blob.slice(2));
    const original = readFileSync(object);
    let exit: number | undefined;
    let said = '';
    f.backend.replyForRequest = async (request) => {
      // The loose object of the failing file now holds a passing one, under the same name.
      chmodSync(object, 0o644);
      writeFileSync(object, deflateSync(Buffer.from('blob 2\0ok')));
      exit = await runLauncher(request, 'ct-check', ['--declared', 'result']).then(
        () => 0,
        (error: { code?: number; stdout: string; stderr: string }) => {
          said = error.stdout + error.stderr;
          return error.code;
        },
      );
      writeFileSync(object, original);
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(exit).not.toBe(0);
    expect(said).toContain('could not be checked out');
    expect(() => f.svc.assertRun(f.tree, run)).toThrow('ct-check --declared result');
  },
);
