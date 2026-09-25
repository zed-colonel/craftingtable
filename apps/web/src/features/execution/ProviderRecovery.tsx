import type { WorkCycle } from '@craftingtable/domain';
import { AGENT_BACKEND_LABELS, effectiveCycleAttention } from '@craftingtable/domain';
import { About } from '../../components/About.js';

/** Stops that leave a service failure for the operator to inspect (R-A3 codes). */
const SERVICE_STOPS: readonly string[] = [
  'service-retries-exhausted',
  'service-failure-not-retryable',
];

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
  // The server clears the record when a step succeeds. While it exists, the panel shows a
  // retry that is waiting or running, and a service stop (waiting or paused) the operator
  // must inspect. A record left behind under an unrelated stop has nothing to recover (R-E6,
  // UI-10). Codes, never reason text, decide; older records map through
  // `effectiveCycleAttention`.
  const code = (cycle.attention ?? effectiveCycleAttention(cycle))?.code ?? '';
  const serviceStop =
    ['needs-attention', 'paused'].includes(cycle.status) && SERVICE_STOPS.includes(code);
  if (!pending && cycle.status !== 'running' && !serviceStop) return null;
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
          {cycle.status !== 'running' && ' Resume the cycle to let it run.'}
        </p>
      ) : cycle.status === 'running' ? (
        <p>Retrying the same step.</p>
      ) : code === 'service-failure-not-retryable' ? (
        <p>The service reported this failure as not retryable. Give guidance before resuming.</p>
      ) : (
        <p>Inspect the latest outcome before resuming. Resuming grants a new step window.</p>
      )}
      <About label="About service retries">
        <p>
          Service retries wait 1, 5, then 15 minutes, or until a reported usage-limit reset (at most
          6 hours); a reset wait moves the step deadline by the time waited. Retries do not use
          remediation attempts or change the model. Every verification and merge gate still applies.
        </p>
      </About>
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
