import { CrossProjectPanel } from './CrossProjectPanel.js';
import type { ConcurrencyDetail, ConcurrencyList } from '@craftingtable/contracts';
import type { PlanVersionId, SourceRepositoryId, WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import {
  archiveDownloadPath,
  importConcurrencyZip,
  loadConcurrencyDefinition,
  loadConcurrencyImports,
  saveConcurrencyBindings,
} from '../../lib/package-import-api.js';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';
import { ImportIssues } from './import-issues.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';

export function ConcurrencyImports({
  workspaceId,
  csrfToken,
  canMutate,
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
  canMutate: boolean;
}) {
  const [listing, setListing] = useState<ConcurrencyList>();
  const [detail, setDetail] = useState<ConcurrencyDetail>();
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    void loadConcurrencyImports(workspaceId)
      .then((r) => {
        if (alive) setListing(r);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load imported maps.');
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  const adoptView = (d: ConcurrencyDetail) => {
    setDetail(d);
    setSelections(
      Object.fromEntries(
        d.repositories.map((r) => [
          r.alias,
          r.role === 'implemented_upstream'
            ? (r.selectedRepositoryId ?? '')
            : (r.selectedPlanVersionId ?? ''),
        ]),
      ),
    );
  };
  const open = async (id: string) => {
    setBusy(true);
    setError(undefined);
    setNotice('');
    try {
      adoptView(await loadConcurrencyDefinition(workspaceId, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the definition.');
    } finally {
      setBusy(false);
    }
  };
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    setNotice('');
    try {
      const r = await importConcurrencyZip(workspaceId, file, csrfToken);
      setListing(await loadConcurrencyImports(workspaceId));
      if (r.attempt.definitionId && ['succeeded', 'duplicate'].includes(r.attempt.outcome)) {
        adoptView(await loadConcurrencyDefinition(workspaceId, r.attempt.definitionId));
        setNotice(
          r.attempt.outcome === 'duplicate'
            ? 'This exact map is already imported; its history is unchanged.'
            : 'Imported as an inactive cross-project roadmap draft.',
        );
      } else {
        setError(r.attempt.diagnostics.map((d) => d.message).join(' '));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Map import failed.');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!detail) return;
    setBusy(true);
    setError(undefined);
    setNotice('');
    try {
      const bindings = detail.repositories.flatMap((r) => {
        const selected = selections[r.alias];
        return selected
          ? [
              r.role === 'implemented_upstream'
                ? { alias: r.alias, repositoryId: selected as SourceRepositoryId }
                : { alias: r.alias, planVersionId: selected as PlanVersionId },
            ]
          : [];
      });
      adoptView(
        await saveConcurrencyBindings(
          workspaceId,
          detail.summary.id,
          { expectedRevision: detail.summary.bindingRevision, bindings },
          csrfToken,
        ),
      );
      setListing(await loadConcurrencyImports(workspaceId));
      setNotice('Bindings saved. Next: adopt the scheduling proposals in the supervisor below.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save bindings.');
    } finally {
      setBusy(false);
    }
  };
  const invalidSelection = detail?.repositories.some(
    (r) =>
      r.role === 'planned_application' &&
      selections[r.alias] &&
      !r.options.find((o) => o.planVersionId === selections[r.alias])?.exactSources,
  );
  return (
    <Section
      id="cross-project-imports"
      title="Cross-project roadmaps"
      label="Cross-project roadmap imports"
      summary={
        listing === undefined
          ? undefined
          : listing.definitions.length === 0
            ? 'No concurrency maps imported yet.'
            : `${listing.definitions.length} imported map${listing.definitions.length === 1 ? '' : 's'}.`
      }
    >
      <About label="About cross-project roadmaps">
        <p>
          Import a concurrency map to inspect its slices, gates and exact plan bindings. Choose a
          target, review and adopt its scheduling proposals, then create a roadmap and explicitly
          Start. Importing alone never launches work.
        </p>
        <p>
          Start, merge, verification and parent acceptance are distinct. Slice verification also
          requires its merge; a checkpoint's prerequisites only make its evaluation eligible.
        </p>
      </About>
      {canMutate && (
        <details>
          <summary>Import concurrency map</summary>
          <label className="field">
            Concurrency map ZIP (up to 8 MiB)
            <input
              type="file"
              accept=".zip"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
          <button
            type="button"
            disabled={busy || !file || file.size > 8 * 1024 * 1024}
            onClick={() => void upload()}
          >
            {busy ? 'Working…' : 'Import map ZIP'}
          </button>
          {file && file.size > 8 * 1024 * 1024 && <p role="alert">ZIP exceeds 8 MiB.</p>}
        </details>
      )}
      {listing && listing.definitions.length > 0 && (
        <label className="field">
          Imported roadmap draft
          <select
            disabled={busy}
            value={detail?.summary.id ?? ''}
            onChange={(e) => {
              if (e.target.value) void open(e.target.value);
              else setDetail(undefined);
            }}
          >
            <option value="">Select a map revision</option>
            {listing.definitions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.mapId} · {d.revision} · {d.parentCount} parents / {d.sliceCount} slices
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {detail && (
        <>
          <h3>{detail.summary.document}</h3>
          <p>
            <strong>Imported definition · explicit delegation required</strong>
          </p>
          <StatusStrip
            compact
            label="Map size"
            facts={[
              { label: 'Work items', value: detail.summary.parentCount, mono: true },
              { label: 'Slices', value: detail.summary.sliceCount, mono: true },
              { label: 'Checkpoints', value: detail.summary.checkpointCount, mono: true },
              { label: 'Milestones', value: detail.summary.graphNodeCount, mono: true },
              { label: 'Dependency edges', value: detail.summary.graphEdgeCount, mono: true },
            ]}
          />
          <details>
            <summary>Definition identity and original ZIP</summary>
            <p>
              Map {detail.summary.mapId}, revision {detail.summary.revision}
            </p>
            <p>
              Map digest: <code className="import-digest">{detail.summary.digest}</code>
            </p>
            <p>
              ZIP digest: <code className="import-digest">{detail.archiveDigest}</code>
            </p>
            <a href={archiveDownloadPath(workspaceId, detail.archiveId)}>
              Download original concurrency ZIP
            </a>
          </details>
          <ImportIssues issues={detail.blockers} errorLabel="Before execution" />
          <CrossProjectPanel
            workspaceId={workspaceId}
            definitionId={detail.summary.id}
            bindingRevision={detail.summary.bindingRevision}
            targets={detail.targets}
            csrfToken={csrfToken}
            canMutate={canMutate}
            key={`supervision:${detail.summary.id}:${detail.summary.bindingRevision}`}
          />
          <RuntimeEvidencePanel
            key={`${detail.summary.id}:${detail.summary.bindingRevision}`}
            workspaceId={workspaceId}
            definitionId={detail.summary.id}
            bindingRevision={detail.summary.bindingRevision}
            csrfToken={csrfToken}
            canMutate={canMutate}
          />
          <h3>Exact project and plan bindings</h3>
          <p>
            Choose the revised plan versions explicitly. Saving records an immutable binding
            revision; it does not adopt scheduling proposals or start work.
          </p>
          {detail.repositories.map((repo) => {
            const option = repo.options.find((o) => o.planVersionId === selections[repo.alias]);
            const recordedSelection =
              repo.role === 'implemented_upstream'
                ? repo.selectedRepositoryId
                : repo.selectedPlanVersionId;
            const selectionChanged = (selections[repo.alias] ?? '') !== (recordedSelection ?? '');
            return (
              <article className="import-binding" key={repo.alias}>
                <h4>
                  {repo.alias.toUpperCase()} · {repo.name}
                </h4>
                <p>
                  {repo.role === 'implemented_upstream'
                    ? 'Implemented upstream · no runnable AQ work is created'
                    : `Planned application · suggested integration branch: ${repo.suggestedBranch}`}
                </p>
                <label className="field">
                  {repo.role === 'implemented_upstream'
                    ? `${repo.alias} upstream repository`
                    : `${repo.alias} plan version`}
                  <select
                    aria-label={
                      repo.role === 'implemented_upstream'
                        ? `${repo.alias} upstream repository`
                        : `${repo.alias} plan version`
                    }
                    disabled={busy || !canMutate}
                    value={selections[repo.alias] ?? ''}
                    onChange={(e) => setSelections({ ...selections, [repo.alias]: e.target.value })}
                  >
                    <option value="">Unbound — select explicitly</option>
                    {repo.role === 'implemented_upstream'
                      ? detail.sourceRepositories.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))
                      : repo.options.map((o) => (
                          <option key={o.planVersionId} value={o.planVersionId}>
                            {o.projectName} · v{o.versionNumber} ·{' '}
                            {o.exactSources ? 'exact source match' : 'source mismatch'}
                          </option>
                        ))}
                  </select>
                </label>
                {selectionChanged ? (
                  <p className="hint">Unsaved selection — use Save exact bindings below.</p>
                ) : recordedSelection ? (
                  <p>
                    <strong>
                      {repo.role === 'implemented_upstream'
                        ? 'Repository selection saved.'
                        : 'Plan version selection saved.'}
                    </strong>
                  </p>
                ) : null}
                {option && (
                  <>
                    <p>
                      {option.exactSources
                        ? 'All required source documents and work-item records match.'
                        : 'This version cannot be bound to the map.'}{' '}
                      {option.archiveMatched ? 'Declared ZIP provenance matches.' : ''}
                    </p>
                    <ImportIssues issues={option.issues} />
                    <p>
                      <Link
                        route={{
                          name: 'plan-version',
                          workspaceId,
                          projectId: option.projectId,
                          planVersionId: option.planVersionId,
                        }}
                      >
                        Open version {option.versionNumber} / Repository &amp; branches
                      </Link>
                    </p>
                    <p>
                      Configured integration branch:{' '}
                      <code>{option.integrationBranch ?? 'not configured'}</code>
                    </p>
                  </>
                )}
                {repo.role === 'planned_application' && repo.options.length === 0 && (
                  <p>
                    <Link route={{ name: 'import', workspaceId }}>
                      Import the revised planning ZIP
                    </Link>{' '}
                    before choosing a version.
                  </p>
                )}
                <ImportIssues issues={repo.issues} />
                <details>
                  <summary>Required source package and {repo.sources.length} documents</summary>
                  <p>{repo.archiveFilename}</p>
                  <code className="import-digest">{repo.archiveDigest}</code>
                  <ul>
                    {repo.sources.map((s) => (
                      <li key={s.id}>
                        <code>{s.path}</code>
                        <br />
                        <code className="import-digest">{s.sha256}</code>
                      </li>
                    ))}
                  </ul>
                </details>
                {repo.boundWorkItems.length > 0 && (
                  <details>
                    <summary>{repo.boundWorkItems.length} existing work items bound</summary>
                    <ul>
                      {repo.boundWorkItems.map((w) => (
                        <li key={w.sourceId}>
                          <Link
                            route={{
                              name: 'work-item',
                              workspaceId,
                              workItemId: w.workItemId,
                            }}
                          >
                            {w.sourceId}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            );
          })}
          <div className="button-row">
            {canMutate && (
              <button
                type="button"
                className="primary-button"
                disabled={busy || !!invalidSelection || !Object.values(selections).some(Boolean)}
                onClick={() => void save()}
              >
                Save exact bindings
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void open(detail.summary.id)}>
              Refresh binding checks
            </button>
          </div>
          <p className="hint">
            Recorded binding revision: {detail.summary.bindingRevision}. Refresh after configuring
            branches or importing another plan version; refresh replaces unsaved selections.
          </p>
          <details>
            <summary>Binding history ({detail.history.length})</summary>
            <ul>
              {detail.history.map((h) => (
                <li key={h.revision}>
                  Revision {h.revision} · {new Date(h.createdAt).toLocaleString()} ·{' '}
                  {h.aliases.join(', ') || 'no bindings'}
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Planning targets ({detail.targets.length})</summary>
            <p>
              Suggested focus: {detail.suggestedTarget}. No target is selected or approved by
              import.
            </p>
            {detail.targets.map((t) => (
              <article key={t.id}>
                <h4>{t.id}</h4>
                <p>{t.scope}</p>
                <p>
                  {t.isRelease
                    ? 'Full release target'
                    : 'Intermediate proof target; does not complete the plan'}{' '}
                  · gate {t.checkpoint}
                </p>
              </article>
            ))}
          </details>
          <details>
            <summary>Scheduling proposals ({detail.decisions.length})</summary>
            <p>Review and adopt proposals in the target scope supervisor above.</p>
            {detail.decisions.map((d) => (
              <article key={d.id}>
                <h4>
                  {d.id}: {d.title}
                </h4>
                <p>{d.proposal}</p>
              </article>
            ))}
          </details>
          <details>
            <summary>Resources and evidence profiles</summary>
            {detail.resources.map((r) => (
              <article key={r.id}>
                <h4>{r.id}</h4>
                <p>{r.description}</p>
                <p>
                  {r.requiresHardware ? 'Hardware qualification required. ' : ''}
                  {r.requiresAuthorization ? 'Explicit fixture authorization required. ' : ''}
                  Resource not allocated.
                </p>
              </article>
            ))}
            {detail.evidenceProfiles.map((e) => (
              <details key={e.id}>
                <summary>{e.id}</summary>
                <p>Independent reviewer roles: {e.reviewerRoles.join(', ')}</p>
                <ul>
                  {distinct(e.requiredEvidence).map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </details>
            ))}
          </details>
          <details>
            <summary>Work items, slices and checkpoint requirements</summary>
            <p>Start, merge, verification and parent acceptance are distinct steps.</p>
            <label className="field">
              Filter map nodes
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="ID, title, or dependency"
              />
            </label>
            {detail.nodes
              .filter((n) =>
                `${n.id} ${n.title} ${n.requirements.map((r) => r.id).join(' ')}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((n) => (
                <details key={n.id} className="import-node">
                  <summary>
                    {n.id} · {n.kind} · {n.title}
                  </summary>
                  <p>{n.description}</p>
                  {n.parentId && <p>Parent: {n.parentId}</p>}
                  <p>Evidence profile: {n.evidenceProfile}</p>
                  <ul>
                    {n.requirements.map((r) => (
                      <li key={`${r.phase}-${r.kind}-${r.id}-${r.state}`}>
                        <strong>{r.phase}</strong>: {r.id} must be {r.state}
                      </li>
                    ))}
                  </ul>
                  {n.resources.length > 0 && (
                    <p>Resources: {n.resources.map((r) => `${r.phase}: ${r.id}`).join('; ')}</p>
                  )}
                  <ul>
                    {distinct(n.criteria).map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  {n.caseIds.length > 0 && <p>Required cases: {n.caseIds.join(', ')}</p>}
                  <p>
                    Sources: {n.sourceIds.join(', ') || 'none'} · Scheduling proposals:{' '}
                    {n.decisionIds.join(', ') || 'none'}
                  </p>
                </details>
              ))}
          </details>
          <details>
            <summary>Package limitations</summary>
            <ul>
              {distinct(detail.limitations).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      {listing && listing.attempts.length > 0 && (
        <details>
          <summary>Import history ({listing.attempts.length} recent attempts)</summary>
          {listing.attempts.map((a) => (
            <article key={a.id}>
              <p>
                <strong>{a.outcome}</strong> · {a.filename} ·{' '}
                {new Date(a.createdAt).toLocaleString()}
              </p>
              <ImportIssues issues={a.diagnostics} />
              {a.definitionId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void open(a.definitionId as string)}
                >
                  Open recorded definition
                </button>
              )}
            </article>
          ))}
        </details>
      )}
    </Section>
  );
}
