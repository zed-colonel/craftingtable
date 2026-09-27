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
import { workflowContext } from './services/workflow-policy.js';

/**
 * R-C13 (LIVE-07): a checkpoint the controller calls ready is reviewed with every record that
 * made it ready. WI-04/domain's WI-WORKER-G1 required WI-09/domain and WI-10/domain verified;
 * the controller counted their receipts, but the reviewer's evidence packet carried only
 * WI-04's own work items, so each review failed the attestation.
 */

afterEach(cleanupExecutionFixtures);

itNeedsCargo(
  'a checkpoint review is given the producing-slice receipts its readiness counted (LIVE-07)',
  { timeout: 45000 },
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
          requires: [{ kind: 'slice' as const, id: 'local/AQ-02/a', state: 'verified' as const }],
          decision_refs: [],
          pass_criteria: ['Candidate boundary is sound'],
          evidence_profile: 'scope-review',
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
    let packet: { checkpoints: { id: string; prerequisites: { kind: string }[] }[] } | undefined;
    let prompt = '';
    f.backend.replyForRequest = (request) => {
      if (
        request.model === 'review-model' &&
        request.prompt.includes('This is a separate checkpoint review.')
      ) {
        const path = /(\/[^\s`'"]+\/craftingtable-scope-evidence\.json)/.exec(request.prompt)?.[1];
        if (path) packet ??= JSON.parse(readFileSync(path, 'utf8'));
        prompt ||= request.prompt;
      }
      const reply = original(request);
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
    ]);
    // The reviewer's prompt names the same inputs.
    expect(prompt).toContain(ready.inputs[0]!);
  },
);
