import { useState } from 'react';
import type { WorkCycle } from '@craftingtable/domain';
import { loadBaselineEvidence } from '../../lib/work-cycle-api.js';

export function HistoricalEvidencePanel({ cycle }: { cycle: WorkCycle }) {
  const [evidence, setEvidence] = useState<Awaited<ReturnType<typeof loadBaselineEvidence>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="stack">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void loadBaselineEvidence(cycle)
            .then(setEvidence)
            .catch((e: unknown) =>
              setError(e instanceof Error ? e.message : 'Could not read collection logs.'),
            )
            .finally(() => setBusy(false));
        }}
      >
        View historical collection logs
      </button>
      {error && <p role="alert">{error}</p>}
      {evidence && (
        <>
          <p>{evidence.notice}</p>
          {!evidence.artifacts.length && (
            <p>No historical command receipts have been recorded yet.</p>
          )}
          {evidence.artifacts.map((a) => (
            <details key={`${a.runId}/${a.name}`}>
              <summary style={{ overflowWrap: 'anywhere' }}>
                {a.name} · run {a.runId}
                {a.truncated ? ' · preview truncated' : ''}
              </summary>
              <pre className="run-event-body">{a.content}</pre>
            </details>
          ))}
        </>
      )}
    </div>
  );
}
