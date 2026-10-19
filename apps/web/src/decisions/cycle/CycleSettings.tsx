import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  AGENT_PROFILE_PURPOSES,
  type AgentSelections,
  type CycleProjection,
  PROFILE_LABELS,
  type WorkCycle,
} from '@craftingtable/domain';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { AgentSelectionsEditor } from '../../features/execution/AgentSelectionsEditor.js';
import { controlCycle } from './cycle-api.js';

/** The purposes whose selection differs from the cycle's agents now. */
function changedAgents(now: AgentSelections, chosen: AgentSelections): Partial<AgentSelections> {
  return Object.fromEntries(
    AGENT_PROFILE_PURPOSES.flatMap((purpose) =>
      chosen[purpose] && JSON.stringify(chosen[purpose]) !== JSON.stringify(now[purpose])
        ? [[purpose, chosen[purpose]]]
        : [],
    ),
  ) as Partial<AgentSelections>;
}

/**
 * A stopped cycle's step time limit and agents for its remaining steps (R-C17 part 4, decisions
 * 3, 4 and 10): the one poster of the control's `change-settings`. Shown where the daemon offers
 * it; the cycle stays where it stands, and its next run uses the change. Key it by the cycle's
 * version, so a changed cycle starts it afresh from what it holds now.
 */
export function CycleSettings({
  cycle,
  projection,
  backends,
  csrfToken,
  disabled,
  onChanged,
}: {
  cycle: WorkCycle;
  projection: Pick<CycleProjection, 'actions' | 'nextAgentSelections'>;
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  disabled: boolean;
  onChanged: () => void;
}) {
  const now = projection.nextAgentSelections;
  const [minutes, setMinutes] = useState(cycle.policy.maxRunMinutes);
  const [agents, setAgents] = useState<AgentSelections>(now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!projection.actions.includes('change-settings')) return null;
  const agentChanges = changedAgents(now, agents);
  const minutesChanged = minutes !== cycle.policy.maxRunMinutes;
  const minutesValid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const changed = (minutesChanged || Object.keys(agentChanges).length > 0) && minutesValid;
  const locked = disabled || busy;
  return (
    <form
      className="stack-form"
      aria-label="Time limit and agents"
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || !changed) return;
        setBusy(true);
        setError('');
        controlCycle(
          cycle,
          {
            action: 'change-settings',
            expectedVersion: cycle.version,
            ...(minutesChanged ? { maxRunMinutes: minutes } : {}),
            ...(Object.keys(agentChanges).length ? { agents: agentChanges } : {}),
          },
          csrfToken,
        )
          .then(() => onChanged())
          .catch((e: unknown) =>
            setError(e instanceof Error ? e.message : 'The settings were not changed.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      <About label="About these settings">
        <p>
          They apply to this cycle’s remaining steps, from its next run; it stays{' '}
          {cycle.status === 'paused' ? 'paused' : 'stopped'} until you resume it. Each step keeps
          its permissions.
        </p>
        {cycle.owner && (
          <p>
            A roadmap cycle’s agents are applied to its roadmap entry as an assignment, which the
            entry’s later cycles use too.
          </p>
        )}
      </About>
      <label className="field">
        Minutes per step
        <input
          type="number"
          min={1}
          max={1440}
          value={minutes}
          disabled={locked}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
      <AgentSelectionsEditor
        value={agents}
        onChange={setAgents}
        backends={backends}
        disabled={locked}
      />
      {Object.keys(agentChanges).length > 0 && (
        <p className="hint">
          Changing:{' '}
          {Object.keys(agentChanges)
            .map((purpose) => PROFILE_LABELS[purpose as keyof typeof PROFILE_LABELS])
            .join(', ')}
          .
        </p>
      )}
      <button type="submit" className="secondary-button" disabled={locked || !changed}>
        Save time limit and agents
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
