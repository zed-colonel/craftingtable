import { type RoadmapCapacities, roadmapCapacitiesSchema } from '@craftingtable/contracts';
import { useEffect, useState } from 'react';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { request } from '../../lib/api-client.js';

export function RoadmapCapacityPanel({
  workspaceId,
  csrfToken,
  developmentCapacity,
}: {
  workspaceId: string;
  csrfToken: string;
  developmentCapacity?: number;
}) {
  const [data, setData] = useState<RoadmapCapacities>();
  const [selected, setSelected] = useState(
    () => new URLSearchParams(window.location.search).get('roadmap') ?? '',
  );
  const [draft, setDraft] = useState<{
    roadmapId: string;
    maxInFlight: string;
    maxPerRepository: string;
    expectedVersion: number;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmaps`;
  useEffect(() => {
    let alive = true;
    void request(`${base}/capacities`, roadmapCapacitiesSchema)
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load roadmap limits.');
      });
    return () => {
      alive = false;
    };
  }, [base]);
  const roadmap = data?.roadmaps.find((r) => r.id === selected) ?? data?.roadmaps[0];
  const act = async (save: boolean) => {
    if (save && (!roadmap || !draft || draft.roadmapId !== roadmap.id)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(
        save && roadmap ? `${base}/${roadmap.id}/capacity` : `${base}/capacities`,
        roadmapCapacitiesSchema,
        save && draft
          ? {
              method: 'POST',
              headers: { 'x-craftingtable-csrf': csrfToken },
              body: JSON.stringify({
                expectedVersion: draft.expectedVersion,
                maxInFlight: Number(draft.maxInFlight),
                maxPerRepository: Number(draft.maxPerRepository),
              }),
            }
          : undefined,
      );
      setData(result);
      if (save) setDraft(undefined);
      setNotice(
        save
          ? `Roadmap limits saved. ${roadmap?.crossProject ? 'Generate and accept fresh saved-plan evidence on this roadmap before resuming.' : 'Resume scheduling separately when ready.'} Existing attempts are retained.`
          : 'Roadmap limits and in-flight work refreshed.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save roadmap limits.');
    } finally {
      setBusy(false);
    }
  };
  const stale =
    draft &&
    roadmap &&
    (draft.expectedVersion !== roadmap.version || draft.roadmapId !== roadmap.id);
  const invalid =
    draft &&
    [draft.maxInFlight, draft.maxPerRepository].some(
      (v) => !Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 16,
    );
  return (
    <Section
      title="Roadmap in-flight limits"
      summary="Choose a saved roadmap in this workspace. Items awaiting merge or attention retain their places."
      actions={
        <button type="button" disabled={busy} onClick={() => void act(false)}>
          Refresh roadmap limits
        </button>
      }
    >
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success-state">
          {notice}
        </p>
      )}
      {!data && !error && <p>Loading roadmap limits…</p>}
      {data?.roadmaps.length === 0 && (
        <p>
          Save a roadmap draft on the Roadmaps page, then configure its limits here before starting
          it.
        </p>
      )}
      {roadmap && (
        <>
          <label className="field">
            Roadmap
            <select
              value={roadmap.id}
              disabled={busy || !!draft}
              onChange={(e) => {
                setSelected(e.target.value);
                setNotice('');
                setError('');
              }}
            >
              {data?.roadmaps.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.status}
                </option>
              ))}
            </select>
          </label>
          <StatusStrip
            label="Roadmap admission capacity"
            facts={[
              { label: 'Mode', value: roadmap.scheduling.mode },
              {
                label: 'In-flight attempts',
                value: `${roadmap.inFlight.length}/${roadmap.scheduling.mode === 'parallel' ? roadmap.scheduling.maxInFlight : 1}`,
              },
              {
                label: 'Per repository',
                value:
                  roadmap.scheduling.mode === 'parallel' ? roadmap.scheduling.maxPerRepository : 1,
              },
              { label: 'Saved revision', value: roadmap.revision },
            ]}
          />
          {developmentCapacity !== undefined && roadmap.scheduling.mode === 'parallel' && (
            <p className="hint">
              This roadmap allows {roadmap.scheduling.maxInFlight} items in flight and{' '}
              {roadmap.scheduling.maxPerRepository} per repository. The workstation has{' '}
              {developmentCapacity} development/work-item review slots shared across projects and
              roadmaps.
            </p>
          )}
          <p className="hint">
            In-flight limits reserve unmerged development attempts. Independent verification and
            parent acceptance use the workstation pool above. Required predecessors, evidence,
            exclusion groups and repository locks still apply. Manual worktrees also count toward
            repository limits; shared repositories use the tightest active roadmap limit.
          </p>
          {roadmap.editBlocker && <p>{roadmap.editBlocker}</p>}
          <button
            type="button"
            disabled={busy || (!draft && !!roadmap.editBlocker)}
            onClick={() =>
              setDraft(
                draft
                  ? undefined
                  : {
                      roadmapId: roadmap.id,
                      maxInFlight: String(roadmap.scheduling.maxInFlight),
                      maxPerRepository: String(roadmap.scheduling.maxPerRepository),
                      expectedVersion: roadmap.version,
                    },
              )
            }
          >
            {draft ? 'Cancel roadmap capacity edit' : 'Change roadmap limits'}
          </button>
          {draft && (
            <form
              className="stack-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(true);
              }}
            >
              {(['maxInFlight', 'maxPerRepository'] as const).map((key) => (
                <label className="field" key={key}>
                  {key === 'maxInFlight'
                    ? 'Maximum in-flight items'
                    : 'Maximum in-flight items per repository'}
                  <input
                    type="number"
                    min={1}
                    max={16}
                    step={1}
                    required
                    disabled={busy}
                    value={draft[key]}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                  />
                </label>
              ))}
              <p className="hint">
                Saving changes this roadmap's admission limits and saved revision. Existing work
                keeps its profiles and recovery budgets. Lowering a limit delays new admissions; it
                does not stop current work.
                {roadmap.crossProject &&
                  ' Generate and accept fresh saved-plan evidence before resuming.'}
              </p>
              {stale && (
                <p role="alert">
                  The roadmap changed during this edit. Cancel the edit and reopen it to use the
                  refreshed limits.
                </p>
              )}
              <button
                type="submit"
                className="primary-button"
                disabled={
                  busy ||
                  !!stale ||
                  invalid ||
                  !!roadmap.editBlocker ||
                  (Number(draft.maxInFlight) === roadmap.scheduling.maxInFlight &&
                    Number(draft.maxPerRepository) === roadmap.scheduling.maxPerRepository)
                }
              >
                Save roadmap limits
              </button>
            </form>
          )}
          <details>
            <summary>Work holding in-flight places ({roadmap.inFlight.length})</summary>
            <ul>
              {roadmap.inFlight.map((a) => (
                <li key={a.attemptId}>
                  <a
                    href={`/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(a.workItemId)}`}
                  >
                    {a.label}
                  </a>
                </li>
              ))}
            </ul>
          </details>
          <p>
            <a href={base.replace('/api', '')}>
              Open roadmap supervision and saved-plan acceptance
            </a>
          </p>
        </>
      )}
    </Section>
  );
}
