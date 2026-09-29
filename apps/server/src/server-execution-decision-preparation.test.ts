import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConcurrencySource } from '@craftingtable/domain';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  mutationHeaders,
  roadmapControl,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';
import { architectureDecisionInbox } from './services/architecture-decision-inbox.js';
import { RepositoryMutationBusyError } from './services/branch-service.js';

/**
 * R-C3b: shared architecture decisions are prepared ahead of the slices that need them, while
 * the roadmap runs, and answered once (ADR-065 amended 2026-09-28).
 */

afterEach(cleanupExecutionFixtures);

const DECISIONS = ['LOCAL-ADR-01', 'LOCAL-ADR-02'] as const;

/**
 * A map whose slices wait at start on shared architecture decisions: every slice on LOCAL-ADR-01,
 * only the first on LOCAL-ADR-02, so LOCAL-ADR-01 unblocks more slices.
 */
function withDecisions(source: ConcurrencySource): ConcurrencySource {
  return {
    ...source,
    evidence_profiles: [
      ...source.evidence_profiles,
      {
        id: 'architecture-approval',
        independence_required: true,
        reviewer_roles: ['repository-maintainer'],
        required_evidence: [
          'accepted decision artifact digest and revision',
          'source contract and affected schema or protocol references',
          'decision owner approval and applicability to the active plan generation',
        ],
      },
    ],
    checkpoints: [
      ...source.checkpoints,
      ...DECISIONS.map((id) => ({
        ...source.checkpoints[0]!,
        id,
        owner: 'local',
        kind: 'architecture_decision' as const,
        evidence_profile: 'architecture-approval',
        requires: [],
      })),
    ],
    slices: source.slices.map((s, index) => ({
      ...s,
      start_requires: (index === 0 ? DECISIONS : DECISIONS.slice(0, 1)).map((id) => ({
        kind: 'checkpoint' as const,
        id,
        state: 'passed' as const,
      })),
    })),
  };
}

const brief = (checkpointId: string) => ({
  checkpointId,
  decisionText: `Use the documented boundary for ${checkpointId}.`,
  why: 'The plan requires separation.',
  alternatives: [{ option: 'Shared mutable boundary', tradeoff: 'Weaker isolation' }],
  consequences: 'Test isolation later.',
  coverage: 'full',
  consumers: [],
  retainedObligations: 'Implementation tests remain mandatory.',
});

async function decisionFixture(transform = withDecisions) {
  const f = await supervisedMapFixture(false, 'automatic', false, false, false, transform);
  // A preparation's answer can be held, so its run stays in flight while the roadmap runs on.
  const held = new Map<string, Promise<void>>();
  const hold = (checkpointId: string) => {
    let release!: () => void;
    held.set(
      checkpointId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };
  // A preparation run recommends the checkpoint its brief names.
  f.backend.replyForRequest = (request) => {
    const checkpointId = DECISIONS.find((id) =>
      request.prompt.includes(`decision brief for ${id}`),
    );
    if (!checkpointId) return { resultText: 'Nothing to prepare.' };
    const release = held.get(checkpointId);
    return {
      ...(release ? { release } : {}),
      resultText:
        `## Open questions\nApprove ${checkpointId}?\n\`\`\`craftingtable-design\n` +
        JSON.stringify({
          version: 1,
          items: [
            {
              kind: 'operator-decision',
              question: `Approve ${checkpointId}?`,
              answer: 'Use the documented boundary.',
              sources: [`Exact imported plan ${checkpointId}`],
              decision: brief(checkpointId),
            },
          ],
        }) +
        '\n```',
    };
  };
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, f.state.workspaceId, f.input).roadmap;
  return { f, saved, ws: f.state.workspaceId, tx: f.state.context.storage, hold };
}

type Fixture = Awaited<ReturnType<typeof decisionFixture>>;

function prepare({ f, saved, ws }: Fixture, checkpointId: string) {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${saved.id}/prepare-decision`,
    headers: mutationHeaders(f.state),
    payload: {
      expectedVersion: storedRoadmap(f.state).version,
      checkpointId,
      profile: { backend: 'claude-code', model: 'decision-model' },
      minutes: 5,
      instructions: '',
    },
  });
}

/**
 * Waits without stepping the daemons: a step waits for launches to settle, which a held launch
 * never does.
 */
async function until(predicate: () => boolean, label: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Holds every agent launch until released, so a test can act while one is in flight. */
function holdLaunches({ f }: Fixture) {
  const launch = f.backend.launch.bind(f.backend);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.backend, 'launch').mockImplementation(async (request) => {
    await released;
    return launch(request);
  });
  return release;
}

function preparation({ f }: Fixture, checkpointId: string) {
  return storedRoadmap(f.state).decisionPreparations?.findLast(
    (p) => p.checkpointId === checkpointId,
  );
}

async function proposeAndAccept(
  fixture: Fixture,
  checkpointId: string,
  outcome: 'accepted' | 'rejected' = 'accepted',
) {
  const { f, ws, tx } = fixture;
  const p = preparation(fixture, checkpointId)!;
  const definition = tx.imports.definition(ws, p.definitionId)!;
  const card = architectureDecisionInbox(tx, definition).decisions.find(
    (c) => c.checkpointId === checkpointId,
  )!;
  const proposed =
    await f.state.context.services.runtimeEvidenceService.proposeArchitectureDecision(
      f.auth,
      ws,
      p.definitionId,
      {
        bindingRevision: 1,
        checkpointId,
        sourceRunId: p.runId,
        sourceReportDigest: card.recommendation!.sourceReportDigest,
        coverage: 'full',
        proposal: brief(checkpointId).decisionText,
        sourceReferences: card.sourceReferences,
        consumers: [],
        retainedObligations: brief(checkpointId).retainedObligations,
      },
    );
  const submission = proposed.submissions.find(
    (s) => s.submission.subject.sourceId === checkpointId,
  )!.submission;
  return f.state.context.services.runtimeEvidenceService.decide(f.auth, ws, p.definitionId, {
    submissionId: submission.id,
    outcome,
    rationale: outcome === 'accepted' ? 'Approved.' : 'Not this boundary.',
  });
}

it('prepares a decision while the roadmap runs, through the roadmap’s own writes (R-C3b)', {
  timeout: 30000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  await roadmapControl(f.state, 'start');
  expect(storedRoadmap(f.state).status).toBe('running');
  const release = holdLaunches(fixture);
  const pending = prepare(fixture, 'LOCAL-ADR-01');
  await until(() => tx.execution.runs.listLive().length === 1, 'reserved preparation launch');
  // The scheduler writes the roadmap while the preparation launches: its check binds to the
  // map, binding revision and digest, not to the roadmap's version.
  const running = storedRoadmap(f.state);
  tx.roadmaps.save({ ...running, version: running.version + 1 }, running.version);
  release();
  const result = await pending;
  expect(result.statusCode, result.body).toBe(200);
  const p = preparation(fixture, 'LOCAL-ADR-01')!;
  await waitFor(
    () => tx.execution.runs.find(ws, p.runId)?.status === 'finished',
    'the preparation finishes',
  );
  expect(preparation(fixture, 'LOCAL-ADR-01')!.failure).toBeUndefined();
  expect(storedRoadmap(f.state).status).toBe('running');
});

it('approves one decision while another is still being prepared (R-C3b)', {
  timeout: 30000,
}, async () => {
  const fixture = await decisionFixture();
  const { ws, tx } = fixture;
  expect((await prepare(fixture, 'LOCAL-ADR-01')).statusCode).toBe(200);
  const first = preparation(fixture, 'LOCAL-ADR-01')!;
  await waitFor(
    () => tx.execution.runs.find(ws, first.runId)?.status === 'finished',
    'the first preparation finishes',
  );
  // The second preparation is in flight: a read-only run that only proposes.
  const release = holdLaunches(fixture);
  const pending = prepare(fixture, 'LOCAL-ADR-02');
  await until(() => tx.execution.runs.listLive().length === 1, 'second preparation in flight');
  await proposeAndAccept(fixture, 'LOCAL-ADR-01');
  release();
  expect((await pending).statusCode).toBe(200);
  expect(
    tx.runtimeEvidence
      .decisions(ws)
      .filter((d) => d.outcome === 'accepted')
      .map(
        (d) =>
          tx.runtimeEvidence
            .submissions(ws, first.definitionId)
            .find((s) => s.id === d.submissionId)?.subject.sourceId,
      ),
  ).toEqual(['LOCAL-ADR-01']);
});

function grant(
  { f, saved, ws }: Pick<Fixture, 'f' | 'saved' | 'ws'>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = mutationHeaders(f.state),
) {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${saved.id}/decision-preparation-grant`,
    headers,
    payload: { expectedVersion: storedRoadmap(f.state).version, ...payload },
  });
}

it('grants standing decision preparation while paused, and audits it (R-C3b)', {
  timeout: 30000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  const standing = { enabled: true, minutes: 10, maxConcurrent: 2 };
  expect((await grant(fixture, standing, { cookie: f.state.cookie })).statusCode).toBe(403);
  await roadmapControl(f.state, 'start');
  // Like recovery delegation, the grant is changed only while scheduling is paused.
  expect((await grant(fixture, standing)).statusCode).toBe(409);
  await roadmapControl(f.state, 'pause');
  expect((await grant(fixture, { ...standing, maxConcurrent: 9 })).statusCode).toBe(400);
  const granted = await grant(fixture, standing);
  expect(granted.statusCode, granted.body).toBe(200);
  expect(storedRoadmap(f.state).decisionPreparationGrant).toEqual({
    ...standing,
    grantedByUserId: f.state.userId,
    grantedAt: expect.any(String),
  });
  expect(
    tx.audit
      .listWorkspace({ workspaceId: ws, limit: 20 })
      .find((e) => e.metadata?.action === 'configure-decision-preparation')?.metadata,
  ).toMatchObject({ preparationEnabled: true, preparationMinutes: 10, preparationConcurrency: 2 });
  // Revoked by the operator: future preparations stop; nothing started is cancelled.
  expect((await grant(fixture, { ...standing, enabled: false })).statusCode).toBe(200);
  expect(storedRoadmap(f.state).decisionPreparationGrant?.enabled).toBe(false);
});

it('an applied planning amendment revokes the standing preparation grant (R-C3b)', {
  timeout: 30000,
}, async () => {
  const f = await supervisedMapFixture(true);
  const ws = f.state.workspaceId;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  expect(
    (await grant({ f, saved, ws }, { enabled: true, minutes: 10, maxConcurrent: 1 })).statusCode,
  ).toBe(200);
  const amend = (action: string, payload: Record<string, unknown>) =>
    f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/roadmaps/${saved.id}/amendments${action ? `/${action}` : ''}`,
      headers: mutationHeaders(f.state),
      payload,
    });
  const candidate = {
    definitionId: f.input.configuration.definitionId,
    bindingRevision: 1,
    targetId: f.input.configuration.targetId,
    selection: 'prioritize-full',
  };
  const proposed = await amend('', {
    expectedVersion: storedRoadmap(f.state).version,
    candidate,
    summary: 'Include retained work.',
  });
  expect(proposed.statusCode, proposed.body).toBe(200);
  const view = proposed.json();
  const applied = await amend('decision', {
    amendmentId: view.history[0].id,
    outcome: 'apply',
    impactDigest: view.pendingImpact.digest,
    rationale: 'Reviewed.',
    reuseIntegrationIds: [],
  });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(storedRoadmap(f.state).decisionPreparationGrant?.enabled).toBe(false);
});

const prepared = (fixture: Fixture) =>
  (storedRoadmap(fixture.f.state).decisionPreparations ?? []).map((p) => p.checkpointId);

it('under the grant, the running roadmap prepares what its slices need, most-waited first (R-C3b)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  const before = tx.runtimeEvidence.submissions(ws, f.parentScope.definitionId);
  // Without a grant, a running roadmap prepares nothing.
  await roadmapControl(f.state, 'start');
  await f.state.context.services.roadmapService.tick();
  expect(prepared(fixture)).toEqual([]);
  await roadmapControl(f.state, 'pause');
  expect((await grant(fixture, { enabled: true, minutes: 10, maxConcurrent: 1 })).statusCode).toBe(
    200,
  );
  const release = fixture.hold('LOCAL-ADR-01');
  await roadmapControl(f.state, 'resume');
  // LOCAL-ADR-01 unblocks both slices, LOCAL-ADR-02 one: the first goes first, alone.
  await waitFor(() => prepared(fixture).length === 1, 'the first standing preparation');
  expect(prepared(fixture)).toEqual(['LOCAL-ADR-01']);
  const first = preparation(fixture, 'LOCAL-ADR-01')!;
  expect(first.createdByUserId).toBe(f.state.userId);
  // Audited as the controller's, naming the grantor it acted as (R-C3b review).
  expect(
    tx.audit
      .listWorkspace({ workspaceId: ws, limit: 50 })
      .find((e) => e.metadata?.action === 'prepare-decision'),
  ).toMatchObject({
    actorKind: 'system',
    metadata: { checkpointId: 'LOCAL-ADR-01', preparedByUserId: f.state.userId },
  });
  await waitFor(
    () => tx.execution.runs.find(ws, first.runId)?.status === 'running',
    'the first preparation at work',
  );
  // While it works, the grant's bound of one keeps the next waiting.
  await f.state.context.services.roadmapService.tick();
  expect(prepared(fixture)).toEqual(['LOCAL-ADR-01']);
  release();
  await waitFor(
    () => tx.execution.runs.find(ws, first.runId)?.status === 'finished',
    'the first preparation finishes',
  );
  // Then the next; a decision already prepared on this binding is not prepared again.
  await waitFor(() => prepared(fixture).length === 2, 'the second standing preparation');
  expect(prepared(fixture)).toEqual(['LOCAL-ADR-01', 'LOCAL-ADR-02']);
  const second = preparation(fixture, 'LOCAL-ADR-02')!;
  await waitFor(
    () => tx.execution.runs.find(ws, second.runId)?.status === 'finished',
    'the second preparation finishes',
  );
  await f.state.context.services.roadmapService.tick();
  expect(prepared(fixture)).toEqual(['LOCAL-ADR-01', 'LOCAL-ADR-02']);
  // Preparation proposes nothing by itself and approves nothing.
  expect(tx.runtimeEvidence.submissions(ws, f.parentScope.definitionId)).toEqual(before);
  expect(storedRoadmap(f.state).status).toBe('running');
});

it('the grant skips accepted decisions and stops preparing once revoked (R-C3b)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  // LOCAL-ADR-01 was prepared and accepted by hand.
  expect((await prepare(fixture, 'LOCAL-ADR-01')).statusCode).toBe(200);
  const manual = preparation(fixture, 'LOCAL-ADR-01')!;
  await waitFor(
    () => tx.execution.runs.find(ws, manual.runId)?.status === 'finished',
    'the manual preparation finishes',
  );
  await proposeAndAccept(fixture, 'LOCAL-ADR-01');
  // A revoked grant prepares nothing.
  expect((await grant(fixture, { enabled: false, minutes: 10, maxConcurrent: 2 })).statusCode).toBe(
    200,
  );
  await roadmapControl(f.state, 'start');
  await f.state.context.services.roadmapService.tick();
  expect(prepared(fixture)).toEqual(['LOCAL-ADR-01']);
  await roadmapControl(f.state, 'pause');
  expect((await grant(fixture, { enabled: true, minutes: 10, maxConcurrent: 2 })).statusCode).toBe(
    200,
  );
  await roadmapControl(f.state, 'resume');
  await waitFor(() => prepared(fixture).length === 2, 'the standing preparation');
  // Only the decision still needed: LOCAL-ADR-01 is accepted.
  expect(prepared(fixture)).toEqual(['LOCAL-ADR-01', 'LOCAL-ADR-02']);
});

it('a decision item unblocks the slices that wait on it, counted as slices (R-C3b)', {
  timeout: 30000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx, saved } = fixture;
  await roadmapControl(f.state, 'start');
  await f.state.context.services.roadmapService.tick();
  f.state.context.services.roadmapService.syncAttention(true);
  const blocks = (checkpointId: string) =>
    tx.attention
      .open(ws)
      .find((i) => i.subjectKey === `roadmap:${saved.id}:checkpoint:${checkpointId}`)?.blocks;
  // Both slices wait on LOCAL-ADR-01 at start; only the first on LOCAL-ADR-02.
  expect(blocks('LOCAL-ADR-01')).toBe(2);
  expect(blocks('LOCAL-ADR-02')).toBe(1);
});

/** Grants standing preparation with a bound of one and starts the roadmap. */
async function grantAndStart(fixture: Fixture) {
  expect((await grant(fixture, { enabled: true, minutes: 10, maxConcurrent: 1 })).statusCode).toBe(
    200,
  );
  await roadmapControl(fixture.f.state, 'start');
}

it('a busy repository leaves a standing preparation for the next pass, not failed (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  // A slice merge holds the repository when the first preparation would create its worktree.
  vi.spyOn(
    f.state.context.services.executionService,
    'createDecisionWorktree',
  ).mockRejectedValueOnce(new RepositoryMutationBusyError());
  await grantAndStart(fixture);
  await waitFor(
    () => {
      const p = preparation(fixture, 'LOCAL-ADR-01');
      return !!p && tx.execution.runs.find(ws, p.runId)?.status === 'finished';
    },
    'LOCAL-ADR-01 prepared on a later pass',
    15000,
  );
  expect((storedRoadmap(f.state).decisionPreparations ?? []).filter((p) => p.failure)).toEqual([]);
});

it('a decision that cannot be reserved gives its place to the next, and waits before retrying (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  const roadmaps = f.state.context.services.roadmapService as unknown as {
    launchPreparation: (...args: unknown[]) => Promise<void>;
  };
  const launch = roadmaps.launchPreparation.bind(roadmaps);
  let refused = 0;
  vi.spyOn(roadmaps, 'launchPreparation').mockImplementation(async (...args: unknown[]) => {
    const target = args[1] as { checkpoint: { id: string } };
    if (target.checkpoint.id === 'LOCAL-ADR-01') {
      refused += 1;
      throw new Error('The owner integration branch is gone.');
    }
    return launch(...args);
  });
  await grantAndStart(fixture);
  await waitFor(
    () => {
      const p = preparation(fixture, 'LOCAL-ADR-02');
      return !!p && tx.execution.runs.find(ws, p.runId)?.status === 'finished';
    },
    'LOCAL-ADR-02 prepared although LOCAL-ADR-01 cannot be',
    15000,
  );
  for (let pass = 0; pass < 3; pass++) await f.state.context.services.roadmapService.tick();
  expect(refused).toBe(1);
});

it('skips a decision accepted without a preparation on this binding (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  expect((await prepare(fixture, 'LOCAL-ADR-01')).statusCode).toBe(200);
  const manual = preparation(fixture, 'LOCAL-ADR-01')!;
  await waitFor(
    () => tx.execution.runs.find(ws, manual.runId)?.status === 'finished',
    'the manual preparation finishes',
  );
  await proposeAndAccept(fixture, 'LOCAL-ADR-01');
  // As if it were accepted from a design stop's proposal: no preparation is on record.
  const current = storedRoadmap(f.state);
  const { decisionPreparations: _prepared, ...rest } = current;
  tx.roadmaps.save({ ...rest, version: current.version + 1 }, current.version);
  await grantAndStart(fixture);
  await waitFor(() => prepared(fixture).length === 1, 'the standing preparation');
  expect(prepared(fixture)).toEqual(['LOCAL-ADR-02']);
});

it('prepares nothing for a grantor who may no longer prepare, and stops a launch the grant no longer covers (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, tx } = fixture;
  await grantAndStart(fixture);
  // A grant written by a user who is not a member prepares nothing.
  const granted = storedRoadmap(f.state);
  tx.roadmaps.save(
    {
      ...granted,
      version: granted.version + 1,
      decisionPreparationGrant: {
        ...granted.decisionPreparationGrant!,
        grantedByUserId: randomUUID() as never,
      },
    },
    granted.version,
  );
  await f.state.context.services.roadmapService.tick();
  expect(prepared(fixture)).toEqual([]);
  // The grant is the operator's again; a launch in flight when it is revoked stops.
  const restored = storedRoadmap(f.state);
  tx.roadmaps.save(
    {
      ...restored,
      version: restored.version + 1,
      decisionPreparationGrant: { ...granted.decisionPreparationGrant! },
    },
    restored.version,
  );
  const release = holdLaunches(fixture);
  const pass = f.state.context.services.roadmapService.tick();
  await until(() => tx.execution.runs.listLive().length === 1, 'a standing launch in flight');
  const inFlight = storedRoadmap(f.state);
  tx.roadmaps.save(
    {
      ...inFlight,
      version: inFlight.version + 1,
      decisionPreparationGrant: { ...inFlight.decisionPreparationGrant!, enabled: false },
    },
    inFlight.version,
  );
  release();
  await pass;
  // The launch's own check refuses it: the run ends without a recommendation.
  const stopped = preparation(fixture, 'LOCAL-ADR-01')!;
  const run = tx.execution.runs.find(f.state.workspaceId, stopped.runId);
  expect(stopped.failure ?? run?.status).toMatch(/revoked|failed|cancelled/);
  expect(run?.status).not.toBe('finished');
});

it('a decision preparation takes no slice capacity, and goes once its decision is accepted (LIVE-16)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture();
  const { f, ws, tx } = fixture;
  // Both decisions are prepared; only LOCAL-ADR-01, which the second slice alone waits on, is
  // accepted. LOCAL-ADR-02's preparation stays: its questions are still the operator's.
  for (const id of DECISIONS) {
    expect((await prepare(fixture, id)).statusCode).toBe(200);
    const p = preparation(fixture, id)!;
    await waitFor(
      () => tx.execution.runs.find(ws, p.runId)?.status === 'finished',
      `${id} prepared`,
    );
  }
  await proposeAndAccept(fixture, 'LOCAL-ADR-01');
  const accepted = preparation(fixture, 'LOCAL-ADR-01')!;
  const open = preparation(fixture, 'LOCAL-ADR-02')!;
  // As on 2026-09-24: both preparation worktrees are still active when the roadmap runs (their
  // removal is held back here, so capacity is tested alone).
  const release = vi
    .spyOn(f.state.context.services.executionService, 'releaseDecisionWorktree')
    .mockResolvedValue(false);
  await roadmapControl(f.state, 'start');
  await f.state.context.services.roadmapService.tick();
  // The slice whose decision is settled starts: a preparation worktree is read-only and never
  // merges, so it holds no place in the repository's capacity.
  const slices = () =>
    tx.execution.worktrees
      .listActive()
      .filter((w) => w.workspaceId === ws && w.executionScope?.kind === 'slice');
  await waitFor(() => slices().length === 1, 'the unblocked slice starts');
  expect(
    f.state.context.services.roadmapService
      .statusList(f.auth, ws, fixture.saved.id)
      .entries.filter((e) => e.state === 'capacity-blocked'),
  ).toEqual([]);
  for (const p of [accepted, open])
    expect(tx.execution.worktrees.find(ws, p.worktreeId)?.status).toBe('active');
  // The accepted decision's preparation is done with: its worktree goes, its brief stays.
  release.mockRestore();
  await f.state.context.services.roadmapService.tick();
  await waitFor(
    () => tx.execution.worktrees.find(ws, accepted.worktreeId)?.status === 'removed',
    'the accepted preparation worktree removed',
  );
  expect(tx.execution.runs.find(ws, accepted.runId)?.outcomeSummary).toContain('LOCAL-ADR-01');
  expect(tx.execution.worktrees.find(ws, open.worktreeId)?.status).toBe('active');
});

/**
 * The live case (WI-05/domain and WI-ADR-009, 2026-09-29): the first slice's merge, not its
 * start, needs LOCAL-ADR-01, so nothing stops it starting; the second waits for the first.
 */
function withMergeDecision(source: ConcurrencySource): ConcurrencySource {
  const decided = withDecisions(source);
  const [first, ...rest] = source.slices;
  return {
    ...decided,
    slices: [
      {
        ...first!,
        merge_requires: [
          ...first!.merge_requires,
          { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
        ],
      },
      ...rest.map((s) => ({
        ...s,
        start_requires: [
          ...s.start_requires,
          { kind: 'slice' as const, id: first!.id, state: 'merged' as const },
        ],
      })),
    ],
  };
}
const startedSlices = ({ ws, tx }: Fixture) =>
  tx.execution.worktrees
    .listActive()
    .filter((w) => w.workspaceId === ws && w.executionScope?.kind === 'slice')
    .map((w) => w.executionScope!.sourceId);

it('a slice whose merge needs a decision with no brief yet starts as before (R-C3b hold)', {
  timeout: 30000,
}, async () => {
  const fixture = await decisionFixture(withMergeDecision);
  const { f, ws, tx } = fixture;
  // A preparation that asked about LOCAL-ADR-01 but wrote no brief: the decision has a card,
  // but nothing ready for the operator to approve.
  f.backend.replyForRequest = () => ({
    resultText:
      '## Open questions\nApprove LOCAL-ADR-01?\n```craftingtable-design\n' +
      JSON.stringify({
        version: 1,
        items: [
          {
            kind: 'operator-decision',
            question: 'Approve LOCAL-ADR-01?',
            answer: '',
            sources: ['Exact imported plan LOCAL-ADR-01'],
          },
        ],
      }) +
      '\n```',
  });
  expect((await prepare(fixture, 'LOCAL-ADR-01')).statusCode).toBe(200);
  const p = preparation(fixture, 'LOCAL-ADR-01')!;
  await waitFor(
    () => tx.execution.runs.find(ws, p.runId)?.status === 'finished',
    'LOCAL-ADR-01 asked about',
  );
  const card = architectureDecisionInbox(
    tx,
    tx.imports.definition(ws, p.definitionId)!,
  ).decisions.find((c) => c.checkpointId === 'LOCAL-ADR-01');
  expect(card?.recommendation).toBeDefined();
  expect(card?.recommendation?.brief).toBeUndefined();
  await roadmapControl(f.state, 'start');
  await f.state.context.services.roadmapService.tick();
  await waitFor(() => startedSlices(fixture).length === 1, 'the first slice starts');
});

it('holds a slice whose merge needs a prepared decision the operator has not approved, and starts it once approved (R-C3b, operator decision 2026-09-29)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture(withMergeDecision);
  const { f, ws, tx, saved } = fixture;
  expect((await prepare(fixture, 'LOCAL-ADR-01')).statusCode).toBe(200);
  const p = preparation(fixture, 'LOCAL-ADR-01')!;
  await waitFor(
    () => tx.execution.runs.find(ws, p.runId)?.status === 'finished',
    'LOCAL-ADR-01 prepared',
  );
  await roadmapControl(f.state, 'start');
  const roadmaps = f.state.context.services.roadmapService;
  await roadmaps.tick();
  await roadmaps.tick();
  // It waits for the operator instead of starting a design that would stop to ask.
  expect(startedSlices(fixture)).toEqual([]);
  const first = storedRoadmap(f.state).definition.entries.find(
    (e) => e.executionScope?.kind === 'slice',
  )!;
  expect(storedRoadmap(f.state).entryWaits?.[first.id]).toMatchObject({
    code: 'phase-blocked',
    refs: { blockers: ['decision-checkpoint-evidence'] },
  });
  expect(storedRoadmap(f.state).entryWaits?.[first.id]?.reason).toContain(
    'LOCAL-ADR-01 has a prepared brief awaiting your approval',
  );
  roadmaps.syncAttention(true);
  const status = roadmaps
    .statusList(f.auth, ws, saved.id)
    .entries.find((e) => e.entryId === first.id);
  // The status list names the operator, at the decision's own inbox item.
  expect(status).toMatchObject({
    actor: 'operator',
    waitsOn: { source: 'attention-item', blockers: ['decision-checkpoint-evidence'] },
  });
  expect(
    tx.attention.open(ws).find((i) => i.id === status?.waitsOn?.attentionItemId)?.subjectKey,
  ).toBe(`roadmap:${saved.id}:checkpoint:LOCAL-ADR-01`);
  // Approved, the slice starts on the next pass.
  await roadmapControl(f.state, 'pause');
  await proposeAndAccept(fixture, 'LOCAL-ADR-01');
  await roadmapControl(f.state, 'resume');
  await roadmaps.tick();
  await waitFor(() => startedSlices(fixture).length === 1, 'the approved slice starts');
});

/** A preparation answer whose brief is the given one. */
function answerWith(
  fixture: Fixture,
  custom: Omit<ReturnType<typeof brief>, 'consumers'> & { consumers: readonly object[] },
) {
  fixture.f.backend.replyForRequest = () => ({
    resultText:
      `## Open questions\nApprove ${custom.checkpointId}?\n\`\`\`craftingtable-design\n` +
      JSON.stringify({
        version: 1,
        items: [
          {
            kind: 'operator-decision',
            question: `Approve ${custom.checkpointId}?`,
            answer: 'Use the documented boundary.',
            sources: [`Exact imported plan ${custom.checkpointId}`],
            decision: custom,
          },
        ],
      }) +
      '\n```',
  });
}
async function prepared1(fixture: Fixture) {
  const { ws, tx } = fixture;
  expect((await prepare(fixture, 'LOCAL-ADR-01')).statusCode).toBe(200);
  const p = preparation(fixture, 'LOCAL-ADR-01')!;
  await waitFor(
    () => tx.execution.runs.find(ws, p.runId)?.status === 'finished',
    'LOCAL-ADR-01 prepared',
  );
  return p;
}
async function startsFirstSlice(fixture: Fixture) {
  await roadmapControl(fixture.f.state, 'start');
  await fixture.f.state.context.services.roadmapService.tick();
  await waitFor(() => startedSlices(fixture).length === 1, 'the first slice starts');
}

it('does not hold a slice on a brief limited to clauses of another slice, which approving would not settle (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture(withMergeDecision);
  const other = fixture.f.scopes[1]!.sourceId;
  answerWith(fixture, {
    ...brief('LOCAL-ADR-01'),
    coverage: 'clauses',
    consumers: [{ sliceId: other, phase: 'merge', replacesFullCheckpoint: false }],
  });
  await prepared1(fixture);
  await startsFirstSlice(fixture);
});

it('does not hold a slice on a brief the operator rejected (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture(withMergeDecision);
  await prepared1(fixture);
  await proposeAndAccept(fixture, 'LOCAL-ADR-01', 'rejected');
  await startsFirstSlice(fixture);
});

it('does not hold a slice on a decision that cannot be approved until later work is done (R-C3b review)', {
  timeout: 45000,
}, async () => {
  // LOCAL-ADR-01 needs LOCAL-ADR-02 accepted first, so its card cannot be approved: holding the
  // slice on it would ask the operator for something they cannot do yet.
  const fixture = await decisionFixture((source) => {
    const decided = withMergeDecision(source);
    return {
      ...decided,
      checkpoints: decided.checkpoints.map((c) =>
        c.id === 'LOCAL-ADR-01'
          ? {
              ...c,
              requires: [
                { kind: 'checkpoint' as const, id: 'LOCAL-ADR-02', state: 'passed' as const },
              ],
            }
          : c,
      ),
    };
  });
  const p = await prepared1(fixture);
  const card = architectureDecisionInbox(
    fixture.tx,
    fixture.tx.imports.definition(fixture.ws, p.definitionId)!,
  ).decisions.find((c) => c.checkpointId === 'LOCAL-ADR-01')!;
  expect(card.recommendation?.brief).toBeDefined();
  expect(card.blockers.length).toBeGreaterThan(0);
  await startsFirstSlice(fixture);
});

it('holds a slice on a brief limited to clauses that names it (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture(withMergeDecision);
  const own = fixture.f.scopes[0]!.sourceId;
  answerWith(fixture, {
    ...brief('LOCAL-ADR-01'),
    coverage: 'clauses',
    consumers: [{ sliceId: own, phase: 'merge', replacesFullCheckpoint: false }],
  });
  await prepared1(fixture);
  await roadmapControl(fixture.f.state, 'start');
  await fixture.f.state.context.services.roadmapService.tick();
  await fixture.f.state.context.services.roadmapService.tick();
  expect(startedSlices(fixture)).toEqual([]);
});

it('keeps holding when the operator rejected another proposal, not the one made from this brief (R-C3b review)', {
  timeout: 45000,
}, async () => {
  const fixture = await decisionFixture(withMergeDecision);
  const { f, ws } = fixture;
  const p = await prepared1(fixture);
  // A proposal written by hand, not from the brief, is rejected.
  const evidence = f.state.context.services.runtimeEvidenceService;
  const proposed = await evidence.proposeArchitectureDecision(f.auth, ws, p.definitionId, {
    bindingRevision: 1,
    checkpointId: 'LOCAL-ADR-01',
    coverage: 'full',
    proposal: 'A different boundary, written by hand.',
    sourceReferences: 'Exact imported plan LOCAL-ADR-01',
    consumers: [],
    retainedObligations: 'Implementation tests remain mandatory.',
  });
  const submission = proposed.submissions.find(
    (x) => x.submission.subject.sourceId === 'LOCAL-ADR-01',
  )!.submission;
  await evidence.decide(f.auth, ws, p.definitionId, {
    submissionId: submission.id,
    outcome: 'rejected',
    rationale: 'Not this one.',
  });
  await roadmapControl(f.state, 'start');
  await f.state.context.services.roadmapService.tick();
  await f.state.context.services.roadmapService.tick();
  expect(startedSlices(fixture)).toEqual([]);
});
