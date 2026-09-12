import type { ReactNode } from 'react';
import type { AgentRunDetailResponse } from '@craftingtable/contracts';
import { reviewReportSchema } from '@craftingtable/contracts';
import type { ReviewReportAssessment } from '@craftingtable/domain';

type Outcome = NonNullable<AgentRunDetailResponse['latestOutcome']>;
/** Only a validated copy of the separately displayed report is folded out of the prose. */
export function outcomeProse(text: string, assessment?: ReviewReportAssessment): string {
  if (assessment?.status !== 'complete') return text;
  return text
    .replace(
      /```(?:craftingtable-review|json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g,
      (block, body: string) => {
        try {
          const parsed = reviewReportSchema.safeParse(JSON.parse(body));
          return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(assessment.report)
            ? ''
            : block;
        } catch {
          return block;
        }
      },
    )
    .trim();
}
function inline(text: string) {
  const nodes: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(/\*\*[^*\n]+\*\*|`[^`\n]+`/g)) {
    nodes.push(text.slice(end, match.index));
    const part = match[0];
    nodes.push(
      part.startsWith('**') ? (
        <strong key={match.index}>{part.slice(2, -2)}</strong>
      ) : (
        <code key={match.index}>{part.slice(1, -1)}</code>
      ),
    );
    end = match.index + part.length;
  }
  nodes.push(text.slice(end));
  return nodes;
}
export function RunOutcome({
  outcome,
  finished,
  assessment,
}: {
  outcome: Outcome;
  finished: boolean;
  assessment?: ReviewReportAssessment;
}) {
  const prose = outcomeProse(outcome.text, assessment);
  return (
    <section className="panel run-outcome" aria-label="Run outcome">
      <h2>{finished ? 'Final outcome' : 'Latest completed turn'}</h2>
      <p className="hint">
        {new Date(outcome.occurredAt).toLocaleString()} ·{' '}
        {outcome.outcome === 'success' ? 'Agent turn completed' : 'Agent turn reported an error'}
      </p>
      {outcome.truncated && (
        <p role="alert">
          The recorded final message was truncated by the backend. It may be incomplete.
        </p>
      )}
      <div
        className="run-outcome-prose"
        style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
      >
        {inline(prose || 'The structured review report below contains this run’s outcome.')}
      </div>
      <details className="run-event-details">
        <summary>Full recorded final message</summary>
        <pre className="run-event-body run-event-prose">{outcome.text}</pre>
      </details>
    </section>
  );
}
