import { type HostSchedulingStatus, hostSchedulingSchema } from '@craftingtable/contracts';
import { useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { request } from '../../lib/api-client.js';

export function HostSchedulingPanel({
  workspaceId,
  csrfToken,
}: {
  workspaceId: string;
  csrfToken: string;
}) {
  const [status, setStatus] = useState<HostSchedulingStatus>();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/host-scheduling`;
  useEffect(() => {
    let alive = true;
    void request(url, hostSchedulingSchema)
      .then((value) => {
        if (alive) {
          setStatus(value);
          setDraft(String(value.verificationCapacity));
        }
      })
      .catch((value) => {
        if (alive)
          setError(value instanceof Error ? value.message : 'Could not load host settings.');
      });
    return () => {
      alive = false;
    };
  }, [url]);
  const act = async (save: boolean) => {
    if (!status) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await request(
        url,
        hostSchedulingSchema,
        save
          ? {
              method: 'POST',
              headers: { 'x-craftingtable-csrf': csrfToken },
              body: JSON.stringify({
                expectedVersion: status.version,
                verificationCapacity: Number(draft),
              }),
            }
          : undefined,
      );
      setStatus(value);
      // A status refresh never discards an unsaved capacity edit.
      if (save || !editing) setDraft(String(value.verificationCapacity));
      if (save) setEditing(false);
      setNotice(
        save
          ? 'Verification capacity saved. Review new saved-plan acceptance evidence for affected cross-project roadmaps before resuming.'
          : 'Reservations and settings refreshed.',
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Could not save host settings.');
    } finally {
      setBusy(false);
    }
  };
  const capacity = Number(draft);
  const invalid = !Number.isInteger(capacity) || capacity < 1 || capacity > 32;
  const running = status?.roadmaps.filter((r) => r.status === 'running') ?? [];
  return (
    <Section
      id="host-scheduling"
      title="Host verification capacity"
      summary="Shared by slice verification and parent-acceptance reviews across all projects and workspaces."
      actions={
        <>
          <button
            type="button"
            disabled={busy || !status}
            onClick={() => {
              if (status) setDraft(String(status.verificationCapacity));
              setEditing(!editing);
            }}
          >
            {editing ? 'Cancel capacity edit' : 'Change verification capacity'}
          </button>
          <button type="button" disabled={busy || !status} onClick={() => void act(false)}>
            Refresh reservations
          </button>
        </>
      }
    >
      {error && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-state" role="status">
          {notice}
        </p>
      )}
      {!status && !error && <p>Loading host settings…</p>}
      {status && (
        <>
          <StatusStrip
            label="Host capacity"
            facts={[
              {
                label: 'Verification slots in use',
                value: `${status.reservations.length}/${status.verificationCapacity}`,
              },
              { label: 'Development limit (separate)', value: status.developmentCapacity },
              {
                label: 'Verification setting',
                value:
                  status.source === 'saved-setting'
                    ? 'Saved in CraftingTable'
                    : 'Daemon environment/default',
              },
            ]}
          />
          <About label="About verification capacity">
            <p>
              This limit controls how many eligible reviews can run together. Dependency and
              evidence gates still apply; parent acceptance waits for required slice verifications.
              Development and roadmap in-flight limits are separate. A reservation lasts until its
              run and background work finish. This setting does not limit CPU or memory usage.
            </p>
            <p>
              Only an owner of every active workspace can change this installation-wide setting. A
              saved value takes precedence over the daemon environment and survives restarts.
              Reducing it keeps existing runs alive and delays new reservations until usage falls
              below the limit.
            </p>
          </About>
          {editing && (
            <form
              className="stack-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act(true);
              }}
            >
              <label className="field">
                Concurrent verification reviews
                <input
                  type="number"
                  min={1}
                  max={32}
                  step={1}
                  required
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <p className="hint">
                Pause roadmap scheduling before saving. Changed capacity requires generating and
                accepting fresh saved-plan evidence on each affected cross-project roadmap. Saving
                does not resume scheduling.
              </p>
              {running.length > 0 && (
                <p className="error-state">
                  Pause these roadmaps first: {running.map((r) => r.name).join(', ')}.
                </p>
              )}
              <button
                type="submit"
                className="primary-button"
                disabled={
                  busy || invalid || running.length > 0 || capacity === status.verificationCapacity
                }
              >
                Save verification capacity
              </button>
            </form>
          )}
          <h3>Reviews holding slots ({status.reservations.length})</h3>
          {status.reservations.length === 0 ? (
            <p>No verification reservations are occupied.</p>
          ) : (
            <ul>
              {status.reservations.map((r) => (
                <li key={r.id}>
                  <strong>{r.label}</strong> ·{' '}
                  {r.phase === 'accept' ? 'Parent acceptance' : 'Slice verification'} · since{' '}
                  {new Date(r.acquiredAt).toLocaleString()}
                  {r.runId && (
                    <>
                      {' '}
                      ·{' '}
                      <a
                        href={`/workspaces/${encodeURIComponent(r.workspaceId)}/runs/${encodeURIComponent(r.runId)}`}
                      >
                        Open run
                      </a>
                    </>
                  )}
                  {r.workItemId && (
                    <>
                      {' '}
                      ·{' '}
                      <a
                        href={`/workspaces/${encodeURIComponent(r.workspaceId)}/work-items/${encodeURIComponent(r.workItemId)}`}
                      >
                        Open work item
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>Recorded verification waits ({status.waiting.length})</h3>
          <p className="hint">
            Waiting cycles retry when capacity is available and their automation is running.
            Roadmaps also show reviews awaiting prerequisites or not yet dispatched. This view
            refreshes only when requested.
          </p>
          {status.waiting.length === 0 ? (
            <p>No cycles have recorded a verification-capacity wait.</p>
          ) : (
            <ul>
              {status.waiting.map((w) => (
                <li key={w.id}>
                  <strong>{w.label}</strong> · {w.reason}{' '}
                  {w.paused
                    ? 'Cycle needs explicit resumption before it can retry.'
                    : 'Will retry automatically.'}
                  {w.workItemId && (
                    <>
                      {' '}
                      ·{' '}
                      <a
                        href={`/workspaces/${encodeURIComponent(w.workspaceId)}/work-items/${encodeURIComponent(w.workItemId)}`}
                      >
                        Open work item
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {status.roadmaps.length > 0 && (
            <details>
              <summary>Roadmaps and saved-plan review</summary>
              <ul>
                {status.roadmaps.map((r) => (
                  <li key={r.id}>
                    <a href={`/workspaces/${encodeURIComponent(r.workspaceId)}/roadmaps`}>
                      {r.name}
                    </a>{' '}
                    · {r.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Section>
  );
}
