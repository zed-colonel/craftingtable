import type { EvidenceSubmissionRecord, RuntimeEvidenceView } from '@craftingtable/contracts';
import type { AgentRunId, WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { readSubmission } from '../../lib/runtime-evidence-api.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import { planInputLabels } from '../plan-acceptance/plan-inputs.js';
import { EvidenceDecision } from './EvidenceDecision.js';

/**
 * One evidence submission for the operator's review (R-A6 rest): what it attests, its full
 * record, read when the review is opened (R-H4, LIVE-29), and its decision through
 * EvidenceDecision. The setup's evidence list, a checkpoint's item and a plan's acceptance
 * render it.
 */
export function EvidenceReview({
  workspaceId,
  definitionId,
  base,
  view,
  entry,
  csrfToken,
  disabled,
  unsavedSetup = false,
  id,
  initiallyOpen = false,
  onDecided,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  /** The API base of the map's dependency environment. */
  base: string;
  view: RuntimeEvidenceView;
  entry: RuntimeEvidenceView['submissions'][number];
  csrfToken: string;
  disabled: boolean;
  /** Unsaved setup beside it holds an attesting acceptance (UI-17). */
  unsavedSetup?: boolean;
  id?: string;
  /** Open at once, its record read: an item's own submission (R-A6 rest). */
  initiallyOpen?: boolean;
  /** The decision was recorded: the new view, and what to tell the operator. */
  onDecided: (view: RuntimeEvidenceView, notice: string) => void;
}) {
  const { submission: s, decision, issues } = entry;
  const [open, setOpen] = useState(initiallyOpen);
  /** The full record; the view lists each submission without its bodies, and it never changes. */
  const [record, setRecord] = useState<EvidenceSubmissionRecord | 'loading' | 'failed'>();
  const loadRecord = () => {
    if (record && record !== 'failed') return;
    setRecord('loading');
    void readSubmission(base, s.id)
      .then(setRecord)
      .catch(() => setRecord('failed'));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: an item's submission is read once.
  useEffect(() => {
    if (initiallyOpen) loadRecord();
  }, []);
  const full = typeof record === 'object' ? record : undefined;
  const attests = !!(s.generatedPlan || s.architectureDecision || s.candidateCheckpoint);
  const reviewerRoles = view.subjects.find(
    (v) => v.subject.kind === s.subject.kind && v.subject.sourceId === s.subject.sourceId,
  )?.reviewerRoles;
  // The role the map declares for this subject, not one the browser assumes (R-F2).
  const asRoles = reviewerRoles?.length ? ` as ${reviewerRoles.join(', ')}` : '';
  return (
    <details
      id={id}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) loadRecord();
      }}
    >
      <summary>
        {s.subject.sourceId} · {decision?.outcome ?? 'awaiting review'}
        {issues.length ? ' · blocked or stale' : ''}
      </summary>
      <p>
        {s.architectureDecision
          ? 'Prepared decision packet'
          : `Environment ${s.environmentId} · tested`}{' '}
        {s.executedAt} · {s.executedBy}
      </p>
      <p>
        {s.architectureDecision ? (
          decision ? (
            `Architecture decision recorded by ${decision.decidedByUserId}${asRoles}.`
          ) : (
            'Your authenticated acceptance records decision-owner review. The source design remains a proposal until you approve.'
          )
        ) : s.candidateCheckpoint ? (
          s.candidateCheckpoint.delegatedReview ? (
            <>
              Independent agent checkpoint review recorded under saved roadmap responsibilities (
              {s.candidateCheckpoint.delegatedReview.roles.join(', ')}).{' '}
              <Link
                route={{
                  name: 'run',
                  workspaceId: workspaceId as WorkspaceId,
                  runId: s.candidateCheckpoint.runId as AgentRunId,
                }}
              >
                Read the checkpoint review
              </Link>
              . This is delegated evidence, not a claim of personal operator review.
            </>
          ) : decision ? (
            `Checkpoint review recorded by ${decision.decidedByUserId} (${decision.checkpointReviewRoles?.join(', ') ?? 'no roles recorded'}).`
          ) : (
            'Candidate checkpoint review pending. Inspect the retained review and receipts; accepting records your explicit checkpoint attestation.'
          )
        ) : s.generatedPlan ? (
          decision?.carriedFrom && s.generatedPlan.kind === 'saved-plan-v2' ? (
            `Plan acceptance carried forward by ${decision.decidedByUserId}${asRoles}; ${
              s.generatedPlan.changedInputs.length
                ? `this step changed: ${planInputLabels(s.generatedPlan.changedInputs)}`
                : 'this step changed no plan-acceptance input'
            }.`
          ) : decision ? (
            `Plan review recorded by ${decision.decidedByUserId}${asRoles}.`
          ) : (
            `Independent plan review pending: accepting below records your authenticated review${asRoles}. The daemon only collected setup facts.`
          )
        ) : (
          <>
            Independent reviewers:{' '}
            {s.reviewers.map((r) => `${r.identity} (${r.roles.join(', ')})`).join('; ')}
          </>
        )}
      </p>
      {s.architectureDecision && (
        <section aria-label="Decision text for review">
          <h4>
            {s.architectureDecision.coverage === 'clauses'
              ? 'Early clauses to approve'
              : 'Decision to approve'}
          </h4>
          {full?.architectureDecision && (
            <>
              <p style={{ whiteSpace: 'pre-wrap' }}>{full.architectureDecision.proposal}</p>
              <h4>Source references</h4>
              <p style={{ whiteSpace: 'pre-wrap' }}>{full.architectureDecision.sourceReferences}</p>
            </>
          )}
          {s.architectureDecision.consumers.length > 0 && (
            <ul>
              {s.architectureDecision.consumers.map((c) => (
                <li key={c.sliceId}>
                  {c.sliceId}: required before {c.phase};{' '}
                  {c.replacesFullCheckpoint
                    ? 'replaces this slice’s full-checkpoint gate'
                    : 'adds a definition prerequisite'}
                  .
                </li>
              ))}
            </ul>
          )}
          {full?.architectureDecision?.retainedObligations && (
            <>
              <h4>Full obligations retained</h4>
              <p style={{ whiteSpace: 'pre-wrap' }}>
                {full.architectureDecision.retainedObligations}
              </p>
            </>
          )}
          <p>
            This packet records a proposed decision, not test execution or a passing verification
            result.
          </p>
        </section>
      )}
      {!s.architectureDecision && (
        <p>
          Code:{' '}
          <code className="import-digest">
            {s.subjectCommit ?? 'upstream pins in recorded generation'}
          </code>
        </p>
      )}
      {s.testedCode?.map((c) => (
        <p key={c.alias}>
          Tested {c.alias}: <code className="import-digest">{c.commitSha}</code>
        </p>
      ))}
      {issues.length > 0 && (
        <ul>
          {distinct(issues).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {(record === 'loading' || record === 'failed') && (
        <p role="status">
          {record === 'failed'
            ? 'Could not load the full record. Close and reopen this review to try again.'
            : 'Loading the full record…'}
        </p>
      )}
      {s.artifacts.map((a) => (
        <details key={a.name}>
          <summary>{a.name}</summary>
          <code className="import-digest">SHA-256 {a.digest}</code>
          {full && (
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {full.artifacts.find((f) => f.name === a.name)?.content}
            </pre>
          )}
        </details>
      ))}
      {decision ? (
        <p>
          {decision.outcome} · {decision.rationale}
        </p>
      ) : (
        <EvidenceDecision
          key={s.id}
          workspaceId={workspaceId}
          definitionId={definitionId}
          csrfToken={csrfToken}
          submissionIds={[s.id]}
          labels={{
            rationale: 'Review decision rationale',
            accepted: 'Accept evidence',
            rejected: 'Reject evidence',
          }}
          {...(attests
            ? {
                attestation: s.candidateCheckpoint
                  ? `I reviewed the candidate evidence against every checkpoint requirement as ${reviewerRoles?.join(', ')}.`
                  : s.architectureDecision
                    ? `I reviewed the exact proposal, source references, scope and retained obligations${asRoles}. I authorize these decisions and any stated clause staging.`
                    : `I reviewed the saved plan, bindings, decisions, reviewer assignments and resources${asRoles}.`,
              }
            : {})}
          {...(s.candidateCheckpoint && reviewerRoles
            ? { checkpointReviewRoles: reviewerRoles }
            : {})}
          // Accepting attests to the record: only once it has been shown.
          acceptBlocked={issues.length > 0 || !full || (attests && unsavedSetup)}
          disabled={disabled}
          onDecided={(next, outcome) =>
            onDecided(
              next,
              s.architectureDecision && outcome === 'accepted'
                ? s.architectureDecision.coverage === 'clauses'
                  ? 'Early clauses approved. Your approval carries an accepted saved plan forward. Continue affected designs with the new decision packet.'
                  : 'Decision approved. Continue affected designs with the updated decision packet.'
                : s.generatedPlan && outcome === 'accepted'
                  ? 'Plan evidence accepted. Start or Resume the roadmap when ready.'
                  : `Evidence ${outcome}.`,
            )
          }
        />
      )}
    </details>
  );
}
