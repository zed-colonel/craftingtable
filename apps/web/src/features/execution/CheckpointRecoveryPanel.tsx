import { useState } from 'react';
import {
  checkpointRecoverySchema,
  runtimeEvidenceViewSchema,
  type CheckpointRecovery,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import type { AgentRunId, WorkspaceId } from '@craftingtable/domain';

export function CheckpointRecoveryPanel({
  workspaceId,
  definitionId,
  worktreeId,
  csrfToken,
  canMutate,
  onChanged,
}: {
  workspaceId: string;
  definitionId: string;
  worktreeId: string;
  csrfToken: string;
  canMutate: boolean;
  onChanged: () => void;
}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/concurrency-definitions/${encodeURIComponent(definitionId)}/runtime`;
  const [view, setView] = useState<CheckpointRecovery>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkpoint operation failed.');
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () =>
    setView(
      await request(
        `${base}/checkpoint-recovery/${encodeURIComponent(worktreeId)}`,
        checkpointRecoverySchema,
      ),
    );
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(body),
  });
  return (
    <section aria-label="Checkpoint recovery" className="import-binding">
      <h4>Checkpoint acceptance before merge</h4>
      <p>
        Use the saved candidate review and build receipts. Preparing evidence starts no agent and
        grants no approval.
      </p>
      <button
        type="button"
        className="secondary-button"
        disabled={busy || !canMutate}
        onClick={() => void act(refresh)}
      >
        {view ? 'Refresh checkpoint evidence' : 'Review checkpoint evidence'}
      </button>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {view?.candidates.length === 0 && (
        <p>
          This slice has no supported contract checkpoint recovery. Use the roadmap’s evidence
          controls for other checkpoint types.
        </p>
      )}
      {view?.candidates.map((c) => {
        const key = c.submission?.id ?? c.snapshotDigest;
        return (
          <article key={c.checkpointId}>
            <h4>
              {c.checkpointId} · {c.title}
            </h4>
            <p>
              {c.decision?.outcome === 'accepted'
                ? 'Checkpoint accepted for this candidate.'
                : c.submission && !c.decision
                  ? 'Evidence prepared — your review is required.'
                  : 'Candidate evidence preview'}
            </p>
            <p>
              Candidate <code className="import-digest">{c.headSha ?? 'not available'}</code>{' '}
              against integration{' '}
              <code className="import-digest">{c.integrationSha ?? 'not available'}</code>.
            </p>
            <p>
              This approval covers this slice’s exact candidate. It does not merge code, verify the
              merged slice, or accept the parent.
            </p>
            <h5>Review these checkpoint requirements</h5>
            <ul>
              {distinct(c.requirements).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p>
              Cases covered here:{' '}
              {c.cases.map((x) => x.id).join(', ') ||
                'No additional source cases assigned to this slice.'}
            </p>
            {c.laterCases.length > 0 && (
              <details>
                <summary>Case obligations retained for other slices</summary>
                <ul>
                  {c.laterCases.map((x) => (
                    <li key={x.id}>
                      {x.id}: required at {x.sliceId} verification; not approved here.
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {c.runId && (
              <p>
                <Link
                  route={{
                    name: 'run',
                    workspaceId: workspaceId as WorkspaceId,
                    runId: c.runId as AgentRunId,
                  }}
                >
                  Open the saved independent review
                </Link>
              </p>
            )}
            <details>
              <summary>Saved review report</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.report}</pre>
            </details>
            <details>
              <summary>Frozen controller build receipts</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {c.buildReceipts}
              </pre>
            </details>
            {c.issues.length > 0 && (
              <ul>
                {distinct(c.issues).map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
            {(c.prerequisiteCheckpoints?.length ?? 0) > 0 && (
              <p>
                <Link
                  route={{
                    name: 'roadmap-map',
                    workspaceId: workspaceId as WorkspaceId,
                    definitionId,
                  }}
                >
                  Review prerequisite evidence on the roadmap
                </Link>{' '}
                under Dependency environments and evidence, then Submitted evidence. Accept it
                first, then refresh here.
              </p>
            )}
            {c.decision?.outcome === 'accepted' ? (
              <p role="status">
                Return to the integration cycle to approve its merge, or resume scheduling if
                integration merges are delegated.
              </p>
            ) : !c.submission || c.decision?.outcome === 'rejected' ? (
              <button
                type="button"
                disabled={busy || !canMutate || c.issues.length > 0}
                onClick={() =>
                  void act(async () => {
                    setView(
                      await request(
                        `${base}/prepare-checkpoint`,
                        checkpointRecoverySchema,
                        post({
                          worktreeId,
                          checkpointId: c.checkpointId,
                          snapshotDigest: c.snapshotDigest,
                        }),
                      ),
                    );
                    onChanged();
                  })
                }
              >
                Prepare checkpoint evidence
              </button>
            ) : (
              <fieldset disabled={busy || !canMutate}>
                <label className="field">
                  <span>
                    <input
                      type="checkbox"
                      checked={reviewed[key] ?? false}
                      onChange={(e) => setReviewed({ ...reviewed, [key]: e.target.checked })}
                    />{' '}
                    I reviewed the retained evidence against every requirement above and accept the
                    checkpoint review responsibilities: {c.reviewerRoles.join(', ')}.
                  </span>
                </label>
                <p className="hint">
                  The recorded agent review is supporting evidence. Your acceptance supplies the
                  checkpoint attestation; it does not claim that you personally ran the tests.
                </p>
                <label className="field">
                  Checkpoint review rationale
                  <textarea
                    value={rationale[key] ?? ''}
                    onChange={(e) => setRationale({ ...rationale, [key]: e.target.value })}
                  />
                </label>
                {(['accepted', 'rejected'] as const).map((outcome) => (
                  <button
                    type="button"
                    key={outcome}
                    disabled={
                      !rationale[key]?.trim() ||
                      (outcome === 'accepted' && (!reviewed[key] || c.issues.length > 0))
                    }
                    onClick={() =>
                      void act(async () => {
                        await request(
                          `${base}/decide`,
                          runtimeEvidenceViewSchema,
                          post({
                            submissionId: c.submission!.id,
                            outcome,
                            rationale: rationale[key],
                            ...(outcome === 'accepted'
                              ? { checkpointReviewRoles: c.reviewerRoles }
                              : {}),
                          }),
                        );
                        await refresh();
                        onChanged();
                        window.dispatchEvent(
                          new CustomEvent('craftingtable:runtime-saved', { detail: definitionId }),
                        );
                      })
                    }
                  >
                    {outcome === 'accepted'
                      ? 'Accept checkpoint evidence'
                      : 'Reject checkpoint evidence'}
                  </button>
                ))}
              </fieldset>
            )}
          </article>
        );
      })}
    </section>
  );
}
