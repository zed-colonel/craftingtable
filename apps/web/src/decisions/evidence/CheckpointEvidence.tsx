import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { distinct } from '../../lib/distinct.js';
import { EvidenceReview } from './EvidenceReview.js';
import { SubmitEvidence } from './SubmitEvidence.js';

/**
 * A map checkpoint's evidence decision, alone (R-A6 rest, A2): what the checkpoint requires,
 * each submission for it to review, and a form to submit evidence for it. A
 * `checkpoint-evidence` item renders it in place of the roadmap's whole evidence step.
 */
export function CheckpointEvidence({
  workspaceId,
  definitionId,
  base,
  view,
  checkpointId,
  csrfToken,
  canMutate,
  onChanged,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  /** The API base of the map's dependency environment. */
  base: string;
  view: RuntimeEvidenceView;
  checkpointId: string;
  csrfToken: string;
  canMutate: boolean;
  onChanged: (view: RuntimeEvidenceView) => void;
}) {
  const [notice, setNotice] = useState('');
  const subject = view.subjects.find(
    (s) => s.subject.kind === 'checkpoint' && s.subject.sourceId === checkpointId,
  );
  const submissions = view.submissions.filter(
    (s) =>
      s.submission.subject.kind === 'checkpoint' && s.submission.subject.sourceId === checkpointId,
  );
  // Only the newest submission awaiting review opens at once; the rest read on request (R-H4).
  const newestUndecided = submissions
    .filter((s) => !s.decision)
    .sort((a, b) => b.submission.createdAt.localeCompare(a.submission.createdAt))[0]?.submission.id;
  return (
    <section className="panel stack" aria-label={`${checkpointId} evidence`}>
      <h3>{checkpointId} · checkpoint evidence</h3>
      {subject ? (
        <>
          <p>
            {subject.title} · profile {subject.profile}
          </p>
          {subject.reviewerRoles.length > 0 && (
            <p>Required independent roles: {subject.reviewerRoles.join(', ')}</p>
          )}
          <ul>
            {distinct(subject.requirements).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="empty-state">This map has no evidence subject named {checkpointId}.</p>
      )}
      {submissions.length === 0 && <p>No evidence has been submitted for this checkpoint.</p>}
      {submissions.map((entry) => (
        <EvidenceReview
          key={entry.submission.id}
          workspaceId={workspaceId}
          definitionId={definitionId}
          base={base}
          view={view}
          entry={entry}
          csrfToken={csrfToken}
          disabled={!canMutate}
          initiallyOpen={entry.submission.id === newestUndecided}
          onDecided={(next, message) => {
            onChanged(next);
            setNotice(message);
          }}
        />
      ))}
      {notice && <p role="status">{notice}</p>}
      {subject && (
        <SubmitEvidence
          base={base}
          view={view}
          csrfToken={csrfToken}
          disabled={!canMutate}
          subject={`checkpoint:${checkpointId}`}
          onSubmitted={onChanged}
        />
      )}
    </section>
  );
}
