import { useCallback, useEffect, useState } from 'react';
import {
  decisionPreparationSettingsSchema,
  roadmapViewSchema,
  type DecisionPreparationGrantRequest,
  type DecisionPreparationSettings,
} from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  type AgentRunId,
  type AgentSelection,
  type Roadmap,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useExecutionStatus } from '../../app/reads.js';
import { About } from '../../components/About.js';
import { ModelField } from '../../features/execution/ModelField.js';
import { ReasoningEffortField } from '../../features/execution/ReasoningEffortField.js';
import { request } from '../../lib/api-client.js';
import { Link } from '../../lib/navigation.js';

/**
 * The decision-preparation commands (R-A6): starting a brief for one decision
 * (`roadmaps/:id/prepare-decision`) and the roadmap's standing grant
 * (`roadmaps/:id/decision-preparation-grant`). Private to this module.
 */
const roadmapBase = (workspaceId: string, roadmapId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmaps/${encodeURIComponent(roadmapId)}`;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
const loadSettings = (workspaceId: string, roadmapId: string) =>
  request(
    `${roadmapBase(workspaceId, roadmapId)}/decision-preparations`,
    decisionPreparationSettingsSchema,
  );
/** Preparation proposes only, so it may run beside the roadmap (R-C3b, ADR-065). */
const PREPARING_STATUSES: readonly string[] = ['draft', 'paused', 'needs-attention', 'running'];
const LIVE = ['preparing', 'starting', 'running', 'waiting'];

/**
 * Starts an agent-prepared brief for one decision, with the decision's own agent unless the
 * operator chooses another, a time limit and optional guidance (R-A6 rest: the roadmap's
 * preparation panel folded into the decision's card). It reads the roadmap's version as it is
 * when started, since another card's preparation moves it, and shows the latest preparation.
 * The agent proposes only; nothing is approved.
 */
export function PrepareDecisionBrief({
  workspaceId,
  roadmapId,
  csrfToken,
  checkpointId,
  disabled = false,
  refreshOn,
}: {
  workspaceId: string;
  roadmapId: string;
  csrfToken: string;
  checkpointId: string;
  disabled?: boolean;
  /**
   * Read the preparations again when this changes: the decision's view, which the store reads
   * again on the roadmap's and map's events, so a finished preparation is seen (R-A6 review).
   */
  refreshOn?: unknown;
}) {
  const [settings, setSettings] = useState<DecisionPreparationSettings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [profile, setProfile] = useState<AgentSelection>();
  const [minutes, setMinutes] = useState(30);
  const [instructions, setInstructions] = useState('');
  const backends = useExecutionStatus().data?.backends ?? [];
  const load = useCallback(
    () =>
      loadSettings(workspaceId, roadmapId)
        .then(setSettings)
        .catch((e) => setMessage(e instanceof Error ? e.message : 'Could not load preparation.')),
    [workspaceId, roadmapId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view is a reason to read again.
  useEffect(() => {
    void load();
  }, [load, refreshOn]);
  const decision = settings?.decisions.find((d) => d.id === checkpointId);
  const latest = decision?.latest;
  const inFlight = !!latest && LIVE.includes(latest.status);
  const agent = profile ?? decision?.profile;
  const locked = disabled || busy || !settings || !PREPARING_STATUSES.includes(settings.status);
  const validMinutes = Number.isInteger(minutes) && minutes >= 5 && minutes <= 60;
  const prepare = async () => {
    if (!decision || !agent) return;
    setBusy(true);
    setMessage('');
    try {
      const now = await loadSettings(workspaceId, roadmapId);
      await request(
        `${roadmapBase(workspaceId, roadmapId)}/prepare-decision`,
        roadmapViewSchema,
        mutation(csrfToken, {
          expectedVersion: now.version,
          checkpointId,
          profile: agent,
          minutes,
          instructions,
        }),
      );
      setMessage(
        'Preparation started. Its recommendation appears with the decision when it finishes; no decision is approved automatically.',
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not prepare the brief.');
    } finally {
      await load();
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="inline-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={locked || !decision || !agent || inFlight || !validMinutes}
          onClick={() => void prepare()}
        >
          Prepare decision brief
        </button>
        {inFlight && <span role="status">Preparing · {latest?.status}</span>}
        {message && <span role="status">{message}</span>}
      </div>
      <details>
        <summary>Preparation agent, time limit and guidance</summary>
        <p className="hint">A read-only run: no implementation, merge or approval authority.</p>
        {agent && (
          <>
            <label className="field">
              Preparation agent
              <select
                value={agent.backend}
                disabled={locked}
                onChange={(e) =>
                  setProfile({ backend: e.target.value as AgentSelection['backend'] })
                }
              >
                {backends
                  .filter((b) => b.available || b.kind === agent.backend)
                  .map((b) => (
                    <option key={b.kind} value={b.kind} disabled={!b.available}>
                      {AGENT_BACKEND_LABELS[b.kind]}
                    </option>
                  ))}
              </select>
            </label>
            <ModelField
              models={backends.find((b) => b.kind === agent.backend)?.models ?? []}
              catalog={backends.find((b) => b.kind === agent.backend)?.catalog}
              value={agent.model ?? ''}
              disabled={locked}
              onChange={(model) => {
                const { model: _old, ...rest } = agent;
                setProfile(model ? { ...rest, model } : rest);
              }}
            />
            <ReasoningEffortField
              backend={agent.backend}
              value={agent.reasoningEffort}
              disabled={locked}
              onChange={(effort) => {
                const { reasoningEffort: _old, ...rest } = agent;
                setProfile(effort ? { ...rest, reasoningEffort: effort } : rest);
              }}
            />
          </>
        )}
        <label className="field">
          Preparation time limit (minutes)
          <input
            type="number"
            min={5}
            max={60}
            value={minutes}
            disabled={locked}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <label className="field">
          Optional decision guidance
          <textarea
            value={instructions}
            maxLength={8000}
            disabled={locked}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
      </details>
      {latest && (
        <p>
          Latest preparation: {latest.status} ·{' '}
          <Link
            route={{
              name: 'run',
              workspaceId: workspaceId as WorkspaceId,
              runId: latest.runId as AgentRunId,
            }}
          >
            Open preparation run
          </Link>
          {latest.summary && <span> · {latest.summary.slice(0, 600)}</span>}
        </p>
      )}
    </div>
  );
}

/**
 * The roadmap's standing grant to prepare the decisions its slices need while it runs (R-C3b):
 * changed only while scheduling is paused. It stays in the roadmap's setup, on the decisions
 * step (R-A6 rest).
 */
export function StandingPreparation({
  roadmap,
  csrfToken,
  disabled,
  onSaved,
}: {
  roadmap: Roadmap;
  csrfToken: string;
  disabled: boolean;
  /** The roadmap changed (the grant was saved). */
  onSaved?: () => void;
}) {
  const standing = roadmap.decisionPreparationGrant;
  const [enabled, setEnabled] = useState(standing?.enabled ?? false),
    [minutes, setMinutes] = useState(standing?.minutes ?? 30),
    [concurrent, setConcurrent] = useState(standing?.maxConcurrent ?? 1);
  // The saved grant wins when it changes (an amendment revokes it), so a stale form never
  // re-enables it (R-C3b review).
  useEffect(() => {
    setEnabled(standing?.enabled ?? false);
    setMinutes(standing?.minutes ?? 30);
    setConcurrent(standing?.maxConcurrent ?? 1);
  }, [standing?.enabled, standing?.minutes, standing?.maxConcurrent]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // Like recovery delegation, the grant changes only while scheduling is paused.
  const locked =
    disabled || busy || !['draft', 'paused', 'needs-attention'].includes(roadmap.status);
  const grant: DecisionPreparationGrantRequest = {
    expectedVersion: roadmap.version,
    enabled,
    minutes,
    maxConcurrent: concurrent,
  };
  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      await request(
        `${roadmapBase(roadmap.workspaceId, roadmap.id)}/decision-preparation-grant`,
        roadmapViewSchema,
        mutation(csrfToken, grant),
      );
      onSaved?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save standing preparation.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="field" id={`standing-preparation-${roadmap.id}`}>
      <legend>Standing decision preparation</legend>
      <About label="About standing preparation">
        <p>
          With standing preparation on, CraftingTable prepares every decision a selected slice still
          needs while the roadmap runs, those that unblock the most slices first. You still approve
          each decision, with scheduling paused. Change it while the roadmap is paused.
        </p>
      </About>
      <p role="status">
        {standing?.enabled
          ? `Standing preparation: up to ${standing.maxConcurrent} at a time, ${standing.minutes} min each`
          : 'Standing preparation: off'}
      </p>
      <label>
        <input
          type="checkbox"
          disabled={locked}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{' '}
        Prepare needed decisions while the roadmap runs
      </label>
      <label>
        Minutes per preparation
        <input
          type="number"
          disabled={locked}
          min={5}
          max={60}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
      </label>
      <label>
        Preparations at once
        <select
          disabled={locked}
          value={concurrent}
          onChange={(e) => setConcurrent(Number(e.target.value))}
        >
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={locked}
        onClick={() => void save()}
      >
        Save standing preparation
      </button>
      {message && <p role="alert">{message}</p>}
    </fieldset>
  );
}
