import {
  currentFinalizationStage,
  type Finalization,
  type FinalizationProgress,
  optionalFinding,
  type ReviewBranchContext,
  type ReviewReportAssessment,
  type WorkCycle,
} from '@craftingtable/domain';

/** Report validity is separate from success; gaps and failed checks remain valid, actionable reports. */
export function assessStageReport(
  value: Finalization,
  cycle: WorkCycle,
  assessment: ReviewReportAssessment,
  baseline?: ReviewBranchContext,
): ReviewReportAssessment {
  if (!value.stages || assessment.status !== 'complete') return assessment;
  const stage = value.stages[cycle.finalizationProgress?.stageIndex ?? 0];
  const report = assessment.report.finalization;
  const issues: string[] = [];
  if (!stage || !report || report.stageId !== stage.id || !baseline)
    return {
      status: 'invalid',
      issues: [
        'A staged finalization report must name the current stage and have its recorded review baseline. Read craftingtable-finalization-state.json.',
      ],
    };
  if (assessment.report.findings.some((f) => !f.category))
    issues.push(
      'Every staged finding needs a category independent of severity. Split bundled concerns into separate IDs.',
    );
  if (stage.kind === 'final-review' && !report.fullChecks)
    issues.push('The final independent review must run and report the full required checks.');
  const requiredChecks =
    stage.kind === 'final-review'
      ? new Set(value.stages.flatMap((s) => s.requiredChecks))
      : stage.requiredChecks;
  for (const name of requiredChecks)
    if (!report.checks.some((c) => c.name === name)) issues.push(`Required check missing: ${name}`);
  if (
    assessment.report.exitGate.met &&
    (report.checks.some((c) => c.status !== 'passed') ||
      report.obligations.some((o) => o.status !== 'met'))
  )
    issues.push(
      'A met stage exit gate requires passing checks and no reported obligation gaps or unapproved changes.',
    );
  const obligations = cycle.finalizationProgress?.obligations ?? [];
  const known = new Map(obligations.map((o) => [o.id, o]));
  for (const o of report.obligations) {
    const prior = known.get(o.id);
    if (!prior && (!o.source || !o.requirement))
      issues.push(`New obligation ${o.id} requires an exact source citation and requirement.`);
    if (
      prior &&
      ((o.source !== undefined && o.source !== prior.source) ||
        (o.requirement !== undefined && o.requirement !== prior.requirement) ||
        (o.workItemSourceId !== undefined && o.workItemSourceId !== prior.workItemSourceId))
    )
      issues.push(
        `Obligation ${o.id} changed its adopted source or requirement. Request and obtain an explicit plan-change decision first.`,
      );
    if (
      o.reusedFromRunId &&
      (stage.kind === 'final-review' ||
        !prior ||
        prior.status !== 'met' ||
        prior.runId !== o.reusedFromRunId ||
        prior.headSha !== baseline.headSha ||
        prior.targetSha !== baseline.targetSha ||
        !cycle.finalizationProgress?.stages.some(
          (s) =>
            s.status === 'completed' &&
            s.completedRunId === prior.runId &&
            s.headSha === baseline.headSha &&
            s.targetSha === baseline.targetSha,
        ) ||
        (o.requirement !== undefined && prior.requirement !== o.requirement) ||
        prior.evidence !== o.evidence ||
        o.status !== 'met')
    )
      issues.push(
        `Obligation ${o.id} cannot reuse that evidence: only complete matching-commit, matching-requirement evidence is reusable; final review always revalidates.`,
      );
  }
  if (stage.kind === 'conformance' || stage.kind === 'final-review') {
    const required = obligations.filter(
      (o) =>
        stage.workItemSourceIds.length === 0 ||
        !o.workItemSourceId ||
        stage.workItemSourceIds.includes(o.workItemSourceId),
    );
    const reported = new Set(report.obligations.map((o) => o.id));
    const missing = required.filter((o) => !reported.has(o.id));
    if (missing.length)
      issues.push(
        `Missing adopted obligations: ${missing.map((o) => o.id).join(', ')}. Report each current disposition; historical completion is not evidence of current conformance.`,
      );
  }
  return issues.length ? { status: 'invalid', issues: issues.slice(0, 20) } : assessment;
}

export function recordStageEvidence(
  cycle: WorkCycle,
  assessment: Extract<ReviewReportAssessment, { status: 'complete' }>,
  baseline: ReviewBranchContext,
): FinalizationProgress {
  const progress = cycle.finalizationProgress;
  if (!progress || !assessment.report.finalization) throw new Error('Missing staged report');
  const obligations = new Map(progress.obligations.map((o) => [o.id, o]));
  for (const entry of assessment.report.finalization.obligations) {
    const prior = obligations.get(entry.id);
    const source = entry.source ?? prior?.source;
    const requirement = entry.requirement ?? prior?.requirement;
    if (!source || !requirement)
      throw new Error('Missing adopted obligation source or requirement');
    obligations.set(entry.id, {
      ...entry,
      source,
      requirement,
      ...((entry.workItemSourceId ?? prior?.workItemSourceId)
        ? { workItemSourceId: entry.workItemSourceId ?? prior?.workItemSourceId }
        : {}),
      ...(prior?.approvedChange ? { approvedChange: prior.approvedChange } : {}),
      runId: cycle.currentRunId,
      headSha: baseline.headSha,
      targetSha: baseline.targetSha,
    });
  }
  const followUps = new Map(progress.followUps.map((f) => [f.id, f]));
  for (const f of assessment.report.findings) {
    if (f.status !== 'open' || !optionalFinding(f)) followUps.delete(f.id);
    else if (followUps.has(f.id)) followUps.set(f.id, f);
  }
  return {
    ...progress,
    obligations: [...obligations.values()],
    followUps: [...followUps.values()],
  };
}

export function stagedPromotionIssue(
  value: Finalization,
  cycle: WorkCycle,
  assessment?: ReviewReportAssessment,
  baseline?: ReviewBranchContext,
): string | undefined {
  if (!value.stages) return;
  const progress = cycle.finalizationProgress;
  if (
    !progress ||
    progress.stageIndex !== value.stages.length - 1 ||
    progress.stages.length !== value.stages.length ||
    progress.stages.some((s, i) => s.id !== value.stages?.[i]?.id) ||
    currentFinalizationStage(cycle)?.completedRunId !== cycle.currentRunId ||
    currentFinalizationStage(cycle)?.status !== 'completed' ||
    progress.stages.some((s) => s.status !== 'completed')
  )
    return 'Every finalization stage and the final independent review must be complete.';
  if (!assessment || assessStageReport(value, cycle, assessment, baseline).status !== 'complete')
    return 'The final staged review report is incomplete or stale.';
  if (
    progress.obligations.some(
      (o) =>
        o.status !== 'met' ||
        o.runId !== cycle.currentRunId ||
        o.headSha !== baseline?.headSha ||
        o.targetSha !== baseline?.targetSha,
    )
  )
    return 'Every adopted obligation needs current final-review evidence.';
  if (
    assessment.status === 'complete' &&
    assessment.report.finalization?.checks.some((c) => c.status !== 'passed')
  )
    return 'All final required checks must pass.';
  return;
}
