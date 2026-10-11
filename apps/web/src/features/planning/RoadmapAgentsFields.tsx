import type { ExecutionStatusResponse, RunProfilesResponse } from '@craftingtable/contracts';
import {
  type AgentSelections,
  CYCLE_STEPS,
  PROFILE_LABELS,
  SPECIALIST_PROFILES,
} from '@craftingtable/domain';
import { About } from '../../components/About.js';
import { AgentSelectionsEditor } from '../execution/AgentSelectionsEditor.js';
import { EffectiveAgentText } from '../execution/EffectiveAgentText.js';

type EffectiveAgents = NonNullable<RunProfilesResponse['agents']>;

/**
 * A roadmap scope's agents in its setup form (R-E5b, E5-1 as amended 2026-10-11): each purpose's
 * effective agent with its source, as the daemon reports it, and on request an editor. The form
 * applies a changed set as an ADR-064 assignment when it saves; the step permissions are the
 * form's other fields and stay in the saved definition.
 */
export function RoadmapAgentsFields({
  legend,
  agents,
  selections,
  differing = 1,
  value,
  onChange,
  backends,
  disabled,
  locked,
}: {
  legend: string;
  /** Each purpose's effective agent: the scope's first entry's, or the workspace default's. */
  agents: EffectiveAgents | undefined;
  /** The selection set the editor starts from. */
  selections: AgentSelections | undefined;
  /** How many different agent sets the scope's entries use now. */
  differing?: number;
  /** The changed set, or nothing while the agents are kept. */
  value: AgentSelections | undefined;
  onChange: (value: AgentSelections | undefined) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
  /** Why the agents cannot change now, from the daemon (a running roadmap, a pending amendment). */
  locked?: string | null;
}) {
  return (
    <fieldset className="stack-form" disabled={disabled}>
      <legend>{legend}</legend>
      {agents ? (
        <ul className="agent-list">
          {CYCLE_STEPS.map((step) => (
            <li key={step}>
              {PROFILE_LABELS[step]}: <EffectiveAgentText agent={agents[step]} purpose={step} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Loading the current agents…</p>
      )}
      {agents && (
        <details>
          <summary>Specialist agents</summary>
          <ul className="agent-list">
            {SPECIALIST_PROFILES.map((purpose) => (
              <li key={purpose}>
                {PROFILE_LABELS[purpose]}:{' '}
                <EffectiveAgentText agent={agents[purpose]} purpose={purpose} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {differing > 1 && (
        <p className="hint">
          These entries use {differing} different agent sets; shown is the first. A change applies
          one set to all of them.
        </p>
      )}
      {locked && <p className="hint">{locked}</p>}
      {value === undefined ? (
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || !!locked || !selections}
          onClick={() => selections && onChange(structuredClone(selections))}
        >
          Change agents
        </button>
      ) : (
        <>
          <AgentSelectionsEditor
            value={value}
            onChange={onChange}
            backends={backends}
            disabled={disabled}
          />
          <p className="hint">
            Saved as a roadmap assignment: future runs, later steps of started entries included.
            Plan acceptance is unaffected.
          </p>
          <button type="button" className="secondary-button" onClick={() => onChange(undefined)}>
            Keep current agents
          </button>
        </>
      )}
      <About label="About agent precedence">
        <p>
          Highest first: a change for one action, a finalization stage, this roadmap's assignment,
          its saved definition, the workspace default, then the daemon's default.
        </p>
      </About>
    </fieldset>
  );
}
