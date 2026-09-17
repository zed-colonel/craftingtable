import { useState } from 'react';
import type { WorkCycle } from '@craftingtable/domain';
import type { BaselinePreview } from '@craftingtable/contracts';
import { prepareBaseline, previewBaseline } from '../../lib/work-cycle-api.js';

export function BaselinePreparationPanel({
  cycle,
  csrfToken,
  onChanged,
}: {
  cycle: WorkCycle;
  csrfToken: string;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<BaselinePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const stale = preview && preview.expectedVersion !== cycle.version;
  const discover = async () => {
    setBusy(true);
    setError(undefined);
    setConfirmed(false);
    try {
      setPreview(await previewBaseline(cycle));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not discover baseline setup.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Historical baseline preparation" className="stack">
      <h4>Historical baseline preparation</h4>
      {cycle.baselinePreparation && (
        <>
          <p role="status">
            {cycle.baselinePreparation.status === 'prepared'
              ? 'Sources prepared'
              : cycle.baselinePreparation.status === 'preparing'
                ? 'Preparation in progress'
                : 'Preparation needs attention'}{' '}
            · {cycle.baselinePreparation.message}
          </p>
          <details>
            <summary>Saved historical commits and storage</summary>
            <p style={{ overflowWrap: 'anywhere' }}>{cycle.baselinePreparation.directory}</p>
            {cycle.baselinePreparation.sources.map((s) => (
              <p key={s.alias} style={{ overflowWrap: 'anywhere' }}>
                {s.alias}: <code>{s.commitSha}</code>
                {s.tag ? ` · local tag ${s.tag}` : ''}
              </p>
            ))}
          </details>
          {cycle.baselinePreparation.status === 'prepared' && (
            <p>
              Use the recovery form below to start collection. The agent receives isolated
              historical sources and a separate Cargo launcher; actual results will appear in its
              report and retained command logs.
            </p>
          )}
        </>
      )}
      <button
        type="button"
        disabled={busy || cycle.baselinePreparation?.status === 'preparing'}
        onClick={() => void discover()}
      >
        {preview ? 'Refresh baseline setup' : 'Prepare baseline evidence'}
      </button>
      {busy && <p role="status">Preparing historical sources…</p>}
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {preview && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!confirmed || busy || stale) return;
            setBusy(true);
            setError(undefined);
            void prepareBaseline(
              cycle,
              {
                expectedVersion: preview.expectedVersion,
                contextDigest: preview.contextDigest,
                sources: preview.sources.map((s) => ({
                  alias: s.alias,
                  ref: s.ref,
                  ...(s.tag ? { tag: s.tag } : {}),
                })),
              },
              csrfToken,
            )
              .then(() => {
                setPreview(undefined);
                setConfirmed(false);
                onChanged();
              })
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : 'Preparation failed.'),
              )
              .finally(() => setBusy(false));
          }}
        >
          {stale && <p role="alert">The cycle changed. Refresh baseline setup.</p>}
          <p>
            Confirm the historical repository revisions. Preparation creates local tags and source
            snapshots only; it does not start an agent, publish tags, configure remote protection,
            or approve design choices.
          </p>
          {preview.sources.map((source, index) => (
            <fieldset key={source.alias}>
              <legend>
                {source.alias} ·{' '}
                {source.alias === preview.consumerAlias
                  ? 'Historical application'
                  : 'Historical dependency'}
              </legend>
              <p>{source.explanation}</p>
              <label className="field">
                Historical commit or local ref
                <input
                  required
                  disabled={busy}
                  readOnly={source.fixed}
                  value={source.ref}
                  onChange={(e) => {
                    setConfirmed(false);
                    setPreview({
                      ...preview,
                      sources: preview.sources.map((s, i) =>
                        i === index ? { ...s, ref: e.target.value } : s,
                      ),
                    });
                  }}
                />
              </label>
              {source.tag && (
                <p style={{ overflowWrap: 'anywhere' }}>
                  Create or verify local baseline tag: <code>{source.tag}</code>. An existing tag at
                  another commit is an error; it will never be moved.
                </p>
              )}
            </fieldset>
          ))}
          <details>
            <summary>Preparation boundaries</summary>
            <ul>
              {preview.notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            Use these historical revisions and create the displayed local baseline tags.
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || stale || !confirmed || preview.sources.some((s) => !s.ref.trim())}
          >
            Prepare historical sources and tags
          </button>
        </form>
      )}
    </section>
  );
}
