import { expect, it } from 'vitest';
import { finalizationActions } from './finalization-actions.js';

const staged = { status: 'active' as const, stages: [{ kind: 'simplification' }] } as never;
const progress = (status: string, obligations: { status: string }[] = []) =>
  ({ stageIndex: 0, stages: [{ status }], obligations }) as never;
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
        finalizationProgress: progress('selecting', [{ status: 'change-requested' }]),
      } as never,
    }),
  ).toEqual(['approve-plan-change', 'resume']);
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
  // Ended, or the retired improvement rounds: nothing.
  for (const finalization of [
    { status: 'completed', stages: [] },
    { status: 'stopped', stages: [] },
    { status: 'active' },
  ])
    expect(finalizationActions({ ...base, finalization: finalization as never })).toEqual([]);
});
