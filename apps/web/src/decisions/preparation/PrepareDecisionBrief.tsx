import { useCallback, useEffect, useState } from 'react';
import {
  decisionPreparationSettingsSchema,
  roadmapViewSchema,
  type DecisionPreparationGrantRequest,
  type DecisionPreparationSettings,
} from '@craftingtable/contracts';
import type { AgentSelection } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

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

/**
 * Starts an agent-prepared brief for one decision. It reads the roadmap's version as it is
 * when started, since another card's preparation moves it. The agent proposes only.
 */
export function PrepareDecisionBrief({
  workspaceId,
  roadmapId,
  csrfToken,
  checkpointId,
  profile,
  minutes = 30,
  instructions = '',
  disabled = false,
  onStarted,
}: {
  workspaceId: string;
  roadmapId: string;
  csrfToken: string;
  checkpointId: string;
  /** The agent to use; the decision's own profile when absent. */
  profile?: AgentSelection | undefined;
  minutes?: number;
  instructions?: string;
  disabled?: boolean;
  onStarted?: () => void | Promise<void>;
}) {
  const [settings, setSettings] = useState<DecisionPreparationSettings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(
    () =>
      loadSettings(workspaceId, roadmapId)
        .then(setSettings)
        .catch((e) => setMessage(e instanceof Error ? e.message : 'Could not load preparation.')),
    [workspaceId, roadmapId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const decision = settings?.decisions.find((d) => d.id === checkpointId);
  const latest = decision?.latest;
  const inFlight =
    !!latest && ['preparing', 'starting', 'running', 'waiting'].includes(latest.status);
  const agent = profile ?? decision?.profile;
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
      await onStarted?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not prepare the brief.');
    } finally {
      await load();
      setBusy(false);
    }
  };
  return (
    <div className="inline-actions">
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || busy || !decision || !agent || inFlight}
        onClick={() => void prepare()}
      >
        Prepare decision brief
      </button>
      {inFlight && <span role="status">Preparing · {latest?.status}</span>}
      {message && <span role="status">{message}</span>}
    </div>
  );
}

/** Saves the roadmap's standing grant to prepare the decisions its slices need (R-C3b). */
export function SaveStandingPreparation({
  workspaceId,
  roadmapId,
  csrfToken,
  grant,
  disabled = false,
  onSaved,
}: {
  workspaceId: string;
  roadmapId: string;
  csrfToken: string;
  grant: DecisionPreparationGrantRequest;
  disabled?: boolean;
  onSaved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      await request(
        `${roadmapBase(workspaceId, roadmapId)}/decision-preparation-grant`,
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
    <>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || busy}
        onClick={() => void save()}
      >
        Save standing preparation
      </button>
      {message && <p role="alert">{message}</p>}
    </>
  );
}
