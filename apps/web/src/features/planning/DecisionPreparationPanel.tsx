import { ActionBar } from '../../components/ActionBar.js';
import { useCallback, useEffect, useState } from 'react';
import {
  decisionPreparationSettingsSchema,
  roadmapViewSchema,
  type DecisionPreparationSettings,
  type ExecutionStatusResponse,
} from '@craftingtable/contracts';
import { AGENT_BACKEND_LABELS, type AgentSelection, type Roadmap } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { configureDecisionPreparation } from '../../lib/roadmap-api.js';
import { ModelField } from '../execution/ModelField.js';
import { ReasoningEffortField } from '../execution/ReasoningEffortField.js';
import { About } from '../../components/About.js';

export function DecisionPreparationPanel({
  roadmap,
  backends,
  csrfToken,
  disabled,
  onChanged,
}: {
  roadmap: Roadmap;
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  disabled: boolean;
  /** The roadmap changed (the standing grant was saved). */
  onChanged?: () => void;
}) {
  const standing = roadmap.decisionPreparationGrant;
  const [grantEnabled, setGrantEnabled] = useState(standing?.enabled ?? false),
    [grantMinutes, setGrantMinutes] = useState(standing?.minutes ?? 30),
    [grantConcurrent, setGrantConcurrent] = useState(standing?.maxConcurrent ?? 1);
  // The saved grant wins when it changes (an amendment revokes it), so a stale form never
  // re-enables it (R-C3b review).
  useEffect(() => {
    setGrantEnabled(standing?.enabled ?? false);
    setGrantMinutes(standing?.minutes ?? 30);
    setGrantConcurrent(standing?.maxConcurrent ?? 1);
  }, [standing?.enabled, standing?.minutes, standing?.maxConcurrent]);
  // Like recovery delegation, the grant changes only while scheduling is paused.
  const grantLocked = disabled || !['draft', 'paused', 'needs-attention'].includes(roadmap.status);
  const [open, setOpen] = useState(false),
    [data, setData] = useState<DecisionPreparationSettings>(),
    [checkpoint, setCheckpoint] = useState('');
  const [profile, setProfile] = useState<AgentSelection>(),
    [minutes, setMinutes] = useState(30),
    [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const base = `/api/workspaces/${roadmap.workspaceId}/roadmaps/${roadmap.id}`;
  const refresh = useCallback(async () => {
    setData(await request(`${base}/decision-preparations`, decisionPreparationSettingsSchema));
  }, [base]);
  useEffect(() => {
    if (open)
      void refresh().catch((e) =>
        setMessage(e instanceof Error ? e.message : 'Could not load decisions.'),
      );
  }, [open, refresh]);
  const current = data?.decisions.find((c) => c.id === checkpoint);
  const inFlight =
    !!current?.latest &&
    ['preparing', 'starting', 'running', 'waiting'].includes(current.latest.status);
  // Preparation proposes only, so it may run beside the roadmap (R-C3b, ADR-065).
  const locked =
    disabled ||
    busy ||
    !data ||
    !['draft', 'paused', 'needs-attention', 'running'].includes(roadmap.status);
  const prepare = async () => {
    if (!data || !profile) return;
    setBusy(true);
    setMessage('');
    try {
      await request(`${base}/prepare-decision`, roadmapViewSchema, {
        method: 'POST',
        headers: { 'x-craftingtable-csrf': csrfToken },
        body: JSON.stringify({
          expectedVersion: data.version,
          checkpointId: checkpoint,
          profile,
          minutes,
          instructions: guidance,
        }),
      });
      setMessage(
        'Preparation started. When it finishes, refresh here to read its recommendation in Shared architecture decisions. No decision is approved automatically.',
      );
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not prepare decision.');
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const saveGrant = async () => {
    setBusy(true);
    setMessage('');
    try {
      await configureDecisionPreparation(
        roadmap,
        {
          expectedVersion: roadmap.version,
          enabled: grantEnabled,
          minutes: grantMinutes,
          maxConcurrent: grantConcurrent,
        },
        csrfToken,
      );
      onChanged?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save standing preparation.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      id={`decision-preparation-${roadmap.id}`}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Prepare architecture decision briefs</summary>
      <p>
        A read-only run: no implementation, merge or approval authority. It may run while the
        roadmap runs.
      </p>
      <About label="About decision briefs">
        <p>
          Prepare a recommendation before its owning development slice is eligible. CraftingTable
          supplies the exact imported plan documents, existing shared decisions and a separate
          integration snapshot.
        </p>
        <p>
          With standing preparation on, CraftingTable prepares every decision a selected slice still
          needs while the roadmap runs, those that unblock the most slices first. You still approve
          each decision, with scheduling paused. Change it while the roadmap is paused.
        </p>
      </About>
      <fieldset className="field">
        <p role="status">
          {standing?.enabled
            ? `Standing preparation: up to ${standing.maxConcurrent} at a time, ${standing.minutes} min each`
            : 'Standing preparation: off'}
        </p>
        <label>
          <input
            type="checkbox"
            disabled={grantLocked || busy}
            checked={grantEnabled}
            onChange={(e) => setGrantEnabled(e.target.checked)}
          />{' '}
          Prepare needed decisions while the roadmap runs
        </label>
        <label>
          Minutes per preparation
          <input
            type="number"
            disabled={grantLocked || busy}
            min={5}
            max={60}
            value={grantMinutes}
            onChange={(e) => setGrantMinutes(Number(e.target.value))}
          />
        </label>
        <label>
          Preparations at once
          <select
            disabled={grantLocked || busy}
            value={grantConcurrent}
            onChange={(e) => setGrantConcurrent(Number(e.target.value))}
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
          disabled={grantLocked || busy}
          onClick={() => void saveGrant()}
        >
          Save standing preparation
        </button>
      </fieldset>
      <label className="field">
        Decision to prepare
        <select
          value={checkpoint}
          disabled={locked}
          onChange={(e) => {
            setCheckpoint(e.target.value);
            setProfile(data?.decisions.find((c) => c.id === e.target.value)?.profile);
          }}
        >
          <option value="">Choose a decision to prepare</option>
          {data?.decisions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} · {c.title}
            </option>
          ))}
        </select>
      </label>
      {profile && (
        <>
          <label className="field">
            Preparation agent
            <select
              value={profile.backend}
              disabled={locked}
              onChange={(e) => setProfile({ backend: e.target.value as AgentSelection['backend'] })}
            >
              {backends
                .filter((b) => b.available || b.kind === profile.backend)
                .map((b) => (
                  <option key={b.kind} value={b.kind} disabled={!b.available}>
                    {AGENT_BACKEND_LABELS[b.kind]}
                  </option>
                ))}
            </select>
          </label>
          <ModelField
            models={backends.find((b) => b.kind === profile.backend)?.models ?? []}
            value={profile.model ?? ''}
            disabled={locked}
            onChange={(model) => {
              const { model: _old, ...rest } = profile;
              setProfile(model ? { ...rest, model } : rest);
            }}
          />
          {profile.backend === 'codex' && (
            <ReasoningEffortField
              value={profile.reasoningEffort}
              disabled={locked}
              onChange={(effort) => {
                const { reasoningEffort: _old, ...rest } = profile;
                setProfile(effort ? { ...rest, reasoningEffort: effort } : rest);
              }}
            />
          )}
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
          value={guidance}
          maxLength={8000}
          disabled={locked}
          onChange={(e) => setGuidance(e.target.value)}
        />
      </label>
      <ActionBar label="Decision preparation actions">
        <button
          type="button"
          className="primary-button"
          disabled={
            locked ||
            !checkpoint ||
            !profile ||
            inFlight ||
            minutes < 5 ||
            minutes > 60 ||
            !Number.isInteger(minutes)
          }
          onClick={() => void prepare()}
        >
          Prepare decision brief
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            void refresh()
              .then(() =>
                window.dispatchEvent(
                  new CustomEvent('craftingtable:runtime-saved', {
                    detail: roadmap.definition.crossProject?.definitionId,
                  }),
                ),
              )
              .catch((e) => setMessage(e instanceof Error ? e.message : 'Could not refresh.'));
          }}
        >
          Refresh preparation status and decisions
        </button>
      </ActionBar>
      {current?.latest && (
        <p>
          Latest preparation: {current.latest.status} ·{' '}
          <a href={`/workspaces/${roadmap.workspaceId}/runs/${current.latest.runId}`}>
            Open preparation run
          </a>
          {current.latest.summary && <span> · {current.latest.summary.slice(0, 600)}</span>}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
