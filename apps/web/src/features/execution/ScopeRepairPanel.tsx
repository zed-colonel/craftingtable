import type { ScopeRepairPreview } from '@craftingtable/contracts';
import type { WorkCycle, WorktreeId } from '@craftingtable/domain';
import { AGENT_BACKEND_LABELS } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { delegateScopeRepair, previewScopeRepair } from '../../lib/work-cycle-api.js';
import { distinct } from '../../lib/distinct.js';
import { About } from '../../components/About.js';

export function ScopeRepairPanel({
  cycle,
  disabled,
  csrfToken,
  refreshToken,
  onOpen,
  onStarted,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  csrfToken: string;
  refreshToken: number;
  onOpen: (id: WorktreeId) => void;
  onStarted: (cycle: WorkCycle) => void;
}) {
  const [preview, setPreview] = useState<ScopeRepairPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [instructions, setInstructions] = useState('');
  const [rounds, setRounds] = useState(3);
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: current phase events refresh the preview.
  useEffect(() => {
    let alive = true;
    // Keep the findings mounted while revalidating. Unmounting collapses native
    // disclosures and interrupts the operator's reading on every workspace event.
    setRefreshing(true);
    setError(undefined);
    void previewScopeRepair(cycle)
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load source recovery.');
      })
      .finally(() => {
        if (alive) setRefreshing(false);
      });
    return () => {
      alive = false;
    };
  }, [cycle.id, cycle.version, refreshToken, retry]);
  if (!preview && error)
    return (
      <div>
        <p role="alert" className="error-state">
          {error}
        </p>
        <button type="button" disabled={disabled} onClick={() => setRetry((n) => n + 1)}>
          Refresh source recovery
        </button>
      </div>
    );
  if (!preview) return <p role="status">Checking source findings and owning slices…</p>;
  if (!preview.sources.length) return null;
  const owner =
    preview.candidates.find((c) => c.scope.sourceId === selected) ?? preview.candidates[0];
  const sources = preview.sources.filter(
    (s) => s.scope.kind === 'parent-acceptance' || s.scope.sourceId === owner?.scope.sourceId,
  );
  return (
    <form
      className="stack-form"
      aria-label="Delegate source fixes"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          !owner ||
          busy ||
          refreshing ||
          error ||
          disabled ||
          owner.blockers.length ||
          owner.cycleId ||
          !owner.profiles ||
          !sources.length
        )
          return;
        setBusy(true);
        setError(undefined);
        void delegateScopeRepair(
          cycle,
          {
            expectedVersion: preview.cycleVersion,
            snapshotDigest: preview.snapshotDigest,
            sourceId: owner.scope.sourceId,
            instructions,
            maxRemediationRounds: rounds,
          },
          csrfToken,
        )
          .then((result) => onStarted(result.cycle))
          .catch((e) =>
            setError(e instanceof Error ? e.message : 'Could not delegate source fixes.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      <h3>Source changes required</h3>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {refreshing && (
        <p role="status">Refreshing source recovery… Existing findings remain visible.</p>
      )}
      <button type="button" disabled={busy || disabled} onClick={() => setRetry((n) => n + 1)}>
        Refresh source recovery
      </button>
      <p>Delegate these fixes to an editable owning slice; another review cannot make them.</p>
      <About label="About source recovery">
        <p>
          Merge the owning slice's reviewed changes, then resume independent verification and parent
          acceptance. The list includes open findings from related slice and parent reviews. IDs are
          labelled by source review so different findings cannot overwrite one another. Older
          questions must be rechecked against the current adopted policy.
        </p>
      </About>
      {!sources.length && <p>No open source findings apply to this owning slice.</p>}
      {sources.map((source) => (
        <details key={source.runId}>
          <summary>
            {source.scope.kind} · {source.findings.length} open finding(s)
          </summary>
          <p className="hint">
            Source run: <code>{source.runId}</code>
          </p>
          {source.findings.map((f) => (
            <article className="review-finding" key={f.id}>
              <strong>
                {f.id} · {f.severity} · {f.title}
              </strong>
              {f.location && (
                <p>
                  <code>
                    {f.location.path}
                    {f.location.line ? `:${f.location.line}` : ''}
                  </code>
                </p>
              )}
              <p>{f.explanation}</p>
              <p>{f.recommendation}</p>
            </article>
          ))}
        </details>
      ))}
      <label className="field">
        Owning slice
        <select
          value={owner?.scope.sourceId ?? ''}
          disabled={busy || disabled}
          onChange={(e) => setSelected(e.target.value)}
        >
          {preview.candidates.map((c) => (
            <option key={c.scope.sourceId} value={c.scope.sourceId}>
              {c.scope.sourceId} · {c.title}
            </option>
          ))}
        </select>
      </label>
      {owner?.profiles && (
        <p className="hint">
          Implementer: {AGENT_BACKEND_LABELS[owner.profiles.remediate.backend]} ·{' '}
          {owner.profiles.remediate.model ?? 'Backend default'}. Reviewer:{' '}
          {AGENT_BACKEND_LABELS[owner.profiles.review.backend]} ·{' '}
          {owner.profiles.review.model ?? 'Backend default'}.
        </p>
      )}
      {owner?.cycleId && owner.worktreeId ? (
        <button type="button" onClick={() => onOpen(owner.worktreeId!)}>
          Open existing slice repair cycle
        </button>
      ) : (
        <>
          {!!owner?.blockers.length && (
            <ul className="warning-state">
              {distinct(owner.blockers).map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <label className="field">
            Follow-up remediation rounds
            <input
              type="number"
              min={1}
              max={20}
              value={rounds}
              disabled={busy || disabled}
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </label>
          <p className="hint">
            A focused implementation pass, then review and up to this many more remediation rounds.
            Integration merge approval is separate; roadmap scheduling is unchanged.
          </p>
          <label className="field">
            Additional repair guidance
            <textarea
              maxLength={16000}
              value={instructions}
              disabled={busy || disabled}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={
              busy ||
              refreshing ||
              !!error ||
              disabled ||
              !owner?.profiles ||
              !sources.length ||
              !!owner?.blockers.length ||
              !Number.isInteger(rounds) ||
              rounds < 1 ||
              rounds > 20
            }
          >
            Delegate fixes to owning slice
          </button>
        </>
      )}
    </form>
  );
}
