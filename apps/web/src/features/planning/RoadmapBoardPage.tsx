import { type EntryCommand, RoadmapEntryRow } from './RoadmapEntryRow.js';
import type {
  AttentionItemView,
  RoadmapPage as RoadmapPageRead,
  RuntimeEvidenceView,
} from '@craftingtable/contracts';
import type {
  Roadmap,
  RoadmapDefinition,
  RoadmapEntry,
  RoadmapView,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { PageHeader } from '../../components/PageHeader.js';
import { PageTabs } from '../../components/PageTabs.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import { revealElement } from '../../lib/reveal-element.js';
import { useStableCallback } from '../../lib/use-stable-callback.js';
import {
  roadmapSetupIds,
  SetupChecklist,
  type SetupStep,
  SetupStepPart,
  SetupStepProvider,
  stepForPath,
  useSetupStep,
} from './setup-steps.js';
import {
  controlRoadmap,
  loadRoadmapDefinition,
  loadRoadmapGraph,
  loadRoadmapHistory,
  loadRoadmapPage,
} from '../../lib/roadmap-api.js';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import { AmendmentDecision } from '../../decisions/amendment/AmendmentDecision.js';
import { runtimeScope } from '../../decisions/roadmap-runtime.js';
import { ATTENTION_CODE_LABELS } from '../../lib/attention-labels.js';
import { RoadmapStatusList } from './RoadmapStatusList.js';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';
import { ScopeRecoveryPanel } from './ScopeRecoveryPanel.js';
import { Link, useNavigation } from '../../lib/navigation.js';
import type { BoardView, Route, RoadmapTab } from '../../lib/route.js';
import type { RoadmapItemPart } from '../../decisions/registry.js';
import { ROADMAP_STATUS_LABELS as labels, roadmapStatusLabel } from './roadmap-labels.js';
import { type Draft, draftOf, RoadmapEditor } from './RoadmapEditor.js';
import type { BoardModel } from '../roadmap-board/board-model.js';
import { BoardList } from '../roadmap-board/BoardList.js';
import { NeighbourhoodGraph } from '../roadmap-board/NeighbourhoodGraph.js';
import { RoadmapBoard } from '../roadmap-board/RoadmapBoard.js';
import { BoardViewSwitch } from '../roadmap-board/BoardViewSwitch.js';
import { useWide } from '../roadmap-board/use-wide.js';

/** The first item per entry, by `entryId`. */
function firstByEntry<T extends { readonly entryId: string }>(items: readonly T[]) {
  const first = new Map<string, T>();
  for (const item of items) if (!first.has(item.entryId)) first.set(item.entryId, item);
  return first;
}

/**
 * One roadmap page's region (R-D5): the roadmap and its status list in one read, and its
 * definition by revision, which never changes and so is read once per revision. The view is put
 * back together here, so the page reads the roadmap as before.
 */
function useRoadmapPage(workspaceId: WorkspaceId, roadmapId: string) {
  const store = useQueryStore();
  const pageKey = queryKeys.roadmapPage(workspaceId, roadmapId);
  const page = useQuery(pageKey, () => loadRoadmapPage(workspaceId, roadmapId));
  const revision = page.data?.definitionRevision;
  const definition = useQuery(
    revision === undefined
      ? undefined
      : queryKeys.roadmapDefinition(workspaceId, roadmapId, String(revision)),
    () => loadRoadmapDefinition(workspaceId, roadmapId, revision as number),
  );
  // The board's graph, by the board's revision, read once per revision (R-E3b).
  const boardRevision = page.data?.board?.revision;
  const graph = useQuery(
    boardRevision === undefined
      ? undefined
      : queryKeys.roadmapGraph(workspaceId, roadmapId, String(boardRevision)),
    () => loadRoadmapGraph(workspaceId, roadmapId, boardRevision as number),
  );
  const model = useMemo<BoardModel | undefined>(() => {
    const board = page.data?.board;
    return board &&
      graph.data?.revision === board.revision &&
      definition.data?.revision === board.revision
      ? {
          graph: graph.data,
          board,
          status: page.data!.status,
          entryIds: definition.data.entries.map((entry) => entry.id),
        }
      : undefined;
  }, [page.data, graph.data, definition.data]);
  const composed = useMemo<RoadmapView | undefined>(
    () =>
      page.data && definition.data?.revision === page.data.definitionRevision
        ? {
            ...page.data.view,
            roadmap: { ...page.data.view.roadmap, definition: definition.data },
          }
        : undefined,
    [page.data, definition.data],
  );
  // While a new revision's definition loads, the roadmap as last put together stays shown, so
  // the page keeps its forms and drafts; a region is never shown with another revision's
  // definition (R-D5 review).
  const last = useRef<RoadmapView | undefined>(undefined);
  if (composed !== undefined) last.current = composed;
  const view = composed ?? (last.current?.roadmap.id === roadmapId ? last.current : undefined);
  const [commandError, setError] = useState<string>();
  const failure = page.error ?? definition.error;
  const error =
    commandError ??
    (failure === undefined
      ? undefined
      : failure instanceof Error
        ? failure.message
        : 'Could not load the roadmap.');
  /** A command's response: the roadmap it returned replaces the one shown, and the list's. */
  const apply = useCallback(
    (next: RoadmapView) => {
      const { definition: nextDefinition, ...roadmap } = next.roadmap;
      store.set(
        queryKeys.roadmapDefinition(workspaceId, next.roadmap.id, String(nextDefinition.revision)),
        nextDefinition,
      );
      const current = store.view<RoadmapPageRead>(pageKey).data;
      if (current)
        store.set(pageKey, {
          ...current,
          view: { ...next, roadmap },
          definitionRevision: nextDefinition.revision,
        });
      const listed = queryKeys.roadmaps(workspaceId);
      const list = store.view<{ roadmaps: RoadmapView[] }>(listed).data;
      if (list)
        store.set(listed, {
          ...list,
          roadmaps: list.roadmaps.map((r) => (r.roadmap.id === next.roadmap.id ? next : r)),
        });
      // Its status list follows from the roadmap's next read.
      store.invalidate([pageKey]);
    },
    [store, workspaceId, pageKey],
  );
  return {
    view,
    status: page.data?.status,
    statusError: page.error ?? graph.error,
    board: model,
    loaded: view !== undefined || page.status === 'error',
    error,
    setError,
    apply,
  };
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
  part,
  view: boardView,
  select,
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
  /**
   * Inside an inbox item: the one part of the roadmap the item is decided in (R-A6 increment
   * 2a), instead of the whole roadmap.
   */
  part?: RoadmapItemPart;
  /** The board's view, when the route names one; else the width's default (R-E3b). */
  view?: BoardView;
  /** The board's selected node (`?select=`). */
  select?: string;
}) {
  const navigation = useNavigation();
  const {
    view,
    status,
    statusError,
    board: boardModel,
    loaded,
    error,
    setError,
    apply,
  } = useRoadmapPage(workspaceId, roadmapId);
  const wide = useWide();
  // No graph on a phone (ADR-072): there the list stands in for it.
  const shown: BoardView =
    boardView === 'graph' && !wide ? 'list' : (boardView ?? (wide ? 'board' : 'list'));
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
  // Setup shows one checklist step at a time (R-E2): the one chosen, else the first an open
  // attention item names, else the bindings.
  const setupNeeds = new Set(
    tab === 'setup'
      ? attention.flatMap((item) =>
          item.refs.roadmapId === roadmapId ? (stepForPath(item.path, roadmapId) ?? []) : [],
        )
      : [],
  );
  const [shownStep, setSetupStep] = useSetupStep(
    tab === 'setup' ? roadmapSetupIds(roadmapId) : undefined,
    setupNeeds,
  );
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
  // The entry rows are memoized; their callbacks keep their identity (R-D4 increment 4c).
  const openWorkItem = useStableCallback(onOpenWorkItem);
  const entryCommand = useStableCallback((action: EntryCommand, entryId: string) => {
    if (view) void command(view.roadmap, action, entryId);
  });
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
  const runtimePanelId = `runtime-evidence-roadmap-${roadmap.id}`;
  // Selecting changes only the address: it replaces the history entry and reads nothing (R-E3b).
  const selectNode = (key: string | undefined) =>
    navigation?.navigate(
      {
        ...tabRoute('board'),
        ...(boardView ? { view: boardView } : {}),
        ...(key === undefined ? {} : { select: key }),
      },
      { replace: true },
    );
  const boardLinks = {
    workspaceId,
    roadmapId: roadmap.id,
    onOpenWorkItem,
    ...(onOpenAttention ? { onOpenAttention } : {}),
  };
  // A single-project roadmap whose slices all come from one map revision.
  const mapScope = crossProject ? undefined : runtimeScope(roadmap);

  const actionBar = (
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
  );
  /**
   * Each entry's progress and attempt, looked up once per read rather than once per row: the
   * first per entry, as `find` gave (recovery rounds append attempts under their owner's entry).
   */
  const progressOf = firstByEntry(progress);
  const attemptOf = firstByEntry(roadmap.attempts);
  const entryRow = (entry: RoadmapEntry) => (
    <RoadmapEntryRow
      key={entry.id}
      entry={entry}
      state={progressOf.get(entry.id)}
      attempt={attemptOf.get(entry.id)}
      workspaceId={workspaceId}
      roadmapId={roadmap.id}
      roadmapStatus={roadmap.status}
      automation={roadmap.definition.automation}
      parallel={roadmap.definition.scheduling?.mode === 'parallel'}
      canMutate={canMutate}
      busy={busy}
      setupInline={shows('setup') && !part}
      runtimePanelId={runtimePanelId}
      onOpenWorkItem={openWorkItem}
      onCommand={entryCommand}
    />
  );
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
      {actionBar}
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
        <>
          {boardModel && (
            <BoardViewSwitch
              shown={shown}
              views={wide ? ['board', 'graph', 'list'] : ['board', 'list']}
              route={(next) => ({
                ...tabRoute('board'),
                view: next,
                ...(select ? { select } : {}),
              })}
            />
          )}
          {boardModel && shown === 'board' ? (
            <RoadmapBoard
              model={boardModel}
              selected={select}
              onSelect={selectNode}
              links={boardLinks}
            />
          ) : boardModel && shown === 'graph' ? (
            <NeighbourhoodGraph
              model={boardModel}
              selected={select}
              onSelect={selectNode}
              links={boardLinks}
            />
          ) : boardModel ? (
            <BoardList
              model={boardModel}
              selected={select}
              onSelect={selectNode}
              links={boardLinks}
            />
          ) : (
            <RoadmapStatusList
              roadmap={roadmap}
              page={{ status, error: statusError }}
              onOpenWorkItem={onOpenWorkItem}
              {...(onOpenAttention ? { onOpenAttention } : {})}
            />
          )}
        </>
      )}
      <details open={!crossProject}>
        <summary>
          Execution attempts and individual controls ({roadmap.definition.entries.length})
        </summary>
        <ol className="roadmap-entries">{roadmap.definition.entries.map(entryRow)}</ol>
      </details>
    </>
  );

  const notNeeded = new Set<SetupStep>(
    runtimeView
      ? [
          ...(runtimeView.nativeVerification?.requirements.length ? [] : ['verification' as const]),
          ...(runtimeView.planAcceptance ? [] : ['plan-acceptance' as const]),
        ]
      : [],
  );
  const setup = crossProject ? (
    <SetupStepProvider
      value={part?.kind === 'setup' ? part.step : embedded ? undefined : shownStep}
    >
      {!embedded && (
        <SetupChecklist
          ids={roadmapSetupIds(roadmap.id)}
          shown={shownStep}
          onSelect={setSetupStep}
          needed={setupNeeds}
          notNeeded={notNeeded}
        />
      )}
      <SetupStepPart step="bindings">
        <p id={`roadmap-setup-${roadmap.id}-bindings`}>
          Map revision {crossProject.definitionId.slice(0, 8)} · binding revision{' '}
          {crossProject.bindingRevision}.{' '}
          <Link
            route={{ name: 'roadmap-map', workspaceId, definitionId: crossProject.definitionId }}
          >
            Review the imported map and its bindings
          </Link>
        </p>
      </SetupStepPart>
      <SetupStepPart step="reviewers">
        <ScopeRecoveryPanel
          roadmap={roadmap}
          csrfToken={csrfToken}
          canMutate={canMutate}
          onChange={apply}
          onOpenWorkItem={onOpenWorkItem}
        />
      </SetupStepPart>
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
    </SetupStepProvider>
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
        <AmendmentDecision
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
  // Inside an inbox item, only the part the item is decided in (R-A6 increment 2a). A cycle's
  // item shows its entry's controls only while the entry is held or the roadmap stopped.
  const held = part?.kind === 'controls' && part.entryId;
  if (
    part?.kind === 'controls' &&
    part.heldOnly &&
    !(held && roadmap.entryHolds?.[held]?.status === 'needs-attention') &&
    !['paused', 'needs-attention'].includes(roadmap.status)
  )
    return null;
  const partBody =
    part?.kind === 'setup' ? (
      setup
    ) : part ? (
      <>
        <p role="status">
          <strong>Scheduler: </strong>
          <span>{roadmap.reason}</span>
        </p>
        {actionBar}
        {held && (
          <ol className="roadmap-entries">
            {roadmap.definition.entries.filter((e) => e.id === held).map(entryRow)}
          </ol>
        )}
      </>
    ) : undefined;
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
          {partBody ?? body}
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
