import type {
  ExecutionStatusResponse,
  IntegrationResolutionRequest,
} from '@craftingtable/contracts';
import { ownsIntegrationResolution, type AgentRunId, type WorkCycle } from '@craftingtable/domain';
import { useState } from 'react';
import { HandoffForm } from './HandoffForm.js';

export function IntegrationResolutionPanel({
  cycle,
  backends,
  busy,
  canMutate,
  onCommand,
  onOpenRun,
  runIds,
}: {
  cycle: WorkCycle;
  backends: ExecutionStatusResponse['backends'];
  busy: boolean;
  canMutate: boolean;
  onOpenRun: (id: AgentRunId) => void;
  runIds: readonly AgentRunId[];
  onCommand: (input: Omit<IntegrationResolutionRequest, 'expectedVersion'>) => void;
}) {
  const [form, setForm] = useState(false);
  const [abandon, setAbandon] = useState(false);
  const resolution = cycle.integrationResolution;
  const idle = ['paused', 'needs-attention'].includes(cycle.status);
  const owned = ownsIntegrationResolution(cycle);
  if (!idle && !resolution) return null;
  return (
    <section className="panel" aria-label="Integration conflicts">
      <h3>Integration conflicts</h3>
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
              Integration update committed: <code>{resolution.commitSha}</code>. Fresh review
              required.
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
              defaults={resolution.profile ?? cycle.profiles.remediate}
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
                Discard the pending merge resolution? This aborts the pinned integration merge.
                Unrelated edits may remain; untracked files will be preserved. End the agent session
                first.
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
        <p className="hint">
          Pause the cycle before giving the agent guidance from its run page. Edits survive pause
          and restart. Stop preserves the resolution until you resume or abandon it.
        </p>
      )}
    </section>
  );
}
