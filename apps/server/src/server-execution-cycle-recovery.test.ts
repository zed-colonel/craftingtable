import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeStreamNormalizer,
  CodexStreamNormalizer,
  type NormalizedAgentEvent,
} from '@craftingtable/agents';
import { agentRunDetailResponseSchema } from '@craftingtable/contracts';
import {
  asAgentRunId,
  DEFAULT_COMPLETION_POLICY,
  FINALIZATION_STAGE_KINDS,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  beginFinalization,
  cleanupExecutionFixtures,
  commitFile,
  currentCycle,
  cycleFixture,
  designDone,
  finalizationCommand,
  finalizationCycle,
  finalizationFixture,
  git,
  implementationDone,
  implementsFinalization,
  merge,
  mutationHeaders,
  present,
  reviewText,
  roadmapControl,
  roadmapFixture,
  type ScriptedReply,
  saveRoadmapRequest,
  startCycle,
  stagedText,
  stepDaemons,
  storedRoadmap,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

describe('background-work completion recovery', () => {
  const incomplete: ScriptedReply = {
    resultText: 'Waiting for verification.',
    exitReason: 'background-work-incomplete',
  };

  it('continues the same implementation with its handoff and original deadline, then requires review', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      incomplete,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id, { instructions: 'Keep the agreed scope.' });
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'completion recovery',
    );
    expect(backend.launches.map((r) => r.model)).toEqual([
      'design-model',
      'implement-model',
      'implement-model',
      'review-model',
    ]);
    expect(backend.launches[2]?.deadlineAt).toBe(backend.launches[1]?.deadlineAt);
    expect(backend.launches[2]?.prompt).toContain('completion recovery attempt 1 of 2');
    expect(backend.launches[2]?.prompt).toContain('Keep the agreed scope.');
    expect(currentCycle(state, cycle)).toMatchObject({
      resultContinuations: 0,
      remediationRounds: 0,
    });
    const runs = [
      ...state.context.storage.execution.runs.listForWorktree(state.workspaceId, worktree.id),
    ].reverse();
    expect(runs.map((r) => r.status)).toEqual(['finished', 'failed', 'finished', 'finished']);
    expect(runs[2]?.parentRunId).toBe(runs[1]?.id);
    const detail = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${runs[1]?.id}`,
      headers: { cookie: state.cookie },
    });
    const parsed = agentRunDetailResponseSchema.parse(detail.json());
    expect(parsed.completionIssue).toMatchObject({ reason: 'background-work-incomplete' });
    expect(parsed.latestOutcome?.text).toBe('Waiting for verification.');
  });

  it('stops after two continuations and retains the budget in durable state', async () => {
    const { state, backend, worktree } = await cycleFixture([incomplete, incomplete, incomplete]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'continuation allowance',
    );
    expect(backend.launches).toHaveLength(3);
    expect(new Set(backend.launches.map((r) => r.deadlineAt)).size).toBe(1);
    expect(currentCycle(state, cycle)).toMatchObject({
      resultContinuations: 2,
      remediationRounds: 0,
    });
    expect(currentCycle(state, cycle).reason).toContain('exhausted its two continuation');
    const reopened = openDaemonStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)).toMatchObject({
        resultContinuations: 2,
        runDeadlineAt: cycle.runDeadlineAt,
      });
    } finally {
      reopened.close();
    }
  });

  it.each([
    {
      resultText: 'Decision required.\n\n## Open questions\nShould cancellation change history?',
      exitReason: 'background-work-incomplete' as const,
    },
    {
      resultText: 'Background tests exceeded their deadline.',
      exitReason: 'background-work-timeout' as const,
    },
    {
      resultText: 'Waiting for verification.',
      exitReason: 'background-work-incomplete' as const,
      truncated: true,
    },
    { resultText: 'Missing checkpoint without a lifecycle failure.' },
  ])(
    'does not repair questions, timeouts, truncation, or ordinary missing checkpoints: $resultText',
    async (reply) => {
      const { state, backend, worktree } = await cycleFixture([reply]);
      const cycle = await startCycle(state, worktree.id);
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'operator attention',
      );
      // No completion continuation. A missing checkpoint on a finished run is an output-format
      // fault, which gets the separate automatic format repair first (R-C2).
      expect(backend.repairs).toBe(reply.exitReason === undefined ? 2 : 0);
      expect(backend.launches).toHaveLength(1 + backend.repairs);
      expect(currentCycle(state, cycle).resultContinuations ?? 0).toBe(0);
    },
  );

  it('does not extend the original time limit to finish a continuation', async () => {
    let now = new Date('2026-09-14T12:00:00Z');
    const { state, backend, worktree } = await cycleFixture([incomplete, incomplete], () => now);
    backend.onLaunch = () => {
      if (backend.launches.length === 1) now = new Date(now.getTime() + 121 * 60_000);
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'original time limit',
    );
    expect(backend.launches).toHaveLength(2);
    expect(currentCycle(state, cycle).reason).toContain('Step time limit');
    expect(currentCycle(state, cycle).resultContinuations).toBe(1);
  });

  it('continues an interrupted stage remediation and still requires every stage review, with no automatic promotion', {
    timeout: 15000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend, root } = fixture;
    const defect = { ...structuredFinding, category: 'correctness' };
    let fixed = false;
    let interrupted = false;
    backend.replyForRequest = (request) => {
      if (implementsFinalization(request)) {
        if (!interrupted) {
          interrupted = true;
          return incomplete;
        }
        fixed = true;
        return { resultText: 'Committed and checked.\n\n## Open questions\nnone' };
      }
      return {
        resultText: stagedText(request, [
          fixed ? { ...defect, status: 'resolved', disposition: 'Verified the fix.' } : defect,
        ]),
      };
    };
    const main = git(['rev-parse', 'main'], root);
    const value = await beginFinalization(fixture);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'final independent review',
      8000,
    );
    expect(backend.launches.map((r) => r.model)).toEqual([
      'correctness-review',
      'correctness-implement',
      'correctness-implement',
      ...FINALIZATION_STAGE_KINDS.map((kind) => `${kind}-review`),
    ]);
    // The continuation keeps the interrupted step's deadline and stage.
    expect(backend.launches[2]?.deadlineAt).toBe(backend.launches[1]?.deadlineAt);
    expect(backend.launches[2]?.prompt).toContain('Staged finalization: correctness (correctness)');
    const cycle = finalizationCycle(state, value);
    expect(cycle.remediationRounds).toBe(1);
    expect(cycle.finalizationProgress?.stageIndex).toBe(FINALIZATION_STAGE_KINDS.length - 1);
    expect(cycle.finalizationProgress?.stages[0]?.remediationRounds).toBe(1);
    expect(git(['rev-parse', 'main'], root)).toBe(main);
  });
});

describe('collecting background review results', () => {
  it('keeps stdin open while background work is pending and ends only after the collected outcome', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: 'Waiting for a background check.', backgroundWorkPending: true },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'waiting',
      'background wait',
    );
    await stepDaemons(3);
    const session = present(backend.sessions[0]);
    expect(session.endCount).toBe(0);
    expect(backend.launches).toHaveLength(1);
    expect(currentCycle(state, cycle).status).toBe('running');
    session.completeBackground(designDone.resultText);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'collected result');
    expect(session.endCount).toBe(1);
    expect(backend.launches).toHaveLength(3);
    expect(currentCycle(state, cycle).resultContinuations ?? 0).toBe(0);
  });

  it('still cancels pending background work at the original step deadline', async () => {
    let now = new Date('2026-09-15T03:00:00Z');
    const { state, backend, worktree } = await cycleFixture(
      [{ resultText: 'Waiting.', backgroundWorkPending: true }],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => backend.sessions.length === 1, 'pending background work');
    now = new Date(now.getTime() + 121 * 60_000);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'background time limit',
    );
    expect(currentCycle(state, cycle).reason).toContain('Step time limit');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'cancel background owner',
    );
    expect(backend.launches).toHaveLength(1);
    expect(backend.sessions[0]?.endCount).toBe(0);
  });

  it('continues a pinned review with test artifacts, preserves them in scratch, and still requires clean review evidence', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: 'Waiting for the matrix.', exitReason: 'background-work-incomplete' },
      { resultText: reviewText([]) },
    ]);
    const artifact = join(worktree.path, 'test-scratch.rs');
    let preserved: string | undefined;
    backend.onLaunch = (request) => {
      if (backend.launches.length === 2) writeFileSync(artifact, 'generated test fixture');
      if (backend.launches.length === 3) {
        expect(request.prompt).toContain(
          'Untracked paths present at continuation preflight: ["test-scratch.rs"]',
        );
        expect(request.prompt).toContain('Do not stage or commit it');
        preserved = join(present(request.temporaryDirectory), 'preserved-test-scratch.rs');
        renameSync(artifact, preserved);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'artifact recovery',
    );
    expect(readFileSync(present(preserved), 'utf8')).toBe('generated test fixture');
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
    expect(backend.launches.map((r) => r.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'review-model',
    ]);
    expect(backend.launches[3]?.deadlineAt).toBe(backend.launches[2]?.deadlineAt);
    expect(currentCycle(state, cycle)).toMatchObject({
      remediationRounds: 0,
      resultContinuations: 1,
    });
    const runs = state.context.storage.execution.runs.listForWorktree(
      state.workspaceId,
      worktree.id,
    );
    expect(runs[0]?.reviewBranchContext).toEqual(runs[1]?.reviewBranchContext);
  });

  it('cannot approve a continued review while an unknown untracked file remains', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: 'Waiting.', exitReason: 'background-work-incomplete' },
      { resultText: reviewText([]) },
    ]);
    const artifact = join(worktree.path, 'unknown.txt');
    backend.onLaunch = () => {
      if (backend.launches.length === 2) writeFileSync(artifact, 'preserve me');
    };
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'dirty continuation',
    );
    expect(backend.launches).toHaveLength(4);
    expect(readFileSync(artifact, 'utf8')).toBe('preserve me');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    expect(currentCycle(state, cycle).remediationRounds).toBe(0);
  });

  it.each(['tracked', 'staged', 'index-only', 'head', 'target', 'merge'])(
    'does not continue a review when %s state changed',
    async (change) => {
      const { state, backend, worktree, root } = await cycleFixture([
        designDone,
        implementationDone,
        { resultText: 'Waiting.', exitReason: 'background-work-incomplete' },
      ]);
      backend.onLaunch = () => {
        if (backend.launches.length !== 2) return;
        if (change === 'tracked')
          writeFileSync(join(worktree.path, 'README.md'), 'unreviewed change');
        if (change === 'staged') {
          writeFileSync(join(worktree.path, 'new-source.rs'), 'new source');
          git(['add', '.'], worktree.path);
        }
        if (change === 'index-only') {
          const original = readFileSync(join(worktree.path, 'README.md'), 'utf8');
          writeFileSync(join(worktree.path, 'README.md'), 'staged edit');
          git(['add', 'README.md'], worktree.path);
          writeFileSync(join(worktree.path, 'README.md'), original);
          writeFileSync(join(worktree.path, 'test-scratch.rs'), 'temporary');
        }
        if (change === 'head') commitFile(worktree.path, 'other.txt', 'new commit');
        if (change === 'target') commitFile(root, 'upstream.txt', 'integration advanced');
        if (change === 'merge')
          writeFileSync(
            git(['rev-parse', '--git-path', 'MERGE_HEAD'], worktree.path).trim(),
            git(['rev-parse', 'HEAD'], worktree.path),
          );
      };
      const cycle = await startCycle(state, worktree.id);
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'changed review baseline',
      );
      expect(backend.launches).toHaveLength(3);
      expect(currentCycle(state, cycle).resultContinuations ?? 0).toBe(0);
      expect(currentCycle(state, cycle).reason).toMatch(
        /Review continuation requires|review baseline changed/,
      );
    },
  );

  it.each(['plain', 'guided', 'reserved'])(
    '%s resume of an interrupted finalization review can classify its artifacts',
    {
      timeout: 15000,
    },
    async (mode) => {
      const fixture = await finalizationFixture();
      const { state, backend } = fixture;
      const normal = present(backend.replyForRequest);
      let interrupted = false;
      let artifact: string | undefined;
      let preserved: string | undefined;
      backend.replyForRequest = (request) => {
        if (!interrupted) {
          interrupted = true;
          return {
            resultText: '## Open questions\nMay I preserve this generated fixture?',
            exitReason: 'background-work-incomplete',
          };
        }
        return normal(request);
      };
      backend.onLaunch = (request) => {
        if (backend.launches.length === 0) {
          artifact = join(request.cwd, 'test-scratch.rs');
          writeFileSync(artifact, 'generated fixture');
        } else if (backend.launches.length === 1) {
          expect(request.prompt).toContain(
            'Continue interrupted verification on the pinned review baseline',
          );
          if (mode === 'guided')
            expect(request.prompt).toContain('Preserve the fixture and finish verification.');
          preserved = join(present(request.temporaryDirectory), 'preserved-fixture.rs');
          renameSync(present(artifact), preserved);
        }
      };
      const value = await beginFinalization(fixture);
      await waitFor(
        () => finalizationCycle(state, value).status === 'needs-attention',
        'question before continuation',
      );
      if (mode === 'reserved') {
        // A restart or failed launch can leave the continuation reserved without a run record.
        const current = finalizationCycle(state, value);
        state.context.storage.transaction((tx) =>
          tx.execution.cycles.replace(
            {
              ...current,
              version: current.version + 1,
              currentRunId: asAgentRunId('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'),
              parentRunId: current.currentRunId,
              resultContinuations: 1,
            },
            current.version,
          ),
        );
      }
      expect(
        (
          await finalizationCommand(state, value, 'resume', {
            ...(mode === 'guided'
              ? { instructions: 'Preserve the fixture and finish verification.' }
              : {}),
          })
        ).statusCode,
      ).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'awaiting-merge',
        'guided artifact continuation',
        8000,
      );
      expect(readFileSync(present(preserved), 'utf8')).toBe('generated fixture');
      expect(finalizationCycle(state, value).remediationRounds).toBe(0);
    },
  );
});

describe('bounded model service recovery', () => {
  const overloaded: ScriptedReply = {
    resultText: 'Service temporarily unavailable.',
    providerFailure: {
      kind: 'capacity',
      message: 'The selected model is at capacity.',
      safeToRetry: true,
    },
  };
  async function command(
    state: Awaited<ReturnType<typeof cycleFixture>>['state'],
    cycle: WorkCycle,
    action: string,
    version = currentCycle(state, cycle).version,
  ) {
    return state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { action, expectedVersion: version },
    });
  }
  it('waits durably, retries the same model with partial handoff, then requires a complete review', async () => {
    let now = new Date('2026-09-22T12:00:00Z');
    const { state, backend, worktree } = await cycleFixture(
      [
        designDone,
        { ...overloaded, messages: ['Partial implementation saved; verification remains.'] },
        implementationDone,
        { resultText: reviewText([]) },
      ],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id, { instructions: 'Keep the scope.' });
    await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'backoff');
    const waiting = currentCycle(state, cycle);
    expect(waiting.status).toBe('running');
    expect(waiting.providerRecovery).toMatchObject({
      attempts: 0,
      nextRetryAt: '2026-09-22T12:01:00.000Z',
    });
    expect(backend.launches).toHaveLength(2);
    const reopened = openDaemonStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)?.providerRecovery).toEqual(
        waiting.providerRecovery,
      );
    } finally {
      reopened.close();
    }
    now = new Date('2026-09-22T12:01:01Z');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'service recovery');
    expect(backend.launches.map((r) => r.model)).toEqual([
      'design-model',
      'implement-model',
      'implement-model',
      'review-model',
    ]);
    expect(backend.launches[2]?.deadlineAt).toBe(backend.launches[1]?.deadlineAt);
    expect(backend.launches[2]?.resumeSessionId).toBeUndefined();
    expect(backend.launches[2]?.prompt).toContain('service retry 1 of 3');
    expect(
      readFileSync(
        join(
          present(backend.launches[2]?.temporaryDirectory),
          '..',
          'handoff',
          '0000-conversation.md',
        ),
        'utf8',
      ),
    ).toContain('Partial implementation saved');
    expect(backend.launches[2]?.prompt).toContain('Keep the scope.');
    expect(currentCycle(state, cycle)).toMatchObject({
      remediationRounds: 0,
      providerRecovery: null,
    });
    const runs = [
      ...state.context.storage.execution.runs.listForWorktree(state.workspaceId, worktree.id),
    ].reverse();
    expect(runs[2]?.parentRunId).toBe(runs[1]?.id);
  });

  it('bounds retries at three with 1/5/15 minute backoff and no remediation debit', {
    timeout: 15000,
  }, async () => {
    let now = new Date('2026-09-22T12:00:00Z');
    const { state, backend, worktree } = await cycleFixture(
      [overloaded, overloaded, overloaded, overloaded],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    for (const [attempt, minutes] of [1, 5, 15].entries()) {
      await waitFor(
        () =>
          currentCycle(state, cycle).providerRecovery?.attempts === attempt &&
          !!currentCycle(state, cycle).providerRecovery?.nextRetryAt,
        'retry backoff',
      );
      const recovery = currentCycle(state, cycle).providerRecovery!;
      expect(Date.parse(recovery.nextRetryAt!) - now.getTime()).toBe(minutes * 60_000);
      now = new Date(recovery.nextRetryAt!);
    }
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'retry exhaustion',
    );
    expect(backend.launches).toHaveLength(4);
    expect(new Set(backend.launches.map((r) => r.deadlineAt)).size).toBe(1);
    expect(currentCycle(state, cycle)).toMatchObject({
      remediationRounds: 0,
      providerRecovery: { attempts: 3 },
    });
    expect(currentCycle(state, cycle).reason).toContain('three service retries are exhausted');
    expect((await command(state, cycle, 'retry-provider')).statusCode).toBe(409);
  });

  it('supports version-checked Retry now and Pause without resetting allowances', async () => {
    const { state, backend, worktree } = await cycleFixture([overloaded, overloaded]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'backoff');
    const version = currentCycle(state, cycle).version;
    expect((await command(state, cycle, 'pause')).statusCode).toBe(200);
    const before = currentCycle(state, cycle);
    const resumed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'resume',
        expectedVersion: before.version,
        instructions: 'Keep the saved scope.',
      },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(currentCycle(state, cycle).stepGuidance).toBe('Keep the saved scope.');
    expect(currentCycle(state, cycle).runDeadlineAt).toBe(before.runDeadlineAt);
    expect(currentCycle(state, cycle).providerRecovery).toEqual(before.providerRecovery);
    expect((await command(state, cycle, 'pause')).statusCode).toBe(200);
    expect((await command(state, cycle, 'retry-provider', version)).statusCode).toBe(409);
    expect(backend.launches).toHaveLength(1);
    expect((await command(state, cycle, 'retry-provider')).statusCode).toBe(200);
    await waitFor(
      () =>
        currentCycle(state, cycle).providerRecovery?.attempts === 1 &&
        !!currentCycle(state, cycle).providerRecovery?.nextRetryAt,
      'second backoff',
    );
    expect(backend.launches).toHaveLength(2);
    expect(currentCycle(state, cycle).remediationRounds).toBe(0);
  });

  it.each([
    {
      ...overloaded,
      providerFailure: {
        kind: 'authentication' as const,
        message: 'Log in again.',
        safeToRetry: false,
      },
    },
    {
      ...overloaded,
      providerFailure: {
        kind: 'quota' as const,
        message: 'Allowance exhausted.',
        safeToRetry: false,
      },
    },
    { ...overloaded, providerFailure: { ...overloaded.providerFailure!, safeToRetry: false } },
    { ...overloaded, messages: ['## Open questions\nWhich contract should apply?'] },
    { ...overloaded, truncated: true },
    { ...overloaded, exitReason: 'background-work-timeout' as const },
  ])('requires operator input for unsafe or nonretryable failures: $resultText', async (reply) => {
    const { state, backend, worktree } = await cycleFixture([reply]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'safe hold');
    expect(backend.launches).toHaveLength(1);
    expect(currentCycle(state, cycle).providerRecovery?.nextRetryAt).toBeUndefined();
  });

  /** Replays a recorded vendor failure through the real adapter normalizer. */
  function recordedFailure(name: string) {
    const lines = readFileSync(
      new URL(`../../../packages/agents/fixtures/provider-failures/${name}.jsonl`, import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n');
    const events: NormalizedAgentEvent[] = [];
    if (name.startsWith('claude-')) {
      const normalizer = new ClaudeStreamNormalizer({ permissionMode: 'auto', cwd: '/work' });
      for (const line of lines) {
        events.push(...normalizer.normalizeLine(line));
        // As the Claude session does: a used-up allowance with a known reset ends it (R-C9).
        if (normalizer.quotaExhausted) {
          events.push(normalizer.endedForQuota());
          break;
        }
      }
    } else {
      // As the Codex session feeds it: signed in with ChatGPT, requests and stderr included.
      const normalizer = new CodexStreamNormalizer();
      normalizer.setAuthMode('chatgpt');
      for (const line of lines) {
        const { method, params, id, stderr } = JSON.parse(line);
        if (stderr !== undefined) normalizer.observeStderr(stderr);
        else if (id !== undefined) normalizer.requireOperator(method);
        else if (method === 'turn/started') normalizer.beginTurn();
        else if (method === 'turn/completed') events.push(normalizer.complete(params.turn, 'm'));
        else events.push(...normalizer.normalize(method, params));
      }
    }
    const turn = events.at(-1);
    if (turn?.kind !== 'turn-completed' || !turn.payload.providerFailure)
      throw new Error(`${name} did not record a provider failure`);
    return turn.payload.providerFailure;
  }

  it.each([
    'claude-overloaded',
    'claude-server-error',
    'codex-sleep-then-overloaded',
    'codex-stream-disconnected',
  ])('schedules a bounded service retry for recorded %s', async (name) => {
    const failure = recordedFailure(name);
    const { state, backend, worktree } = await cycleFixture([
      { resultText: 'API Error', providerFailure: failure },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'backoff');
    expect(currentCycle(state, cycle)).toMatchObject({
      status: 'running',
      providerRecovery: { attempts: 0, failure },
    });
    expect(backend.launches).toHaveLength(1);
  });

  it.each([
    'claude-overloaded-pending-tool',
    'codex-usage-limit',
    'codex-delegated-then-overloaded',
  ])('holds recorded %s for the operator', async (name) => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: 'API Error', providerFailure: recordedFailure(name) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'safe hold');
    expect(backend.launches).toHaveLength(1);
    expect(currentCycle(state, cycle).providerRecovery?.nextRetryAt).toBeUndefined();
  });

  it('waits for a recorded session limit to reset, then retries the same agent (R-C8)', async () => {
    // The fixture's rate-limit report says the five-hour allowance resets at 14:50 UTC.
    let now = new Date('2026-09-15T12:00:00Z');
    const failure = recordedFailure('claude-session-limit');
    expect(failure).toMatchObject({
      kind: 'quota',
      safeToRetry: true,
      resetsAt: '2026-09-15T14:50:00.000Z',
    });
    const { state, backend, worktree } = await cycleFixture(
      [{ resultText: 'API Error', providerFailure: failure }, designDone],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    const deadline = Date.parse(currentCycle(state, cycle).runDeadlineAt);
    await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'quota wait');
    const waiting = currentCycle(state, cycle);
    expect(waiting).toMatchObject({
      status: 'running',
      providerRecovery: { attempts: 0, failure, nextRetryAt: '2026-09-15T14:52:00.000Z' },
    });
    expect(waiting.attention).toBeUndefined();
    // The wait does not use up the step's own time.
    expect(Date.parse(waiting.runDeadlineAt) - deadline).toBe(172 * 60_000);
    expect(waiting.reason).toContain('resets at 2026-09-15T14:50:00.000Z');

    now = new Date('2026-09-15T14:52:00Z');
    await waitFor(() => backend.launches.length === 3, 'retried design, then implementation');
    expect(backend.launches.map((launch) => launch.model)).toEqual([
      'design-model',
      'design-model',
      'implement-model',
    ]);
  });

  it.each([
    ['codex-provider-credential-rejected', 'API Error'],
    // The review asked the operator to restore the approval service: the outage, not a question.
    [
      'codex-approval-review-rejected',
      '## Open questions\n- Can you restore the automatic approval service so I can run the required ct-act jobs? The approval service returned HTTP 401.',
    ],
  ])(
    'waits out the recorded 2026-09-25 credential outage (%s), then continues without the operator (R-C11)',
    async (name, resultText) => {
      let now = new Date('2026-09-25T22:41:00Z');
      const failure = recordedFailure(name);
      expect(failure).toMatchObject({ kind: 'credential-rejected', safeToRetry: true });
      const { state, backend, worktree } = await cycleFixture(
        [{ resultText, providerFailure: failure }, designDone],
        () => now,
      );
      const cycle = await startCycle(state, worktree.id);
      const deadline = Date.parse(currentCycle(state, cycle).runDeadlineAt);
      await waitFor(
        () => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt,
        'credential wait',
      );
      const waiting = currentCycle(state, cycle);
      expect(waiting).toMatchObject({
        status: 'running',
        providerRecovery: { attempts: 0, failure, nextRetryAt: '2026-09-25T22:46:00.000Z' },
      });
      expect(waiting.attention).toBeUndefined();
      expect(Date.parse(waiting.runDeadlineAt) - deadline).toBe(5 * 60_000);
      expect(waiting.reason).toContain('provider-side outage is suspected');
      expect(waiting.reason).toContain('Evidence: ');
      now = new Date('2026-09-25T22:46:00Z');
      await waitFor(() => backend.launches.length === 3, 'retried design, then implementation');
      expect(currentCycle(state, cycle).attention).toBeUndefined();
    },
  );

  it('stops with the suspected outage and its evidence once the credential retries are spent (R-C11)', async () => {
    let now = new Date('2026-09-25T22:41:00Z');
    const failure = recordedFailure('codex-provider-credential-rejected');
    const rejected = { resultText: 'API Error', providerFailure: failure };
    const { state, backend, worktree } = await cycleFixture(
      [rejected, rejected, rejected, rejected],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    for (const [attempt, minutes] of [
      [1, 5],
      [2, 15],
      [3, 30],
    ] as const) {
      await waitFor(
        () => currentCycle(state, cycle).providerRecovery?.nextRetryAt !== undefined,
        `wait ${attempt}`,
      );
      now = new Date(Date.parse(currentCycle(state, cycle).providerRecovery!.nextRetryAt!));
      expect(now.getTime() - Date.parse(currentCycle(state, cycle).updatedAt)).toBeLessThanOrEqual(
        minutes * 60_000,
      );
      await waitFor(() => backend.launches.length === attempt + 1, `retry ${attempt}`);
    }
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'spent');
    const stopped = currentCycle(state, cycle);
    expect(stopped.attention).toMatchObject({
      code: 'provider-credentials-rejected',
      owner: 'operator',
    });
    expect(stopped.reason).toContain('provider-side outage is suspected');
    expect(stopped.reason).toContain(
      'Evidence: HTTP 401 from https://chatgpt.com/backend-api/codex/responses naming an API key sk-svcac…fvMA',
    );
    expect(stopped.reason).toContain('Three retries');
  });

  it('still stops a locally expired login for a new sign-in (R-C11)', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: 'API Error', providerFailure: recordedFailure('codex-unauthorized') },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'login stop');
    expect(backend.launches).toHaveLength(1);
    expect(currentCycle(state, cycle)).toMatchObject({
      attention: { code: 'service-failure-not-retryable' },
      reason: expect.stringContaining('Sign in again on the workstation'),
    });
  });

  it('waits for the reset after the recorded 736446e8 quota incident instead of stopping (R-C9)', async () => {
    let now = new Date('2026-09-15T10:12:00Z');
    const failure = recordedFailure('claude-session-limit-background-736446e8');
    expect(failure).toMatchObject({
      kind: 'quota',
      safeToRetry: true,
      resetsAt: '2026-09-15T14:50:00.000Z',
    });
    const { state, backend, worktree } = await cycleFixture(
      [{ resultText: "You've hit your session limit", providerFailure: failure }, designDone],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'quota wait');
    expect(currentCycle(state, cycle)).toMatchObject({
      status: 'running',
      providerRecovery: { attempts: 0, nextRetryAt: '2026-09-15T14:52:00.000Z' },
    });
    expect(currentCycle(state, cycle).attention).toBeUndefined();
    now = new Date('2026-09-15T14:52:00Z');
    await waitFor(() => backend.launches.length === 3, 'retried, then the next step');
  });

  it('does not extend the deadline for a provider retry', async () => {
    let now = new Date('2026-09-22T12:00:00Z');
    const { state, backend, worktree } = await cycleFixture([overloaded], () => now);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'backoff');
    now = new Date(Date.parse(currentCycle(state, cycle).runDeadlineAt) + 1);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'deadline');
    expect(backend.launches).toHaveLength(1);
    expect(currentCycle(state, cycle).reason).toContain('Step time limit');
    expect((await command(state, cycle, 'retry-provider')).statusCode).toBe(409);
  });
});

it('holds provider backoff after a daemon restart and while its roadmap is paused', async () => {
  const reply: ScriptedReply = {
    resultText: 'At capacity.',
    providerFailure: { kind: 'capacity', message: 'At capacity.', safeToRetry: true },
  };
  const { state, backend } = await roadmapFixture([reply, reply]);
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .listForWorkspace(state.workspaceId)
        .some((c) => c.providerRecovery?.nextRetryAt),
    'roadmap service backoff',
  );
  const cycle = state.context.storage.execution.cycles
    .listForWorkspace(state.workspaceId)
    .find((c) => c.providerRecovery)!;
  state.context.services.workCycleService.recoverInterrupted();
  expect(currentCycle(state, cycle).status).toBe('needs-attention');
  await waitFor(
    () => storedRoadmap(state).status === 'needs-attention',
    'restart supervision hold',
  );
  await roadmapControl(state, 'pause');
  const command = async () =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'retry-provider', expectedVersion: currentCycle(state, cycle).version },
    });
  const blocked = await command();
  expect(blocked.statusCode, blocked.body).toBe(409);
  expect(blocked.body).toContain('Resume roadmap scheduling');
  expect(backend.launches).toHaveLength(1);
  await roadmapControl(state, 'resume');
  expect(backend.launches).toHaveLength(1);
  expect((await command()).statusCode).toBe(200);
  await waitFor(
    () =>
      currentCycle(state, cycle).providerRecovery?.attempts === 1 &&
      !!currentCycle(state, cycle).providerRecovery?.nextRetryAt,
    'operator resumed service recovery',
  );
  expect(backend.launches).toHaveLength(2);
});

it('retries an interrupted review on its pinned snapshot but never adopts its failed draft', async () => {
  const reply: ScriptedReply = {
    resultText: reviewText([]),
    providerFailure: { kind: 'capacity', message: 'At capacity.', safeToRetry: true },
  };
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    reply,
    { resultText: reviewText([]) },
  ]);
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'review backoff');
  expect((await merge(state, worktree.id)).statusCode).toBe(409);
  const failed = state.context.storage.execution.runs.find(
    state.workspaceId,
    currentCycle(state, cycle).currentRunId,
  )!;
  expect(failed.status).toBe('failed');
  expect(failed.verdict).toBeUndefined();
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'retry-provider', expectedVersion: currentCycle(state, cycle).version },
  });
  expect(response.statusCode, response.body).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'fresh complete review',
  );
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'review-model',
  ]);
  const fresh = state.context.storage.execution.runs.find(
    state.workspaceId,
    currentCycle(state, cycle).currentRunId,
  )!;
  expect(fresh.reviewBranchContext).toEqual(failed.reviewBranchContext);
  expect(fresh.parentRunId).toBe(failed.id);
  expect(currentCycle(state, cycle).remediationRounds).toBe(0);
});
