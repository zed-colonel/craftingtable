import { useCallback, useEffect, useRef, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import {
  amendmentImpactSchema,
  mapAmendmentsViewSchema,
  crossProjectFinalizationSchema,
  type AmendmentImpact,
  type MapAmendmentsView,
  type CrossProjectFinalizationView,
} from '@craftingtable/contracts';
import {
  asAgentRunId,
  type Roadmap,
  type MapSelection,
  type WorkspaceId,
} from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { buildPath } from '../../lib/route.js';
export function MapAmendmentPanel({
  workspaceId,
  roadmap,
  csrfToken,
  canMutate,
}: {
  workspaceId: WorkspaceId;
  roadmap: Roadmap;
  csrfToken: string;
  canMutate: boolean;
}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmaps/${encodeURIComponent(roadmap.id)}`;
  const [view, setView] = useState<MapAmendmentsView>(),
    [readiness, setReadiness] = useState<CrossProjectFinalizationView>(),
    [candidate, setCandidate] = useState<MapSelection>(() => {
      const c = roadmap.definition.crossProject!;
      return {
        definitionId: c.definitionId,
        bindingRevision: c.bindingRevision,
        targetId: c.targetId,
        selection: c.selection,
      };
    }),
    [impact, setImpact] = useState<AmendmentImpact>(),
    [summary, setSummary] = useState(''),
    [sourceRunId, setSourceRunId] = useState(''),
    [rationale, setRationale] = useState(''),
    [reuse, setReuse] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const [v, f] = await Promise.all([
      request(`${base}/amendments`, mapAmendmentsViewSchema),
      request(`${base}/finalization-readiness`, crossProjectFinalizationSchema),
    ]);
    if (sequence !== refreshSequence.current) return;
    setView(v);
    setReadiness(f);
    if (v.pendingImpact) setImpact(v.pendingImpact);
  }, [base]);
  useEffect(() => {
    if (roadmap.version < 1) return;
    void refresh().catch((e) =>
      setError(e instanceof Error ? e.message : 'Could not load amendments.'),
    );
  }, [refresh, roadmap.version]);
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(body),
  });
  const act = async (work: () => Promise<void>) => {
    refreshSequence.current++;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  const pending = view?.history.find((a) => !a.decision);
  const selected = view?.candidates.find(
    (c) =>
      c.definitionId === candidate.definitionId && c.bindingRevision === candidate.bindingRevision,
  );
  const change = (next: MapSelection) => {
    setCandidate(next);
    setImpact(undefined);
    setReuse([]);
  };
  const decide = (outcome: 'apply' | 'reject') =>
    void act(async () => {
      if (!pending || !impact) return;
      const next = await request(
        `${base}/amendments/decision`,
        mapAmendmentsViewSchema,
        post({
          amendmentId: pending.id,
          outcome,
          impactDigest: impact.digest,
          rationale,
          reuseIntegrationIds: outcome === 'apply' ? reuse : [],
        }),
      );
      setView(next);
      if (outcome === 'apply') {
        setCandidate(pending.candidate);
        setSummary('');
        setSourceRunId('');
      }
      setImpact(undefined);
      setRationale('');
      setReuse([]);
      setNotice(
        outcome === 'apply'
          ? 'Amendment applied. Review the new configuration, adoption and dependency environment, then explicitly Resume.'
          : 'Proposal rejected. Explicitly Resume when ready.',
      );
      await refresh();
    });
  return (
    <Section
      id={`map-amendments-${roadmap.id}`}
      className="runtime-evidence"
      title="Planning amendments and reconciliation"
      label="Planning amendments and finalization"
      collapsible
      defaultOpen={!!pending}
    >
      <About label="About amendments">
        <p>
          Import revised plans with “Make active” unchecked, configure their branches, then import
          and bind the revised map. Preview and propose the exact replacement here. Use the current
          binding to reconcile stale reviews or change the selected target. Applying keeps this
          roadmap paused.
        </p>
      </About>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending ? (
        <p>
          <strong>Execution held:</strong> {pending.summary}
          {pending.sourceRunId && (
            <>
              {' '}
              ·{' '}
              <a
                href={buildPath({
                  name: 'run',
                  workspaceId,
                  runId: asAgentRunId(pending.sourceRunId),
                })}
              >
                Source run
              </a>
            </>
          )}
        </p>
      ) : (
        <fieldset disabled={!canMutate || busy}>
          <legend>Amendment candidate</legend>
          <label className="field">
            Exact map binding
            <select
              value={`${candidate.definitionId}:${candidate.bindingRevision}`}
              onChange={(e) => {
                const next = view?.candidates.find(
                  (c) => `${c.definitionId}:${c.bindingRevision}` === e.target.value,
                );
                if (next)
                  change({
                    definitionId: next.definitionId,
                    bindingRevision: next.bindingRevision,
                    targetId: next.targets[0]?.id ?? '',
                    selection: candidate.selection,
                  });
              }}
            >
              {view?.candidates.map((c) => (
                <option
                  key={`${c.definitionId}:${c.bindingRevision}`}
                  value={`${c.definitionId}:${c.bindingRevision}`}
                >
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Amended target
            <select
              value={candidate.targetId}
              onChange={(e) => change({ ...candidate, targetId: e.target.value })}
            >
              {selected?.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} — {t.scope}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Amended scope
            <select
              value={candidate.selection}
              onChange={(e) =>
                change({ ...candidate, selection: e.target.value as MapSelection['selection'] })
              }
            >
              <option value="target-only">Selected target only</option>
              <option value="prioritize-full">Full roadmap, prioritize target</option>
            </select>
          </label>
          <label className="field">
            Planning proposal
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={16000}
              placeholder="What needs to change and why?"
            />
          </label>
          <label className="field">
            Source run ID (optional)
            <input value={sourceRunId} onChange={(e) => setSourceRunId(e.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="secondary-button"
              type="button"
              onClick={() =>
                void act(async () =>
                  setImpact(
                    await request(
                      `${base}/amendments/preview`,
                      amendmentImpactSchema,
                      post(candidate),
                    ),
                  ),
                )
              }
            >
              Preview amendment impact
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!impact || !summary.trim()}
              onClick={() =>
                void act(async () => {
                  const next = await request(
                    `${base}/amendments`,
                    mapAmendmentsViewSchema,
                    post({
                      expectedVersion: roadmap.version,
                      candidate,
                      summary,
                      ...(sourceRunId.trim() ? { sourceRunId: sourceRunId.trim() } : {}),
                    }),
                  );
                  setView(next);
                  setImpact(next.pendingImpact);
                  setNotice(
                    'Proposal recorded. Dispatch is held; existing sessions retain their original context.',
                  );
                })
              }
            >
              Propose and hold roadmap
            </button>
          </div>
        </fieldset>
      )}
      {impact && (
        <div>
          <h4>Impact preview</h4>
          <p>
            {impact.candidate.definitionId} · binding {impact.candidate.bindingRevision} ·{' '}
            {impact.candidate.targetId} · {impact.candidate.selection}
          </p>
          {impact.blockers.length > 0 && (
            <ul>
              {impact.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <ul>
            {impact.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <details>
            <summary>
              Changed requirements ({impact.changes.filter((c) => c.change !== 'unchanged').length})
            </summary>
            <ul>
              {impact.changes
                .filter((c) => c.change !== 'unchanged')
                .map((c) => (
                  <li key={c.key}>
                    <strong>
                      {c.change}: {c.key}
                    </strong>
                    <p>
                      Before: {c.before.join(', ') || 'none'}
                      <br />
                      After: {c.after.join(', ') || 'none'}
                    </p>
                  </li>
                ))}
            </ul>
          </details>
          <details>
            <summary>Queued work ({impact.queued.length})</summary>
            <ul>
              {impact.queued.map((q) => (
                <li key={q.key}>
                  {q.key}: {q.disposition}
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Plan bindings ({impact.bindings.length})</summary>
            <ul>
              {impact.bindings.map((b) => (
                <li key={b.alias}>
                  {b.alias}: {b.before} → {b.after}
                  {b.activate ? ' (will activate revised plan)' : ''}
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Attempts ({impact.attempts.length})</summary>
            <ul>
              {impact.attempts.map((a) => (
                <li key={a.id}>
                  {a.sourceId}: {a.status} — {a.disposition}
                  {a.runId && (
                    <>
                      {' '}
                      ·{' '}
                      <a
                        href={buildPath({ name: 'run', workspaceId, runId: asAgentRunId(a.runId) })}
                      >
                        Original run
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p>
              Retired worktrees and branches remain available for inspection. They cannot launch or
              merge work.
            </p>
          </details>
          <details>
            <summary>Evidence applicability ({impact.evidence.length})</summary>
            <ul>
              {impact.evidence.map((e) => (
                <li key={e.id}>
                  {e.sourceId} · {e.kind}: {e.applicability}
                </li>
              ))}
            </ul>
          </details>
          {impact.integrations.length > 0 && (
            <fieldset disabled={!canMutate || busy || !pending}>
              <legend>Explicit integration code reuse</legend>
              <p>Code reuse is optional. It transfers no verification or acceptance approval.</p>
              {impact.integrations.map((i) => (
                <label className="checkbox-row" key={i.sourceId}>
                  <input
                    type="checkbox"
                    disabled={!i.eligible}
                    checked={reuse.includes(i.sourceId)}
                    onChange={(e) =>
                      setReuse(
                        e.target.checked
                          ? [...reuse, i.sourceId]
                          : reuse.filter((x) => x !== i.sourceId),
                      )
                    }
                  />
                  {i.sourceId} · {i.mergeSha.slice(0, 12)} — {i.reason}
                </label>
              ))}
            </fieldset>
          )}
          {pending && (
            <fieldset disabled={!canMutate || busy}>
              <legend>Review decision</legend>
              <label className="field">
                Decision rationale
                <textarea
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  maxLength={8000}
                />
              </label>
              <div className="button-row">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void act(refresh)}
                >
                  Refresh impact
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={impact.blockers.length > 0 || !rationale.trim()}
                  onClick={() => decide('apply')}
                >
                  Apply reviewed amendment
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!rationale.trim()}
                  onClick={() => decide('reject')}
                >
                  Reject proposal
                </button>
              </div>
            </fieldset>
          )}
        </div>
      )}
      {!!view?.history.length && (
        <details>
          <summary>Amendment history ({view.history.length})</summary>
          {view.history.map((a) => (
            <article key={a.id}>
              <p>
                {a.createdAt} · {a.decision?.outcome ?? 'pending'} · {a.summary}
              </p>
              {a.decision && (
                <>
                  <p>
                    {a.decision.rationale} · Previous roadmap revision{' '}
                    {a.decision.previous.definition.revision}
                  </p>
                  <ul>
                    {a.decision.previous.attempts.map((t) => (
                      <li key={t.id}>
                        <a
                          href={buildPath({
                            name: 'work-item',
                            workspaceId,
                            workItemId: a.decision!.previous.definition.entries.find(
                              (e) => e.id === t.entryId,
                            )!.workItemId,
                          })}
                        >
                          Preserved attempt {t.id.slice(0, 8)}
                        </a>{' '}
                        · {t.status}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </article>
          ))}
        </details>
      )}
      <h3>Project finalization readiness</h3>
      <About label="About project finalization">
        <p>
          Finalization covers the full original plan, freezes its integration commit and dependency
          environment, and holds its integration branch. Final promotion always requires your
          approval of the reviewed commit. Promotion does not prove publication or compatibility for
          consumers; review new upstream pins and evidence explicitly.
        </p>
      </About>
      {readiness?.projects.map((p) => (
        <article key={p.alias}>
          <h4>
            {p.alias} — {p.status}
          </h4>
          <p>
            {p.accepted} / {p.total} original parents accepted · {p.integrationBranch}
            {p.integrationSha && <> · snapshot {p.integrationSha.slice(0, 12)}</>}
          </p>
          {p.blockers.length > 0 && (
            <ul>
              {p.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <a
            href={buildPath({
              name: 'plan-version',
              workspaceId,
              projectId: p.projectId,
              planVersionId: p.planVersionId,
            })}
          >
            Open {p.alias} plan and staged finalization
          </a>
        </article>
      ))}
    </Section>
  );
}
