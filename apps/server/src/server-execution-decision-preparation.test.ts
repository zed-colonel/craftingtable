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

async function decisionFixture() {
  const f = await supervisedMapFixture(false, 'automatic', false, false, false, withDecisions);
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

async function proposeAndAccept(fixture: Fixture, checkpointId: string) {
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
    outcome: 'accepted',
    rationale: 'Approved.',
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
