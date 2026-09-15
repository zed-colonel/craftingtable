import { DEFAULT_COMPLETION_POLICY, FINALIZATION_STAGE_KINDS } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { controlFinalizationRequestSchema, finalizationStagesSchema } from './finalization.js';
import { stageReviewReportSchema } from './stage-report.js';

const profile = { backend: 'codex', permissionMode: 'auto' };
const stages = FINALIZATION_STAGE_KINDS.map((kind) => ({
  id: kind,
  kind,
  name: kind,
  workItemSourceIds: [],
  instructions: '',
  review: profile,
  implement: profile,
  policy: DEFAULT_COMPLETION_POLICY,
  requiredChecks: ['Repository checks'],
}));
describe('staged finalization contracts', () => {
  it('allows subsystem slices only alongside mandatory whole-plan correctness and conformance checks', () => {
    expect(finalizationStagesSchema.safeParse(stages).success).toBe(true);
    expect(
      finalizationStagesSchema.safeParse([
        { ...stages[0], id: 'slice-1', workItemSourceIds: ['WI-01'] },
        ...stages,
      ]).success,
    ).toBe(true);
    expect(finalizationStagesSchema.safeParse(stages.slice(1)).success).toBe(false);
    expect(finalizationStagesSchema.safeParse([...stages].reverse()).success).toBe(false);
    expect(
      finalizationStagesSchema.safeParse(
        stages.map((s) => (s.kind === 'correctness' ? { ...s, workItemSourceIds: ['WI-01'] } : s)),
      ).success,
    ).toBe(false);
    expect(
      finalizationStagesSchema.safeParse([...stages, { ...stages[4], id: 'second-final' }]).success,
    ).toBe(false);
  });
  it('requires explicit scoped decisions and permits an empty optional batch', () => {
    const selection = {
      action: 'select-stage-findings',
      expectedVersion: 1,
      expectedCycleVersion: 1,
      selectedFindingIds: [],
      rationale: 'Retain optional work for later.',
    };
    expect(controlFinalizationRequestSchema.safeParse(selection).success).toBe(true);
    expect(
      controlFinalizationRequestSchema.safeParse({
        ...selection,
        additionalRounds: 2,
        agentOverride: { backend: 'codex', model: 'recovery-model' },
      }).success,
    ).toBe(true);
    expect(
      controlFinalizationRequestSchema.safeParse({ ...selection, rationale: '' }).success,
    ).toBe(false);
    expect(
      controlFinalizationRequestSchema.safeParse({ ...selection, action: 'resume' }).success,
    ).toBe(false);
    expect(
      controlFinalizationRequestSchema.safeParse({
        action: 'approve-plan-change',
        expectedVersion: 1,
        obligationId: 'gate-1',
        rationale: 'Approved scope adjustment.',
      }).success,
    ).toBe(true);
    expect(
      controlFinalizationRequestSchema.safeParse({
        action: 'approve-plan-change',
        expectedVersion: 1,
        rationale: 'Too vague.',
      }).success,
    ).toBe(false);
  });
  it('accepts compact obligation updates but rejects ambiguous dispositions and duplicate check rows', () => {
    const report = {
      stageId: 'conformance',
      fullChecks: false,
      checks: [{ name: 'check', status: 'passed', evidence: 'Passed.' }],
      obligations: [{ id: 'gate-1', status: 'met', evidence: 'Implementation and checks.' }],
    };
    expect(stageReviewReportSchema.safeParse(report).success).toBe(true);
    expect(
      stageReviewReportSchema.safeParse({ ...report, checks: [...report.checks, ...report.checks] })
        .success,
    ).toBe(false);
    expect(
      stageReviewReportSchema.safeParse({
        ...report,
        obligations: [{ ...report.obligations[0], status: 'change-requested' }],
      }).success,
    ).toBe(false);
    expect(
      stageReviewReportSchema.safeParse({
        ...report,
        obligations: [
          { ...report.obligations[0], proposedRequirement: 'Unapproved substitution.' },
        ],
      }).success,
    ).toBe(false);
  });
});
