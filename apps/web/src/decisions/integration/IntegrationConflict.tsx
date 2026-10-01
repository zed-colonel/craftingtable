import { agentSelections, selectionsForPurpose } from '@craftingtable/domain';
import {
  type ExecutionStatusResponse,
  type IntegrationResolutionRequest,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import {
  type AgentRunId,
  effectiveCycleAttention,
  ownsIntegrationResolution,
  type WorkCycle,
} from '@craftingtable/domain';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { HandoffForm } from '../../features/execution/HandoffForm.js';
import { request } from '../../lib/api-client.js';

/** Stops an integration update leaves for the operator (R-A3 codes). */
const INTEGRATION_STOPS: readonly string[] = [
  'integration-conflict',
  'integration-update-failed',
  'integration-refresh-limit',
];

const encode = encodeURIComponent;

/**
 * The decision on a detected integration conflict: inspect, delegate a resolution, resume one,
 * or abandon it. The only poster of `cycles/:id/integration-resolution` (R-A6).
 */
function resolveIntegration(
  cycle: WorkCycle,
  input: Omit<IntegrationResolutionRequest, 'expectedVersion'>,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/integration-resolution`,
    workCycleResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ ...input, expectedVersion: cycle.version }),
    },
  );
}

/**
 * A cycle's integration conflict (R-A6 increment 2a). It renders in the cycle's inbox item, on
 * the work item page when no item carries the cycle's stop, and in a finalization's panel.
 */
export function IntegrationConflict({
  cycle,
  backends,
  disabled,
  canMutate,
  csrfToken,
  onChanged,
  offerInspect = true,
  onOpenRun,
  runIds,
}: {
  cycle: WorkCycle;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
  canMutate: boolean;
  onOpenRun: (id: AgentRunId) => void;
  runIds: readonly AgentRunId[];
  csrfToken: string;
  /** After a command, so the host reloads the cycle. */
  onChanged: () => void;
  /**
   * Whether an idle cycle with no conflict on record offers inspection: on its page, where a
   * manual update may have conflicted, but not in an inbox item about another stop.
   */
  offerInspect?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = disabled || pending;
  const onCommand = (input: Omit<IntegrationResolutionRequest, 'expectedVersion'>) => {
    setPending(true);
    setError(undefined);
    void resolveIntegration(cycle, input, csrfToken)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .then(() => onChanged())
      .finally(() => setPending(false));
  };
  const [form, setForm] = useState(false);
  const [abandon, setAbandon] = useState(false);
  const resolution = cycle.integrationResolution;
  const idle = ['paused', 'needs-attention'].includes(cycle.status);
  const owned = ownsIntegrationResolution(cycle);
  // The panel shows only with a resolution on record or an integration stop (R-E6, UI-10).
  // Paused cycles keep their code in `attention`; older records map through
  // `effectiveCycleAttention`.
  const code = (cycle.attention ?? effectiveCycleAttention(cycle))?.code ?? '';
  if (!resolution && !(idle && INTEGRATION_STOPS.includes(code))) {
    // Any other idle cycle keeps the one action: a manual update from integration can
    // conflict without recording a stop, and inspection is how that conflict reaches an agent.
    if (!idle || !canMutate || owned || !offerInspect) return null;
    return (
      <div className="inline-actions">
        {error && (
          <p role="alert" className="error-state">
            {error}
          </p>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => onCommand({ action: 'inspect' })}
        >
          Inspect integration conflicts
        </button>
      </div>
    );
  }
  return (
    <section className="panel" aria-label="Integration conflicts">
      <h3>Integration conflicts</h3>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {resolution && (
        <>
          <p>
            <strong>{resolution.status}</strong> · Agent attempts {resolution.attempts} of 3
          </p>
          <p style={{ overflowWrap: 'anywhere' }}>
            Item <code>{resolution.headSha}</code> ← <code>{resolution.targetBranch}</code> at{' '}
            <code>{resolution.targetSha}</code>
          </p>
          <ul>
            {resolution.paths.map((path) => (
              <li key={path}>
                <code style={{ overflowWrap: 'anywhere' }}>{path}</code>
              </li>
            ))}
          </ul>
          {resolution.commitSha && (
            <p>
              Integration update committed: <code>{resolution.commitSha}</code>.{' '}
              {/* A review that passed is what reviewed them, not one that started (LIVE-25). */}
              {['awaiting-merge', 'completed'].includes(cycle.status)
                ? 'The combined changes were reviewed afresh.'
                : cycle.status === 'running' && cycle.step === 'review'
                  ? 'A fresh review of the combined changes is running.'
                  : 'Fresh review required.'}
            </p>
          )}
          {(resolution.runIds ?? [])
            .filter((id) => runIds.includes(id))
            .map((id, index) => (
              <button key={id} type="button" className="text-button" onClick={() => onOpenRun(id)}>
                Open resolution attempt {index + 1}
              </button>
            ))}
          <details>
            <summary>Conflict details and incoming changes</summary>
            <pre className="run-event-body">{resolution.diagnostics}</pre>
          </details>
        </>
      )}
      {canMutate && idle && (
        <div className="stack-form">
          {!owned && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => onCommand({ action: 'inspect' })}
            >
              Inspect integration conflicts
            </button>
          )}
          {(resolution?.status === 'detected' ||
            (owned && resolution?.status === 'resolving' && resolution.attempts < 3)) &&
            !form && (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => setForm(true)}
              >
                {owned ? 'Resume resolution with agent' : 'Resolve integration conflicts'}
              </button>
            )}
          {owned && resolution?.status !== 'resolving' && (
            <button type="button" disabled={busy} onClick={() => onCommand({ action: 'resume' })}>
              Resume reserved integration operation
            </button>
          )}
          {form && resolution && (
            <HandoffForm
              key={`${resolution.id}-${resolution.attempts}`}
              label="Resolve with agent"
              maxInstructionsLength={16000}
              backends={backends}
              defaults={{
                ...(cycle.nextAgentSelections
                  ? selectionsForPurpose(cycle.nextAgentSelections, 'conflict')
                  : (resolution?.profile ??
                    selectionsForPurpose(agentSelections(cycle.profiles), 'conflict'))),
                permissionMode: cycle.profiles.remediate.permissionMode,
              }}
              busy={busy}
              hint="The agent resolves and verifies files. CraftingTable completes the integration update and requires a fresh review. Final merge remains yours."
              onCancel={() => setForm(false)}
              onLaunch={(choice) => {
                const { instructions, ...profile } = choice;
                onCommand({
                  action: owned ? 'resume' : 'start',
                  profile: {
                    ...profile,
                    backend: profile.backend ?? cycle.profiles.remediate.backend,
                  },
                  ...(instructions ? { instructions } : {}),
                });
                setForm(false);
              }}
            />
          )}
          {owned && !abandon && (
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => setAbandon(true)}
            >
              Abandon resolution…
            </button>
          )}
          {abandon && (
            <fieldset aria-label="Confirm abandon resolution">
              <p>
                Discard the resolution and abort the pinned merge? End the agent session first.
                Unrelated edits may remain; untracked files are kept.
              </p>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  onCommand({ action: 'abandon' });
                  setAbandon(false);
                }}
              >
                Abandon resolution and abort merge
              </button>
              <button type="button" disabled={busy} onClick={() => setAbandon(false)}>
                Keep resolution
              </button>
            </fieldset>
          )}
        </div>
      )}
      {owned && (
        <>
          <p className="hint">
            Pause the cycle before giving the agent guidance from its run page.
          </p>
          <About label="About conflict resolution">
            <p>
              Edits survive pause and restart. Stop preserves the resolution until you resume or
              abandon it.
            </p>
          </About>
        </>
      )}
    </section>
  );
}
