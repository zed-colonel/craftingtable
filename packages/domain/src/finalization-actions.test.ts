import { expect, it } from 'vitest';
import { currentPlanChanges, finalizationActions } from './finalization-actions.js';

const staged = { status: 'active' as const, stages: [{ kind: 'simplification' }] } as never;
const progress = (status: string, obligations: object[] = []) =>
  ({ stageIndex: 0, stages: [{ status }], obligations }) as never;
const proposal = (runId: string) => ({
  id: 'OB-1',
  status: 'change-requested',
  proposedRequirement: 'Narrower requirement.',
  runId,
});
const base = { mergeRecoveryPending: false, checkpointFindings: 0, canAuthorizeRemediation: false };

it('offers the decisions a staged finalization can be given now, one rule for command and page (R-A6 2b)', () => {
  // Approved by the final review: the promotion; a running cycle offers nothing else.
  expect(
    finalizationActions({
      ...base,
      finalization: staged,
      cycle: { status: 'awaiting-merge', polishPhase: 'final-review' } as never,
    }),
  ).toEqual(['merge']);
  expect(
    finalizationActions({ ...base, finalization: staged, cycle: { status: 'running' } as never }),
  ).toEqual([]);
  // Awaiting merge in an earlier phase is not a promotion.
  expect(
    finalizationActions({
      ...base,
      finalization: staged,
      cycle: { status: 'awaiting-merge', polishPhase: 'stage-review' } as never,
    }),
  ).toEqual([]);
  // A reserved promotion is recovered before anything else.
  expect(
    finalizationActions({
      ...base,
      mergeRecoveryPending: true,
      finalization: staged,
      cycle: { status: 'needs-attention' } as never,
    }),
  ).toEqual(['merge']);
  // A stage selecting its batch, or a plan adjustment proposed (which comes first).
  expect(
    finalizationActions({
      ...base,
      finalization: staged,
      cycle: { status: 'needs-attention', finalizationProgress: progress('selecting') } as never,
    }),
  ).toEqual(['select-stage-findings', 'resume']);
  expect(
    finalizationActions({
      ...base,
      finalization: staged,
      cycle: {
        status: 'needs-attention',
        currentRunId: 'run-2',
        finalizationProgress: progress('selecting', [proposal('run-2')]),
      } as never,
    }),
  ).toEqual(['approve-plan-change', 'resume']);
  // An earlier review's proposal, kept because a later report did not mention it, cannot be
  // approved: the stage's batch is selected instead (R-A6 2b review).
  expect(
    finalizationActions({
      ...base,
      finalization: staged,
      cycle: {
        status: 'needs-attention',
        currentRunId: 'run-2',
        finalizationProgress: progress('selecting', [proposal('run-1')]),
      } as never,
    }),
  ).toEqual(['select-stage-findings', 'resume']);
  // A checkpoint with findings, and attempts where the daemon allows them.
  expect(
    finalizationActions({
      ...base,
      checkpointFindings: 2,
      canAuthorizeRemediation: true,
      finalization: staged,
      cycle: { status: 'paused', finalizationProgress: progress('reviewing') } as never,
    }),
  ).toEqual(['remediate-findings', 'authorize-remediation', 'resume']);
  // An open integration resolution is decided there; the finalization only resumes.
  expect(
    finalizationActions({
      ...base,
      checkpointFindings: 2,
      finalization: staged,
      cycle: { status: 'needs-attention', integrationResolution: { status: 'detected' } } as never,
    }),
  ).toEqual(['resume']);
  // Preparing, with no cycle yet: resume.
  expect(
    finalizationActions({ ...base, finalization: { status: 'preparing', stages: [] } as never }),
  ).toEqual(['resume']);
  // Ended: nothing.
  for (const finalization of [
    { status: 'completed', stages: [] },
    { status: 'stopped', stages: [] },
  ])
    expect(finalizationActions({ ...base, finalization: finalization as never })).toEqual([]);
  // The retired improvement rounds: only an approved or reserved promotion; Stop is the
  // panel's (R-A6 2b review).
  const retired = { status: 'active' } as never;
  expect(
    finalizationActions({ ...base, finalization: retired, cycle: { status: 'paused' } as never }),
  ).toEqual([]);
  expect(
    finalizationActions({
      ...base,
      finalization: retired,
      cycle: { status: 'awaiting-merge' } as never,
    }),
  ).toEqual(['merge']);
  expect(
    finalizationActions({
      ...base,
      mergeRecoveryPending: true,
      finalization: retired,
      cycle: { status: 'paused' } as never,
    }),
  ).toEqual(['merge']);
});

it("counts only the current review's explicit proposals, as approve-plan-change does", () => {
  const cycle = (obligations: object[]) =>
    ({ currentRunId: 'run-2', finalizationProgress: { obligations } }) as never;
  expect(currentPlanChanges(cycle([proposal('run-2')]))).toHaveLength(1);
  expect(currentPlanChanges(cycle([proposal('run-1')]))).toEqual([]);
  expect(
    currentPlanChanges(cycle([{ ...proposal('run-2'), proposedRequirement: undefined }])),
  ).toEqual([]);
  expect(currentPlanChanges(cycle([{ ...proposal('run-2'), status: 'gap' }]))).toEqual([]);
  expect(
    currentPlanChanges({
      finalizationProgress: {
        obligations: [{ status: 'change-requested', proposedRequirement: 'x' }],
      },
    } as never),
  ).toEqual([]);
});
