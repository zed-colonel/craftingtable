import type { FinalizationView } from '@craftingtable/contracts';
import { stageStoppingRule } from '@craftingtable/domain';

export function FinalizationStageProgress({ view }: { view: FinalizationView }) {
  const progress = view.cycle?.finalizationProgress;
  const stages = view.finalization.stages;
  if (!progress || !stages) return null;
  const stage = stages[progress.stageIndex];
  const current = progress.stages[progress.stageIndex];
  const baseline = view.runs.find((r) => r.id === view.cycle?.currentRunId)?.reviewBranchContext;
  const met = progress.obligations.filter(
    (o) =>
      o.status === 'met' && o.headSha === baseline?.headSha && o.targetSha === baseline?.targetSha,
  ).length;
  return (
    <section className="stack-form" aria-label="Finalization stages">
      <h4>
        Stage {progress.stageIndex + 1} of {stages.length}: {stage?.name}
      </h4>
      {stage && <p>{stageStoppingRule(stage.kind)}</p>}
      <p>Selected batch: {current?.selectedFindingIds.join(', ') || 'none'}.</p>
      <details>
        <summary>Stage progress and allowances</summary>
        <ol>
          {stages.map((s, i) => (
            <li key={s.id} aria-current={i === progress.stageIndex ? 'step' : undefined}>
              <strong>{s.name}</strong> · {progress.stages[i]?.status} ·{' '}
              {progress.stages[i]?.remediationRounds ?? 0} of{' '}
              {s.policy.maxRemediationRounds +
                (progress.stages[i]?.additionalRemediationRounds ?? 0)}{' '}
              attempts used
              <p className="hint">
                {s.workItemSourceIds.length
                  ? `Scope: ${s.workItemSourceIds.join(', ')}`
                  : 'Whole plan and cross-boundary interactions'}
              </p>
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>
          Plan obligations and evidence ({met} of {progress.obligations.length} current)
        </summary>
        <p className="hint">
          Evidence belongs to the recorded candidate and destination commits. Later changes require
          revalidation; the final independent review revalidates every obligation.
        </p>
        {progress.obligations.map((o) => (
          <article key={o.id} className="review-finding">
            <h4>
              {o.id} · {o.status}
              {o.status === 'met' &&
              (o.headSha !== baseline?.headSha || o.targetSha !== baseline?.targetSha)
                ? ' · needs revalidation'
                : ''}
            </h4>
            <p>{o.requirement}</p>
            <p className="hint">Source: {o.source}</p>
            <p style={{ overflowWrap: 'anywhere' }}>{o.evidence || 'Awaiting verification.'}</p>
            {o.proposedRequirement && <p>Proposed replacement: {o.proposedRequirement}</p>}
            {o.approvedChange && (
              <p>
                Approved adjustment: {o.approvedChange.rationale} · {o.approvedChange.createdAt}
              </p>
            )}
            {o.headSha && (
              <p className="hint">
                Candidate {o.headSha.slice(0, 8)} · destination {o.targetSha?.slice(0, 8)}
              </p>
            )}
          </article>
        ))}
      </details>
      <details>
        <summary>Optional follow-up work ({progress.followUps.length})</summary>
        <p className="hint">
          These suggestions remain open. They were not selected for the current batch and are not
          claimed as resolved.
        </p>
        {progress.followUps.map((f) => (
          <article key={f.id} className="review-finding">
            <h4>
              {f.id} · {f.category} · {f.severity} · {f.title}
            </h4>
            <p>{f.explanation}</p>
            <p>Suggested change: {f.recommendation}</p>
          </article>
        ))}
      </details>
      {!!progress.decisions.length && (
        <details>
          <summary>Stage decisions ({progress.decisions.length})</summary>
          {progress.decisions.map((d) => (
            <p key={`${d.runId}:${d.createdAt}`}>
              {stages.find((s) => s.id === d.stageId)?.name} · selected{' '}
              {d.selectedIds.join(', ') || 'none'} · {d.rationale} · {d.createdAt}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
