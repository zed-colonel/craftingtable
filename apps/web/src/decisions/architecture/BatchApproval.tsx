import { useState } from 'react';
import type { ArchitectureDecisionInbox, RuntimeEvidenceView } from '@craftingtable/contracts';
import { About } from '../../components/About.js';
import { EvidenceDecision } from '../evidence/EvidenceDecision.js';

/**
 * Several saved proposals approved in one pause (R-C3b): each is reviewed on its own, one
 * rationale covers them, and each is approved through the same command as its card.
 */
export function BatchApproval({
  data,
  csrfToken,
  disabled,
  onChanged,
}: {
  data: ArchitectureDecisionInbox;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
}) {
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState('');
  const saved = data.decisions.flatMap((card) => {
    const record = card.records.find((r) => !r.decision && !r.issues.length && r.applicable);
    return record && !card.blockers.length ? [{ card, record }] : [];
  });
  if (saved.length < 2) return null;
  const locked = disabled || !!data.blockers.length;
  const chosen = saved.filter(({ record }) => reviewed.has(record.id));
  return (
    <section className="panel stack" aria-label="Approve saved decisions">
      <h3>Approve saved decisions</h3>
      <About label="About approving several decisions">
        <p>
          Approve saved proposals together while scheduling is paused. Review each exact text first;
          one rationale is recorded with each approval.
        </p>
      </About>
      {saved.map(({ card, record }) => (
        <label key={record.id} className="field">
          <input
            type="checkbox"
            disabled={locked}
            checked={reviewed.has(record.id)}
            onChange={(e) => {
              const next = new Set(reviewed);
              if (e.target.checked) next.add(record.id);
              else next.delete(record.id);
              setReviewed(next);
            }}
          />{' '}
          {`Reviewed ${card.checkpointId} (${record.proposal.coverage === 'full' ? 'full' : 'limited'}): ${record.proposal.proposal}`}
        </label>
      ))}
      <EvidenceDecision
        workspaceId={data.workspaceId}
        definitionId={data.definitionId}
        csrfToken={csrfToken}
        submissionIds={chosen.map(({ record }) => record.id)}
        outcomes={['accepted']}
        labels={{
          rationale: 'Approval rationale for the batch',
          accepted: 'Approve reviewed decisions',
          actions: 'Batch approval',
        }}
        disabled={locked}
        name={(id) => chosen.find(({ record }) => record.id === id)?.card.checkpointId ?? id}
        onDecided={async (next, _outcome, submissionId) => {
          const approved = chosen.find(({ record }) => record.id === submissionId);
          await onChanged(next);
          if (submissionId === chosen.at(-1)?.record.id) {
            setReviewed(new Set());
            setMessage(`Approved ${chosen.map(({ card }) => card.checkpointId).join(', ')}.`);
          } else if (approved) setMessage(`Approved ${approved.card.checkpointId}…`);
        }}
      />
      {message && <p role="status">{message}</p>}
    </section>
  );
}
