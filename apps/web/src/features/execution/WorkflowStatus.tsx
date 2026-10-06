import {
  effectiveCycleAttention,
  type WorkCycle,
  type WorkflowQuestion,
} from '@craftingtable/domain';
import { Link } from '../../lib/navigation.js';
import { sharedDecisionsRoute } from '../../lib/decision-links.js';
import type { Route } from '../../lib/route.js';
/**
 * The cycle's controller work and its questions. `decidedIn`: the inbox item that decides the
 * cycle's stop, where questions are answered when the page shows only a banner (R-A6).
 */
export function WorkflowStatus({
  cycle,
  questionRoutes,
  decidedIn,
}: {
  cycle: WorkCycle;
  /** The projection's routed questions, which stand for the recorded ones when present. */
  questionRoutes?: readonly WorkflowQuestion[];
  decidedIn?: Route;
}) {
  const workflow = cycle.workflow;
  const questions = questionRoutes ?? workflow?.questions ?? [];
  if (!workflow && questions.length === 0) return null;
  const roadmap: Route =
    cycle.owner?.roadmapId === undefined
      ? { name: 'roadmaps', workspaceId: cycle.workspaceId }
      : {
          name: 'roadmap',
          workspaceId: cycle.workspaceId,
          roadmapId: cycle.owner.roadmapId,
          tab: 'board',
        };
  return (
    <section aria-label="Controller work and operator questions">
      {workflow?.activeReview && (
        <p>
          <strong>Controller review:</strong>{' '}
          {workflow.activeReview.kind === 'security'
            ? 'Separate security review'
            : workflow.activeReview.kind === 'checkpoint'
              ? `Checkpoint ${workflow.activeReview.checkpointId}`
              : 'Plan and question reassessment'}
          . This uses a separate read-only run.
        </p>
      )}
      {workflow?.securityRequired && (
        <p>
          Required security review:{' '}
          {workflow.securityReceipt
            ? 'A review receipt is recorded; the controller rechecks its candidate, integration, repository policy and dependency inputs.'
            : 'Queued after technical remediation.'}
        </p>
      )}
      {workflow?.waiting && (
        <p role="status">
          <strong>Waiting for prerequisites:</strong> {workflow.waiting}{' '}
          <Link route={roadmap}>Open roadmap requirements</Link>
        </p>
      )}
      {questions.length > 0 && (
        <div>
          <h3>Questions needing your decision</h3>
          {questions.map((q) => (
            <article key={`${q.destination}:${q.checkpointId ?? 'local'}:${q.question}`}>
              <p style={{ whiteSpace: 'pre-wrap' }}>{q.question}</p>
              {q.destination === 'shared-decision' && cycle.executionScope ? (
                <p>
                  <Link route={sharedDecisionsRoute(cycle)}>
                    Resolve {q.checkpointId} in Shared architecture decisions
                  </Link>
                  . Save and approve it there so other work items inherit it, then refresh this
                  item’s evidence and continue with it.
                </p>
              ) : decidedIn ? (
                <p>
                  <Link route={decidedIn}>Answer in Needs you</Link>. This answer stays with this
                  cycle; it does not approve a shared ADR.
                </p>
              ) : (
                <p>
                  <a href={`#cycle-${cycle.step === 'design' ? 'design' : 'guidance'}-${cycle.id}`}>
                    {cycle.step === 'design'
                      ? 'Answer in this work item’s Resolve design questions controls'
                      : ['remediation-exhausted', 'review-open-questions-at-limit'].includes(
                            effectiveCycleAttention(cycle)?.code ?? '',
                          )
                        ? 'Answer when authorizing more remediation for this work item'
                        : 'Answer in this work item’s Continue with guidance form'}
                  </a>
                  . This answer stays with this cycle; it does not approve a shared ADR.
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
