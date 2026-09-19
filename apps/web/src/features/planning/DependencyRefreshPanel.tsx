import { useEffect, useState } from 'react';
import {
  runtimeEvidenceViewSchema,
  runtimeRefreshPreviewSchema,
  type RuntimeEvidenceView,
  type RuntimeRefreshPreview,
} from '@craftingtable/contracts';
import { ActionBar } from '../../components/ActionBar.js';
import { request } from '../../lib/api-client.js';

export function DependencyRefreshPanel({
  base,
  view,
  csrfToken,
  disabled,
  onSaved,
}: {
  base: string;
  view: RuntimeEvidenceView;
  csrfToken: string;
  disabled: boolean;
  onSaved: (view: RuntimeEvidenceView) => void;
}) {
  const [preview, setPreview] = useState<RuntimeRefreshPreview>();
  const [rationale, setRationale] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // A new saved generation or binding must never reuse an earlier impact confirmation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Saved identities invalidate the preview.
  useEffect(() => {
    setPreview(undefined);
    setConfirmed(false);
  }, [view.current?.id, view.bindingRevision]);
  const current = view.current;
  if (!current) return null;
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dependency refresh failed.');
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Dependency pin refresh">
      <h4>Dependency pin refresh</h4>
      <p>
        Preview current provider commits and their effect on evidence. Your saved environments and
        workstation approval remain usable when their inputs are unchanged. Applying leaves
        scheduling paused; plan acceptance and Resume remain separate.
      </p>
      {view.pinStatus
        ?.filter((p) => p.issue)
        .map((p) => (
          <p key={p.alias}>
            <strong>
              {p.alias.toUpperCase()} · {p.ref}
            </strong>
            <br />
            Saved <code className="import-digest">{p.savedCommitSha}</code>
            <br />
            Current <code className="import-digest">{p.currentCommitSha ?? 'unavailable'}</code>
          </p>
        ))}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || busy}
        onClick={() =>
          void act(async () => {
            setConfirmed(false);
            setPreview(
              await request(`${base}/preview-refresh`, runtimeRefreshPreviewSchema, {
                method: 'POST',
                headers: { 'x-craftingtable-csrf': csrfToken },
                body: JSON.stringify({
                  bindingRevision: view.bindingRevision,
                  expectedGeneration: current.generation,
                }),
              }),
            );
          })
        }
      >
        {busy ? 'Working…' : 'Preview dependency refresh'}
      </button>
      {disabled && (
        <p className="subtle">
          Save or discard any setup draft before previewing the saved dependencies.
        </p>
      )}
      {preview && (
        <div>
          <p>
            <strong>
              Generation {preview.expectedGeneration} → {preview.expectedGeneration + 1}
            </strong>
          </p>
          {preview.pins.map((p) => (
            <p key={p.alias}>
              <strong>{p.alias.toUpperCase()}</strong> · {p.changed ? 'Pin changes' : 'Unchanged'} ·{' '}
              {p.ref}
              <br />
              <code className="import-digest">{p.before}</code>
              {p.changed && (
                <>
                  <br />→ <code className="import-digest">{p.after}</code>
                </>
              )}
            </p>
          ))}
          <p>
            Native workstation approval:{' '}
            {preview.nativeApproval === 'retained'
              ? 'retained; approved environment inputs are unchanged'
              : 'audit and approval required for the new environment'}
            .
          </p>
          <p>
            {preview.evidence.filter((e) => e.disposition === 'retained').length} evidence records
            retain applicable inputs ·{' '}
            {preview.evidence.filter((e) => e.disposition !== 'retained').length} need review.
            Prerequisite and source-freshness checks still apply.
          </p>
          <details open={preview.evidence.some((e) => e.disposition !== 'retained')}>
            <summary>Evidence affected by this refresh</summary>
            <ul>
              {preview.evidence.map((e) => (
                <li key={e.id}>
                  <strong>{e.sourceId}</strong> · {e.kind} ·{' '}
                  {e.disposition === 'retained'
                    ? 'Inputs unchanged'
                    : e.disposition === 'reverify'
                      ? 'Fresh evidence required'
                      : 'Already requires review'}
                  {e.generation && ` · recorded generation ${e.generation}`}
                  <p>{e.reasons.join(' ')}</p>
                </li>
              ))}
            </ul>
          </details>
          {preview.reviews.length > 0 && (
            <div>
              <h4>What the roadmap will do after Resume</h4>
              <ul>
                {preview.reviews.map((r) => (
                  <li key={`${r.roadmapId}:${r.attemptId}`}>
                    <strong>{r.sourceId}</strong>: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p>
            Saved-plan evidence always needs your new acceptance. External checkpoints that need
            fresh evidence retain their existing review controls.
          </p>
          {preview.blockers.length > 0 && (
            <ul role="status">
              {preview.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <label className="field">
            Dependency refresh rationale
            <textarea
              value={rationale}
              disabled={busy || disabled}
              onChange={(e) => setRationale(e.target.value)}
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || disabled || preview.blockers.length > 0}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed the new pins, retained evidence, and required fresh reviews.
          </label>
          <ActionBar label="Apply dependency refresh">
            <button
              type="button"
              className="primary-button"
              disabled={
                disabled || busy || !confirmed || !rationale.trim() || preview.blockers.length > 0
              }
              onClick={() =>
                void act(async () => {
                  const result = await request(`${base}/refresh`, runtimeEvidenceViewSchema, {
                    method: 'POST',
                    headers: { 'x-craftingtable-csrf': csrfToken },
                    body: JSON.stringify({
                      bindingRevision: preview.bindingRevision,
                      expectedGeneration: preview.expectedGeneration,
                      snapshotDigest: preview.snapshotDigest,
                      rationale: rationale.trim(),
                    }),
                  });
                  onSaved(result);
                  setPreview(undefined);
                  setConfirmed(false);
                  setRationale('');
                  setNotice(
                    'Dependency refresh saved. Review saved-plan acceptance, then Resume when ready. No agents were started.',
                  );
                })
              }
            >
              Apply reviewed dependency refresh
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setConfirmed(false);
              }}
            >
              Cancel preview
            </button>
          </ActionBar>
        </div>
      )}
    </section>
  );
}
