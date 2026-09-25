import { type HostSchedulingStatus, hostSchedulingSchema } from '@craftingtable/contracts';
import { useEffect, useRef, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { request } from '../../lib/api-client.js';
import { revealElement } from '../../lib/reveal-element.js';
import { RoadmapCapacityPanel } from './RoadmapCapacityPanel.js';

const pools = [
  {
    key: 'local-development',
    title: 'Development and work-item reviews',
    field: 'Concurrent development/work-item review runs',
  },
  {
    key: 'local-verification',
    title: 'Independent verification and parent acceptance',
    field: 'Concurrent verification/parent acceptance reviews',
  },
] as const;

export function HostSchedulingPanel({
  workspaceId,
  csrfToken,
  canManageHost = true,
}: {
  workspaceId: string;
  csrfToken: string;
  canManageHost?: boolean;
}) {
  const [status, setStatus] = useState<HostSchedulingStatus>();
  const [draft, setDraft] = useState<{
    development: string;
    verification: string;
    version: number;
    developmentVersion: number;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/host-scheduling`;
  useEffect(() => {
    if (!canManageHost) return;
    let alive = true;
    void request(url, hostSchedulingSchema)
      .then((value) => {
        if (alive) setStatus(value);
      })
      .catch((value) => {
        if (alive)
          setError(value instanceof Error ? value.message : 'Could not load workstation settings.');
      });
    return () => {
      alive = false;
    };
  }, [url, canManageHost]);
  const revealed = useRef(false);
  useEffect(() => {
    if (
      !revealed.current &&
      (status || error || !canManageHost) &&
      ['#execution-capacity', '#host-scheduling'].includes(window.location.hash)
    ) {
      revealed.current = true;
      revealElement('execution-capacity');
    }
  }, [status, error, canManageHost]);
  const act = async (save: boolean) => {
    if (!status || (save && !draft)) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await request(
        url,
        hostSchedulingSchema,
        save && draft
          ? {
              method: 'POST',
              headers: { 'x-craftingtable-csrf': csrfToken },
              body: JSON.stringify({
                expectedVersion: draft.version,
                expectedDevelopmentVersion: draft.developmentVersion,
                developmentCapacity: Number(draft.development),
                verificationCapacity: Number(draft.verification),
              }),
            }
          : undefined,
      );
      setStatus(value);
      // Keep both values and their original versions until an explicit save/cancel.
      if (save) setDraft(undefined);
      setNotice(
        save
          ? 'Workstation capacity saved. Generate and accept fresh saved-plan evidence for the affected cross-project roadmaps below before resuming.'
          : 'Reservations and settings refreshed.',
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Could not save workstation settings.');
    } finally {
      setBusy(false);
    }
  };
  const invalid =
    draft &&
    [draft.development, draft.verification].some(
      (v) => !Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 32,
    );
  const stale =
    draft &&
    status &&
    (draft.version !== status.version || draft.developmentVersion !== status.developmentVersion);
  const running = status?.roadmaps.filter((r) => r.status === 'running') ?? [];
  return (
    <Section
      id="execution-capacity"
      title="Execution capacity"
      summary="Workstation slots and roadmap in-flight limits, with their current reservations."
    >
      <span id="host-scheduling" />
      <Section
        title="Shared workstation"
        summary="These slots are shared across projects, roadmaps and workspaces."
        actions={
          canManageHost && (
            <>
              <button
                type="button"
                disabled={busy || !status}
                onClick={() =>
                  setDraft(
                    draft || !status
                      ? undefined
                      : {
                          development: String(status.developmentCapacity),
                          verification: String(status.verificationCapacity),
                          version: status.version,
                          developmentVersion: status.developmentVersion,
                        },
                  )
                }
              >
                {draft ? 'Cancel capacity edit' : 'Change workstation capacity'}
              </button>
              <button type="button" disabled={busy || !status} onClick={() => void act(false)}>
                Refresh reservations
              </button>
            </>
          )
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
        {!canManageHost && (
          <p>
            Workstation capacity is managed by an owner of every active workspace. Your roadmap
            limits are available below.
          </p>
        )}
        {canManageHost && !status && !error && <p>Loading workstation settings…</p>}
        {status && (
          <>
            <div className="cycle-settings-grid">
              {pools.map((pool) => {
                const development = pool.key === 'local-development';
                const limit = development
                  ? status.developmentCapacity
                  : status.verificationCapacity;
                const source = development ? status.developmentSource : status.source;
                const claims = status.reservations.filter((r) => r.resourceKey === pool.key);
                const waits = status.waiting.filter((r) => r.resourceKey === pool.key);
                return (
                  <div key={pool.key}>
                    <h3>{pool.title}</h3>
                    <StatusStrip
                      label={pool.title}
                      facts={[
                        { label: 'Slots in use', value: `${claims.length}/${limit}` },
                        { label: 'Recorded waits', value: waits.length },
                        {
                          label: 'Setting source',
                          value:
                            source === 'saved-setting'
                              ? 'Saved in CraftingTable'
                              : 'Daemon environment/default',
                        },
                      ]}
                    />
                    <details>
                      <summary>
                        Occupied slots ({claims.length}) and recorded waits ({waits.length})
                      </summary>
                      {!claims.length && <p>No occupied slots.</p>}
                      <ul>
                        {claims.map((r) => (
                          <li key={r.id}>
                            <strong>{r.label}</strong> ·{' '}
                            {r.phase === 'accept'
                              ? 'Parent acceptance'
                              : r.phase === 'verify'
                                ? 'Slice verification'
                                : r.phase === 'merge'
                                  ? 'Integration'
                                  : 'Development/work-item review'}{' '}
                            · since {new Date(r.acquiredAt).toLocaleString()}{' '}
                            <CapacityLinks item={r} />
                          </li>
                        ))}
                      </ul>
                      {!waits.length && <p>No recorded capacity waits.</p>}
                      <ul>
                        {waits.map((w) => (
                          <li key={w.id}>
                            <strong>{w.label}</strong> · {w.reason}{' '}
                            {w.paused
                              ? 'Cycle needs explicit resumption before it can retry.'
                              : 'Retries while automation is running.'}{' '}
                            <CapacityLinks item={w} />
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              })}
            </div>
            <About label="About capacity and dependencies">
              <p>
                Development includes ordinary design, implementation, review and remediation for
                scoped work. Independent slice verification and parent acceptance share their own
                pool. Dependency, evidence and exclusive resource gates still apply. These are
                controller reservations, not limits on CPU or memory, and standalone unscoped runs
                do not reserve these pools.
              </p>
              <p>
                Only an owner of every active workspace can change workstation limits. Saved values
                survive restarts and override daemon environment defaults. Lowering a limit retains
                active work and delays new reservations until usage falls below it.
              </p>
              <p>
                Recorded waits come from saved cycle state; Roadmaps shows undispatched work and its
                other prerequisites. Refresh is explicit and preserves unsaved edits.
              </p>
              <p>
                After changing a workstation limit, regenerate and accept saved-plan evidence for
                the affected cross-project roadmaps. Dependency pins need no change for a capacity
                adjustment alone.
              </p>
            </About>
            {draft && (
              <form
                className="stack-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(true);
                }}
              >
                <div className="cycle-settings-grid">
                  {pools.map((p) => {
                    const key = p.key === 'local-development' ? 'development' : 'verification';
                    return (
                      <label className="field" key={key}>
                        {p.field}
                        <input
                          type="number"
                          min={1}
                          max={32}
                          step={1}
                          required
                          value={draft[key]}
                          disabled={busy}
                          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                        />
                      </label>
                    );
                  })}
                </div>
                <p className="hint">
                  Pause scheduling in every workspace before saving. Saving does not resume
                  scheduling. Affected cross-project roadmaps need fresh saved-plan acceptance.
                </p>
                {running.length > 0 && (
                  <p className="error-state">
                    Pause these roadmaps first: {running.map((r) => r.name).join(', ')}.
                  </p>
                )}
                {stale && (
                  <p role="alert">
                    Saved limits changed during this edit. Cancel the edit and reopen it to use the
                    refreshed values.
                  </p>
                )}
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    busy ||
                    invalid ||
                    !!stale ||
                    running.length > 0 ||
                    (Number(draft.development) === status.developmentCapacity &&
                      Number(draft.verification) === status.verificationCapacity)
                  }
                >
                  Save workstation capacity
                </button>
              </form>
            )}
            <details>
              <summary>Roadmaps affected by workstation changes ({status.roadmaps.length})</summary>
              <p>
                After a limit change, regenerate and accept saved-plan evidence for cross-project
                roadmaps here. Resume remains a separate action.
              </p>
              <ul>
                {status.roadmaps.map((r) => (
                  <li key={r.id}>
                    <a href={`/workspaces/${encodeURIComponent(r.workspaceId)}/roadmaps`}>
                      {r.name}
                    </a>{' '}
                    · {r.status} ·{' '}
                    {r.crossProject
                      ? 'Saved-plan review required after a capacity change'
                      : 'No cross-project plan review required'}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </Section>
      <RoadmapCapacityPanel
        workspaceId={workspaceId}
        csrfToken={csrfToken}
        {...(status ? { developmentCapacity: status.developmentCapacity } : {})}
      />
    </Section>
  );
}
function CapacityLinks({
  item,
}: {
  item: HostSchedulingStatus['reservations'][number] | HostSchedulingStatus['waiting'][number];
}) {
  const path = `/workspaces/${encodeURIComponent(item.workspaceId)}`;
  return (
    <>
      {item.runId && (
        <>
          {' '}
          · <a href={`${path}/runs/${encodeURIComponent(item.runId)}`}>Open run</a>
        </>
      )}
      {item.workItemId && (
        <>
          {' '}
          · <a href={`${path}/work-items/${encodeURIComponent(item.workItemId)}`}>Open work item</a>
        </>
      )}
    </>
  );
}
