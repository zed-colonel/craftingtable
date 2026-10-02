import { useState } from 'react';
import { workCycleResponseSchema } from '@craftingtable/contracts';
import {
  effectiveCycleAttention,
  remediationAllowance,
  type WorkCycle,
} from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { CycleGuidanceRecovery } from './CycleGuidanceRecovery.js';
import {
  type CycleRemediationGrant,
  CycleRemediationRecovery,
} from './CycleRemediationRecovery.js';
import { ProviderRecovery } from './ProviderRecovery.js';
import { ScopeReviewRecovery } from './ScopeReviewRecovery.js';
import type { AnswerDraft } from './answer-draft.js';

type ControlBody =
  | { readonly action: 'pause' | 'stop' | 'retry-provider' }
  | { readonly action: 'resume' | 'review-again'; readonly instructions?: string }
  | ({ readonly action: 'authorize-remediation' } & CycleRemediationGrant);

/**
 * The cycle control command, `cycles/:id/control` (R-A6). Private to this module: continuing a
 * stopped cycle, the manual pause, resume and stop, and a service retry are all posted here.
 */
function control(cycle: WorkCycle, csrfToken: string, body: ControlBody) {
  return request(
    `/api/workspaces/${encodeURIComponent(cycle.workspaceId)}/cycles/${encodeURIComponent(cycle.id)}/control`,
    workCycleResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ ...body, expectedVersion: cycle.version }),
    },
  );
}

function useCommand(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (command: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await command();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The cycle command failed.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** How a stopped cycle is continued, from the actions the daemon returned with it. */
export type Continuation = 'scope-review' | 'remediation' | 'guidance' | 'resume';

export function continuationOf(cycle: WorkCycle): Continuation | undefined {
  const actions = cycle.actions ?? [];
  // A stop that waits on shared decisions is answered there, not here (LIVE-18), and one being
  // investigated takes no answer until the investigation ends (R-C16).
  if (actions.includes('open-shared-decisions') || actions.includes('end-investigation'))
    return undefined;
  // A parent or verification review is continued, or reviewed again, with instructions.
  if (cycle.executionScope && cycle.executionScope.kind !== 'slice')
    return ['paused', 'needs-attention', 'completed'].includes(cycle.status)
      ? 'scope-review'
      : undefined;
  // More rounds only where the daemon grants them: a review that used its allowance, with no
  // integration resolution open (R-A6 review; the old form's rule).
  if (
    actions.includes('authorize-remediation') &&
    cycle.step === 'review' &&
    cycle.remediationRounds >= remediationAllowance(cycle) &&
    (!cycle.integrationResolution ||
      ['completed', 'abandoned'].includes(cycle.integrationResolution.status))
  )
    return 'remediation';
  if (
    cycle.step !== 'design' &&
    ['paused', 'needs-attention'].includes(cycle.status) &&
    (actions.includes('continue-with-guidance') ||
      !!cycle.workflow?.questions.length ||
      effectiveCycleAttention(cycle)?.code === 'remediation-stalled')
  )
    return 'guidance';
  if (cycle.status === 'needs-attention' && actions.includes('resume')) return 'resume';
  return undefined;
}

/**
 * Continues a stopped cycle (R-A6): with guidance, with more remediation rounds, by resuming,
 * or, for a parent or verification review, by resuming or reviewing again with instructions.
 * The daemon's returned actions choose which; nothing renders when none applies.
 */
export function CycleContinuation({
  cycle,
  csrfToken,
  disabled,
  onChanged,
  answer,
}: {
  cycle: WorkCycle;
  csrfToken: string;
  disabled: boolean;
  onChanged: () => void;
  /** The stop's answer as its decision holds it, which the forms share (R-C16). */
  answer?: AnswerDraft;
}) {
  // A sent answer is not offered again (R-C16 16b review).
  const { busy, error, run } = useCommand(() => {
    answer?.clear?.();
    onChanged();
  });
  const kind = continuationOf(cycle);
  if (!kind) return null;
  const locked = disabled || busy;
  return (
    <div id={`cycle-continuation-${cycle.id}`} className="stack">
      {kind === 'scope-review' && (
        <ScopeReviewRecovery
          key={cycle.id}
          cycle={cycle}
          {...(answer ? { answer } : {})}
          disabled={locked}
          onResume={(instructions) =>
            void run(() =>
              control(cycle, csrfToken, {
                action: cycle.status === 'completed' ? 'review-again' : 'resume',
                instructions,
              }),
            )
          }
        />
      )}
      {kind === 'remediation' && (
        <div id={`cycle-guidance-${cycle.id}`}>
          <CycleRemediationRecovery
            key={`${cycle.id}:${cycle.version}`}
            cycle={cycle}
            {...(answer ? { answer } : {})}
            disabled={locked}
            onAuthorize={(grant) =>
              void run(() =>
                control(cycle, csrfToken, { action: 'authorize-remediation', ...grant }),
              )
            }
          />
        </div>
      )}
      {kind === 'guidance' && (
        <CycleGuidanceRecovery
          key={cycle.id}
          cycle={cycle}
          {...(answer ? { answer } : {})}
          disabled={locked}
          onContinue={(instructions) =>
            void run(() => control(cycle, csrfToken, { action: 'resume', instructions }))
          }
        />
      )}
      {kind === 'resume' && (
        <button
          type="button"
          className="primary-button"
          disabled={locked}
          onClick={() => void run(() => control(cycle, csrfToken, { action: 'resume' }))}
        >
          Resume automation
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/**
 * The manual controls the daemon offers for a cycle: pause, resume a pause, and stop. A stopped
 * cycle's continuation is `CycleContinuation`; `resume` here is offered only when `resumable`.
 */
export function CycleControlButtons({
  cycle,
  csrfToken,
  disabled,
  resumable,
  onChanged,
}: {
  cycle: WorkCycle;
  csrfToken: string;
  disabled: boolean;
  resumable: boolean;
  onChanged: () => void;
}) {
  const { busy, error, run } = useCommand(onChanged);
  const actions = cycle.actions ?? [];
  const locked = disabled || busy;
  return (
    <>
      {actions.includes('pause') && (
        <button
          type="button"
          className="secondary-button"
          disabled={locked}
          onClick={() => void run(() => control(cycle, csrfToken, { action: 'pause' }))}
        >
          Pause automation
        </button>
      )}
      {actions.includes('resume') && resumable && (
        <button
          type="button"
          className="primary-button"
          disabled={locked}
          onClick={() => void run(() => control(cycle, csrfToken, { action: 'resume' }))}
        >
          Resume automation
        </button>
      )}
      {actions.includes('stop') && (
        <button
          type="button"
          className="secondary-button danger"
          disabled={locked}
          onClick={() => void run(() => control(cycle, csrfToken, { action: 'stop' }))}
        >
          Stop automation
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </>
  );
}

/**
 * A service retry that is waiting or has stopped: Retry now, or pause. A finalization pauses
 * itself, so its host supplies `onPause`.
 */
export function ProviderRetry({
  cycle,
  csrfToken,
  disabled,
  onChanged,
  onPause,
}: {
  cycle: WorkCycle;
  csrfToken: string;
  disabled: boolean;
  onChanged: () => void;
  onPause?: () => void;
}) {
  const { busy, error, run } = useCommand(onChanged);
  return (
    <>
      <ProviderRecovery
        cycle={cycle}
        disabled={disabled || busy}
        onRetry={() => void run(() => control(cycle, csrfToken, { action: 'retry-provider' }))}
        onPause={onPause ?? (() => void run(() => control(cycle, csrfToken, { action: 'pause' })))}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
