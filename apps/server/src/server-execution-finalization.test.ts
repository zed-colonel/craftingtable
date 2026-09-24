import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeResponseSchema } from '@craftingtable/contracts';
import { createGitOperations } from '@craftingtable/git';
import { openCraftingTableStorage, openDatabase } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { recordedFindings, requiredFindingIds } from './services/run-handoff.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  beginFinalization,
  cleanupExecutionFixtures,
  commitFile,
  finalizationCommand,
  finalizationCycle,
  finalizationFixture,
  git,
  merge,
  mutationHeaders,
  present,
  reviewText,
  runDetail,
  runToFinish,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it('runs plan-scoped polish and independent verification, then requires explicit exact-commit promotion', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root, integration } = fixture;
  const main = git(['rev-parse', 'main'], root);
  backend.onLaunch = (request) => {
    if (request.model === 'polish-model') commitFile(request.cwd, 'polish.txt', 'simplified\n');
  };
  const value = await beginFinalization(fixture);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'final independent review',
    8000,
  );
  const cycle = finalizationCycle(state, value);
  expect(backend.launches.map((r) => r.model)).toEqual([
    'assessment-model',
    'polish-model',
    'assessment-model',
    'final-review-model',
  ]);
  expect(cycle.polishPhase).toBe('final-review');
  expect(backend.launches[0]?.prompt).toContain('# Plan finalization');
  expect(backend.launches[0]?.prompt).toContain('craftingtable-work-items.json');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(integration);
  const tree = present(
    state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
  );
  expect(tree.workItemId).toBeUndefined();
  expect(tree.planVersionId).toBe('version-1');
  expect(
    state.context.storage.execution.runs.listForWorkItem(state.workspaceId, state.workItemId),
  ).toHaveLength(0);
  expect((await merge(state, tree.id)).statusCode).toBe(409);
  const review = present(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  ).reviewBranchContext;
  if (!review) throw new Error('Expected final review context');
  expect(
    (
      await finalizationCommand(state, value, 'merge', {
        expectedHeadSha: '0'.repeat(40),
        expectedTargetSha: review.targetSha,
      })
    ).statusCode,
  ).toBe(409);
  const promoted = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: review.headSha,
    expectedTargetSha: review.targetSha,
  });
  expect(promoted.statusCode, promoted.body).toBe(200);
  expect(promoted.json().finalization.status).toBe('completed');
  expect(readFileSync(join(root, 'polish.txt'), 'utf8')).toBe('simplified\n');
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(integration);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.mergeSha,
  ).toBeUndefined();
});

it('stops finalization for genuine questions and never converts exhausted remediation into approval', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root } = fixture;
  const main = git(['rev-parse', 'main'], root);
  backend.replyForRequest = () => ({
    resultText: `## Open questions\nMay I change the intended public API?\n\n## Review report\n${reviewText([])}`,
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [],
    policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
  });
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'finalization question',
  );
  expect(backend.launches).toHaveLength(1);
  expect(finalizationCycle(state, value).reason).toContain('input');
  backend.replyForRequest = () => ({
    resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([structuredFinding])}`,
  });
  const resumed = await finalizationCommand(state, value, 'resume', {
    instructions: 'Keep the public API unchanged; identify required fixes within the plan.',
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'finalization remediation limit',
  );
  expect(finalizationCycle(state, value).reason).toContain('limit');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
});

it('invalidates final promotion after integration drift and preserves the snapshot on stop', {
  timeout: 10000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, root } = fixture;
  const value = await beginFinalization(fixture, { ...fixture.input, rounds: [] });
  await waitFor(() => finalizationCycle(state, value).status === 'awaiting-merge', 'final review');
  const cycle = finalizationCycle(state, value);
  const context = present(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  ).reviewBranchContext;
  if (!context) throw new Error('Expected final review context');
  git(['checkout', 'revision'], root);
  commitFile(root, 'extra.txt', 'external integration\n');
  git(['checkout', 'main'], root);
  const rejected = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: context.headSha,
    expectedTargetSha: context.targetSha,
  });
  expect(rejected.statusCode, rejected.body).toBe(409);
  expect(rejected.body).toContain('Integration changed');
  const stopped = await finalizationCommand(state, value, 'stop');
  expect(stopped.statusCode, stopped.body).toBe(200);
  expect(stopped.json().finalization.status).toBe('stopped');
  expect(
    existsSync(
      present(state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId))
        .path,
    ),
  ).toBe(true);
});

it('recovers finalization preparation only on explicit resume and preserves its reserved worktree', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let interrupted = false;
  const fixture = await finalizationFixture({
    gitOperations: {
      ...realGit,
      createWorktree: async (input) => {
        const result = await realGit.createWorktree(input);
        if (result.ok && input.branchName.startsWith('ct/finalize-') && !interrupted) {
          interrupted = true;
          throw new Error('Simulated interruption after finalization worktree creation');
        }
        return result;
      },
    },
  });
  const { state, backend, root } = fixture;
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/plans/version-1/finalizations`,
    headers: mutationHeaders(state),
    payload: { ...fixture.input, rounds: [] },
  });
  expect(response.statusCode).toBe(500);
  const value = present(state.context.storage.execution.finalizations.list(state.workspaceId)[0]);
  expect(value.status).toBe('preparing');
  expect(backend.launches).toHaveLength(0);
  const before = git(['worktree', 'list', '--porcelain'], root);
  expect(before).toContain(`ct/finalize-${value.id}`);
  state.context.services.workCycleService.recoverInterrupted();
  expect(backend.launches).toHaveLength(0);
  const resumed = await finalizationCommand(state, value, 'resume');
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'recovered plan review',
  );
  expect(git(['worktree', 'list', '--porcelain'], root)).toBe(before);
  expect(backend.launches).toHaveLength(1);
});

it('holds integration merges while finalization is active or paused and releases them on stop', {
  timeout: 10000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, repository, root } = fixture;
  const value = await beginFinalization(fixture, { ...fixture.input, rounds: [] });
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'ready finalization',
  );
  const created = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/worktrees`,
    headers: mutationHeaders(state),
    payload: { repositoryId: repository.id },
  });
  expect(created.statusCode, created.body).toBe(200);
  const tree = createWorktreeResponseSchema.parse(created.json()).worktree;
  commitFile(tree.path, 'late-fix.txt', 'late integrated change');
  await runToFinish(state, tree.id, { role: 'review' });
  const initial = git(['rev-parse', 'revision'], root);
  const held = await merge(state, tree.id);
  expect(held.statusCode).toBe(409);
  expect(held.body).toContain('held for plan finalization');
  expect((await finalizationCommand(state, value, 'pause')).statusCode).toBe(200);
  expect((await merge(state, tree.id)).statusCode).toBe(409);
  expect(git(['rev-parse', 'revision'], root)).toBe(initial);
  const stopped = await finalizationCommand(state, value, 'stop');
  expect(stopped.statusCode, stopped.body).toBe(200);
  const released = await merge(state, tree.id);
  expect(released.statusCode, released.body).toBe(200);
  expect(git(['rev-parse', 'revision'], root)).not.toBe(initial);
});

it('compacts finalization findings while preserving closure history and requiring reopened findings', {
  timeout: 20000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  const history = Array.from({ length: 112 }, (_, index) => ({
    ...structuredFinding,
    id: `ITEM-${index}.F-001`,
    status: index === 0 ? 'withdrawn' : 'resolved',
    disposition: 'Verified during the integrated work item.',
  }));
  const closed = { ...structuredFinding, status: 'resolved', disposition: 'Verified the fix.' };
  const reports = [
    [...history, structuredFinding],
    [closed],
    [structuredFinding], // Independent final review reopens the concern.
    [], // An open finding still cannot disappear.
  ];
  let review = 0;
  backend.replyForRequest = (request) => ({
    resultText: request.model?.includes('polish')
      ? 'Fixed and verified.\n\n## Open questions\nnone'
      : `## Open questions\nnone\n\n## Review report\n${reviewText(reports[review++] ?? [closed])}`,
  });
  const value = await beginFinalization(fixture);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'missing reopened finding',
    12000,
  );
  const cycle = finalizationCycle(state, value);
  expect(cycle.reason).toContain('F-001');
  expect((await runDetail(state, cycle.currentRunId)).run.verdict).toBeUndefined();
  // Dropping a reopened finding is missing content, not format: it stops at once (R-C2).
  expect(backend.repairs).toBe(0);
  expect(backend.launches).toHaveLength(6 + backend.repairs);
  const current = present(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  );
  expect([...requiredFindingIds(state.context.storage.execution, current)]).toEqual(['F-001']);
  expect(recordedFindings(state.context.storage.execution, current).size).toBe(113);
  const finalLaunch = present(backend.launches.find((r) => r.model === 'final-review-model'));
  const handoff = join(present(finalLaunch.additionalDirectories?.[0]), 'handoff');
  const snapshot = JSON.parse(readFileSync(join(handoff, 'findings.json'), 'utf8'));
  expect(snapshot.requiredFindingIds).toEqual([]);
  expect(snapshot.closedFindingIds).toHaveLength(113);
  const archive = JSON.parse(readFileSync(join(handoff, snapshot.closedHistory), 'utf8'));
  expect(
    archive.findings.find((r: { finding: { id: string } }) => r.finding.id === 'F-001'),
  ).toMatchObject({ finding: closed, runId: expect.any(String), sequence: expect.any(Number) });
  const initial = state.context.storage.execution.runs
    .listForWorktree(state.workspaceId, value.worktreeId)
    .at(-1);
  expect(recordedFindings(state.context.storage.execution, present(initial)).size).toBe(113);
  expect(finalLaunch.prompt).not.toContain('Verified during the integrated work item.');
  const resumed = await finalizationCommand(state, value, 'resume');
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'closed reopened finding',
  );
  expect(
    (await runDetail(state, finalizationCycle(state, value).currentRunId)).reviewReport,
  ).toMatchObject({ status: 'complete', report: { findings: [closed] } });
});

it.each(['unchanged', 'candidate-changed', 'destination-changed', 'truncated'] as const)(
  'guides a rejected finalization report retry with %s evidence and expires attempt guidance',
  { timeout: 20000 },
  async (scenario) => {
    const fixture = await finalizationFixture();
    const { state, backend, root } = fixture;
    const report = {
      version: 1,
      complete: true,
      verdict: 'mergeable',
      exitGate: { met: true, evidence: 'Current and historical verification. '.repeat(800) },
      findings: [],
    };
    backend.replyForRequest = () => ({
      resultText: `## Open questions\nnone\n\n## Review report\n\`\`\`craftingtable-review\n${JSON.stringify(report)}\n\`\`\`\nVERDICT: mergeable`,
      ...(scenario === 'truncated' ? { truncated: true } : {}),
    });
    const value = await beginFinalization(fixture);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'oversized review',
    );
    const failed = finalizationCycle(state, value);
    if (scenario !== 'truncated') expect(failed.reason).toContain('exitGate.evidence');
    expect((await runDetail(state, failed.currentRunId)).run.verdict).toBeUndefined();
    if (scenario === 'candidate-changed') {
      const tree = present(
        state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
      );
      commitFile(tree.path, 'changed.txt', 'changed since the review\n');
    }
    if (scenario === 'destination-changed') commitFile(root, 'destination.txt', 'changed main\n');
    backend.replyForRequest = (request) => ({
      resultText: request.model?.includes('polish')
        ? 'Polish verified.\n\n## Open questions\nnone'
        : `## Open questions\nnone\n\n## Review report\n${reviewText([])}`,
    });
    const resumed = await finalizationCommand(state, value, 'resume', {
      instructions: 'Answer for this attempt only.',
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'corrected finalization',
      12000,
    );
    // The oversized report is repaired automatically twice before the stop (R-C2).
    expect(backend.repairs).toBe(scenario === 'truncated' ? 0 : 2);
    const retry = present(backend.launches[1 + backend.repairs]);
    expect(retry.prompt).toContain('## Correct the rejected review report');
    expect(retry.prompt).toContain('Answer for this attempt only.');
    if (scenario === 'unchanged') {
      expect(retry.prompt).toContain('same candidate and destination commits');
      expect(retry.prompt).toContain('exitGate.evidence');
    } else {
      expect(retry.prompt).toContain('Perform a fresh review and run the required verification');
      expect(retry.prompt).not.toContain('The daemon confirmed');
    }
    for (const launch of backend.launches.slice(2 + backend.repairs)) {
      expect(launch.prompt).not.toContain('Answer for this attempt only.');
      expect(launch.prompt).not.toContain('## Correct the rejected review report');
    }
    const retryRoot = present(retry.additionalDirectories?.[0]);
    const fullOutcome = readFileSync(join(retryRoot, 'handoff/0000-final.md'), 'utf8');
    expect(fullOutcome).toContain(report.exitGate.evidence);
    expect(retry.prompt.length).toBeLessThan(fullOutcome.length);
    expect(finalizationCycle(state, value).instructions).toBe('');
  },
);

it('authorizes bounded extra finalization remediation, preserves counts and rounds, and rejects replay', {
  timeout: 20000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root } = fixture;
  const initialMain = git(['rev-parse', 'main'], root);
  const result = (findings: readonly unknown[]) =>
    `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`;
  let fixed = false;
  backend.replyForRequest = (request) => ({
    resultText: request.model?.includes('polish')
      ? 'Checked the fix.\n\n## Open questions\nnone'
      : result([
          {
            ...structuredFinding,
            ...(fixed ? { status: 'resolved', disposition: 'Fix independently verified.' } : {}),
          },
        ]),
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [present(fixture.input.rounds[0]), present(fixture.input.rounds[0])],
    policy: { ...fixture.input.policy, maxRemediationRounds: 1 },
  });
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'initial remediation limit',
    10000,
  );
  const before = finalizationCycle(state, value);
  expect(before).toMatchObject({ remediationRounds: 1, polishRound: 0, polishPhase: 'verify' });
  const count = backend.launches.length;
  // A plain resume cannot add remediation rounds: it is refused and names the control (R-A7).
  const unchanged = await finalizationCommand(state, value, 'resume');
  expect(unchanged.statusCode).toBe(409);
  expect(unchanged.body).toContain('Authorize more remediation');
  expect(backend.launches).toHaveLength(count);
  const versions = finalizationCycle(state, value);
  const requests = await Promise.all([
    finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
      instructions: 'Focus on the remaining regression.',
    }),
    finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
      instructions: 'Focus on the remaining regression.',
    }),
  ]);
  expect(requests.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const granted = present(requests.find((r) => r.statusCode === 200)).json();
  expect(granted.cycle).toMatchObject({
    step: 'remediate',
    remediationRounds: 2,
    additionalRemediationRounds: 1,
    parentRunId: versions.currentRunId,
  });
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'extended remediation limit',
  );
  expect(backend.launches[count]?.model).toBe('polish-model');
  expect(backend.launches[count]?.prompt).toContain('Focus on the remaining regression.');
  expect(backend.launches[count + 1]?.prompt).not.toContain('Focus on the remaining regression.');
  expect(finalizationCycle(state, value)).toMatchObject({
    remediationRounds: 2,
    additionalRemediationRounds: 1,
    policy: { maxRemediationRounds: 1 },
  });
  const reopened = openCraftingTableStorage(state.context.storage.databasePath);
  try {
    expect(reopened.execution.cycles.find(state.workspaceId, value.cycleId)).toMatchObject({
      remediationRounds: 2,
      additionalRemediationRounds: 1,
    });
  } finally {
    reopened.close();
  }
  fixed = true;
  expect(
    (await finalizationCommand(state, value, 'authorize-remediation', { additionalRounds: 2 }))
      .statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'remaining rounds and independent review',
    10000,
  );
  expect(finalizationCycle(state, value)).toMatchObject({
    worktreeId: before.worktreeId,
    remediationRounds: 3,
    additionalRemediationRounds: 3,
    polishPhase: 'final-review',
    polishRound: 2,
    policy: { maxRemediationRounds: 1, maxNits: 0 },
  });
  expect(backend.launches.at(-1)?.model).toBe('final-review-model');
  expect(git(['rev-parse', 'main'], root)).toBe(initialMain);
  expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
  const audit = state.context.storage.audit
    .listWorkspace({ workspaceId: state.workspaceId, limit: 1000 })
    .filter((event) => event.metadata?.action === 'authorize-remediation');
  expect(audit).toHaveLength(2);
  expect(audit.map((event) => event.metadata?.additionalRemediationRounds).sort()).toEqual([1, 3]);
  expect(
    audit.every((event) => event.actorKind === 'user' && event.actorUserId === state.userId),
  ).toBe(true);
});

it.each(['questions', 'invalid', 'conflict'] as const)(
  'does not authorize extra remediation across a %s checkpoint',
  {
    timeout: 15000,
  },
  async (checkpoint) => {
    const fixture = await finalizationFixture();
    const { state, backend } = fixture;
    backend.replyForRequest = () => ({
      resultText: `## Open questions\n${checkpoint === 'questions' ? 'May I change the public API?' : 'none'}\n\n## Review report\n${checkpoint === 'invalid' ? 'Invalid review' : reviewText([structuredFinding])}`,
    });
    const value = await beginFinalization(fixture, {
      ...fixture.input,
      rounds: [],
      policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
    });
    await waitFor(() => finalizationCycle(state, value).status === 'needs-attention', 'checkpoint');
    const current = finalizationCycle(state, value);
    if (checkpoint === 'conflict')
      state.context.storage.transaction((tx) =>
        tx.execution.cycles.replace(
          {
            ...current,
            version: current.version + 1,
            integrationResolution: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              status: 'detected',
              headSha: '1'.repeat(40),
              targetSha: '2'.repeat(40),
              targetBranch: 'main',
              paths: ['README.md'],
              diagnostics: 'Conflict',
              attempts: 0,
              createdAt: current.updatedAt,
            },
          },
          current.version,
        ),
      );
    const response = await finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(finalizationCycle(state, value).additionalRemediationRounds).toBeUndefined();
    // An invalid report is repaired twice before the stop (R-C2).
    expect(backend.repairs).toBe(checkpoint === 'invalid' ? 2 : 0);
    expect(backend.launches).toHaveLength(1 + backend.repairs);
  },
);

it('requires CSRF and editor authority before authorizing finalization remediation', {
  timeout: 10000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  backend.replyForRequest = () => ({
    resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([structuredFinding])}`,
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [],
    policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
  });
  await waitFor(() => finalizationCycle(state, value).status === 'needs-attention', 'budget');
  const noCsrf = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/finalizations/${value.id}/control`,
    headers: { cookie: state.cookie },
    payload: {
      action: 'authorize-remediation',
      additionalRounds: 1,
      expectedVersion: value.version,
      expectedCycleVersion: finalizationCycle(state, value).version,
    },
  });
  expect(noCsrf.statusCode).toBe(403);
  const db = openDatabase(state.context.storage.databasePath);
  try {
    db.prepare(
      "UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
    ).run(state.workspaceId, state.userId);
  } finally {
    db.close();
  }
  expect(
    (await finalizationCommand(state, value, 'authorize-remediation', { additionalRounds: 1 }))
      .statusCode,
  ).toBe(403);
  expect(finalizationCycle(state, value).additionalRemediationRounds).toBeUndefined();
  expect(backend.launches).toHaveLength(1);
});

it.each(['pause', 'revoke'] as const)(
  'rechecks finalization authorization after Git inspection when the operator chooses %s',
  { timeout: 15000 },
  async (change) => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    let duringInspection: (() => Promise<void>) | undefined;
    const fixture = await finalizationFixture({
      gitOperations: {
        ...realGit,
        inspectWorktreeChanges: async (path) => {
          const result = await realGit.inspectWorktreeChanges(path);
          const operation = duringInspection;
          duringInspection = undefined;
          await operation?.();
          return result;
        },
      },
    });
    const { state, backend } = fixture;
    backend.replyForRequest = () => ({
      resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([structuredFinding])}`,
    });
    const value = await beginFinalization(fixture, {
      ...fixture.input,
      rounds: [],
      policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
    });
    await waitFor(() => finalizationCycle(state, value).status === 'needs-attention', 'budget');
    duringInspection = async () => {
      if (change === 'pause') {
        const paused = await state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${state.workspaceId}/cycles/${value.cycleId}/control`,
          headers: mutationHeaders(state),
          payload: { action: 'pause', expectedVersion: finalizationCycle(state, value).version },
        });
        expect(paused.statusCode).toBe(200);
      } else {
        const db = openDatabase(state.context.storage.databasePath);
        try {
          db.prepare(
            "UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
          ).run(state.workspaceId, state.userId);
        } finally {
          db.close();
        }
      }
    };
    const response = await finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
    });
    expect(response.statusCode, response.body).toBe(change === 'pause' ? 409 : 403);
    expect(finalizationCycle(state, value).additionalRemediationRounds).toBeUndefined();
    expect(finalizationCycle(state, value).remediationRounds).toBe(0);
    expect(backend.launches).toHaveLength(1);
  },
);
