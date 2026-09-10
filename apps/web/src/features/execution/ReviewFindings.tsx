import type { ReviewReportAssessment } from '@craftingtable/domain';
import { FINDING_SEVERITIES } from '@craftingtable/domain';

export function ReviewFindings({ assessment }: { assessment: ReviewReportAssessment }) {
  if (assessment.status !== 'complete') {
    return (
      <section className="panel" aria-label="Review findings">
        <h2>
          {assessment.status === 'invalid'
            ? 'Review report needs attention'
            : 'Unstructured review'}
        </h2>
        {assessment.issues.map((issue) => (
          <p key={issue}>{issue}</p>
        ))}
        <p className="hint">
          Handoffs include the recorded conversation. Ask the reviewer to consolidate its findings
          before relying on counts.
        </p>
      </section>
    );
  }
  const report = assessment.report;
  return (
    <details className="disclosure" aria-label="Review findings">
      <summary>
        <span>Review findings</span>
        <span className="hint">
          {FINDING_SEVERITIES.map(
            (severity) =>
              `${report.findings.filter((finding) => finding.status === 'open' && finding.severity === severity).length} ${severity}`,
          ).join(' · ')}
        </span>
      </summary>
      <div className="disclosure-body">
        <p>
          Exit gate: {report.exitGate.met ? 'reported met' : 'not met'}. {report.exitGate.evidence}
        </p>
        <p className="hint">
          Counts include open findings. Resolved and withdrawn findings remain below with the
          reviewer’s disposition.
        </p>
        {report.findings.length === 0 ? (
          <p>No findings reported.</p>
        ) : (
          report.findings.map((finding) => (
            <article key={finding.id}>
              <h3>
                <span className="mono">{finding.id}</span> · {finding.severity} · {finding.status} ·{' '}
                {finding.title}
              </h3>
              {finding.location !== undefined && (
                <p className="mono">
                  {finding.location.path}
                  {finding.location.line === undefined ? '' : `:${finding.location.line}`}
                </p>
              )}
              <p>{finding.explanation}</p>
              <p>Suggested fix: {finding.recommendation}</p>
              {finding.disposition !== undefined && (
                <p>Reviewer disposition: {finding.disposition}</p>
              )}
            </article>
          ))
        )}
      </div>
    </details>
  );
}
