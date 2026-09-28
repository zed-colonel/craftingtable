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

/**
 * R-C3b: shared architecture decisions are prepared ahead of the slices that need them, while
 * the roadmap runs, and answered once (ADR-065 amended 2026-09-28).
 */

afterEach(cleanupExecutionFixtures);

const DECISIONS = ['LOCAL-ADR-01', 'LOCAL-ADR-02'] as const;

/** A map whose slices both wait at start on two shared architecture decisions. */
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
    slices: source.slices.map((s) => ({
      ...s,
      start_requires: DECISIONS.map((id) => ({
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
  // A preparation run recommends the checkpoint its brief names.
  f.backend.replyForRequest = (request) => {
    const checkpointId = DECISIONS.find((id) =>
      request.prompt.includes(`decision brief for ${id}`),
    );
    if (!checkpointId) return { resultText: 'Nothing to prepare.' };
    return {
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
  return { f, saved, ws: f.state.workspaceId, tx: f.state.context.storage };
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
  await waitFor(() => tx.execution.runs.listLive().length === 1, 'reserved preparation launch');
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
  await waitFor(() => tx.execution.runs.listLive().length === 1, 'second preparation in flight');
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
