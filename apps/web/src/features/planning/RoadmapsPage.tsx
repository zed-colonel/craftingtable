import { MapAmendmentPanel } from './MapAmendmentPanel.js';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';
import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import { executionScopeKey } from '@craftingtable/domain';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import type {
  ExecutionStatusResponse,
  SaveRoadmapRequest,
  WorkspaceWorkItemListResponse,
} from '@craftingtable/contracts';
import {
  CYCLE_STEPS,
  type CycleProfiles,
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_ROADMAP_SCHEDULING,
  type Roadmap,
  type RoadmapDefinition,
  type RoadmapStatus,
  type RoadmapView,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { loadWorkspaceWorkItems } from '../../lib/planning-api.js';
import {
  controlRoadmap,
  loadRoadmapHistory,
  loadRoadmaps,
  saveRoadmap,
} from '../../lib/roadmap-api.js';
import { buildPath } from '../../lib/route.js';
import { CycleSettingsFields } from '../execution/CycleSettingsFields.js';
import { ConcurrencyImports } from './ConcurrencyImports.js';
import { RoadmapAutomationFields } from './RoadmapAutomationFields.js';

const labels: Record<RoadmapStatus, string> = {
  draft: 'Draft',
  running: 'Scheduling enabled',
  paused: 'Paused',
  'needs-attention': 'Needs attention',
  stopped: 'Stopped',
  completed: 'Completed',
};
type Draft = SaveRoadmapRequest & { id: string };
export function RoadmapsPage({
  workspaceId,
  csrfToken,
  canMutate,
  onOpenWorkItem,
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
  canMutate: boolean;
  onOpenWorkItem: (id: WorkItemId) => void;
}) {
  const [roadmaps, setRoadmaps] = useState<readonly RoadmapView[]>([]);
  const [items, setItems] = useState<WorkspaceWorkItemListResponse['items']>([]);
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  const [defaults, setDefaults] = useState<CycleProfiles>();
  const [draft, setDraft] = useState<Draft>();
  const [selected, setSelected] = useState('');
  const [scopeChoices, setScopeChoices] = useState<ExecutionScopeChoice[]>([]);
  const [selectedScope, setSelectedScope] = useState('whole-item');
  useEffect(() => {
    let alive = true;
    setScopeChoices([]);
    setSelectedScope('whole-item');
    if (selected)
      void loadExecutionScopes(workspaceId, selected as WorkItemId)
        .then((r) => {
          if (alive) setScopeChoices(r.choices.filter((c) => c.scope.kind === 'slice'));
        })
        .catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : 'Could not load scopes.');
        });
    return () => {
      alive = false;
    };
  }, [workspaceId, selected]);
  const scopeToAdd = scopeChoices.find((c) => executionScopeKey(c.scope) === selectedScope);
  const duplicateScope = draft?.entries.some(
    (e) =>
      e.workItemId === selected &&
      (!e.executionScope ||
        selectedScope === 'whole-item' ||
        executionScopeKey(e.executionScope) === selectedScope),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [history, setHistory] = useState<{
    id: string;
    definitions: readonly RoadmapDefinition[];
  }>();
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await loadRoadmaps(workspaceId);
        if (alive) {
          setRoadmaps(result.roadmaps);
          setLoaded(true);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load roadmaps.');
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    void Promise.all([
      loadWorkspaceWorkItems(workspaceId, 'all'),
      loadExecutionStatus(),
      loadRunProfiles(workspaceId),
    ])
      .then(([listing, status, profiles]) => {
        if (!alive) return;
        setItems(listing.items);
        setBackends(status.backends);
        setDefaults(
          Object.fromEntries(
            CYCLE_STEPS.map((step) => {
              const profile = profiles.profiles.find(
                (p) => p.role === (step === 'remediate' ? 'implement' : step),
              );
              return [
                step,
                {
                  backend:
                    profile?.backend ??
                    status.backends.find((b) => b.available)?.kind ??
                    'claude-code',
                  permissionMode: profile?.permissionMode ?? 'auto',
                  ...(profile?.model ? { model: profile.model } : {}),
                },
              ];
            }),
          ) as CycleProfiles,
        );
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load work items.');
      });
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [workspaceId]);
  const apply = (view: RoadmapView) =>
    setRoadmaps((current) => [view, ...current.filter((r) => r.roadmap.id !== view.roadmap.id)]);
  const command = async (
    roadmap: Roadmap,
    action: 'start' | 'pause' | 'resume' | 'stop',
    entryId?: string,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      apply(await controlRoadmap(roadmap, action, csrfToken, entryId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Roadmap command failed.');
    } finally {
      setBusy(false);
    }
  };
  const edit = (roadmap: Roadmap) => {
    setDraft({
      id: roadmap.id,
      expectedVersion: roadmap.version,
      name: roadmap.definition.name,
      scheduling: roadmap.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING,
      ...(roadmap.definition.automation ? { automation: roadmap.definition.automation } : {}),
      entries: roadmap.definition.entries.map(
        ({
          id,
          workItemId,
          profiles,
          policy,
          instructions,
          exclusionGroups,
          automation,
          executionScope,
        }) => ({
          ...(executionScope
            ? { executionScope: { ...executionScope, kind: 'slice' as const } }
            : {}),
          id,
          workItemId,
          profiles,
          policy,
          instructions,
          ...(automation ? { automation } : {}),
          ...(exclusionGroups === undefined ? {} : { exclusionGroups: [...exclusionGroups] }),
        }),
      ),
    });
    setError(undefined);
  };
  const current = roadmaps.find((r) => r.roadmap.id === draft?.id)?.roadmap;
  const lastStarted =
    current?.definition.entries.findLastIndex((e) =>
      current.attempts.some((a) => a.entryId === e.id),
    ) ?? -1;
  const parallel = draft?.scheduling?.mode === 'parallel';
  const updateEntry = (index: number, changes: Partial<SaveRoadmapRequest['entries'][number]>) => {
    if (draft)
      setDraft({
        ...draft,
        entries: draft.entries.map((entry, i) => (i === index ? { ...entry, ...changes } : entry)),
      });
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Roadmaps</h1>
          <p className="subtitle">
            Sequential or parallel work items, with configurable integration automation.
          </p>
        </div>
        {canMutate && !draft && (
          <button
            type="button"
            className="primary-button"
            disabled={busy || !defaults}
            onClick={() =>
              setDraft({
                id: crypto.randomUUID(),
                expectedVersion: 0,
                name: '',
                entries: [],
                scheduling: DEFAULT_ROADMAP_SCHEDULING,
              })
            }
          >
            New roadmap
          </button>
        )}
      </header>
      <ConcurrencyImports
        key={workspaceId}
        workspaceId={workspaceId}
        csrfToken={csrfToken}
        canMutate={canMutate}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p className="hint">
        One delegated roadmap per workspace. Sequential mode follows list order; parallel mode
        starts eligible items in priority order, subject to dependencies, capacity, and exclusion
        groups. The daemon creates its branch and worktree when eligible, runs its automated cycle,
        and waits for you to merge. Closing the browser leaves scheduling active. Restarting the
        daemon requires explicit resume.
      </p>
      {draft && (
        <section className="panel" aria-label="Roadmap editor">
          <h2>{draft.expectedVersion === 0 ? 'New roadmap' : 'Edit queued entries'}</h2>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(undefined);
              try {
                const { id, ...input } = draft;
                apply(await saveRoadmap(workspaceId, id, input, csrfToken));
                setDraft(undefined);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not save roadmap.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              Roadmap name
              <input
                required
                maxLength={120}
                value={draft.name}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="field">
              Scheduling mode
              <select
                value={draft.scheduling?.mode ?? 'sequential'}
                disabled={busy || !!current?.attempts.some((a) => a.status !== 'completed')}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    scheduling: {
                      ...(draft.scheduling ?? DEFAULT_ROADMAP_SCHEDULING),
                      mode: e.target.value as 'sequential' | 'parallel',
                    },
                  })
                }
              >
                <option value="sequential">Sequential</option>
                <option value="parallel">Parallel</option>
              </select>
            </label>
            {parallel && (
              <>
                <p className="hint">
                  List order is scheduling priority. Required predecessors must be merged first.
                  Items awaiting merge or attention retain their capacity and exclusion groups.
                  Refresh limits are fixed for each item when it starts.
                </p>
                {(
                  [
                    ['maxInFlight', 'Maximum in-flight items', 16],
                    ['maxPerRepository', 'Maximum in-flight items per repository', 16],
                    ['maxIntegrationRefreshes', 'Maximum integration refreshes per item', 20],
                  ] as const
                ).map(([key, label, max]) => (
                  <label className="field" key={key}>
                    {label}
                    <input
                      type="number"
                      required
                      min={1}
                      max={max}
                      disabled={busy}
                      value={draft.scheduling?.[key] ?? DEFAULT_ROADMAP_SCHEDULING[key]}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          scheduling: {
                            ...(draft.scheduling ?? DEFAULT_ROADMAP_SCHEDULING),
                            [key]: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </>
            )}
            <RoadmapAutomationFields
              value={draft.automation}
              onChange={(automation) => setDraft({ ...draft, automation })}
              disabled={busy}
              backends={backends}
            />
            <label className="field">
              Add work item
              <select
                value={selected}
                disabled={busy}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Choose from imported active plans</option>
                {items
                  .filter(
                    (item) =>
                      item.status !== 'completed' &&
                      !draft.entries.some((e) => e.workItemId === item.id && !e.executionScope),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.projectName} · {item.sourceId} · {item.title}
                    </option>
                  ))}
              </select>
            </label>
            {scopeChoices.length > 0 && (
              <label className="field">
                Execution scope
                <select
                  value={selectedScope}
                  onChange={(e) => setSelectedScope(e.target.value)}
                  disabled={busy}
                >
                  <option value="whole-item">Whole work item — existing workflow</option>
                  {scopeChoices.map((c) => (
                    <option key={executionScopeKey(c.scope)} value={executionScopeKey(c.scope)}>
                      {c.scope.sourceId} · {c.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {scopeToAdd && (
              <>
                <p>{scopeToAdd.description}</p>
                <p className="hint">
                  Merging this slice will not complete its parent. This draft does not adopt map
                  decisions.
                </p>
                {scopeToAdd.blockers.length > 0 && (
                  <details>
                    <summary>Pending scope requirements ({scopeToAdd.blockers.length})</summary>
                    <ul>
                      {scopeToAdd.blockers.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            {duplicateScope && (
              <p className="hint">
                Choose an unused slice. Whole-item and slice entries cannot be mixed for one parent.
              </p>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={
                busy ||
                !selected ||
                !defaults ||
                draft.entries.length >= 100 ||
                !!duplicateScope ||
                (selectedScope !== 'whole-item' && !scopeToAdd)
              }
              onClick={() => {
                if (defaults) {
                  setDraft({
                    ...draft,
                    entries: [
                      ...draft.entries,
                      {
                        ...(scopeToAdd
                          ? { executionScope: { ...scopeToAdd.scope, kind: 'slice' as const } }
                          : {}),
                        id: crypto.randomUUID(),
                        workItemId: selected as WorkItemId,
                        profiles: defaults,
                        policy: DEFAULT_COMPLETION_POLICY,
                        instructions: '',
                      },
                    ],
                  });
                  setSelected('');
                }
              }}
            >
              Add to sequence
            </button>
            <ol className="roadmap-entries">
              {draft.entries.map((entry, index) => {
                const item =
                  items.find((i) => i.id === entry.workItemId) ??
                  current?.definition.entries.find((i) => i.workItemId === entry.workItemId);
                const frozen = parallel
                  ? !!current?.attempts.some((a) => a.entryId === entry.id)
                  : index <= lastStarted;
                return (
                  <li key={entry.id} className="panel">
                    <h3>
                      {entry.executionScope?.sourceId ?? item?.sourceId ?? entry.workItemId} ·{' '}
                      {item?.title}
                    </h3>
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          busy || (parallel ? index === 0 : frozen || index <= lastStarted + 1)
                        }
                        onClick={() => {
                          const entries = [...draft.entries];
                          const prior = entries[index - 1];
                          if (prior) {
                            entries[index - 1] = entry;
                            entries[index] = prior;
                            setDraft({ ...draft, entries });
                          }
                        }}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          busy || (!parallel && frozen) || index === draft.entries.length - 1
                        }
                        onClick={() => {
                          const entries = [...draft.entries];
                          const next = entries[index + 1];
                          if (next) {
                            entries[index + 1] = entry;
                            entries[index] = next;
                            setDraft({ ...draft, entries });
                          }
                        }}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || frozen}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            entries: draft.entries.filter((e) => e.id !== entry.id),
                          })
                        }
                      >
                        Remove entry
                      </button>
                    </div>
                    {frozen && (
                      <p className="hint">
                        This entry has started. Its effective settings stay fixed.
                      </p>
                    )}
                    {parallel && (
                      <label className="field">
                        Exclusion groups (comma separated)
                        <input
                          disabled={busy || frozen}
                          value={(entry.exclusionGroups ?? []).join(', ')}
                          onChange={(e) =>
                            updateEntry(index, {
                              exclusionGroups: e.target.value
                                .split(',')
                                .map((group) => group.trim()),
                            })
                          }
                          onBlur={() =>
                            updateEntry(index, {
                              exclusionGroups: [
                                ...new Set((entry.exclusionGroups ?? []).filter(Boolean)),
                              ],
                            })
                          }
                        />
                      </label>
                    )}
                    <label className="field">
                      Integration policy
                      <select
                        disabled={busy || frozen}
                        value={entry.automation ? 'override' : 'inherit'}
                        onChange={(e) =>
                          updateEntry(index, {
                            automation:
                              e.target.value === 'override'
                                ? (draft.automation ?? {
                                    integrationMerge: 'manual',
                                    integrationConflicts: 'manual',
                                  })
                                : undefined,
                          })
                        }
                      >
                        <option value="inherit">Use roadmap defaults</option>
                        <option value="override">Override for this item</option>
                      </select>
                    </label>
                    {entry.automation && (
                      <RoadmapAutomationFields
                        value={entry.automation}
                        onChange={(automation) => updateEntry(index, { automation })}
                        disabled={busy || frozen}
                        backends={backends}
                      />
                    )}
                    <details>
                      <summary>Agents, models, and completion policy</summary>
                      <CycleSettingsFields
                        policy={entry.policy}
                        setPolicy={(policy) => updateEntry(index, { policy })}
                        choices={entry.profiles}
                        setChoices={(profiles) => updateEntry(index, { profiles })}
                        instructions={entry.instructions}
                        setInstructions={(instructions) => updateEntry(index, { instructions })}
                        backends={backends}
                        disabled={busy || frozen}
                      />
                    </details>
                  </li>
                );
              })}
            </ol>
            <p className="hint">
              Saving binds these exact plan versions and their configured integration branches.
              Starting delegates only the selected items. Dependencies outside this sequence remain
              visible blockers. Design pauses for open questions. Starting authorizes the selected
              integration policies; merging into main always remains yours.
            </p>
            {current && current.version !== draft.expectedVersion && (
              <p role="alert">
                This roadmap changed while you were editing. Cancel and reopen the editor to use its
                current version.
              </p>
            )}
            <div className="inline-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={
                  busy ||
                  draft.entries.length === 0 ||
                  !!(current && current.version !== draft.expectedVersion)
                }
              >
                Save roadmap
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setDraft(undefined)}
              >
                Cancel editing
              </button>
            </div>
          </form>
        </section>
      )}
      {!loaded && <p>Loading roadmaps…</p>}
      {loaded && roadmaps.length === 0 && !draft && (
        <p className="empty-state">
          No roadmaps yet. Create a sequence from your imported work items.
        </p>
      )}
      {roadmaps.map(({ roadmap, progress }) => (
        <section className="panel" key={roadmap.id} aria-label={roadmap.definition.name}>
          <h2>{roadmap.definition.name}</h2>
          <p>
            <strong>{labels[roadmap.status]}</strong> ·{' '}
            {progress.filter((p) => p.status === 'completed').length}/{progress.length} completed ·
            Revision {roadmap.definition.revision}
          </p>
          <p>
            {roadmap.definition.scheduling?.mode === 'parallel'
              ? `Parallel · ${roadmap.definition.scheduling.maxInFlight} in-flight slots · ${roadmap.definition.scheduling.maxPerRepository} per repository`
              : 'Sequential'}
          </p>
          <p>
            {roadmap.attempts.filter((a) => a.status !== 'completed').length} in flight ·{' '}
            {progress.filter((p) => p.status === 'running').length} cycles running
          </p>
          <p role="status">{roadmap.reason}</p>
          <div className="inline-actions">
            {canMutate && (
              <>
                {roadmap.status === 'draft' && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !!draft}
                    onClick={() => void command(roadmap, 'start')}
                  >
                    Start roadmap
                  </button>
                )}
                {roadmap.status === 'running' && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void command(roadmap, 'pause')}
                  >
                    Pause roadmap
                  </button>
                )}
                {['paused', 'needs-attention'].includes(roadmap.status) && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !!draft}
                    onClick={() => void command(roadmap, 'resume')}
                  >
                    Resume roadmap
                  </button>
                )}
                {!roadmap.definition.crossProject &&
                  ['draft', 'paused', 'needs-attention'].includes(roadmap.status) && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !!draft}
                      onClick={() => edit(roadmap)}
                    >
                      Edit queued entries
                    </button>
                  )}
                {!['completed', 'stopped'].includes(roadmap.status) && (
                  <button
                    type="button"
                    className="secondary-button danger"
                    disabled={busy || !!draft}
                    onClick={() => void command(roadmap, 'stop')}
                  >
                    Stop roadmap
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                void loadRoadmapHistory(roadmap)
                  .then((result) => setHistory({ id: roadmap.id, definitions: result.definitions }))
                  .catch((e) =>
                    setError(e instanceof Error ? e.message : 'Could not load history.'),
                  )
              }
            >
              View revisions
            </button>
          </div>
          {roadmap.definition.crossProject && (
            <>
              <MapAmendmentPanel
                key={`${roadmap.id}:${roadmap.definition.revision}`}
                workspaceId={workspaceId}
                roadmap={roadmap}
                csrfToken={csrfToken}
                canMutate={canMutate}
              />
              <CrossProjectPanel
                workspaceId={workspaceId}
                definitionId={roadmap.definition.crossProject.definitionId}
                bindingRevision={roadmap.definition.crossProject.bindingRevision}
                targets={[
                  {
                    id: roadmap.definition.crossProject.targetId,
                    scope:
                      roadmap.definition.crossProject.selection === 'target-only'
                        ? 'Only the selected target prerequisite scope is delegated.'
                        : 'Full retained roadmap with the selected target prioritized.',
                  },
                ]}
                roadmap={roadmap}
                csrfToken={csrfToken}
                canMutate={canMutate}
              />
              <div id={`runtime-evidence-${roadmap.definition.crossProject.definitionId}`} />
              <RuntimeEvidencePanel
                workspaceId={workspaceId}
                definitionId={roadmap.definition.crossProject.definitionId}
                bindingRevision={roadmap.definition.crossProject.bindingRevision}
                csrfToken={csrfToken}
                canMutate={canMutate}
              />
            </>
          )}
          <details open={!roadmap.definition.crossProject}>
            <summary>
              Execution attempts and individual controls ({roadmap.definition.entries.length})
            </summary>
            <ol className="roadmap-entries">
              {roadmap.definition.entries.map((entry) => {
                const state = progress.find((p) => p.entryId === entry.id);
                const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
                return (
                  <li key={entry.id}>
                    <a
                      href={buildPath({
                        name: 'work-item',
                        workspaceId,
                        workItemId: entry.workItemId,
                      })}
                      onClick={(event) => {
                        event.preventDefault();
                        onOpenWorkItem(entry.workItemId);
                      }}
                    >
                      {entry.sourceId} · {entry.executionScope?.kind} · {entry.title}
                    </a>
                    <p>
                      <strong>
                        {state?.status === 'awaiting-merge'
                          ? entry.executionScope && entry.executionScope.kind !== 'slice'
                            ? 'Ready for scope acceptance'
                            : 'Awaiting merge approval'
                          : state?.status === 'paused'
                            ? 'Item paused'
                            : state?.status === 'capacity-blocked'
                              ? 'Waiting for capacity'
                              : state?.status === 'exclusion-blocked'
                                ? 'Waiting for exclusion group'
                                : state?.status === 'dependency-blocked'
                                  ? 'Waiting on prerequisites'
                                  : state?.status === 'needs-attention'
                                    ? 'Needs attention'
                                    : state?.status === 'completed'
                                      ? 'Completed'
                                      : state?.status === 'running'
                                        ? 'Running'
                                        : 'Queued'}
                      </strong>{' '}
                      · <code>{entry.integrationBranch}</code>
                    </p>
                    <p className="hint">{state?.reason}</p>
                    {entry.executionScope && entry.executionScope.kind !== 'slice' ? (
                      <p className="hint">
                        Independent review records scope evidence; it does not merge a branch.
                      </p>
                    ) : (
                      <p className="hint">
                        Integration merge:{' '}
                        {(
                          state?.effectiveAutomation ??
                          entry.automation ??
                          roadmap.definition.automation
                        )?.integrationMerge === 'automatic'
                          ? 'Automatic when reviewed and ready'
                          : 'Your approval required'}{' '}
                        · Conflicts:{' '}
                        {(
                          state?.effectiveAutomation ??
                          entry.automation ??
                          roadmap.definition.automation
                        )?.integrationConflicts === 'automatic'
                          ? 'Automatic delegation'
                          : 'Ask you'}
                      </p>
                    )}
                    {!!entry.exclusionGroups?.length && (
                      <p className="hint">Exclusion groups: {entry.exclusionGroups.join(', ')}</p>
                    )}
                    {canMutate &&
                      roadmap.status === 'running' &&
                      roadmap.definition.scheduling?.mode === 'parallel' &&
                      state?.status !== 'completed' && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void command(
                              roadmap,
                              ['paused', 'needs-attention'].includes(state?.status ?? '')
                                ? 'resume'
                                : 'pause',
                              entry.id,
                            )
                          }
                        >
                          {['paused', 'needs-attention'].includes(state?.status ?? '')
                            ? 'Resume item'
                            : 'Pause item'}
                        </button>
                      )}
                    <details>
                      <summary>Bound plan and cycle settings</summary>
                      <p className="hint">
                        Plan version: <code>{entry.planVersionId}</code>
                        {attempt && <> · Execution revision {attempt.definitionRevision}</>}
                      </p>
                      <ul>
                        {CYCLE_STEPS.map((step) => (
                          <li key={step}>
                            {step}: {entry.profiles[step].backend} ·{' '}
                            <code>{entry.profiles[step].model ?? 'Backend default'}</code> ·{' '}
                            {entry.profiles[step].permissionMode}
                          </li>
                        ))}
                      </ul>
                      <p>
                        Zero blocking, major, or minor findings; at most {entry.policy.maxNits}{' '}
                        nits. Up to {entry.policy.maxRemediationRounds} remediation rounds,{' '}
                        {entry.policy.maxRunMinutes} minutes per step.
                      </p>
                      {entry.instructions && (
                        <pre className="roadmap-instructions">{entry.instructions}</pre>
                      )}
                    </details>
                  </li>
                );
              })}
            </ol>
          </details>
          {history?.id === roadmap.id && (
            <details open>
              <summary>Saved revisions</summary>
              {history.definitions.map((def) => (
                <details key={def.revision}>
                  <summary>
                    Revision {def.revision} · {def.name} ·{' '}
                    {new Date(def.createdAt).toLocaleString()}
                  </summary>
                  <pre className="roadmap-instructions">{JSON.stringify(def, null, 2)}</pre>
                </details>
              ))}
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
