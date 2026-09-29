import { ReverifyItem } from './ReverifyItem.js';
import type {
  AttentionItemView,
  ExecutionScopeChoice,
  ExecutionStatusResponse,
  RuntimeEvidenceView,
  SaveRoadmapRequest,
  WorkspaceWorkItemListResponse,
} from '@craftingtable/contracts';
import {
  CYCLE_STEPS,
  type CycleProfiles,
  cycleProfilesFromDefaults,
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_ROADMAP_SCHEDULING,
  executionScopeKey,
  phaseBlockerCode,
  type Roadmap,
  type RoadmapDefinition,
  type RoadmapStatus,
  type RoadmapView,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { About } from '../../components/About.js';
import { ActionBar } from '../../components/ActionBar.js';
import { PageHeader } from '../../components/PageHeader.js';
import { PageTabs } from '../../components/PageTabs.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import { loadWorkspaceWorkItems } from '../../lib/planning-api.js';
import { useRefreshOn } from '../../lib/refresh-signals.js';
import { revealElement } from '../../lib/reveal-element.js';
import {
  controlRoadmap,
  loadRoadmapHistory,
  loadRoadmaps,
  saveRoadmap,
} from '../../lib/roadmap-api.js';
import { CycleSettingsFields } from '../execution/CycleSettingsFields.js';
import { ConcurrencyImports } from './ConcurrencyImports.js';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import { MapAmendmentPanel } from './MapAmendmentPanel.js';
import { ATTENTION_CODE_LABELS } from '../../lib/attention-labels.js';
import { effectiveRoadmapAttention } from '@craftingtable/domain';
import { RoadmapAutomationFields } from './RoadmapAutomationFields.js';
import { RoadmapStatusList } from './RoadmapStatusList.js';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';
import { ScopeRecoveryPanel } from './ScopeRecoveryPanel.js';
import { distinct } from '../../lib/distinct.js';
import { Link, useNavigation } from '../../lib/navigation.js';
import type { Route, RoadmapTab } from '../../lib/route.js';

const labels: Record<RoadmapStatus, string> = {
  draft: 'Draft',
  running: 'Scheduling enabled',
  paused: 'Paused',
  'needs-attention': 'Needs attention',
  stopped: 'Stopped',
  completed: 'Completed',
};
type Draft = SaveRoadmapRequest & { id: string };
export function roadmapStatusLabel(roadmap: Roadmap, fallback: string) {
  return effectiveRoadmapAttention(roadmap)?.code === 'restart-resume'
    ? 'Resume required after restart'
    : fallback;
}

/** Finished roadmaps go under History on the list; the rest are active. */
const FINISHED: ReadonlySet<RoadmapStatus> = new Set(['completed', 'stopped']);

/**
 * The workspace's roadmaps. They reload when a round says they changed (roadmap, cycle,
 * evidence and merge events) and on the slow safety refresh, never on a fixed 3 s poll
 * (PERF-06). One read at a time; a round during a read is caught by the next.
 */
function useRoadmaps(workspaceId: WorkspaceId) {
  const [roadmaps, setRoadmaps] = useState<readonly RoadmapView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const result = await loadRoadmaps(workspaceId);
      if (mounted.current) {
        setRoadmaps(result.roadmaps);
        setLoaded(true);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not load roadmaps.');
    } finally {
      refreshing.current = false;
    }
  }, [workspaceId]);
  useRefreshOn('roadmaps', () => void refresh());
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  const apply = useCallback(
    (view: RoadmapView) =>
      setRoadmaps((current) => [view, ...current.filter((r) => r.roadmap.id !== view.roadmap.id)]),
    [],
  );
  return { roadmaps, loaded, error, setError, apply };
}

/** What the roadmap editor offers: the workspace's work items, backends and default profiles. */
function useEditorChoices(workspaceId: WorkspaceId, onError: (message: string) => void) {
  const [items, setItems] = useState<WorkspaceWorkItemListResponse['items']>([]);
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  const [defaults, setDefaults] = useState<CycleProfiles>();
  useEffect(() => {
    let alive = true;
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
          cycleProfilesFromDefaults(profiles.profiles, {
            backend: status.backends.find((b) => b.available)?.kind ?? 'claude-code',
            permissionMode: 'auto',
          }),
        );
      })
      .catch((e) => {
        if (alive) onError(e instanceof Error ? e.message : 'Could not load work items.');
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, onError]);
  return { items, backends, defaults };
}

function draftOf(roadmap: Roadmap): Draft {
  return {
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
  };
}

/**
 * The roadmap editor: a new roadmap on the list, or a roadmap's queued entries on its board.
 * `onSaved` receives the saved roadmap; `onCancel` discards the draft.
 */
function RoadmapEditor({
  workspaceId,
  csrfToken,
  draft,
  setDraft,
  current,
  onSaved,
  onCancel,
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  /** The saved roadmap being edited; absent for a new one. */
  current: Roadmap | undefined;
  onSaved: (view: RoadmapView) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { items, backends, defaults } = useEditorChoices(workspaceId, setError);
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
  const duplicateScope = draft.entries.some(
    (e) =>
      e.workItemId === selected &&
      (!e.executionScope ||
        selectedScope === 'whole-item' ||
        executionScopeKey(e.executionScope) === selectedScope),
  );
  const lastStarted =
    current?.definition.entries.findLastIndex((e) =>
      current.attempts.some((a) => a.entryId === e.id),
    ) ?? -1;
  const parallel = draft.scheduling?.mode === 'parallel';
  const updateEntry = (index: number, changes: Partial<SaveRoadmapRequest['entries'][number]>) =>
    setDraft({
      ...draft,
      entries: draft.entries.map((entry, i) => (i === index ? { ...entry, ...changes } : entry)),
    });
  return (
    <Section
      title={draft.expectedVersion === 0 ? 'New roadmap' : 'Edit queued entries'}
      label="Roadmap editor"
    >
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const { id, ...input } = draft;
            onSaved(await saveRoadmap(workspaceId, id, input, csrfToken));
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
            </p>
            <p>
              In-flight limits: {draft.scheduling?.maxInFlight ?? 2} total ·{' '}
              {draft.scheduling?.maxPerRepository ?? 2} per repository.{' '}
              {current ? (
                <Link
                  route={{
                    name: 'settings',
                    workspaceId,
                    roadmapId: current.id,
                    focus: 'execution-capacity',
                  }}
                >
                  Manage capacity in Settings
                </Link>
              ) : (
                'Save this draft, then configure capacity in Workspace Settings before starting.'
              )}
            </p>
            {(
              [['maxIntegrationRefreshes', 'Maximum integration refreshes per item', 20]] as const
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
          <select value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
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
                  {distinct(scopeToAdd.blockers).map((b) => (
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
            duplicateScope ||
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
                    disabled={busy || (parallel ? index === 0 : frozen || index <= lastStarted + 1)}
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
                    disabled={busy || (!parallel && frozen) || index === draft.entries.length - 1}
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
                  <p className="hint">This entry has started. Its effective settings stay fixed.</p>
                )}
                {parallel && (
                  <label className="field">
                    Exclusion groups (comma separated)
                    <input
                      disabled={busy || frozen}
                      value={(entry.exclusionGroups ?? []).join(', ')}
                      onChange={(e) =>
                        updateEntry(index, {
                          exclusionGroups: e.target.value.split(',').map((group) => group.trim()),
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
                    profilesLocked={draft.expectedVersion > 0}
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
        <About label="About saving and starting">
          <p>
            Saving binds these exact plan versions and their configured integration branches.
            Starting delegates only the selected items. Dependencies outside this sequence remain
            visible blockers. Design pauses for open questions. Starting authorizes the selected
            integration policies; merging into main always remains yours.
          </p>
          <p>
            In parallel mode, items awaiting merge or attention retain their capacity and exclusion
            groups. Refresh limits are fixed for each item when it starts.
          </p>
        </About>
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
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
            Cancel editing
          </button>
        </div>
      </form>
    </Section>
  );
}

/**
 * `/roadmaps`: every roadmap of the workspace, active first and finished ones under History,
 * and the imported concurrency maps (R-E2). Each roadmap has its own board, setup and history.
 */
export function RoadmapsPage({
  workspaceId,
  csrfToken,
  canMutate,
  attention = [],
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
  canMutate: boolean;
  /** The workspace's open attention items; each roadmap counts its own (R-A5). */
  attention?: readonly AttentionItemView[];
}) {
  const navigation = useNavigation();
  const { roadmaps, loaded, error } = useRoadmaps(workspaceId);
  const [draft, setDraft] = useState<Draft>();
  const cancel = useCallback(() => setDraft(undefined), []);
  const active = roadmaps.filter((r) => !FINISHED.has(r.roadmap.status));
  const finished = roadmaps.filter((r) => FINISHED.has(r.roadmap.status));
  const row = ({ roadmap, progress }: RoadmapView) => {
    const completed = progress.filter((p) => p.status === 'completed').length;
    const needsYou = attention.filter((item) => item.refs.roadmapId === roadmap.id).length;
    return (
      <li key={roadmap.id} className="roadmap-row">
        <Link route={{ name: 'roadmap', workspaceId, roadmapId: roadmap.id, tab: 'board' }}>
          {roadmap.definition.name}
        </Link>
        <StatusStrip
          compact
          facts={[
            { label: 'Status', value: roadmapStatusLabel(roadmap, labels[roadmap.status]) },
            { label: 'Completed', value: `${completed}/${progress.length}`, mono: true },
            ...(needsYou > 0
              ? [{ label: 'Needs you', value: needsYou, accent: 'var(--color-attention)' }]
              : []),
          ]}
        />
        <p className="hint">{roadmap.reason}</p>
      </li>
    );
  };
  return (
    <div className="page">
      <PageHeader
        title="Roadmaps"
        subtitle="Delegated sequences of work items with their integration policy."
        actions={
          canMutate && !draft ? (
            <button
              type="button"
              className="primary-button"
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
          ) : undefined
        }
      />
      <p>
        <Link route={{ name: 'settings', workspaceId, focus: 'roadmap-agent-profiles' }}>
          Manage agent profiles for future runs
        </Link>
      </p>
      <About label="About roadmaps">
        <p>
          One delegated roadmap per workspace. Sequential mode follows list order; parallel mode
          starts eligible items in priority order, subject to dependencies, capacity, and exclusion
          groups. The daemon creates each item's branch and worktree when eligible, runs its
          automated cycle, and waits for you to merge. Closing the browser leaves scheduling active.
          Restarting the daemon requires explicit resume.
        </p>
      </About>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {draft && (
        <RoadmapEditor
          workspaceId={workspaceId}
          csrfToken={csrfToken}
          draft={draft}
          setDraft={setDraft}
          current={undefined}
          onSaved={(view) => {
            setDraft(undefined);
            // A new roadmap opens on its own board, where it is started.
            navigation?.navigate({
              name: 'roadmap',
              workspaceId,
              roadmapId: view.roadmap.id,
              tab: 'board',
            });
          }}
          onCancel={cancel}
        />
      )}
      {!loaded && !error && <p className="empty-state">Loading roadmaps…</p>}
      {loaded && roadmaps.length === 0 && !draft && (
        <p className="empty-state">
          No roadmaps yet. Create a sequence from your imported work items.
        </p>
      )}
      {active.length > 0 && (
        <Section title="Active roadmaps" count={active.length}>
          <ul className="roadmap-list">{active.map(row)}</ul>
        </Section>
      )}
      {finished.length > 0 && (
        <Section
          title="Finished roadmaps"
          count={finished.length}
          summary="Completed and stopped roadmaps."
          collapsible
          defaultOpen={false}
        >
          <ul className="roadmap-list">{finished.map(row)}</ul>
        </Section>
      )}
      <ConcurrencyImports
        key={workspaceId}
        workspaceId={workspaceId}
        csrfToken={csrfToken}
        canMutate={canMutate}
      />
    </div>
  );
}

const TAB_LABELS: Record<RoadmapTab, string> = {
  board: 'Board',
  setup: 'Setup',
  history: 'History',
};

/**
 * One roadmap (R-E2): its board and controls, its setup checklist, or its history. `all`
 * renders every part without the page chrome, for the inbox item that hosts the roadmap's own
 * controls (R-A5); each element then keeps the id a stored link or the inbox focuses.
 */
export function RoadmapPage({
  workspaceId,
  roadmapId,
  tab,
  csrfToken,
  canMutate,
  onOpenWorkItem,
  attention = [],
  onOpenAttention,
  focus,
}: {
  workspaceId: WorkspaceId;
  roadmapId: string;
  tab: RoadmapTab | 'all';
  csrfToken: string;
  canMutate: boolean;
  onOpenWorkItem: (id: WorkItemId) => void;
  /** The workspace's open attention items; the roadmap lists its own (R-A5). */
  attention?: readonly AttentionItemView[];
  onOpenAttention?: (itemId: string) => void;
  /** Inside an inbox item: an element to bring into view once the roadmap has loaded. */
  focus?: string;
}) {
  const navigation = useNavigation();
  const { roadmaps, loaded, error, setError, apply } = useRoadmaps(workspaceId);
  const [draft, setDraft] = useState<Draft>();
  const cancel = useCallback(() => setDraft(undefined), []);
  const [busy, setBusy] = useState(false);
  // Setup's panels share unsaved-draft state: each gates the other's actions (UI-17).
  const [dirtySettings, setDirtySettings] = useState(false);
  const [dirtyDependencies, setDirtyDependencies] = useState(false);
  const [runtimeView, setRuntimeView] = useState<RuntimeEvidenceView>();
  const settingsChanged = useCallback((_: string, dirty: boolean) => setDirtySettings(dirty), []);
  const dependenciesChanged = useCallback(
    (_: string, dirty: boolean) => setDirtyDependencies(dirty),
    [],
  );
  const runtimeChanged = useCallback(
    (_: string, view: RuntimeEvidenceView) => setRuntimeView(view),
    [],
  );
  const [history, setHistory] = useState<readonly RoadmapDefinition[]>();
  const embedded = tab === 'all';
  const shows = (part: RoadmapTab) => embedded || tab === part;
  const view = roadmaps.find((r) => r.roadmap.id === roadmapId);
  // The history page loads its revisions, again only when the roadmap gains a revision.
  const historyOf = tab === 'history' ? view?.roadmap : undefined;
  const historyKey = historyOf && `${historyOf.id}:${historyOf.definition.revision}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the roadmap and its revision, not on every refresh.
  useEffect(() => {
    if (!historyOf) return;
    let alive = true;
    void loadRoadmapHistory(historyOf)
      .then((result) => {
        if (alive) setHistory(result.definitions);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load history.');
      });
    return () => {
      alive = false;
    };
  }, [historyKey]);
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focus === undefined || focused.current === focus || !loaded) return;
    focused.current = focus;
    revealElement(focus);
  }, [focus, loaded]);
  const command = async (
    roadmap: Roadmap,
    action: 'start' | 'pause' | 'resume' | 'stop' | 'reverify',
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
  const alert = error && (
    <p role="alert" className="error-state">
      {error}
    </p>
  );
  if (!view) {
    const missing = loaded && (
      <p className="empty-state">
        This roadmap does not exist in this workspace.{' '}
        <Link route={{ name: 'roadmaps', workspaceId }}>All roadmaps</Link>
      </p>
    );
    return embedded ? (
      <div className="embedded-roadmap">
        {alert}
        {!loaded && <p className="empty-state">Loading roadmap…</p>}
        {missing}
      </div>
    ) : (
      <div className="page">
        <PageHeader
          crumbs={<Link route={{ name: 'roadmaps', workspaceId }}>Roadmaps</Link>}
          title="Roadmap"
        />
        {alert}
        {!loaded && !error && <p className="empty-state">Loading roadmap…</p>}
        {missing}
      </div>
    );
  }
  const { roadmap, progress, hostCapacity } = view;
  const crossProject = roadmap.definition.crossProject;
  const completed = progress.filter((p) => p.status === 'completed').length;
  const items = attention.filter((item) => item.refs.roadmapId === roadmap.id);
  // The roadmap needs the operator exactly when an open attention item says so (R-A5).
  const needsYou = items.length > 0;
  const setupDirty = dirtySettings || dirtyDependencies;
  const tabRoute = (part: RoadmapTab, element?: string): Route => ({
    name: 'roadmap',
    workspaceId,
    roadmapId: roadmap.id,
    tab: part,
    ...(element === undefined ? {} : { focus: element }),
  });
  // An element on another of the roadmap's pages is reached by navigating there; on this one
  // (or inside the inbox, which shows every part) it is revealed in place.
  const reveal = (part: RoadmapTab, element: string) => (label: string) =>
    shows(part) ? (
      <button type="button" className="secondary-button" onClick={() => revealElement(element)}>
        {label}
      </button>
    ) : (
      <Link className="secondary-button" route={tabRoute(part, element)}>
        {label}
      </Link>
    );
  const runtimePanelId = `runtime-evidence-roadmap-${roadmap.id}`;
  // A single-project roadmap whose slices all come from one map revision.
  const scopes = [
    ...new Map(
      roadmap.definition.entries.flatMap((e) =>
        e.executionScope
          ? [
              [
                `${e.executionScope.definitionId}:${e.executionScope.bindingRevision}`,
                e.executionScope,
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  const mapScope = !crossProject && scopes.length === 1 ? scopes[0] : undefined;

  const board = (
    <>
      <p role="status">
        <strong>Scheduler: </strong>
        <span>{roadmap.reason}</span>
      </p>
      {needsYou && (
        <section aria-label="Needs you on this roadmap" className="roadmap-next-actions">
          <ul className="attention-list compact">
            {items.map((item) => (
              <li key={item.id} className="attention-row">
                <Link
                  className="text-button"
                  route={{ name: 'inbox', workspaceId, itemId: item.id }}
                  onClick={(event) => {
                    if (!onOpenAttention) return;
                    event.preventDefault();
                    onOpenAttention(item.id);
                  }}
                >
                  {ATTENTION_CODE_LABELS[item.code]}
                </Link>
                <span className="attention-reason">{item.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <StatusStrip
        label="Roadmap status"
        facts={[
          {
            label: 'Status',
            value: roadmapStatusLabel(roadmap, labels[roadmap.status]),
            accent: needsYou
              ? 'var(--color-attention)'
              : roadmap.status === 'running'
                ? 'var(--color-active)'
                : undefined,
          },
          {
            label: 'Mode',
            value:
              roadmap.definition.scheduling?.mode === 'parallel'
                ? `Parallel · ${roadmap.definition.scheduling.maxInFlight} in flight · ${roadmap.definition.scheduling.maxPerRepository} per repository`
                : 'Sequential',
          },
          {
            label: 'In flight',
            value: roadmap.attempts.filter((a) => a.status !== 'completed').length,
            mono: true,
          },
          {
            label: 'Cycles running',
            value: progress.filter((p) => p.status === 'running').length,
            mono: true,
          },
        ]}
      />
      {hostCapacity && (
        <>
          <StatusStrip
            label="Shared workstation capacity"
            facts={[
              {
                label: 'Development/work-item review slots',
                value: `${hostCapacity.development.inUse}/${hostCapacity.development.limit}`,
                mono: true,
              },
              {
                label: 'Independent verification slots',
                value: `${hostCapacity.verification.inUse}/${hostCapacity.verification.limit}`,
                mono: true,
              },
            ]}
          />
          <p className="subtle">
            These workstation slots are shared across projects. Roadmap limits include items waiting
            for review or merge; they do not increase workstation capacity.
          </p>
          <p>
            <Link
              route={{
                name: 'settings',
                workspaceId,
                roadmapId: roadmap.id,
                focus: 'execution-capacity',
              }}
            >
              Manage capacity
            </Link>{' '}
            ·{' '}
            <Link
              route={{
                name: 'settings',
                workspaceId,
                roadmapId: roadmap.id,
                focus: 'roadmap-agent-profiles',
              }}
            >
              Manage agent profiles
            </Link>
          </p>
          {roadmap.definition.scheduling?.mode === 'parallel' &&
            roadmap.definition.scheduling.maxInFlight > hostCapacity.development.limit && (
              <p role="status">
                This roadmap permits {roadmap.definition.scheduling.maxInFlight} items in flight,
                but the workstation permits only {hostCapacity.development.limit} concurrent scoped
                development runs across all projects.
              </p>
            )}
        </>
      )}
      {setupDirty && (
        <p role="status">
          Save the unsaved {dirtySettings ? 'queued roadmap settings' : 'dependency settings'} below
          before starting or resuming, then review plan acceptance for the updated configuration.
        </p>
      )}
      <ActionBar label="Roadmap controls">
        {canMutate && (
          <>
            {roadmap.status === 'draft' && (
              <button
                type="button"
                className="primary-button"
                disabled={busy || !!draft || setupDirty}
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
                disabled={busy || !!draft || setupDirty}
                onClick={() => void command(roadmap, 'resume')}
              >
                Resume roadmap
              </button>
            )}
            {!crossProject &&
              // The editor lives on the roadmap's own page, not inside an inbox item.
              !embedded &&
              ['draft', 'paused', 'needs-attention'].includes(roadmap.status) && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !!draft}
                  onClick={() => setDraft(draftOf(roadmap))}
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
      </ActionBar>
      {draft && (
        <RoadmapEditor
          workspaceId={workspaceId}
          csrfToken={csrfToken}
          draft={draft}
          setDraft={setDraft}
          current={roadmap}
          onSaved={(saved) => {
            apply(saved);
            setDraft(undefined);
          }}
          onCancel={cancel}
        />
      )}
      {!embedded && !['draft', 'completed'].includes(roadmap.status) && (
        <RoadmapStatusList
          roadmap={roadmap}
          onOpenWorkItem={onOpenWorkItem}
          {...(onOpenAttention ? { onOpenAttention } : {})}
        />
      )}
      <details open={!crossProject}>
        <summary>
          Execution attempts and individual controls ({roadmap.definition.entries.length})
        </summary>
        <ol className="roadmap-entries">
          {roadmap.definition.entries.map((entry) => {
            const state = progress.find((p) => p.entryId === entry.id);
            const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
            return (
              <li key={entry.id} id={`roadmap-entry-${roadmap.id}-${entry.id}`}>
                <Link
                  route={{ name: 'work-item', workspaceId, workItemId: entry.workItemId }}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenWorkItem(entry.workItemId);
                  }}
                >
                  {[entry.sourceId, entry.executionScope?.kind, entry.title]
                    .filter((part) => part !== undefined && part !== '')
                    .join(' · ')}
                </Link>
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
                {entry.executionScope &&
                  state?.blockers?.some((b) =>
                    ['environment-approval', 'resource-unsupported'].includes(phaseBlockerCode(b)),
                  ) &&
                  reveal('setup', `${runtimePanelId}-native`)('Set up verification environment')}
                {entry.executionScope &&
                  state?.blockers?.some((b) => b.kind === 'review') &&
                  reveal(
                    'setup',
                    `map-reviewers-roadmap-${roadmap.id}`,
                  )('Assign independent reviewer responsibilities')}
                {entry.executionScope && entry.executionScope.kind !== 'slice' ? (
                  <p className="hint">
                    Independent review records scope evidence; it does not merge a branch.
                  </p>
                ) : (
                  <StatusStrip
                    compact
                    facts={[
                      {
                        label: 'Integration merge',
                        value:
                          (
                            state?.effectiveAutomation ??
                            entry.automation ??
                            roadmap.definition.automation
                          )?.integrationMerge === 'automatic'
                            ? 'Automatic when reviewed and ready'
                            : 'Your approval required',
                      },
                      {
                        label: 'Conflicts',
                        value:
                          (
                            state?.effectiveAutomation ??
                            entry.automation ??
                            roadmap.definition.automation
                          )?.integrationConflicts === 'automatic'
                            ? 'Automatic delegation'
                            : 'Ask you',
                      },
                      ...(entry.exclusionGroups?.length
                        ? [{ label: 'Exclusion groups', value: entry.exclusionGroups.join(', ') }]
                        : []),
                    ]}
                  />
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
                <ReverifyItem
                  reverifiable={!!state?.reverifiable}
                  canMutate={canMutate}
                  busy={busy}
                  onReverify={() => void command(roadmap, 'reverify', entry.id)}
                />
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
                    Zero blocking, major, or minor findings; at most {entry.policy.maxNits} nits. Up
                    to {entry.policy.maxRemediationRounds} remediation rounds,{' '}
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
    </>
  );

  // The setup checklist, in the order the work is done (R-E2). Each step opens its section.
  const steps: readonly { id: string; label: string }[] = crossProject
    ? [
        { id: `roadmap-setup-${roadmap.id}-bindings`, label: 'Plan and repository bindings' },
        { id: `${runtimePanelId}-setup`, label: 'Dependency environment' },
        { id: `${runtimePanelId}-native`, label: 'Verification environments' },
        {
          id: `map-reviewers-roadmap-${roadmap.id}`,
          label: 'Reviewer responsibilities and delegation',
        },
        { id: `map-settings-roadmap-${roadmap.id}`, label: 'Automation and agents' },
        { id: `${runtimePanelId}-plan-acceptance`, label: 'Plan acceptance' },
        { id: `${runtimePanelId}-decisions`, label: 'Shared architecture decisions' },
      ]
    : [];
  const setup = crossProject ? (
    <>
      {!embedded && (
        <nav aria-label="Setup checklist" className="setup-checklist">
          <ol>
            {steps.map((step) => (
              <li key={step.id}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => revealElement(step.id)}
                >
                  {step.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <p id={`roadmap-setup-${roadmap.id}-bindings`}>
        Map revision {crossProject.definitionId.slice(0, 8)} · binding revision{' '}
        {crossProject.bindingRevision}.{' '}
        <Link route={{ name: 'roadmap-map', workspaceId, definitionId: crossProject.definitionId }}>
          Review the imported map and its bindings
        </Link>
      </p>
      <ScopeRecoveryPanel
        roadmap={roadmap}
        csrfToken={csrfToken}
        canMutate={canMutate}
        onChange={apply}
        onOpenWorkItem={onOpenWorkItem}
      />
      <CrossProjectPanel
        workspaceId={workspaceId}
        definitionId={crossProject.definitionId}
        bindingRevision={crossProject.bindingRevision}
        targets={[
          {
            id: crossProject.targetId,
            scope:
              crossProject.selection === 'target-only'
                ? 'Only the selected target prerequisite scope is delegated.'
                : 'Full retained roadmap with the selected target prioritized.',
          },
        ]}
        roadmap={roadmap}
        runtimeView={runtimeView}
        dependencySettingsDirty={dirtyDependencies}
        onDraftChange={settingsChanged}
        csrfToken={csrfToken}
        canMutate={canMutate}
        onOpenAmendments={
          shows('history')
            ? undefined
            : () => navigation?.navigate(tabRoute('history', `map-amendments-${roadmap.id}`))
        }
      />
      <RuntimeEvidencePanel
        panelId={runtimePanelId}
        roadmapId={roadmap.id}
        roadmapRevision={roadmap.definition.revision}
        roadmapSettingsDirty={dirtySettings}
        onViewChange={runtimeChanged}
        onDraftChange={dependenciesChanged}
        workspaceId={workspaceId}
        definitionId={crossProject.definitionId}
        bindingRevision={crossProject.bindingRevision}
        csrfToken={csrfToken}
        canMutate={canMutate}
      />
    </>
  ) : (
    <>
      <p className="empty-state">
        This roadmap's entries, agents and policies are set in its editor on the board. Capacity and
        agent profiles are workspace settings.
      </p>
      {/* Slices of one imported map share its dependency environment and decisions (LIVE-18). */}
      {mapScope && (
        <RuntimeEvidencePanel
          panelId={runtimePanelId}
          roadmapId={roadmap.id}
          roadmapRevision={roadmap.definition.revision}
          onViewChange={runtimeChanged}
          onDraftChange={dependenciesChanged}
          workspaceId={workspaceId}
          definitionId={mapScope.definitionId}
          bindingRevision={mapScope.bindingRevision}
          csrfToken={csrfToken}
          canMutate={canMutate}
        />
      )}
    </>
  );

  const historyPart = (
    <>
      {crossProject && (
        <MapAmendmentPanel
          key={`${roadmap.id}:${roadmap.definition.revision}`}
          workspaceId={workspaceId}
          roadmap={roadmap}
          csrfToken={csrfToken}
          canMutate={canMutate}
        />
      )}
      {!embedded && (
        <Section
          id={`roadmap-revisions-${roadmap.id}`}
          title="Saved revisions"
          count={history?.length}
          summary={`Current revision ${roadmap.definition.revision}.`}
        >
          {history === undefined ? (
            <p className="empty-state">Loading revisions…</p>
          ) : (
            history.map((def) => (
              <details key={def.revision}>
                <summary>
                  Revision {def.revision} · {def.name} · {new Date(def.createdAt).toLocaleString()}
                </summary>
                <pre className="roadmap-instructions">{JSON.stringify(def, null, 2)}</pre>
              </details>
            ))
          )}
        </Section>
      )}
    </>
  );

  const body = (
    <>
      {shows('board') && board}
      {shows('setup') && setup}
      {shows('history') && historyPart}
    </>
  );
  if (embedded)
    return (
      <div className="embedded-roadmap">
        {alert}
        <Section
          title={roadmap.definition.name}
          label={roadmap.definition.name}
          summary={`${completed}/${progress.length} completed · revision ${roadmap.definition.revision}`}
          {...(needsYou ? { tone: 'attention' as const } : {})}
        >
          {body}
        </Section>
      </div>
    );
  return (
    <section
      aria-label={roadmap.definition.name}
      className={`page roadmap-page${needsYou ? ' section-attention' : ''}`}
    >
      <PageHeader
        crumbs={<Link route={{ name: 'roadmaps', workspaceId }}>Roadmaps</Link>}
        title={roadmap.definition.name}
        subtitle={`${completed}/${progress.length} completed · revision ${roadmap.definition.revision}`}
      />
      <PageTabs
        label="Roadmap pages"
        tabs={(['board', 'setup', 'history'] as const).map((part) => ({
          route: tabRoute(part),
          label: TAB_LABELS[part],
          current: part === tab,
        }))}
      />
      {alert}
      {body}
    </section>
  );
}
