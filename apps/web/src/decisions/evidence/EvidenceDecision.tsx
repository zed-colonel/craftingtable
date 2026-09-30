import { useState } from 'react';
import { runtimeEvidenceViewSchema, type RuntimeEvidenceView } from '@craftingtable/contracts';
import { ActionBar } from '../../components/ActionBar.js';
import { request } from '../../lib/api-client.js';

type Outcome = 'accepted' | 'rejected';

/**
 * The daemon's only evidence decision command, `runtime/decide` (R-A6). Private to this
 * module: every acceptance or rejection of evidence, a checkpoint, a saved plan or an
 * architecture decision is posted from `EvidenceDecision`.
 */
function decide(
  workspaceId: string,
  definitionId: string,
  csrfToken: string,
  input: {
    readonly submissionId: string;
    readonly outcome: Outcome;
    readonly rationale: string;
    readonly checkpointReviewRoles?: readonly string[];
  },
) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/concurrency-definitions/${encodeURIComponent(definitionId)}/runtime/decide`,
    runtimeEvidenceViewSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}

/**
 * Accepts or rejects evidence submissions, with a rationale and, where the host asks for one,
 * the operator's attestation. Several submissions reviewed together are decided in turn with
 * one rationale; the first refusal stops the rest.
 */
export function EvidenceDecision({
  workspaceId,
  definitionId,
  csrfToken,
  submissionIds,
  outcomes = ['accepted', 'rejected'],
  labels,
  attestation,
  checkpointReviewRoles,
  acceptBlocked = false,
  disabled = false,
  onDecided,
  onCancel,
  name = (id) => id,
}: {
  workspaceId: string;
  definitionId: string;
  csrfToken: string;
  /** What is decided; empty until the host has a submission chosen. */
  submissionIds: readonly string[];
  outcomes?: readonly Outcome[];
  labels: {
    readonly rationale: string;
    readonly accepted: string;
    readonly rejected?: string;
    readonly actions?: string;
  };
  /** The statement the operator ticks before accepting; no acceptance without it. */
  attestation?: string;
  /** Sent with an acceptance, for a checkpoint review's responsibilities. */
  checkpointReviewRoles?: readonly string[];
  /** Acceptance is not allowed now (open issues, a record not yet shown, unsaved setup). */
  acceptBlocked?: boolean;
  disabled?: boolean;
  onDecided: (
    view: RuntimeEvidenceView,
    outcome: Outcome,
    submissionId: string,
  ) => void | Promise<void>;
  onCancel?: { readonly label: string; readonly run: () => void };
  /** How a submission is named when several are decided and one is refused. */
  name?: (submissionId: string) => string;
}) {
  const [rationale, setRationale] = useState('');
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = disabled || busy;
  const submit = async (outcome: Outcome) => {
    setBusy(true);
    setError('');
    const decided: string[] = [];
    try {
      for (const submissionId of submissionIds) {
        const view = await decide(workspaceId, definitionId, csrfToken, {
          submissionId,
          outcome,
          rationale,
          ...(outcome === 'accepted' && checkpointReviewRoles ? { checkpointReviewRoles } : {}),
        });
        decided.push(name(submissionId));
        await onDecided(view, outcome, submissionId);
      }
      setRationale('');
      setAttested(false);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'The decision was not recorded.';
      setError(
        decided.length
          ? `${outcome === 'accepted' ? 'Approved' : 'Rejected'} ${decided.join(', ')}; stopped: ${reason}`
          : reason,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {attestation && (
        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={attested}
              disabled={locked || acceptBlocked}
              onChange={(e) => setAttested(e.target.checked)}
            />{' '}
            {attestation}
          </span>
        </label>
      )}
      <label className="field">
        {labels.rationale}
        <textarea
          value={rationale}
          disabled={locked}
          maxLength={16000}
          onChange={(e) => setRationale(e.target.value)}
        />
      </label>
      <ActionBar label={labels.actions ?? 'Evidence decision'}>
        {outcomes.map((outcome) => (
          <button
            key={outcome}
            type="button"
            className={outcome === 'accepted' ? 'primary-button' : 'secondary-button'}
            disabled={
              locked ||
              !submissionIds.length ||
              !rationale.trim() ||
              (outcome === 'accepted' && (acceptBlocked || (!!attestation && !attested)))
            }
            onClick={() => void submit(outcome)}
          >
            {outcome === 'accepted' ? labels.accepted : (labels.rejected ?? 'Reject')}
          </button>
        ))}
        {onCancel && (
          <button type="button" disabled={locked} onClick={onCancel.run}>
            {onCancel.label}
          </button>
        )}
      </ActionBar>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
