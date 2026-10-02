import { afterEach, expect } from 'vitest';
import type { ConcurrencySource, WorkCycle } from '@craftingtable/domain';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  commitFile,
  configureLocalRuntime,
  controlCycle,
  designDone,
  implementationDone,
  itNeedsCargo,
  mutationHeaders,
  roadmapControl,
  roadmapInput,
  runScopedFixtureCheck,
  saveRoadmapRequest,
  scopeReport,
  slicedFixture,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';
import { architectureDecisionInbox } from './services/architecture-decision-inbox.js';

/**
 * LIVE-18: a slice whose merge needs shared architecture decisions stops once for all of them,
 * names every one, and is not resumed into another review until each is settled.
 */

afterEach(cleanupExecutionFixtures);

const DECISIONS = ['LOCAL-ADR-01', 'LOCAL-ADR-02'] as const;

/** The first slice's merge needs two shared architecture decisions, as EXO-18's needed four. */
function withMergeDecisions(source: ConcurrencySource): ConcurrencySource {
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
    slices: source.slices.map((s, i) =>
      i
        ? s
        : {
            ...s,
            mode: 'domain',
            merge_requires: DECISIONS.map((id) => ({
              kind: 'checkpoint' as const,
              id,
              state: 'passed' as const,
            })),
          },
    ),
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

function workflowReport(text: string, questions: readonly object[] = []) {
  return (
    '```craftingtable-workflow\n' +
    JSON.stringify({
      version: 1,
      questions,
      resolved: [],
      securityReview: { required: false, sources: [] },
    }) +
    '\n```\n' +
    text
  );
}

async function fixture(map: (source: ConcurrencySource) => ConcurrencySource = withMergeDecisions) {
  const f = await supervisedMapFixture(true, 'automatic', false, false, false, map);
  const original = f.backend.replyForRequest!;
  // Slices run through the scripted cycle; a preparation recommends the checkpoint it names.
  f.backend.replyForRequest = async (request) => {
    const checkpointId = DECISIONS.find((id) =>
      request.prompt.includes(`decision brief for ${id}`),
    );
    if (checkpointId)
      return {
        resultText:
          `## Open questions\nApprove ${checkpointId}?\n\`\`\`craftingtable-design\n` +
          JSON.stringify({
            version: 1,
            items: [
              {
                kind: 'operator-decision',
                question: `Approve ${checkpointId}?`,
                answer: '',
                checkpointId,
                sources: [`Exact imported plan ${checkpointId}`],
                decision: brief(checkpointId),
              },
            ],
          }) +
          '\n```',
      };
    const reply = await original(request);
    return request.model === 'review-model'
      ? { ...reply, resultText: workflowReport(reply.resultText!) }
      : reply;
  };
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, f.state.workspaceId, f.input).roadmap;
  return { f, saved, ws: f.state.workspaceId, tx: f.state.context.storage };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const stopped = ({ tx, ws }: Fixture) =>
  tx.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'slice' && c.status === 'needs-attention');
const reviews = ({ f }: Fixture) =>
  f.backend.launches.filter((r) => r.model === 'review-model').length;

function resume({ f }: Fixture, cycle: WorkCycle, guidance?: string) {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(f.state),
    payload: {
      action: 'resume',
      expectedVersion: cycle.version,
      ...(guidance === undefined ? {} : { instructions: guidance }),
    },
  });
}

async function prepareAndAccept(fx: Fixture, checkpointId: string) {
  const { f, saved, ws, tx } = fx;
  const prepared = await f.state.context.app.inject({
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
  expect(prepared.statusCode, prepared.body).toBe(200);
  const p = storedRoadmap(f.state).decisionPreparations!.findLast(
    (x) => x.checkpointId === checkpointId,
  )!;
  await waitFor(
    () => tx.execution.runs.find(ws, p.runId)?.status === 'finished',
    `the ${checkpointId} preparation`,
  );
  const definition = tx.imports.definition(ws, p.definitionId)!;
  const card = architectureDecisionInbox(tx, definition).decisions.find(
    (c) => c.checkpointId === checkpointId,
  )!;
  const svc = f.state.context.services.runtimeEvidenceService;
  const proposed = await svc.proposeArchitectureDecision(f.auth, ws, p.definitionId, {
    bindingRevision: 1,
    checkpointId,
    sourceRunId: p.runId,
    sourceReportDigest: card.recommendation!.sourceReportDigest,
    coverage: 'full',
    proposal: brief(checkpointId).decisionText,
    sourceReferences: card.sourceReferences,
    consumers: [],
    retainedObligations: brief(checkpointId).retainedObligations,
  });
  const submission = proposed.submissions.find(
    (s) => s.submission.subject.sourceId === checkpointId,
  )!.submission;
  await svc.decide(f.auth, ws, p.definitionId, {
    submissionId: submission.id,
    outcome: 'accepted',
    rationale: 'Approved.',
  });
}

itNeedsCargo(
  'names every unsettled merge decision and refuses resumes until each is approved (LIVE-18)',
  async () => {
    const fx = await fixture();
    const { f, tx, ws } = fx;
    await roadmapControl(f.state, 'start');
    await waitFor(() => !!stopped(fx), 'the shared-decision stop');
    let cycle = stopped(fx)!;
    expect(cycle.attention?.code).toBe('shared-decision-required');
    // One stop for both decisions, not one after the other.
    expect(cycle.reason).toContain('LOCAL-ADR-01');
    expect(cycle.reason).toContain('LOCAL-ADR-02');
    expect(cycle.workflow?.questions.map((q) => q.checkpointId)).toEqual([...DECISIONS]);
    const reviewed = reviews(fx);
    // Each decision the stop names has a card, brief or not, saying which slice waits on it.
    const definition = tx.imports.definition(ws, cycle.executionScope!.definitionId)!;
    const cards = architectureDecisionInbox(tx, definition).decisions;
    expect(cards.map((c) => [c.checkpointId, c.stoppedSlices, !!c.recommendation])).toEqual(
      DECISIONS.map((id) => [id, [cycle.executionScope!.sourceId], false]),
    );

    // The cycle as read carries what it waits on, so the panel offers the decisions instead.
    const listed = async () =>
      (
        await f.state.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ws}/cycles`,
          headers: { cookie: f.state.cookie },
        })
      )
        .json()
        .cycles.find((c: WorkCycle) => c.id === cycle.id) as WorkCycle;
    expect((await listed()).unsettledDecisions).toEqual([...DECISIONS]);
    // The stop's inbox item opens the roadmap's decision cards.
    const item = tx.attention
      .open(ws)
      .find((i) => i.subjectKey === `cycle:${cycle.id}` && i.code === 'shared-decision-required');
    const roadmapId = cycle.owner!.roadmapId;
    expect(item?.path).toBe(
      `/workspaces/${ws}/roadmaps/${roadmapId}/setup#runtime-evidence-roadmap-${roadmapId}-decisions`,
    );
    // Plain and guided resumes would only review again into the same gate.
    for (const guidance of [undefined, 'Continue.']) {
      const refused = await resume(fx, cycle, guidance);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.message).toContain('LOCAL-ADR-01, LOCAL-ADR-02');
    }
    // A roadmap pause and resume leaves the stop in place and launches nothing.
    await roadmapControl(f.state, 'pause');
    await roadmapControl(f.state, 'resume');
    await roadmapControl(f.state, 'pause');
    expect(stopped(fx)?.id).toBe(cycle.id);
    expect(reviews(fx)).toBe(reviewed);

    // Approving one still leaves the other.
    await prepareAndAccept(fx, 'LOCAL-ADR-01');
    cycle = tx.execution.cycles.find(ws, cycle.id)!;
    const still = await resume(fx, cycle);
    expect(still.statusCode, still.body).toBe(409);
    expect(still.json().error.message).toContain('LOCAL-ADR-02');
    expect(still.json().error.message).not.toContain('LOCAL-ADR-01');

    // Once both are settled, one resume carries the cycle on.
    await prepareAndAccept(fx, 'LOCAL-ADR-02');
    cycle = tx.execution.cycles.find(ws, cycle.id)!;
    expect((await listed()).unsettledDecisions).toBeUndefined();
    const accepted = await resume(fx, cycle);
    expect(accepted.statusCode, accepted.body).toBe(200);
  },
);

/** Only the checkpoints: no slice's merge requires them. */
function withDecisionCheckpoints(source: ConcurrencySource): ConcurrencySource {
  const all = withMergeDecisions(source);
  return { ...all, slices: source.slices };
}

itNeedsCargo.each([
  ['its merge still needs the decision', withMergeDecisions],
  ['the reviewer asked about a decision the merge does not need', withDecisionCheckpoints],
] as const)(
  'a sequential roadmap resumes past a paused shared-decision stop and leaves it in place when %s (LIVE-18)',
  async (_case, map) => {
    // A single-project roadmap runs in sequence: a cycle whose resume is refused would fail the
    // whole roadmap's resume, so the roadmap must skip it instead. That holds too once nothing
    // is unsettled, while the reviewer's open questions still need Continue with guidance.
    const f = await slicedFixture(map);
    configureLocalRuntime(f.auth, f.state, f.scopes[0]!.definitionId);
    const tx = f.state.context.storage;
    f.backend.replyForRequest = async (request) => {
      if (request.model === 'design-model') return designDone;
      if (request.model !== 'review-model') {
        commitFile(request.cwd, 'change.txt', 'A change the review accepts');
        return implementationDone;
      }
      await runScopedFixtureCheck(request);
      const tree = tx.execution.worktrees
        .listActive(f.state.workspaceId)
        .find((t) => t.path === request.cwd)!;
      // Without a delegated roadmap the reviewer, not the workflow gate, raises the stop.
      return {
        resultText: workflowReport(
          `## Open questions\nApprove LOCAL-ADR-01?\n\n## Review report\n${scopeReport(f.state, tree.executionScope!)}`,
          [
            {
              question: 'Approve LOCAL-ADR-01?',
              destination: 'shared-decision',
              checkpointId: 'LOCAL-ADR-01',
            },
          ],
        ),
      };
    };
    const [entry] = roadmapInput(f.state, [f.state.workItemId]).entries;
    const saved = await saveRoadmapRequest(f.state, {
      expectedVersion: 0,
      name: 'Slice roadmap',
      entries: [{ ...entry, executionScope: f.scopes[0] }],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await roadmapControl(f.state, 'start');
    const slice = () =>
      tx.execution.cycles
        .listForWorkspace(f.state.workspaceId)
        .find((c) => c.executionScope?.kind === 'slice');
    await waitFor(
      () => slice()?.attention?.code === 'shared-decision-required',
      'the shared-decision stop',
    );
    const reviewed = f.backend.launches.filter((r) => r.model === 'review-model').length;
    // Its slices come from one map, so the roadmap's setup shows that map's decisions.
    const roadmapId = storedRoadmap(f.state).id;
    expect(
      tx.attention.open(f.state.workspaceId).find((i) => i.subjectKey === `cycle:${slice()!.id}`)
        ?.path,
    ).toBe(
      `/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/setup#runtime-evidence-roadmap-${roadmapId}-decisions`,
    );
    // A pause taken at the stop keeps its code.
    await controlCycle(f.state, slice()!, 'pause');
    await roadmapControl(f.state, 'pause');
    await roadmapControl(f.state, 'resume');
    expect(slice()?.status).toBe('paused');
    expect(slice()?.attention?.code).toBe('shared-decision-required');
    expect(f.backend.launches.filter((r) => r.model === 'review-model')).toHaveLength(reviewed);
  },
);

itNeedsCargo(
  'lets a resume through to the review that produces a decision prerequisite (LIVE-18 review)',
  async () => {
    // LOCAL-ADR-02 requires LOCAL-REVIEW, a checkpoint only this slice's workflow review can
    // produce once LOCAL-ADR-01 is approved. Refusing the resume until LOCAL-ADR-02 is approved
    // would leave nothing to do but stop.
    const fx = await fixture((source) => {
      const withBoth = withMergeDecisions(source);
      return {
        ...withBoth,
        checkpoints: [
          ...withBoth.checkpoints.map((c) =>
            c.id === 'LOCAL-ADR-02'
              ? {
                  ...c,
                  requires: [
                    { kind: 'checkpoint' as const, id: 'LOCAL-REVIEW', state: 'passed' as const },
                  ],
                }
              : c,
          ),
          {
            ...source.checkpoints[0]!,
            id: 'LOCAL-REVIEW',
            kind: 'profile' as const,
            owner: 'local',
            requires: [
              { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
            ],
          },
        ],
        slices: withBoth.slices.map((s, i) =>
          i
            ? s
            : {
                ...s,
                merge_requires: [
                  ...s.merge_requires,
                  { kind: 'checkpoint' as const, id: 'LOCAL-REVIEW', state: 'passed' as const },
                ],
              },
        ),
      };
    });
    const { f, tx, ws } = fx;
    await roadmapControl(f.state, 'start');
    await waitFor(() => !!stopped(fx), 'the shared-decision stop');
    let cycle = stopped(fx)!;
    expect(cycle.attention?.code).toBe('shared-decision-required');
    // LOCAL-ADR-02 is named, but only LOCAL-ADR-01 can be approved now.
    expect(cycle.reason).toContain('LOCAL-ADR-02');
    await roadmapControl(f.state, 'pause');
    await prepareAndAccept(fx, 'LOCAL-ADR-01');
    cycle = tx.execution.cycles.find(ws, cycle.id)!;
    const resumed = await resume(fx, cycle);
    expect(resumed.statusCode, resumed.body).toBe(200);
  },
);
