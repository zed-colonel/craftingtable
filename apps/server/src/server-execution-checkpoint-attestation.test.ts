import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  itNeedsCargo,
  mutationHeaders,
  roadmapControl,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';
import { decisionBindingDigest } from './services/architecture-decision-policy.js';
import { workflowContext } from './services/workflow-policy.js';

/**
 * R-C13 (LIVE-07): a checkpoint the controller calls ready is reviewed with every record that
 * made it ready. WI-04/domain's WI-WORKER-G1 required WI-09/domain and WI-10/domain verified;
 * the controller counted their receipts, but the reviewer's evidence packet carried only
 * WI-04's own work items, so each review failed the attestation.
 */

afterEach(cleanupExecutionFixtures);

itNeedsCargo(
  'a checkpoint review is given the receipts and decisions its readiness counted (LIVE-07, LIVE-12)',
  async () => {
    // local/AQ-01/a merges only after LOCAL-REVIEW, which needs another item's slice verified.
    const f = await supervisedMapFixture(true, 'automatic', true, false, false, (source) => ({
      ...source,
      work_items: source.work_items.map((w) =>
        w.id === 'local/AQ-02'
          ? {
              ...w,
              depends_on: [],
              acceptance_requires: [
                { kind: 'slice' as const, id: 'local/AQ-02/a', state: 'verified' as const },
              ],
            }
          : w,
      ),
      checkpoints: [
        ...source.checkpoints.map((c) =>
          c.id === 'LOCAL-TARGET'
            ? {
                ...c,
                requires: [
                  { kind: 'slice' as const, id: 'local/AQ-01/a', state: 'verified' as const },
                  { kind: 'slice' as const, id: 'local/AQ-02/a', state: 'verified' as const },
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
            { kind: 'slice' as const, id: 'local/AQ-02/a', state: 'verified' as const },
            { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
          ],
          decision_refs: [],
          pass_criteria: ['Candidate boundary is sound'],
          evidence_profile: 'scope-review',
        },
        // A decision the checkpoint requires, as WI-WORKER-G1 requires WI-ADR-008 (LIVE-12).
        {
          ...source.checkpoints[0]!,
          id: 'LOCAL-ADR-01',
          kind: 'architecture_decision' as const,
          owner: 'local',
          requires: [],
          decision_refs: [],
          pass_criteria: ['Approve the transport contract.'],
          evidence_profile: 'decision-review',
        },
      ],
      evidence_profiles: [
        ...source.evidence_profiles,
        {
          id: 'decision-review',
          required_evidence: [
            'accepted decision artifact digest and revision',
            'source contract and affected schema or protocol references',
            'decision owner approval and applicability to the active plan generation',
          ],
          reviewer_roles: ['repository-maintainer'],
          independence_required: true as const,
        },
      ],
      slices: source.slices.map((s) =>
        s.id === 'local/AQ-01/a'
          ? {
              ...s,
              mode: 'domain',
              merge_requires: [
                { kind: 'checkpoint' as const, id: 'LOCAL-REVIEW', state: 'passed' as const },
              ],
            }
          : s.id === 'local/AQ-02/a'
            ? { ...s, early_start_exception: true, decision_refs: [] }
            : s,
      ),
    }));
    const tx = f.state.context.storage,
      ws = f.state.workspaceId;

    const original = f.backend.replyForRequest!;
    let packet:
      | {
          checkpoints: { id: string; prerequisites: unknown[]; decisions?: unknown[] }[];
        }
      | undefined;
    let prompt = '';
    f.backend.replyForRequest = async (request) => {
      if (
        request.model === 'review-model' &&
        request.prompt.includes('This is a separate checkpoint review.')
      ) {
        const path = /(\/[^\s`'"]+\/craftingtable-scope-evidence\.json)/.exec(request.prompt)?.[1];
        if (path) packet ??= JSON.parse(readFileSync(path, 'utf8'));
        prompt ||= request.prompt;
      }
      const reply = await original(request);
      // A delegated review answers the controller's workflow contract.
      return request.model === 'review-model'
        ? {
            ...reply,
            resultText:
              '```craftingtable-workflow\n' +
              JSON.stringify({
                version: 1,
                questions: [],
                resolved: [],
                securityReview: { required: false, sources: [] },
              }) +
              '\n```\n' +
              reply.resultText,
          }
        : reply;
    };
    await adoptSupervisedMap(f);
    // The operator accepted LOCAL-ADR-01 in full, as the decision packet records it.
    const definition = tx.imports.definition(ws, f.parentScope.definitionId)!;
    const decisionId = randomUUID();
    tx.runtimeEvidence.addSubmission({
      id: decisionId,
      workspaceId: ws,
      definitionId: definition.id,
      bindingRevision: 1,
      runtimeId: f.runtime.current!.id,
      environmentId: 'local-tests',
      subject: { kind: 'checkpoint', sourceId: 'LOCAL-ADR-01' },
      architectureDecision: {
        kind: 'architecture-decision-v1',
        coverage: 'full',
        proposal: 'Use the stable transport contract for every boundary.',
        sourceReferences: 'source-plan.md §4',
        retainedObligations: '',
        consumers: [],
        bindingDigest: decisionBindingDigest(tx, definition, 1),
      },
      executedBy: 'CraftingTable decision packet collector',
      executedAt: new Date().toISOString(),
      requirements: [],
      reviewers: [],
      cases: [],
      artifacts: [
        {
          name: 'decision-review-packet',
          content: 'Transport contract decision.',
          digest: createHash('sha256').update('Transport contract decision.').digest('hex'),
        },
      ],
      createdAt: new Date().toISOString(),
      createdByUserId: f.state.userId,
    } as never);
    tx.runtimeEvidence.addDecision({
      id: randomUUID(),
      workspaceId: ws,
      submissionId: decisionId,
      outcome: 'accepted',
      rationale: 'Approved.',
      decidedAt: new Date().toISOString(),
      decidedByUserId: f.state.userId,
    } as never);
    // AQ-02 need not wait for AQ-01, as WI-09 need not wait for WI-04: the operator authorizes
    // its slice's early development.
    const producer = tx.imports
      .bindings(ws, f.parentScope.definitionId)[0]!
      .bindings.flatMap((b) => b.workItems)
      .find((w) => w.sourceId === 'local/AQ-02')!.workItemId;
    const early = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/work-items/${producer}/scope-scheduling`,
      headers: mutationHeaders(f.state),
      payload: { scope: { ...f.parentScope, kind: 'slice', sourceId: 'local/AQ-02/a' } },
    });
    expect(early.statusCode, early.body).toBe(200);
    f.service.save(f.auth, ws, f.input);
    await roadmapControl(f.state, 'start');
    await waitFor(() => packet !== undefined, 'the LOCAL-REVIEW checkpoint review', 30000);

    // The receipt that made LOCAL-REVIEW ready is in the packet, from the same evaluation.
    const checkpoint = packet!.checkpoints?.find((c) => c.id === 'LOCAL-REVIEW');
    expect(checkpoint?.prerequisites).toEqual([
      expect.objectContaining({
        kind: 'scope-receipt',
        requirement: { kind: 'slice', id: 'local/AQ-02/a', state: 'verified' },
        receipt: expect.objectContaining({
          scope: expect.objectContaining({ sourceId: 'local/AQ-02/a' }),
        }),
      }),
      expect.objectContaining({ kind: 'accepted-evidence', submissionId: decisionId }),
    ]);
    // The decision itself, not only its ID: the reviewer must review its clauses (LIVE-12).
    expect(checkpoint?.decisions).toEqual([
      expect.objectContaining({
        submissionId: decisionId,
        checkpoint: 'LOCAL-ADR-01',
        decision: expect.objectContaining({
          proposal: 'Use the stable transport contract for every boundary.',
        }),
        approval: expect.objectContaining({ outcome: 'accepted' }),
      }),
    ]);
    const cycle = tx.execution.cycles
      .listForWorkspace(ws)
      .find(
        (c) => c.executionScope?.sourceId === 'local/AQ-01/a' && c.executionScope.kind === 'slice',
      )!;
    const ready = workflowContext(tx, cycle)!.checkpoints.find((c) => c.id === 'LOCAL-REVIEW')!;
    expect(ready.pending).toEqual([]);
    expect(ready.inputs).toEqual([
      expect.stringMatching(/^slice:local\/AQ-02\/a:verified=receipt:/),
      `checkpoint:LOCAL-ADR-01:passed=evidence:${decisionId}`,
    ]);
    // The reviewer's prompt names the same inputs.
    expect(prompt).toContain(ready.inputs[0]!);
  },
);
