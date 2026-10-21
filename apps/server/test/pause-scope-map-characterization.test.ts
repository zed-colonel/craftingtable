import { afterEach, expect, it } from 'vitest';
import {
  asAgentRunId,
  asCheckpointId,
  type AgentRunId,
  type ConcurrencySource,
  type Roadmap,
  type RoadmapStatus,
} from '@craftingtable/domain';
import { architectureDecisionInbox } from '../src/services/architecture-decision-inbox.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  mutationHeaders,
  scopeTree,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

/**
 * R-B6 characterization (step 2): the map-wide refusals, as they were before scoping, and how each
 * was scoped. A dependency refresh still refuses while the map's roadmap runs and while work on
 * the map is live (decision 7). Host capacity (increment 1, decision 9), delegation (increment 2,
 * decision 2) and approving a shared decision (increment 3, decision 6) no longer wait for a
 * pause; approval waits only for the work in flight on the trees whose packet it changes. The
 * roadmap's status is written by hand.
 */

afterEach(cleanupExecutionFixtures);

const DECISION = 'LOCAL-ADR-01';

/** The first slice's merge waits on one shared architecture decision; the second's does not. */
function withMergeDecision(source: ConcurrencySource): ConcurrencySource {
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
      {
        ...source.checkpoints[0]!,
        id: DECISION,
        owner: 'local',
        kind: 'architecture_decision' as const,
        evidence_profile: 'architecture-approval',
        requires: [],
      },
    ],
    slices: source.slices.map((s, index) =>
      index === 0
        ? {
            ...s,
            merge_requires: [
              { kind: 'checkpoint' as const, id: DECISION, state: 'passed' as const },
            ],
          }
        : s,
    ),
  };
}

const brief = {
  checkpointId: DECISION,
  decisionText: 'Use the documented boundary.',
  why: 'The plan requires separation.',
  alternatives: [{ option: 'Shared mutable boundary', tradeoff: 'Weaker isolation' }],
  consequences: 'Test isolation later.',
  coverage: 'full',
  consumers: [],
  retainedObligations: 'Implementation tests remain mandatory.',
};

async function fixture() {
  const f = await supervisedMapFixture(true, 'automatic', false, false, false, withMergeDecision);
  f.backend.replyForRequest = (request) =>
    request.prompt.includes(`decision brief for ${DECISION}`)
      ? {
          resultText:
            `## Open questions\nApprove ${DECISION}?\n\`\`\`craftingtable-design\n` +
            JSON.stringify({
              version: 1,
              items: [
                {
                  kind: 'operator-decision',
                  question: `Approve ${DECISION}?`,
                  answer: 'Use the documented boundary.',
                  sources: [`Exact imported plan ${DECISION}`],
                  decision: brief,
                },
              ],
            }) +
            '\n```',
        }
      : { resultText: 'Working.\n\n## Open questions\nnone' };
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, f.state.workspaceId, f.input).roadmap;
  return {
    f,
    saved,
    ws: f.state.workspaceId,
    tx: f.state.context.storage,
    id: f.parentScope.definitionId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function setStatus({ f, tx }: Fixture, status: RoadmapStatus) {
  const roadmap: Roadmap = storedRoadmap(f.state);
  tx.roadmaps.save({ ...roadmap, status, version: roadmap.version + 1 }, roadmap.version);
}

/** A decision proposal saved from a finished preparation, ready for the operator's decision. */
async function proposal(fx: Fixture) {
  const { f, saved, ws, tx, id } = fx;
  const prepared = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${saved.id}/prepare-decision`,
    headers: mutationHeaders(f.state),
    payload: {
      expectedVersion: storedRoadmap(f.state).version,
      checkpointId: DECISION,
      profile: { backend: 'claude-code', model: 'decision-model' },
      minutes: 5,
      instructions: '',
    },
  });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const preparation = storedRoadmap(f.state).decisionPreparations!.at(-1)!;
  await waitFor(
    () => tx.execution.runs.find(ws, preparation.runId)?.status === 'finished',
    'the preparation finishes',
  );
  const card = architectureDecisionInbox(tx, tx.imports.definition(ws, id)!).decisions.find(
    (c) => c.checkpointId === DECISION,
  )!;
  const proposed =
    await f.state.context.services.runtimeEvidenceService.proposeArchitectureDecision(
      f.auth,
      ws,
      id,
      {
        bindingRevision: 1,
        checkpointId: asCheckpointId(DECISION),
        sourceRunId: preparation.runId,
        sourceReportDigest: card.recommendation!.sourceReportDigest,
        coverage: 'full',
        proposal: brief.decisionText,
        sourceReferences: card.sourceReferences,
        consumers: [],
        retainedObligations: brief.retainedObligations,
      },
    );
  return proposed.submissions.find((s) => s.submission.subject.sourceId === DECISION)!.submission;
}

function decide(fx: Fixture, submissionId: string, outcome: 'accepted' | 'rejected') {
  return fx.f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fx.ws}/concurrency-definitions/${fx.id}/runtime/decide`,
    headers: mutationHeaders(fx.f.state),
    payload: { submissionId, outcome, rationale: 'Characterized.' },
  });
}

/** A run left live (waiting after its turn) in a worktree of one of the map's slices. */
async function liveRunOnTheMap(fx: Fixture, slice = 0) {
  const tree = await scopeTree(fx.f, fx.f.scopes[slice]!);
  const started = await fx.f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fx.ws}/work-items/${fx.f.state.workItemId}/runs`,
    headers: mutationHeaders(fx.f.state),
    payload: { worktreeId: tree.id, role: 'design' },
  });
  expect(started.statusCode, started.body).toBe(200);
  const runId = asAgentRunId(started.json().run.id);
  await waitFor(
    () => fx.tx.execution.runs.find(fx.ws, runId)?.status === 'waiting',
    'the run waits after its turn',
  );
  return { tree, runId };
}

async function endRun(fx: Fixture, runId: AgentRunId) {
  await fx.f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fx.ws}/runs/${runId}/control`,
    headers: mutationHeaders(fx.f.state),
    payload: { action: 'end' },
  });
  await waitFor(
    () => fx.tx.execution.runs.find(fx.ws, runId)?.status === 'finished',
    'the run finishes',
  );
}

const inboxBlockers = ({ tx, ws, id }: Fixture) =>
  architectureDecisionInbox(tx, tx.imports.definition(ws, id)!).blockers;

it('approving an architecture decision beside a running roadmap waits only for the work in flight on the trees it is an input of (R-B6, decision 6)', async () => {
  const fx = await fixture();
  const submission = await proposal(fx);
  setStatus(fx, 'running');
  const waits = () =>
    architectureDecisionInbox(fx.tx, fx.tx.imports.definition(fx.ws, fx.id)!)
      .decisions.find((c) => c.checkpointId === DECISION)!
      .records.find((r) => r.id === submission.id)!.waits;
  expect(inboxBlockers(fx)).toEqual([]);
  expect(waits()).toEqual([]);
  // A live run on the second slice, which does not use the decision, holds nothing.
  const unaffected = await liveRunOnTheMap(fx, 1);
  expect(waits()).toEqual([]);
  // A live run on the first slice, whose merge requires it, holds the approval.
  const affected = await liveRunOnTheMap(fx, 0);
  const message = `Wait for the live run on ${affected.tree.branchName} to finish, or end the run: this decision is one of its inputs.`;
  expect(waits()).toEqual([message]);
  expect(inboxBlockers(fx)).toEqual([]);
  const live = await decide(fx, submission.id, 'accepted');
  expect(live.statusCode, live.body).toBe(409);
  expect(live.json().error.message).toBe(message);
  expect(fx.tx.runtimeEvidence.decisions(fx.ws)).toEqual([]);
  await endRun(fx, affected.runId);
  expect(waits()).toEqual([]);
  const accepted = await decide(fx, submission.id, 'accepted');
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(fx.tx.runtimeEvidence.decisions(fx.ws).map((d) => d.outcome)).toEqual(['accepted']);
  expect(storedRoadmap(fx.f.state).status).toBe('running');
  await endRun(fx, unaffected.runId);
});

it('rejecting an architecture decision proposal is allowed while the roadmap runs', async () => {
  const fx = await fixture();
  const submission = await proposal(fx);
  setStatus(fx, 'running');
  const rejected = await decide(fx, submission.id, 'rejected');
  expect(rejected.statusCode, rejected.body).toBe(200);
  expect(fx.tx.runtimeEvidence.decisions(fx.ws).map((d) => d.outcome)).toEqual(['rejected']);
});

it('a dependency refresh: its preview is blocked while the map’s roadmap runs and while a run on the map is live', async () => {
  const fx = await fixture();
  const preview = () =>
    fx.f.state.context.services.runtimeEvidenceService.previewRefresh(fx.f.auth, fx.ws, fx.id, {
      bindingRevision: 1,
      expectedGeneration: 1,
    });
  // The fixture's environment pins nothing, so a preview always also finds the pins current.
  const current =
    'Dependency pins are already current. No new generation is needed; review plan acceptance instead.';
  expect((await preview()).blockers).toEqual([current]);
  setStatus(fx, 'running');
  expect((await preview()).blockers).toEqual([
    'Pause roadmap scheduling before refreshing dependencies.',
    current,
  ]);
  setStatus(fx, 'paused');
  const { tree, runId } = await liveRunOnTheMap(fx);
  // The live run also holds its phase reservation.
  expect((await preview()).blockers).toEqual([
    `Wait for or end the live session in ${tree.branchName}.`,
    'Wait for the current phase reservations to be released.',
    current,
  ]);
  await endRun(fx, runId);
  expect((await preview()).blockers).toEqual([current]);
});

it('delegation: granted beside a running roadmap and a live run on the map that reads no grant (R-B6, decision 2)', async () => {
  const fx = await fixture();
  setStatus(fx, 'running');
  const grant = () =>
    fx.f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${fx.ws}/roadmaps/${fx.saved.id}/delegation`,
      headers: mutationHeaders(fx.f.state),
      payload: {
        expectedVersion: storedRoadmap(fx.f.state).version,
        entryIds: [fx.saved.definition.entries[0]!.id],
        automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
        reviewerRoles: ['repository-maintainer'],
        rationale: 'Characterize the grant.',
      },
    });
  // Before R-B6 any live run in the workspace held a grant on a paused roadmap.
  const { runId } = await liveRunOnTheMap(fx);
  const granted = await grant();
  expect(granted.statusCode, granted.body).toBe(200);
  expect(storedRoadmap(fx.f.state).delegationAssignments).toHaveLength(1);
  expect(storedRoadmap(fx.f.state).status).toBe('running');
  await endRun(fx, runId);
});

it('host capacity: saved while a roadmap runs (R-B6, decision 9)', async () => {
  const fx = await fixture();
  const save = () =>
    fx.f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${fx.ws}/host-scheduling`,
      headers: mutationHeaders(fx.f.state),
      payload: {
        expectedVersion: fx.tx.phaseScheduling.setting('local-verification').version,
        verificationCapacity: 3,
        expectedDevelopmentVersion: fx.tx.phaseScheduling.setting('local-development').version,
        developmentCapacity: 3,
      },
    });
  setStatus(fx, 'running');
  const saved = await save();
  expect(saved.statusCode, saved.body).toBe(200);
  expect(fx.tx.phaseScheduling.capacity('local-verification')).toBe(3);
  expect(storedRoadmap(fx.f.state).status).toBe('running');
});
