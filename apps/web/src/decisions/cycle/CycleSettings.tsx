import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  AGENT_PROFILE_PURPOSES,
  type AgentSelections,
  type CycleProjection,
  PROFILE_LABELS,
  SPECIALIST_PROFILES,
  selectAgent,
  type WorkCycle,
} from '@craftingtable/domain';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { AgentSelectionFields } from '../../features/execution/AgentSelectionFields.js';
import { AgentSelectionsEditor } from '../../features/execution/AgentSelectionsEditor.js';
import { controlCycle } from './cycle-api.js';

/**
 * The purposes whose selection differs from the cycle's agents now, compared as the daemon
 * compares them (`selectAgent`: backend, model, effort, whatever their key order; increment 4
 * review L-1).
 */
function changedAgents(now: AgentSelections, chosen: AgentSelections): Partial<AgentSelections> {
  const same = (a: AgentSelections[keyof AgentSelections], b: typeof a) =>
    !!a && !!b && JSON.stringify(selectAgent(a)) === JSON.stringify(selectAgent(b));
  return Object.fromEntries(
    AGENT_PROFILE_PURPOSES.flatMap((purpose) => {
      const selection = chosen[purpose];
      return selection && !same(selection, now[purpose]) ? [[purpose, selectAgent(selection)]] : [];
    }),
  ) as Partial<AgentSelections>;
}

/** The key that starts the form afresh: the cycle's version and its agents now (review L-2). */
export function cycleSettingsKey(
  cycle: Pick<WorkCycle, 'id' | 'version'>,
  projection: Pick<CycleProjection, 'nextAgentSelections'>,
): string {
  return `${cycle.id}:${cycle.version}:${JSON.stringify(projection.nextAgentSelections)}`;
}

/**
 * A stopped cycle's step time limit and agents for its remaining steps (R-C17 part 4, decisions
 * 3, 4 and 10): the one poster of the control's `change-settings`. Shown where the daemon offers
 * it; the cycle stays where it stands, and its next run uses the change. Key it with
 * `cycleSettingsKey`, so a changed cycle, or agents changed elsewhere, start it afresh.
 */
export function CycleSettings({
  cycle,
  projection,
  backends,
  csrfToken,
  disabled,
  onChanged,
  readOnly = false,
}: {
  cycle: WorkCycle;
  projection: Pick<CycleProjection, 'actions' | 'nextAgentSelections' | 'agents'>;
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  disabled: boolean;
  onChanged: () => void;
  /** A verification or parent-acceptance review, which launches only reviews (review L-4). */
  readOnly?: boolean;
}) {
  const now = projection.nextAgentSelections;
  const [minutes, setMinutes] = useState(cycle.policy.maxRunMinutes);
  const [agents, setAgents] = useState<AgentSelections>(now);
  const [busy, setBusy] = useState(false);
  // Sent: held until the cycle's new version starts the form afresh (review N-2).
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  if (!projection.actions.includes('change-settings')) return null;
  const agentChanges = changedAgents(now, agents);
  const minutesChanged = minutes !== cycle.policy.maxRunMinutes;
  const minutesValid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const changed = (minutesChanged || Object.keys(agentChanges).length > 0) && minutesValid;
  const locked = disabled || busy || sent;
  // A roadmap's cycle: its agents come from the roadmap's definition or an assignment (the daemon's
  // sources), whether or not the cycle records its owner (review N-5).
  const roadmapCycle =
    !!cycle.owner ||
    ['saved-definition', 'roadmap-assignment'].includes(
      projection.agents?.review.source.layer ?? '',
    );
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
          .then(() => {
            setSent(true);
            onChanged();
          })
          .catch((e: unknown) =>
            setError(e instanceof Error ? e.message : 'The settings were not changed.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      <About label="About these settings">
        <p>
          They apply to this cycle’s remaining steps: the time limit from the step’s next new run
          window (a service retry already pending keeps its own), the agents from its next launch.
          It stays {cycle.status === 'paused' ? 'paused' : 'stopped'} until you resume it. Each step
          keeps its permissions.
        </p>
        {roadmapCycle && (
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
      {!minutesValid && <p className="hint">Between 1 and 1440 minutes.</p>}
      {readOnly ? (
        <fieldset disabled={locked}>
          <legend>{PROFILE_LABELS.review}</legend>
          <AgentSelectionFields
            value={agents.review}
            onChange={(review) => setAgents({ ...agents, review })}
            backends={backends}
            disabled={locked}
          />
        </fieldset>
      ) : (
        <AgentSelectionsEditor
          value={agents}
          onChange={setAgents}
          backends={backends}
          disabled={locked}
          // An override in effect is changed here, not removed (review M-1).
          kept={SPECIALIST_PROFILES.filter((purpose) => !!now[purpose])}
        />
      )}
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
