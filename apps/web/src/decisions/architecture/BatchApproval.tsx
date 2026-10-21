import { useState } from 'react';
import type { ArchitectureDecisionInbox, RuntimeEvidenceView } from '@craftingtable/contracts';
import { About } from '../../components/About.js';
import { EvidenceDecision } from '../evidence/EvidenceDecision.js';

/**
 * Several saved proposals approved together (R-C3b): each is reviewed on its own, one rationale
 * covers them, and each is approved through the same command as its card. Beside a running
 * roadmap each is decided on its own (R-B6, decision 12): one refused, because work started on a
 * tree it is an input of, stays selected with its reason while the rest are approved.
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
  /** The decisions this batch approved, named in its status (review L-5). */
  const [approvedNow, setApprovedNow] = useState<readonly string[]>([]);
  const saved = data.decisions.flatMap((card) => {
    const record = card.records.find((r) => !r.decision && !r.issues.length && r.applicable);
    return record && !card.blockers.length ? [{ card, record }] : [];
  });
  // Kept while a batch has something to show: a refused proposal still selected, or what it
  // approved, though fewer than two saved proposals are left (increment 3 review M-2).
  if (saved.length < 2 && !reviewed.size && !approvedNow.length) return null;
  const locked = disabled || !!data.blockers.length;
  const chosen = saved.filter(({ record }) => reviewed.has(record.id));
  return (
    <section className="panel stack" aria-label="Approve saved decisions">
      <h3>Approve saved decisions</h3>
      <About label="About approving several decisions">
        <p>
          Approve saved proposals together. Review each exact text first; one rationale is recorded
          with each approval. A proposal whose inputs are still in use by running work waits, and is
          left selected if it is refused.
        </p>
      </About>
      {saved.map(({ card, record }) => (
        <label key={record.id} className="field">
          <input
            type="checkbox"
            // One that started waiting while selected can still be unticked (review L-5).
            disabled={locked || (!!record.waits?.length && !reviewed.has(record.id))}
            checked={reviewed.has(record.id)}
            onChange={(e) => {
              setApprovedNow([]);
              const next = new Set(reviewed);
              if (e.target.checked) next.add(record.id);
              else next.delete(record.id);
              setReviewed(next);
            }}
          />{' '}
          {`Reviewed ${card.checkpointId} (${record.proposal.coverage === 'full' ? 'full' : 'limited'}): ${record.proposal.proposal}`}
          {!!record.waits?.length && <span className="hint"> Waits: {record.waits.join(' ')}</span>}
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
        each
        name={(id) => chosen.find(({ record }) => record.id === id)?.card.checkpointId ?? id}
        onDecided={async (next, _outcome, submissionId) => {
          const approved = chosen.find(({ record }) => record.id === submissionId);
          await onChanged(next);
          // An approved one leaves the selection; a refused one stays, with its reason.
          setReviewed((current) => {
            const left = new Set(current);
            left.delete(submissionId);
            return left;
          });
          if (approved) setApprovedNow((now) => [...now, approved.card.checkpointId]);
        }}
      />
      {approvedNow.length > 0 && <p role="status">Approved {approvedNow.join(', ')}.</p>}
    </section>
  );
}
