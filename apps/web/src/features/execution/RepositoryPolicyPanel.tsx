import type { RepositoryPolicyEvidence } from '@craftingtable/contracts';
import type { PlanVersionId, WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { loadRepositoryPolicy, saveRepositoryPolicy } from '../../lib/branch-api.js';
import { distinct } from '../../lib/distinct.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import { About } from '../../components/About.js';

const INTERPRETATION =
  'For this plan, integration branch protection means CraftingTable-controlled work-item/slice branches, review of exact source and target commits, and controller-mediated integration under the configured merge policy. Where an experimental freeze is recorded below, that baseline receives no further feature work; evidence extraction remains permitted. Final promotion remains an explicit operator decision. These are local workflow controls, not a claim that remote hosting protections have been configured.';
const PUBLICATION =
  'The operator must configure and independently verify applicable remote branch/review protections before the first remote publication and final release approval. Publication preparation is separate from publication completion; this deferral does not postpone the local experimental freeze.';

export function RepositoryPolicyPanel({
  workspaceId,
  planVersionId,
  csrfToken,
  editable,
  onChanged,
}: {
  workspaceId: WorkspaceId;
  planVersionId: PlanVersionId;
  csrfToken: string;
  editable: boolean;
  onChanged: () => void;
}) {
  // Read from Git: again on its plan's events, each minute and on a refresh (R-D4 4b).
  const store = useQueryStore();
  const key = queryKeys.repositoryPolicy(workspaceId, planVersionId);
  const policy = useQuery(key, () => loadRepositoryPolicy(workspaceId, planVersionId));
  const data: RepositoryPolicyEvidence | undefined = policy.data;
  const setData = (next: RepositoryPolicyEvidence) => store.set(key, next);
  const [commandError, setError] = useState<string>();
  const error = commandError ?? (policy.error === undefined ? undefined : String(policy.error));
  const [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0),
    [settingsVersion, setSettingsVersion] = useState(0);
  const [interpretation, setInterpretation] = useState(INTERPRETATION),
    [publication, setPublication] = useState(PUBLICATION);
  const [freeze, setFreeze] = useState(true),
    [branch, setBranch] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [freezeObservation, setFreezeObservation] =
    useState<RepositoryPolicyEvidence['proposedFreeze']>();
  const begin = () => {
    if (!data) return;
    setVersion(data.policy?.version ?? 0);
    setSettingsVersion(data.settingsVersion);
    setInterpretation(data.policy?.interpretation ?? INTERPRETATION);
    setPublication(data.policy?.publicationRequirement ?? PUBLICATION);
    setFreeze(data.policy ? !!data.policy.experimentalFreeze : true);
    setBranch(data.policy?.experimentalFreeze?.branch ?? data.proposedFreeze?.branch ?? '');
    setFreezeObservation(data.proposedFreeze);
    setConfirmed(false);
    setEditing(true);
    setError(undefined);
  };
  const observed = freezeObservation?.branch === branch ? freezeObservation : undefined;
  return (
    <section aria-label="Repository policy" className="integration-resolution">
      <h3>Repository policy</h3>
      <p>
        {data?.policy
          ? `Adopted revision ${data.policy.version} · ${new Date(data.policy.adoptedAt).toLocaleString()}`
          : 'No operator repository policy recorded.'}
      </p>
      <p className="hint">
        A new revision invalidates earlier review approvals and scope acceptance receipts.
      </p>
      <About label="About repository policy">
        <p>
          Agents receive this policy, fresh branch observations, and applicable operator decisions
          at each transition, including parent acceptance. Adopting a policy starts no runs and
          changes no Git refs. After a new revision, affected slices need fresh verification before
          parent acceptance.
        </p>
      </About>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {distinct(data?.issues ?? []).map((issue) => (
        <p key={issue} className="warning-state">
          {issue}
        </p>
      ))}
      {data?.policy && !editing && (
        <details>
          <summary>Policy and current evidence</summary>
          <p>{data.policy.interpretation}</p>
          <p>{data.policy.publicationRequirement}</p>
          {data.policy.experimentalFreeze && (
            <p>
              Frozen branch: {data.policy.experimentalFreeze.branch} at{' '}
              <code>{data.policy.experimentalFreeze.commitSha}</code>. Observed:{' '}
              <code>{data.observedFreezeSha ?? 'unavailable'}</code>.
            </p>
          )}
          <p>
            Observed {new Date(data.observedAt).toLocaleString()}. Remote protection is not verified
            by this receipt.
          </p>
        </details>
      )}
      {editable && !editing && (
        <button type="button" className="secondary-button" onClick={begin} disabled={!data || busy}>
          {' '}
          {data?.policy ? 'Review repository policy' : 'Record repository policy'}{' '}
        </button>
      )}
      {editing && (
        <form
          aria-label="Adopt repository policy"
          onSubmit={(event) => {
            event.preventDefault();
            if (!data || !confirmed || (freeze && !observed)) return;
            setBusy(true);
            setError(undefined);
            void saveRepositoryPolicy(
              workspaceId,
              planVersionId,
              {
                expectedVersion: version,
                expectedBranchSettingsVersion: settingsVersion,
                controlMode: 'controller-local',
                interpretation,
                publicationRequirement: publication,
                ...(freeze && observed ? { experimentalFreeze: observed } : {}),
              },
              csrfToken,
            )
              .then((next) => {
                setData(next);
                setEditing(false);
                onChanged();
              })
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            Local protection and freeze interpretation
            <textarea
              required
              maxLength={8000}
              value={interpretation}
              disabled={busy}
              onChange={(e) => {
                setInterpretation(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label className="field">
            Remote publication obligation and due milestone
            <textarea
              required
              maxLength={2000}
              value={publication}
              disabled={busy}
              onChange={(e) => {
                setPublication(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={freeze}
              disabled={busy}
              onChange={(e) => {
                setFreeze(e.target.checked);
                setConfirmed(false);
              }}
            />
            Record a frozen experimental branch
          </label>
          {freeze && (
            <>
              <label className="field">
                Experimental branch
                <input
                  required
                  value={branch}
                  disabled={busy}
                  onChange={(e) => {
                    setBranch(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !branch}
                onClick={() => {
                  setBusy(true);
                  setConfirmed(false);
                  setError(undefined);
                  void loadRepositoryPolicy(workspaceId, planVersionId, branch)
                    .then((next) => {
                      setData(next);
                      setFreezeObservation(next.proposedFreeze);
                    })
                    .catch((e) => setError(String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                Observe freeze branch
              </button>
              <p>
                Commit to freeze:{' '}
                <code>{observed?.commitSha ?? 'Observe this branch before adopting.'}</code>
              </p>
              <p className="muted">
                This records a no-feature-work instruction and checks its current commit. It does
                not install a filesystem lock or remote branch rule.
              </p>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I adopt this interpretation and the displayed freeze, where selected, for this plan.
          </label>
          <div className="inline-actions">
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !confirmed || (freeze && !observed)}
            >
              Adopt repository policy
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel policy changes
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
