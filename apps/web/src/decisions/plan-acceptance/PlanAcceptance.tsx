import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { generatePlanEvidence } from '../../lib/runtime-evidence-api.js';
import { distinct } from '../../lib/distinct.js';
import { revealElement } from '../../lib/reveal-element.js';
import { EvidenceReview } from '../evidence/EvidenceReview.js';
import { planInputLabels } from './plan-inputs.js';

/**
 * The plan-evidence generation command, `runtime/generate-plan` (R-A6 rest): the daemon collects
 * the saved plan's facts for the operator's review. Private to this module; accepting the plan
 * is an evidence decision (EvidenceDecision).
 */
function generatePlan(
  base: string,
  csrfToken: string,
  input: {
    readonly roadmapId: string;
    readonly definitionRevision: number;
    readonly snapshotDigest: string;
  },
) {
  return generatePlanEvidence(base, input, csrfToken);
}

/**
 * A saved plan's acceptance (R-A6 rest): its state, the carried acceptance R-C6 records, the
 * evidence to generate, and its review. In setup the review opens in the evidence list; a
 * plan-acceptance item reviews it in place (`inline`).
 */
export function PlanAcceptance({
  workspaceId,
  definitionId,
  base,
  view,
  roadmapId,
  csrfToken,
  disabled,
  unsaved = false,
  panelId,
  inline = false,
  onChanged,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  /** The API base of the map's dependency environment. */
  base: string;
  view: RuntimeEvidenceView;
  /** One roadmap's plan; every roadmap's on the map's page. */
  roadmapId?: string | undefined;
  csrfToken: string;
  disabled: boolean;
  /** Unsaved roadmap or dependency settings beside it: generation and acceptance wait. */
  unsaved?: boolean;
  panelId: string;
  inline?: boolean;
  onChanged: (view: RuntimeEvidenceView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const planAcceptance = view.planAcceptance;
  if (!planAcceptance) return null;
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id={`${panelId}-plan-acceptance`} aria-label="Saved plan acceptance">
      <h4>Saved plan acceptance · {planAcceptance.checkpoint}</h4>
      {unsaved && (
        <p role="alert">
          Unsaved roadmap or dependency settings: save them before generating or accepting plan
          evidence. The current evidence describes only the last saved revision.
        </p>
      )}
      <p>
        Evidence comes from the saved roadmap and dependency setup, not unsaved edits. Generation
        records facts; your separate review and acceptance approve the plan.
      </p>
      {!inline && !planAcceptance.roadmaps.length && (
        <p>Save a cross-project roadmap first using Create cross-project roadmap above.</p>
      )}
      {planAcceptance.roadmaps
        .filter((r) => !roadmapId || r.roadmapId === roadmapId)
        .map((r) => (
          <div key={r.roadmapId}>
            <p>
              <strong>{r.name}</strong> · Saved revision {r.definitionRevision} · Binding{' '}
              {view.bindingRevision} · Environment generation{' '}
              {view.current?.generation ?? 'not saved'}
            </p>
            <p role="status">
              {r.state === 'accepted'
                ? r.carried
                  ? `Accepted, carried from your review of ${new Date(
                      r.carried.reviewedAt,
                    ).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}; ${
                      r.carried.changedInputs.length
                        ? `changed: ${planInputLabels(r.carried.changedInputs)}`
                        : 'no plan-acceptance input changed'
                    }. Start or Resume remains your action.`
                  : 'Plan evidence accepted. Your saves, dependency refreshes and setup, and clause approvals carry it forward; an amendment or a new map or binding needs your review. Start or Resume remains your action.'
                : r.state === 'awaiting-review'
                  ? 'Evidence generated — awaiting your plan review.'
                  : r.state === 'ready-to-generate'
                    ? 'Saved configuration is ready to generate plan evidence.'
                    : 'Saved configuration needs attention before evidence can be generated.'}
            </p>
            {r.issues.length > 0 && (
              <ul>
                {distinct(r.issues).map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            <ActionBar label="Plan acceptance actions">
              <button
                type="button"
                className="primary-button"
                disabled={disabled || busy || unsaved || r.state !== 'ready-to-generate'}
                onClick={() =>
                  void act(async () => {
                    const next = await generatePlan(base, csrfToken, {
                      roadmapId: r.roadmapId,
                      definitionRevision: r.definitionRevision,
                      snapshotDigest: r.snapshotDigest,
                    });
                    onChanged(next);
                    const generated = next.planAcceptance?.roadmaps.find(
                      (p) => p.roadmapId === r.roadmapId,
                    );
                    setNotice(
                      'Plan evidence generated. Inspect the saved facts below, then record your independent plan review. No checkpoint has been accepted.',
                    );
                    if (generated?.submissionId && !inline)
                      revealElement(`${panelId}-submission-${generated.submissionId}`);
                  })
                }
              >
                Generate plan-acceptance evidence
              </button>
              {r.submissionId && !inline && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => revealElement(`${panelId}-submission-${r.submissionId}`)}
                >
                  Review generated plan evidence
                </button>
              )}
            </ActionBar>
            {inline &&
              r.state === 'awaiting-review' &&
              view.submissions
                .filter((entry) => entry.submission.id === r.submissionId)
                .map((entry) => (
                  <EvidenceReview
                    key={entry.submission.id}
                    workspaceId={workspaceId}
                    definitionId={definitionId}
                    base={base}
                    view={view}
                    entry={entry}
                    csrfToken={csrfToken}
                    disabled={disabled}
                    unsavedSetup={unsaved}
                    initiallyOpen
                    onDecided={(next, message) => {
                      onChanged(next);
                      setNotice(message);
                    }}
                  />
                ))}
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
