import { randomUUID } from 'node:crypto';
import type { ConcurrencySource } from '@craftingtable/domain';
import { observeDecodes } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { resolveScope, scopeEvidenceLedger } from '../src/services/execution-scope.js';
import { savedPlanSnapshot } from '../src/services/plan-acceptance-policy.js';
import {
  acceptedEvidence,
  activeRuntime,
  prerequisiteIssues,
} from '../src/services/runtime-evidence-policy.js';
import { runtimeRefreshImpact } from '../src/services/runtime-refresh.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  supervisedMapFixture,
} from './execution-test-support.js';

/**
 * R-H4: evidence is read through heads. The roadmap view, the cross-project preview, a scope's
 * evidence ledger and an acceptance check decode each head at most once, and full records only
 * where their contents are carried or digested: a staged decision in the saved plan's facts, and
 * accepted evidence in a ledger (operator decision 2026-10-07, done-when b restated).
 */

afterEach(cleanupExecutionFixtures);

const DECISION = 'LOCAL-ADR-01';

/** Every slice waits at start on one shared architecture decision. */
function withDecision(source: ConcurrencySource): ConcurrencySource {
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
    slices: source.slices.map((s) => ({
      ...s,
      start_requires: [{ kind: 'checkpoint' as const, id: DECISION, state: 'passed' as const }],
    })),
  };
}

/**
 * A saved cross-project roadmap whose map has a clause-staged decision accepted for its first
 * slice, a rejected proposal, and accepted plan evidence.
 */
async function stagedFixture() {
  const f = await supervisedMapFixture(false, 'automatic', false, true, false, withDecision);
  await adoptSupervisedMap(f);
  const { context, workspaceId: ws } = f.state;
  const storage = context.storage,
    svc = context.services.runtimeEvidenceService,
    id = f.parentScope.definitionId;
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  const propose = async (proposal: string) => {
    await svc.proposeArchitectureDecision(f.auth, ws, id, {
      bindingRevision: 1,
      checkpointId: DECISION,
      coverage: 'clauses',
      proposal,
      sourceReferences: `Exact imported plan ${DECISION}`,
      consumers: [{ sliceId: f.scopes[0]!.sourceId, phase: 'start', replacesFullCheckpoint: true }],
      retainedObligations: 'Implementation tests remain mandatory.',
    });
    return storage.runtimeEvidence.submissions(ws, id)[0]!.id;
  };
  const rejected = await propose('A shared mutable boundary.');
  await svc.decide(f.auth, ws, id, {
    submissionId: rejected,
    outcome: 'rejected',
    rationale: 'Not this boundary.',
  });
  const staged = await propose('Use the documented boundary.');
  await svc.decide(f.auth, ws, id, {
    submissionId: staged,
    outcome: 'accepted',
    rationale: 'Settled for the first slice.',
  });
  const ready = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  const generated = await svc.generatePlanEvidence(f.auth, ws, id, {
    roadmapId: saved.id,
    definitionRevision: ready.definitionRevision,
    snapshotDigest: ready.snapshotDigest,
  });
  const plan = generated.submissions.find((s) => s.submission.generatedPlan)!.submission.id;
  await svc.decide(f.auth, ws, id, {
    submissionId: plan,
    outcome: 'accepted',
    rationale: 'I reviewed the exact saved plan as stack-integration-owner.',
  });
  return { f, ws, id, storage, saved, staged, plan };
}

/** What a synchronous read decodes: how often each head, and which full records. */
function decodesOf(read: () => unknown) {
  const heads = new Map<string, number>();
  const records: string[] = [];
  observeDecodes((kind, _bytes, record) => {
    const id = (record as { id: string }).id;
    if (kind === 'evidence-submission-head') heads.set(id, (heads.get(id) ?? 0) + 1);
    if (kind === 'evidence-submission') records.push(id);
  }, read);
  return { heads, records };
}

it('reads each head at most once per view, ledger or acceptance check, and full records only where carried (R-H4)', async () => {
  const { f, ws, id, storage, saved, staged, plan } = await stagedFixture();
  const all = storage.runtimeEvidence.submissions(ws, id).map((s) => s.id);
  expect(all).toHaveLength(3);
  const reads = {
    'roadmap view': () => f.state.context.services.roadmapService.page(f.auth, ws, saved.id),
    'cross-project preview': () => f.service.view(f.auth, ws, f.input.configuration),
    ledger: () =>
      scopeEvidenceLedger(storage, resolveScope(storage, ws, f.state.workItemId, f.scopes[0]!)),
    'acceptance check': () =>
      acceptedEvidence(storage, ws, id, 1, { kind: 'checkpoint', sourceId: 'STACK-PLAN-ACCEPTED' }),
    'prerequisite check': () =>
      prerequisiteIssues(storage, storage.imports.definition(ws, id)!, 1, {
        kind: 'slice',
        sourceId: f.scopes[0]!.sourceId,
      }),
  };
  for (const [name, read] of Object.entries(reads)) {
    const { heads, records } = decodesOf(read);
    expect(heads.size, name).toBeGreaterThan(0);
    expect(
      [...heads].filter(([, count]) => count > 1),
      `${name} decodes a head more than once`,
    ).toEqual([]);
    // The full records these reads need: the staged decision, for the saved plan's facts, and
    // in a ledger the accepted evidence it carries.
    for (const record of records)
      expect([staged, ...(name === 'ledger' ? [plan] : [])], name).toContain(record);
  }
  // A ledger carries accepted evidence as full records, contents included.
  const ledger = scopeEvidenceLedger(
    storage,
    resolveScope(storage, ws, f.state.workItemId, f.scopes[0]!),
  );
  expect(ledger.acceptedExternalEvidence).toEqual([
    storage.runtimeEvidence.submission(ws, id, plan),
  ]);
  expect(
    ledger.acceptedExternalEvidence[0]?.artifacts.every((a) => typeof a.content === 'string'),
  ).toBe(true);
});

it("digests a saved plan's staged decisions as their full records (R-H4)", async () => {
  const { ws, id, storage, saved, staged } = await stagedFixture();
  const d = storage.imports.definition(ws, id)!;
  const facts = savedPlanSnapshot(
    storage,
    d,
    storage.roadmaps.find(ws, saved.id)!,
    activeRuntime(storage, ws, id, 1),
  ).facts as { architectureStaging?: unknown[] };
  const record = storage.runtimeEvidence.submission(ws, id, staged)!;
  expect(record.artifacts.length).toBeGreaterThan(0);
  expect(record.artifacts.every((a) => typeof a.content === 'string')).toBe(true);
  expect(facts.architectureStaging).toEqual([record]);
});

it('previews a runtime refresh over accepted plan evidence with a staged decision (R-H4)', async () => {
  const { ws, id, storage, plan } = await stagedFixture();
  const d = storage.imports.definition(ws, id)!;
  const current = activeRuntime(storage, ws, id, 1)!;
  const impact = runtimeRefreshImpact(storage, d, {
    ...current,
    id: randomUUID(),
    generation: current.generation + 1,
  });
  expect(impact.evidence.some((e) => e.id === plan)).toBe(true);
});
