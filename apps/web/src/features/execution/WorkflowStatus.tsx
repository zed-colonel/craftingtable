import type { WorkCycle } from '@craftingtable/domain';
export function WorkflowStatus({ cycle }: { cycle: WorkCycle }) {
  const workflow = cycle.workflow;
  if (!workflow) return null;
  const roadmap = `/workspaces/${encodeURIComponent(cycle.workspaceId)}/roadmaps`;
  return (
    <section aria-label="Controller work and operator questions">
      {workflow.activeReview && (
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
      {workflow.securityRequired && (
        <p>
          Required security review:{' '}
          {workflow.securityReceipt
            ? 'A review receipt is recorded; the controller rechecks its candidate, integration, repository policy and dependency inputs.'
            : 'Queued after technical remediation.'}
        </p>
      )}
      {workflow.waiting && (
        <p role="status">
          <strong>Waiting for prerequisites:</strong> {workflow.waiting}{' '}
          <a href={roadmap}>Open roadmap requirements</a>
        </p>
      )}
      {workflow.questions.length > 0 && (
        <div>
          <h3>Questions needing your decision</h3>
          {workflow.questions.map((q) => (
            <article key={`${q.destination}:${q.checkpointId ?? 'local'}:${q.question}`}>
              <p style={{ whiteSpace: 'pre-wrap' }}>{q.question}</p>
              {q.destination === 'shared-decision' && cycle.executionScope ? (
                <p>
                  <a
                    href={`${roadmap}#architecture-decisions-${cycle.executionScope.definitionId}`}
                  >
                    Resolve {q.checkpointId} in Shared architecture decisions
                  </a>
                  . Save and approve the shared decision there so other work items inherit it. Then
                  refresh this item’s evidence and continue with the recorded decision.
                </p>
              ) : (
                <p>
                  <a href={`#cycle-${cycle.step === 'design' ? 'design' : 'guidance'}-${cycle.id}`}>
                    {cycle.step === 'design'
                      ? 'Answer in this work item’s Resolve design questions controls'
                      : cycle.reason?.startsWith('Remediation limit reached.')
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
