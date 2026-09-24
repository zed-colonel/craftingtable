import type { WorkCycle } from '@craftingtable/domain';
import { AGENT_BACKEND_LABELS } from '@craftingtable/domain';

export function ProviderRecovery({
  cycle,
  disabled,
  onRetry,
  onPause,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  onRetry: () => void;
  onPause: () => void;
}) {
  const recovery = cycle.providerRecovery;
  if (!recovery || ['completed', 'stopped'].includes(cycle.status)) return null;
  const pending = !!recovery.nextRetryAt;
  return (
    <section className="panel" aria-label="Model service recovery">
      <h3>Model service recovery</h3>
      <p>{recovery.failure.message}</p>
      <p>
        {recovery.attempts} of 3 service retries used ·{' '}
        {AGENT_BACKEND_LABELS[recovery.profile.backend]} · {recovery.profile.model}
      </p>
      {pending ? (
        <p>
          Next retry: {new Date(recovery.nextRetryAt!).toLocaleString()}. Paused roadmap scheduling
          holds this retry.
          {cycle.status !== 'running' &&
            ' This cycle also needs your explicit resume after a pause or restart.'}
        </p>
      ) : (
        <p>
          {cycle.status === 'running'
            ? 'Continuing the same step.'
            : recovery.attempts >= 3 && cycle.status === 'needs-attention'
              ? 'Inspect the latest outcome before resuming. An explicit resume after exhaustion grants a new step window.'
              : 'Continue with the normal review, guidance or merge controls for this cycle.'}
        </p>
      )}
      <p className="hint">
        Service retries wait 1, 5, then 15 minutes, or until a reported usage-limit reset (at most 6
        hours); a reset wait moves the step deadline by the time waited. Retries do not use
        remediation attempts or change the model. Every verification and merge gate still applies.
      </p>
      <div className="inline-actions">
        {pending && (
          <button type="button" className="secondary-button" disabled={disabled} onClick={onRetry}>
            Retry now
          </button>
        )}
        {cycle.status === 'running' && (
          <button type="button" className="secondary-button" disabled={disabled} onClick={onPause}>
            Pause service recovery
          </button>
        )}
      </div>
    </section>
  );
}
