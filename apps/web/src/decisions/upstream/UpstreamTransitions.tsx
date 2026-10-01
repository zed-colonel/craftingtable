import { useState } from 'react';
import { runtimeEvidenceViewSchema, type RuntimeEvidenceView } from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';
import { About } from '../../components/About.js';

/** When each consumer→upstream link moves to the current pin, and approval of undeclared ones (ADR-069). */
export function UpstreamTransitions({
  base,
  view,
  csrfToken,
  canMutate,
  onSaved,
}: {
  base: string;
  view: RuntimeEvidenceView;
  csrfToken: string;
  canMutate: boolean;
  onSaved: (v: RuntimeEvidenceView) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string>>({}),
    [rationale, setRationale] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const transitions = view.upstreamTransitions;
  if (!transitions?.links.length) return null;
  const key = (l: { consumer: string; upstream: string }) => `${l.consumer}→${l.upstream}`;
  const name = (l: { consumer: string; upstream: string }) =>
    `${l.consumer.toUpperCase()} → ${l.upstream.toUpperCase()}`;
  const selected = transitions.links.flatMap((l) =>
    !l.slice && chosen[key(l)]
      ? [{ consumer: l.consumer, upstream: l.upstream, slice: chosen[key(l)] as string }]
      : [],
  );
  const undeclared = transitions.links.filter((l) => !l.slice);
  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      const v = await request(`${base}/declare-transitions`, runtimeEvidenceViewSchema, {
        method: 'POST',
        headers: { 'x-craftingtable-csrf': csrfToken },
        body: JSON.stringify({
          expectedRecordIds: transitions.records.map((r) => r.id),
          transitions: selected,
          rationale,
        }),
      });
      onSaved(v);
      setChosen({});
      setRationale('');
      setConfirmed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Upstream transitions" className="stack-form">
      <h3>Upstream transitions</h3>
      <About label="About upstream transitions">
        <p>
          Each application builds against a historical upstream until one slice moves it to the
          current pin. After that slice merges, every later build of the application uses the
          current pin. Work that needs the current pins stops until its link is declared.
        </p>
        <p>
          The map normally declares these. For a map that does not, approve them here. An approval
          is permanent for this map revision and invalidates no evidence; the next map revision
          declares them itself.
        </p>
      </About>
      {error && <p role="alert">{error}</p>}
      <ul>
        {transitions.links.map((l) => (
          <li key={key(l)}>
            <strong>{name(l)}</strong>:{' '}
            {l.slice ? (
              <>
                moves at <code>{l.slice}</code> ·{' '}
                {l.declaredBy === 'map' ? 'declared in the map' : 'approved by the operator'}
              </>
            ) : l.candidates.length ? (
              <label className="field">
                {`${name(l)} transition slice`}
                <select
                  value={chosen[key(l)] ?? ''}
                  disabled={!canMutate || busy}
                  onChange={(e) => setChosen({ ...chosen, [key(l)]: e.target.value })}
                >
                  <option value="">Not declared</option>
                  {l.candidates.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>not declared · no slice qualifies; declare it in the next map revision</>
            )}
          </li>
        ))}
      </ul>
      {transitions.records.length > 0 && (
        <details>
          <summary>Approved transitions ({transitions.records.length})</summary>
          <ul>
            {transitions.records.map((r) => (
              <li key={r.id}>
                {r.createdAt} · {r.transitions.map((t) => `${name(t)} at ${t.slice}`).join('; ')} ·{' '}
                {r.rationale}
              </li>
            ))}
          </ul>
        </details>
      )}
      {undeclared.some((l) => l.candidates.length) && (
        <>
          <label className="field">
            Transition rationale
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              disabled={!canMutate || busy}
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={!canMutate || busy || !selected.length}
            />
            I approve these transitions for this map revision. They cannot be withdrawn.
          </label>
          <div className="action-buttons">
            <button
              type="button"
              className="primary-button"
              disabled={!canMutate || busy || !selected.length || !confirmed || !rationale.trim()}
              onClick={() => void approve()}
            >
              Approve transitions
            </button>
          </div>
        </>
      )}
    </section>
  );
}
