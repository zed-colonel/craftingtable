import type { FinalizationView } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { promoteFinalization as promote } from './finalization-api.js';

/**
 * A finalization's promotion approval (R-A6 increment 2b): the exact candidate and destination
 * the final review saw, approved explicitly, with the integration branch's removal as an
 * option. Rendered only when the daemon offers `merge`.
 */
export function FinalPromotion({
  workspaceId,
  view,
  csrfToken,
  disabled,
  onDone,
}: {
  workspaceId: WorkspaceId;
  view: FinalizationView;
  csrfToken: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const f = view.finalization;
  const cycle = view.cycle;
  const reviewed = view.runs.find((r) => r.id === cycle?.currentRunId)?.reviewBranchContext;
  const [confirm, setConfirm] = useState<{ removeIntegrationBranch: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!(view.actions ?? []).includes('merge') || !cycle || !reviewed) return null;
  const locked = disabled || busy;
  return (
    <>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {!confirm ? (
        <button
          type="button"
          className="primary-button"
          disabled={locked}
          onClick={() => setConfirm({ removeIntegrationBranch: false })}
        >
          {view.mergeRecoveryPending ? 'Recover approved promotion' : 'Review final merge approval'}
        </button>
      ) : (
        <fieldset className="stack-form">
          <legend>Approve final promotion</legend>
          <p style={{ overflowWrap: 'anywhere' }}>
            Merge candidate <code>{reviewed.headSha}</code> into <code>{f.targetBranch}</code> at{' '}
            <code>{reviewed.targetSha}</code>. This requires your explicit approval and renewed
            review if either commit changes.
          </p>
          {view.targetCheckedOut === true && (
            <p className="hint">
              Promotion updates your checkout: {f.targetBranch} is checked out in the repository's
              primary checkout, so its files move to the promoted commit.
            </p>
          )}
          {!view.mergeRecoveryPending && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={confirm.removeIntegrationBranch}
                disabled={locked}
                onChange={(e) => setConfirm({ removeIntegrationBranch: e.target.checked })}
              />
              Remove local integration branch {f.integrationBranch} after successful promotion
            </label>
          )}
          <p className="hint">
            Branch removal keeps merged commits and plan history. If the branch changed or is in
            use, promotion still completes and cleanup can be retried.
          </p>
          <div className="inline-actions">
            <button
              type="button"
              className="primary-button"
              disabled={locked}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void promote(
                  workspaceId,
                  f.id,
                  {
                    expectedVersion: f.version,
                    expectedCycleVersion: cycle.version,
                    expectedHeadSha: reviewed.headSha,
                    expectedTargetSha: reviewed.targetSha,
                    removeIntegrationBranch: confirm.removeIntegrationBranch,
                  },
                  csrfToken,
                )
                  .then(() => setConfirm(undefined))
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  .then(() => onDone())
                  .finally(() => setBusy(false));
              }}
            >
              Approve merge into {f.targetBranch}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={locked}
              onClick={() => setConfirm(undefined)}
            >
              Cancel approval
            </button>
          </div>
        </fieldset>
      )}
    </>
  );
}
