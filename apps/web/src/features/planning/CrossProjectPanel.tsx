import { StandingPreparation } from '../../decisions/preparation/PrepareDecisionBrief.js';
import { RoadmapDelegation } from '../../decisions/delegation/RoadmapDelegation.js';
import type {
  CrossProjectView,
  ExecutionStatusResponse,
  RoadmapAgentSettings,
  RunProfilesResponse,
  RuntimeEvidenceView,
  SaveCrossProjectRequest,
} from '@craftingtable/contracts';
import {
  type AgentSelections,
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_ROADMAP_AUTOMATION,
  type MapActivitySettings,
  type Roadmap,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { SetupStepPart } from './setup-steps.js';
import { ActionBar } from '../../components/ActionBar.js';
import { Reasons } from '../../components/Reasons.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { MapAdoption } from '../../decisions/adoption/MapAdoption.js';
import { previewCrossProject, saveCrossProject } from '../../lib/cross-project-api.js';
import { cycleDefaultMinutes } from '../../lib/cycle-defaults-api.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import { revealElement } from '../../lib/reveal-element.js';
import { CycleSettingsFields } from '../execution/CycleSettingsFields.js';
import { defaultStepPermissions, stepPermissionsOf } from '../execution/step-permissions.js';
import { DependencyGraph, PhaseRequirements, phaseLabel } from './DependencyRequirements.js';
import { ReviewerResponsibilities } from './ReviewerResponsibilities.js';
import { RoadmapAgentsFields } from './RoadmapAgentsFields.js';
import { RoadmapAutomationFields } from './RoadmapAutomationFields.js';
import { applyRoadmapAgents, loadRoadmapAgents } from '../../lib/roadmap-api.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import { useStableCallback } from '../../lib/use-stable-callback.js';
import { MapNodeCard } from './MapNodeCard.js';
/** A settings level as the form edits and saves it: permissions, not profiles (R-E5b). */
type LevelSettings = SaveCrossProjectRequest['configuration']['defaults'];
type LevelOverrides = SaveCrossProjectRequest['configuration']['overrides'];
/** A settings level's key: the defaults, or an override's level and key. */
const levelKey = (level: RoadmapAgentSettings['entries'][number]['settingsLevel']) =>
  level === undefined || level === 'defaults' ? 'defaults' : `${level.level}:${level.key}`;
const levelOf = ({ profiles, reviewerRoles, ...settings }: MapActivitySettings): LevelSettings => ({
  ...settings,
  ...(reviewerRoles ? { reviewerRoles: [...reviewerRoles] } : {}),
  permissions: stepPermissionsOf(profiles),
});

export function CrossProjectPanel({
  workspaceId,
  definitionId,
  bindingRevision,
  targets,
  csrfToken,
  canMutate,
  roadmap,
  runtimeView,
  dependencySettingsDirty = false,
  onDraftChange,
  onCreated,
  onOpenAmendments,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  bindingRevision: number;
  targets: readonly { id: string; scope: string }[];
  csrfToken: string;
  canMutate: boolean;
  roadmap?: Roadmap;
  runtimeView?: RuntimeEvidenceView;
  dependencySettingsDirty?: boolean;
  onDraftChange?: (roadmapId: string, dirty: boolean) => void;
  /** A new roadmap was created from this map; its page takes over (R-E2). */
  onCreated?: (roadmapId: string) => void;
  /** Opens the roadmap's amendments when they are on another of its pages (R-E2). */
  onOpenAmendments?: () => void;
}) {
  const saved = roadmap?.definition.crossProject;
  const panelKey = roadmap ? `roadmap-${roadmap.id}` : definitionId;
  const runtimePanelId = `runtime-evidence-${panelKey}`;
  const nodeId = (key: string) => `map-node-${panelKey}-${encodeURIComponent(key)}`;
  // The node cards are memoized; tracing keeps its identity (R-D4 increment 4c).
  const trace = useStableCallback((key: string) => {
    setFocus(key);
    revealElement(`map-focus-${panelKey}`);
  });
  const [editingRevision, setEditingRevision] = useState(roadmap?.definition.revision);
  const staleSettings = !!roadmap && (editingRevision ?? 0) < roadmap.definition.revision;
  const [target, setTarget] = useState(saved?.targetId ?? ''),
    [selection, setSelection] = useState<'target-only' | 'prioritize-full'>(
      saved?.selection ?? 'target-only',
    );
  const [commandError, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<LevelSettings | undefined>(
      saved && levelOf(saved.defaults),
    ),
    [overrides, setOverrides] = useState<LevelOverrides>(
      saved?.overrides.map((o) => ({ ...o, settings: levelOf(o.settings) })) ?? [],
    );
  const [parentAcceptance, setParentAcceptance] = useState<'manual' | 'automatic'>(
    saved?.parentAcceptance ?? 'manual',
  );
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  // A level's agents are its entries' (R-E5b): read from the roadmap's agents, edited per level
  // and applied as ADR-064 assignments to the level's entries once the settings are saved.
  const [workspaceAgents, setWorkspaceAgents] = useState<RunProfilesResponse>();
  /** A roadmap this form created whose agents were then refused (review MEDIUM-2). */
  const [created, setCreated] = useState<{ id: string; version: number; snapshot: string }>();
  const [roadmapAgents, setRoadmapAgents] = useState<RoadmapAgentSettings>();
  const [agentDrafts, setAgentDrafts] = useState<ReadonlyMap<string, AgentSelections>>(
    () => new Map(),
  );
  const [name, setName] = useState(roadmap?.definition.name ?? 'Cross-project roadmap');
  const limit = roadmap?.definition.scheduling?.maxInFlight ?? 2;
  const repoLimit = roadmap?.definition.scheduling?.maxPerRepository ?? 2;
  const [refreshLimit, setRefreshLimit] = useState(
    roadmap?.definition.scheduling?.maxIntegrationRefreshes ?? 3,
  );
  const [focus, setFocus] = useState('');
  const [overrideLevel, setOverrideLevel] = useState<'project' | 'activity' | 'individual'>(
      'project',
    ),
    [overrideKey, setOverrideKey] = useState('');
  const snapshot = JSON.stringify({
    name,
    target,
    selection,
    settings,
    overrides,
    parentAcceptance,
    limit,
    repoLimit,
    refreshLimit,
  });
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot);
  const settingsDirty = !!roadmap && snapshot !== savedSnapshot;
  const dirty = settingsDirty || (!!roadmap && agentDrafts.size > 0);
  const roadmapId = roadmap?.id;
  const roadmapVersion = roadmap?.version;
  useEffect(() => {
    let live = true;
    if (roadmapId !== undefined && roadmapVersion !== undefined)
      void loadRoadmapAgents(workspaceId, roadmapId)
        .then((read) => {
          if (live) setRoadmapAgents(read);
        })
        .catch((e) => {
          if (live) setError(e instanceof Error ? e.message : 'Could not load the agents.');
        });
    return () => {
      live = false;
    };
  }, [workspaceId, roadmapId, roadmapVersion]);
  /** A settings level's agents: its entries' as the daemon reports them, else the defaults'. */
  const levelAgents = (key: string) => {
    const entries = roadmapAgents?.entries.filter((e) => levelKey(e.settingsLevel) === key);
    const first = entries?.[0];
    return {
      entries: entries ?? [],
      agents: first ? first.agents : roadmap ? undefined : workspaceAgents?.agents,
      selections: first ? first.selections : roadmap ? undefined : workspaceAgents?.selections,
      differing: new Set(entries?.map((e) => JSON.stringify(e.selections))).size,
    };
  };
  const levelAgentsFields = (key: string, legend: string) => {
    // A new override starts from the defaults level's agents, as the daemon stores it (operator
    // 2026-10-11, review MEDIUM-1); a change made here applies to its entries once it is saved.
    const unsaved =
      !!roadmap &&
      key !== 'defaults' &&
      !saved?.overrides.some((o) => `${o.level}:${o.key}` === key);
    const level = levelAgents(unsaved ? 'defaults' : key);
    if (!unsaved && roadmap && roadmapAgents && level.entries.length === 0)
      return <p className="hint">No entry takes these settings, so no agents run under them.</p>;
    return (
      <>
        {unsaved && (
          <p className="hint">
            A new override starts from the default agents below; a change applies to its entries
            when saved.
          </p>
        )}
        <RoadmapAgentsFields
          legend={legend}
          agents={level.agents}
          selections={level.selections}
          differing={level.differing}
          value={agentDrafts.get(key)}
          onChange={(value) =>
            setAgentDrafts((drafts) => {
              const next = new Map(drafts);
              if (value) next.set(key, value);
              else next.delete(key);
              return next;
            })
          }
          backends={backends}
          disabled={!editing || busy}
          locked={roadmapAgents?.editBlocker}
        />
      </>
    );
  };
  useEffect(() => {
    if (roadmapId) onDraftChange?.(roadmapId, dirty || staleSettings);
  }, [roadmapId, dirty, staleSettings, onDraftChange]);
  const plan = runtimeView?.planAcceptance?.roadmaps.find((r) => r.roadmapId === roadmap?.id);
  const currentPlan = plan?.definitionRevision === editingRevision ? plan : undefined;
  const editing =
    canMutate && (!roadmap || ['draft', 'paused', 'needs-attention'].includes(roadmap.status));
  // The map's prerequisites for this target, read again on roadmap, cycle and evidence events
  // and when the environment's setup is saved (R-D4).
  const store = useQueryStore();
  const previewKey =
    target && bindingRevision
      ? queryKeys.crossProject(
          workspaceId,
          definitionId,
          String(bindingRevision),
          target,
          selection,
        )
      : undefined;
  const preview = useQuery(previewKey, () =>
    previewCrossProject(
      workspaceId,
      { definitionId, bindingRevision, targetId: target, selection },
      csrfToken,
    ),
  );
  const view: CrossProjectView | undefined = preview.data;
  const error =
    commandError ||
    (preview.error === undefined
      ? ''
      : preview.error instanceof Error
        ? preview.error.message
        : 'Could not inspect the roadmap.');
  /** After a command: the preview it changed is read before the controls are offered again. */
  const refresh = async () => {
    if (previewKey) await store.refetch(previewKey);
  };
  /** The environment shows what this panel adopts and saves: it is read again at once. */
  const savedPlanChanged = () => store.refreshNow([queryKeys.runtime(workspaceId, definitionId)]);
  useEffect(() => {
    let live = true;
    void Promise.all([
      loadExecutionStatus(),
      loadRunProfiles(workspaceId),
      cycleDefaultMinutes(workspaceId as WorkspaceId),
    ])
      .then(([s, p, maxRunMinutes]) => {
        if (!live) return;
        setBackends(s.backends);
        setWorkspaceAgents(p);
        setSettings(
          (old) =>
            old ?? {
              permissions: defaultStepPermissions(p.agents),
              // The workspace's default step time limit (R-C17 part 4, decision 9).
              policy: { ...DEFAULT_COMPLETION_POLICY, maxRunMinutes },
              instructions: '',
              automation: DEFAULT_ROADMAP_AUTOMATION,
            },
        );
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const command = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Command failed.');
    } finally {
      setBusy(false);
    }
  };
  /** After MapAdoption's command: the saved plan changed, and the preview is read again. */
  const adopted = () =>
    command(async () => {
      savedPlanChanged();
      setNotice(
        'Scheduling proposals adopted. Record independently reviewed checkpoint evidence separately.',
      );
    });
  const save = () =>
    command(async () => {
      if (!settings) return;
      // The roadmap this form saves: the page's, or one it created whose agents then failed, so a
      // retry applies the agents instead of creating a second roadmap (review MEDIUM-2).
      const saving = roadmap ?? created;
      // The settings hold each step's permissions; unchanged ones are not saved again (R-E5b).
      const unchanged = roadmap ? !settingsDirty : created?.snapshot === snapshot;
      const result = unchanged
        ? undefined
        : await saveCrossProject(
            workspaceId,
            {
              roadmapId: saving?.id ?? crypto.randomUUID(),
              expectedVersion: saving?.version ?? 0,
              name,
              configuration: {
                definitionId,
                bindingRevision,
                targetId: target,
                selection,
                parentAcceptance,
                defaults: settings,
                overrides: [...overrides],
              },
              scheduling: {
                mode: 'parallel',
                maxInFlight: limit,
                maxPerRepository: repoLimit,
                maxIntegrationRefreshes: refreshLimit,
              },
            },
            csrfToken,
          );
      if (result) {
        savedPlanChanged();
        if (roadmap) {
          setEditingRevision(result.roadmap.definition.revision);
          setSavedSnapshot(snapshot);
        }
      }
      const id = result?.roadmap.id ?? saving?.id;
      // The agents go to ADR-064 assignments: each changed level's, over the entries it covers.
      if (id && agentDrafts.size > 0) {
        let version = result?.roadmap.version ?? saving?.version;
        try {
          const current = await loadRoadmapAgents(workspaceId, id);
          version = current.version;
          const levels = new Map<object, string>();
          const groups = [...agentDrafts].flatMap(([key, selections]) => {
            const entryIds = current.entries
              .filter((e) => levelKey(e.settingsLevel) === key)
              .map((e) => e.id);
            const group = { entryIds, selections };
            levels.set(group, key);
            return entryIds.length ? [group] : [];
          });
          const applied = await applyRoadmapAgents(
            workspaceId,
            id,
            current.version,
            groups,
            csrfToken,
            // A level applied before a refusal is done: its change is not sent again (LOW-1).
            (group, latest) => {
              version = latest.version;
              setAgentDrafts((drafts) => {
                const next = new Map(drafts);
                next.delete(levels.get(group) ?? '');
                return next;
              });
            },
          );
          setRoadmapAgents(applied ?? current);
          setAgentDrafts(new Map());
        } catch (e) {
          if (!roadmap && id && version !== undefined) setCreated({ id, version, snapshot });
          throw new Error(
            `${
              result && !roadmap
                ? 'The roadmap was created, but its agents were not applied; change them and create again to apply them: '
                : result
                  ? 'The settings were saved, but the agents were not applied: '
                  : ''
            }${e instanceof Error ? e.message : 'Could not apply the agents.'}`,
          );
        }
      }
      if (!roadmap && id) onCreated?.(id);
      setNotice(
        result
          ? `Saved ${result.roadmap.definition.name}. Generate and review plan-acceptance evidence, then use the separate Start or Resume control when startup checks are clear.`
          : 'Agents applied to future runs. Plan acceptance is unaffected.',
      );
    });
  const included = view?.nodes.filter((n) => n.included) ?? [],
    excluded = view?.nodes.filter((n) => !n.included) ?? [];
  const selected = view?.nodes.find((n) => n.key === focus);
  const identities = [
    ...new Set(
      included
        .filter((n) => n.kind !== 'checkpoint' && n.state !== 'merged')
        .map(
          (n) =>
            `${n.kind === 'work_item' ? 'acceptance' : n.state === 'verified' ? 'verification' : 'development'}:${n.sourceId}`,
        ),
    ),
  ];
  const overrideOptions =
    overrideLevel === 'project'
      ? [...new Set(included.filter((n) => n.workItemId).map((n) => n.repository))]
      : overrideLevel === 'activity'
        ? ['development', 'verification', 'acceptance']
        : identities;
  const nodeCard = (n: CrossProjectView['nodes'][number]) => (
    <MapNodeCard
      key={n.key}
      node={n}
      prioritized={selection === 'prioritize-full'}
      workspaceId={workspaceId}
      panelKey={panelKey}
      runtimePanelId={runtimePanelId}
      onTrace={trace}
    />
  );
  const actions = view ? (
    <ActionBar label="Cross-project roadmap actions">
      {editing && (
        <button
          type="button"
          className="primary-button"
          disabled={busy || staleSettings || !settings || !name.trim() || (!!roadmap && !dirty)}
          onClick={() => void save()}
        >
          {roadmap ? 'Save queued roadmap settings' : 'Create cross-project roadmap'}
        </button>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => void command(refresh)}
      >
        Refresh scope and evidence
      </button>
    </ActionBar>
  ) : undefined;
  return (
    <Section
      title={roadmap ? 'Cross-project supervision' : 'Target scope and cross-project roadmap'}
      label={roadmap ? 'Cross-project supervision' : 'Create cross-project roadmap'}
      summary={
        !bindingRevision ? (
          'Save exact plan and repository bindings first.'
        ) : !target ? (
          'Choose a planning target to preview its scope.'
        ) : view ? (
          <>
            <strong>{included.length} selected milestones</strong> · {excluded.length} excluded
          </>
        ) : (
          'Loading scope preview…'
        )
      }
    >
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {staleSettings && (
        <p role="alert">
          Saved settings changed elsewhere. Reload this page before editing queued settings.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <SetupStepPart step="reviewers">
        {roadmap && view && (
          <RoadmapDelegation
            roadmap={roadmap}
            view={view}
            backends={backends}
            csrfToken={csrfToken}
            disabled={!canMutate || busy || dirty || staleSettings}
            onChanged={refresh}
          />
        )}
      </SetupStepPart>
      <SetupStepPart step="decisions">
        {roadmap && (
          <StandingPreparation
            roadmap={roadmap}
            csrfToken={csrfToken}
            disabled={!canMutate || busy || dirty || staleSettings}
            onSaved={refresh}
          />
        )}
      </SetupStepPart>
      <SetupStepPart step="bindings">
        <div className="cycle-settings-grid">
          <label className="field">
            Planning target
            <select
              value={target}
              disabled={!!roadmap || busy || !bindingRevision}
              onChange={(e) => {
                setTarget(e.target.value);
                setFocus('');
              }}
            >
              <option value="">Select a target explicitly</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Selection mode
            <select
              value={selection}
              disabled={!!roadmap || busy}
              onChange={(e) => setSelection(e.target.value as typeof selection)}
            >
              <option value="target-only">Only target prerequisites</option>
              <option value="prioritize-full">Full roadmap; prioritize this target</option>
            </select>
          </label>
        </div>
        <p className="subtle">{targets.find((t) => t.id === target)?.scope}</p>
      </SetupStepPart>
      {view && (
        <>
          <SetupStepPart step="bindings">
            <p className="hint">
              Priority changes scheduling order; it never waives a requirement.
            </p>
            <StatusStrip
              label="Roadmap progress"
              facts={[
                {
                  label: 'Target',
                  value: view.targetReached ? 'reached' : 'not reached',
                  accent: view.targetReached ? 'var(--color-ready)' : undefined,
                },
                {
                  label: 'Selected scope',
                  value: view.selectedScopeComplete ? 'complete' : 'incomplete',
                  accent: view.selectedScopeComplete ? 'var(--color-ready)' : undefined,
                },
                {
                  label: 'Original parents',
                  value: view.fullPlanAccepted ? 'all accepted' : 'not all accepted',
                },
                { label: 'Plans', value: view.finalized ? 'finalized' : 'not all finalized' },
                {
                  label: 'Publication',
                  value: view.published ? 'evidence accepted' : 'not established',
                },
              ]}
            />
          </SetupStepPart>
          {roadmap && (
            <section aria-label="Settings and plan review" className="roadmap-setup-status">
              <h4>Settings and plan review</h4>
              <p role="status">
                <strong>1. Queued settings: </strong>
                {staleSettings
                  ? 'Changed elsewhere — reload before editing.'
                  : dirty
                    ? 'Unsaved changes. Save these settings before reviewing the plan or resuming.'
                    : `Saved · revision ${editingRevision}. No settings save needed.`}
              </p>
              <p role="status">
                <strong>2. Plan acceptance: </strong>
                {dependencySettingsDirty
                  ? 'Unsaved dependency changes. Save the dependency environment before generating or accepting plan evidence.'
                  : dirty || staleSettings
                    ? currentPlan?.state === 'accepted'
                      ? 'Save first. Acceptance covers saved settings only; your save carries the accepted plan forward.'
                      : 'Save first. Acceptance covers saved settings only.'
                    : currentPlan?.state === 'accepted'
                      ? `Accepted for saved revision ${currentPlan.definitionRevision}. Your saves, dependency refreshes and setup, and clause approvals carry it forward; an amendment or a new map or binding needs a new review.`
                      : currentPlan?.state === 'awaiting-review'
                        ? 'Evidence is generated. Review and accept it; do not save the roadmap again.'
                        : currentPlan?.state === 'ready-to-generate'
                          ? 'Saved settings need a new acceptance review. Generate evidence, then review it; no additional settings save is needed.'
                          : currentPlan?.state === 'not-ready'
                            ? 'Resolve the saved setup requirements listed in plan acceptance.'
                            : 'Checking acceptance of the saved revision…'}
              </p>
              {runtimeView?.current && (
                <p>
                  <strong>Dependency environment: </strong>saved generation{' '}
                  {runtimeView.current.generation}.
                  {runtimeView.nativeVerification?.current
                    ? ' Native verification approved.'
                    : runtimeView.nativeVerification?.approval?.approved
                      ? ' Native approval needs renewal for the current environment.'
                      : runtimeView.nativeVerification
                        ? ' Native verification needs approval.'
                        : ''}
                  {runtimeView.nativeVerification && !runtimeView.nativeVerification.current && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => revealElement(`${runtimePanelId}-native`)}
                    >
                      Review native approval
                    </button>
                  )}
                </p>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={dirty || staleSettings || dependencySettingsDirty}
                onClick={() =>
                  revealElement(
                    currentPlan?.submissionId &&
                      ['accepted', 'awaiting-review'].includes(currentPlan.state)
                      ? `${runtimePanelId}-submission-${currentPlan.submissionId}`
                      : `${runtimePanelId}-plan-acceptance`,
                  )
                }
              >
                {currentPlan?.state === 'accepted'
                  ? 'View accepted plan'
                  : currentPlan?.state === 'awaiting-review'
                    ? 'Review and accept saved plan'
                    : 'Open plan acceptance'}
              </button>
            </section>
          )}
          {actions}
          <ActionBar label="Roadmap setup">
            {roadmap && (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => revealElement(`future-delegation-${roadmap.id}`)}
                >
                  Change future delegation
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => revealElement(`decision-preparation-${roadmap.id}`)}
                >
                  Prepare architecture decision
                </button>
              </>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => revealElement(`map-reviewers-${panelKey}`)}
            >
              Assign independent reviewer responsibilities
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={() => revealElement(`map-adoption-${panelKey}`)}
            >
              Review scheduling proposals
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => revealElement(`${runtimePanelId}-setup`)}
            >
              Configure dependencies
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => revealElement(`map-readiness-${panelKey}`)}
            >
              Preview launch readiness
            </button>
            {!roadmap && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => revealElement(`${runtimePanelId}-plan-acceptance`)}
              >
                Review saved plan acceptance
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => revealElement(`map-settings-${panelKey}`)}
            >
              Review automation settings
            </button>
          </ActionBar>
          {view.blockers.length > 0 && (
            <div>
              <h4>Before Start</h4>
              <button
                type="button"
                className="secondary-button"
                onClick={() => revealElement(`${runtimePanelId}-native`)}
              >
                Review verification environments
              </button>
              {view.setupRequirements?.length ? (
                <ul>
                  {view.setupRequirements.map((requirement) => (
                    <li key={`${requirement.kind}:${requirement.message}`}>
                      <p>
                        {roadmap && requirement.kind === 'plan-acceptance'
                          ? 'The saved plan needs acceptance for the current configuration. Another settings save is needed only if you edit settings.'
                          : requirement.message}
                      </p>
                      {requirement.kind === 'adoption' && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => revealElement(`map-adoption-${panelKey}`)}
                        >
                          Resolve map adoption
                        </button>
                      )}
                      {requirement.kind === 'plan-acceptance' && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => revealElement(`${runtimePanelId}-plan-acceptance`)}
                        >
                          Resolve plan acceptance
                        </button>
                      )}
                      {requirement.kind === 'runtime' && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => revealElement(`${runtimePanelId}-setup`)}
                        >
                          Resolve dependency setup
                        </button>
                      )}
                      {requirement.kind === 'binding' && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            roadmap && onOpenAmendments
                              ? onOpenAmendments()
                              : revealElement(
                                  roadmap
                                    ? `map-amendments-${roadmap.id}`
                                    : `map-bindings-${definitionId}`,
                                )
                          }
                        >
                          {roadmap ? 'Review binding reconciliation' : 'Review exact plan bindings'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Reasons
                  reasons={view.blockers.map((b) => ({ kind: 'attention' as const, text: b }))}
                />
              )}
            </div>
          )}
          <SetupStepPart step="bindings">
            <details id={`map-adoption-${panelKey}`}>
              <summary>
                Scheduling proposals · {view.decisions.filter((d) => d.adopted).length}/
                {view.decisions.length} approved
              </summary>
              <p>
                Adoption approves these scheduling proposals for binding {bindingRevision}. It does
                not pass checkpoints, start agents or approve final promotion.
              </p>
              <About label="About proposal adoption">
                <p>
                  Adoption approves the preserved scheduling proposals and their named early-slice
                  exceptions for the exact binding. It does not pass technical or architecture
                  checkpoints, grant qualification access, start agents, or approve final promotion.
                </p>
              </About>
              {view.decisions.map((d) => (
                <details key={d.id}>
                  <summary>
                    {d.id}: {d.title} · {d.adopted ? 'adopted' : 'proposal'}
                  </summary>
                  <p>{d.proposal}</p>
                </details>
              ))}
              {canMutate &&
                (view.decisions.some((d) => !d.adopted) ||
                  !view.adoptions.some((a) => a.bindingRevision === bindingRevision)) && (
                  <MapAdoption
                    workspaceId={workspaceId}
                    definitionId={definitionId}
                    bindingRevision={bindingRevision}
                    decisionIds={view.decisions.map((d) => d.id)}
                    csrfToken={csrfToken}
                    disabled={busy}
                    onAdopted={adopted}
                  />
                )}
              {view.adoptions.map((a) => (
                <p key={a.id}>
                  Binding {a.bindingRevision} · {new Date(a.createdAt).toLocaleString()} ·{' '}
                  {a.rationale}
                </p>
              ))}
            </details>
          </SetupStepPart>
          <SetupStepPart step={['reviewers', 'automation']}>
            <details id={`map-settings-${panelKey}`}>
              <summary>
                {roadmap
                  ? 'Queued settings and overrides'
                  : 'Roadmap agent and automation settings'}
              </summary>
              {!editing && (
                <p>
                  Pause the roadmap to edit queued settings. Started attempts retain their saved
                  profiles and policy.
                </p>
              )}
              <About label="About roadmap settings">
                {roadmap && (
                  <p>
                    Changing agents below applies a roadmap assignment and preserves plan
                    acceptance. Permissions, responsibilities and policy remain plan settings.
                  </p>
                )}
                <p>
                  Reviewer responsibilities are delegated to the review agent, not approvals of its
                  results. Check each responsibility you authorize. Overrides can replace these
                  defaults; started attempts keep their saved assignments. Save changed settings
                  once, then generate and review the updated plan. No native/Kata authority is
                  granted here.
                </p>
                <p>
                  Verification uses the review agent. Independent review recovery can delegate
                  source findings through the owning slice; genuine questions still need you. Final
                  promotion remains your separate exact-commit decision.
                </p>
                <p>
                  Settings resolve in order: defaults → project → activity → individual. Each
                  override replaces the selected level's complete settings. Started attempts retain
                  their original settings.
                </p>
              </About>
              {settings && (
                <>
                  <SetupStepPart step="reviewers">
                    <div id={`map-reviewers-${panelKey}`}>
                      <ReviewerResponsibilities
                        label="Independent reviewer responsibilities"
                        roles={view.reviewerRoles}
                        selected={settings.reviewerRoles ?? []}
                        nodes={included}
                        disabled={!editing || busy}
                        onChange={(reviewerRoles) => setSettings({ ...settings, reviewerRoles })}
                      />
                      <p className="hint">
                        Check each responsibility you authorize; these are not approvals of review
                        results. Save changes once, then generate and review the updated plan.
                      </p>
                      {editing && roadmap && (
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busy || staleSettings || !dirty || !name.trim()}
                          onClick={() => void save()}
                        >
                          Save reviewer and queued settings
                        </button>
                      )}
                    </div>
                  </SetupStepPart>
                  <SetupStepPart step="automation">
                    <label className="field">
                      Roadmap name
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={!editing || busy}
                        maxLength={120}
                      />
                    </label>
                    <p>
                      In-flight limits: {limit} total · {repoLimit} per repository.{' '}
                      {roadmap ? (
                        <Link
                          route={{
                            name: 'settings',
                            section: 'capacity',
                            workspaceId: workspaceId as WorkspaceId,
                            roadmapId: roadmap.id,
                            focus: 'execution-capacity',
                          }}
                        >
                          Manage capacity in Settings
                        </Link>
                      ) : (
                        'Save this roadmap draft, then configure capacity in Workspace Settings before starting.'
                      )}
                    </p>
                    <div className="cycle-settings-grid">
                      {[
                        {
                          label: 'Integration refresh allowance',
                          value: refreshLimit,
                          set: setRefreshLimit,
                          max: 20,
                        },
                      ].map((f) => (
                        <label className="field" key={f.label}>
                          {f.label}
                          <input
                            type="number"
                            min={1}
                            max={f.max}
                            value={f.value}
                            onChange={(e) => f.set(Number(e.target.value))}
                            disabled={!editing || busy}
                          />
                        </label>
                      ))}
                    </div>
                    {levelAgentsFields('defaults', 'Default agents')}
                    <CycleSettingsFields
                      policy={settings.policy}
                      setPolicy={(policy) => setSettings({ ...settings, policy })}
                      permissions={settings.permissions}
                      setPermissions={(permissions) => setSettings({ ...settings, permissions })}
                      instructions={settings.instructions}
                      setInstructions={(instructions) => setSettings({ ...settings, instructions })}
                      backends={backends}
                      disabled={!editing || busy}
                    />
                    <RoadmapAutomationFields
                      value={settings.automation}
                      onChange={(automation) => setSettings({ ...settings, automation })}
                      backends={backends}
                      disabled={!editing || busy}
                    />
                    <label className="field">
                      Parent acceptance after independent review
                      <select
                        value={parentAcceptance}
                        disabled={!editing || busy}
                        onChange={(e) =>
                          setParentAcceptance(e.target.value as typeof parentAcceptance)
                        }
                      >
                        <option value="manual">Require my explicit acceptance</option>
                        <option value="automatic">
                          Automatically record acceptance when all gates pass
                        </option>
                      </select>
                    </label>
                    <p>
                      Verification uses the review agent. Final promotion remains your separate
                      exact-commit decision.
                    </p>
                    <details>
                      <summary>
                        Project, activity and individual overrides ({overrides.length})
                      </summary>
                      <p>
                        Each override replaces the selected level's complete settings. Started
                        attempts retain their original settings.
                      </p>
                      <label className="field">
                        Override level
                        <select
                          value={overrideLevel}
                          disabled={!editing || busy}
                          onChange={(e) => {
                            setOverrideLevel(e.target.value as typeof overrideLevel);
                            setOverrideKey('');
                          }}
                        >
                          <option value="project">Project</option>
                          <option value="activity">Activity</option>
                          <option value="individual">Individual scope</option>
                        </select>
                      </label>
                      <label className="field">
                        Override scope
                        <select
                          value={overrideKey}
                          disabled={!editing || busy}
                          onChange={(e) => setOverrideKey(e.target.value)}
                        >
                          <option value="">Select scope</option>
                          {overrideOptions.map((k) => (
                            <option value={k} key={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          !editing ||
                          busy ||
                          !overrideKey ||
                          overrides.some((o) => o.level === overrideLevel && o.key === overrideKey)
                        }
                        onClick={() =>
                          setOverrides([
                            ...overrides,
                            { level: overrideLevel, key: overrideKey, settings },
                          ])
                        }
                      >
                        Add settings override
                      </button>
                      {overrides.map((o, i) => {
                        const update = (s: LevelSettings) =>
                          setOverrides(
                            overrides.map((old, j) => (i === j ? { ...old, settings: s } : old)),
                          );
                        return (
                          <details key={`${o.level}:${o.key}`}>
                            <summary>
                              {o.level}: {o.key}
                            </summary>
                            {levelAgentsFields(`${o.level}:${o.key}`, 'Agents for this override')}
                            <CycleSettingsFields
                              policy={o.settings.policy}
                              setPolicy={(policy) => update({ ...o.settings, policy })}
                              permissions={o.settings.permissions}
                              setPermissions={(permissions) =>
                                update({ ...o.settings, permissions })
                              }
                              instructions={o.settings.instructions}
                              setInstructions={(instructions) =>
                                update({ ...o.settings, instructions })
                              }
                              backends={backends}
                              disabled={!editing || busy}
                            />
                            <ReviewerResponsibilities
                              label={`Override reviewer responsibilities: ${o.level} ${o.key}`}
                              roles={view.reviewerRoles}
                              selected={o.settings.reviewerRoles ?? []}
                              disabled={!editing || busy}
                              onChange={(reviewerRoles) => update({ ...o.settings, reviewerRoles })}
                            />
                            <RoadmapAutomationFields
                              value={o.settings.automation}
                              onChange={(automation) => update({ ...o.settings, automation })}
                              backends={backends}
                              disabled={!editing || busy}
                            />
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={!editing || busy}
                              onClick={() => setOverrides(overrides.filter((_, j) => i !== j))}
                            >
                              Remove override
                            </button>
                          </details>
                        );
                      })}
                    </details>
                  </SetupStepPart>
                </>
              )}
            </details>
          </SetupStepPart>
          <SetupStepPart step="bindings">
            <details open={!roadmap}>
              <summary>Selected work by project</summary>
              <p>
                Grouped by ownership, not execution order. Projects can progress together; start,
                merge, and verification requirements determine when each slice advances.
              </p>
              <div className="cross-map-lanes">
                {[...new Set(included.map((n) => n.repository))].sort().map((repo) => (
                  <section key={repo} className="cross-map-lane">
                    <h4>{repo.toUpperCase()}</h4>
                    {[
                      ...new Set(
                        included
                          .filter((n) => n.repository === repo && n.kind !== 'checkpoint')
                          .map((n) => n.parentId ?? n.sourceId),
                      ),
                    ].map((parent) => (
                      <details key={parent}>
                        <summary>
                          {parent} ·{' '}
                          {included.some((n) => n.kind === 'work_item' && n.sourceId === parent)
                            ? 'parent acceptance included'
                            : 'partial slices only; parent acceptance excluded'}
                        </summary>
                        <PhaseRequirements
                          nodes={view.nodes}
                          roots={included.filter(
                            (n) =>
                              n.parentId === parent ||
                              (n.kind === 'work_item' && n.sourceId === parent),
                          )}
                          onTrace={trace}
                        />
                        {included
                          .filter(
                            (n) =>
                              n.repository === repo &&
                              (n.parentId === parent ||
                                (n.kind === 'work_item' && n.sourceId === parent)),
                          )
                          .map((n) => (
                            <div key={n.key} id={nodeId(n.key)}>
                              {nodeCard(n)}
                            </div>
                          ))}
                      </details>
                    ))}
                    <details>
                      <summary>
                        Checkpoints (
                        {
                          included.filter((n) => n.repository === repo && n.kind === 'checkpoint')
                            .length
                        }
                        )
                      </summary>
                      {included
                        .filter((n) => n.repository === repo && n.kind === 'checkpoint')
                        .map((n) => (
                          <div key={n.key} id={nodeId(n.key)}>
                            {nodeCard(n)}
                          </div>
                        ))}
                    </details>
                  </section>
                ))}
              </div>
            </details>
            <details>
              <summary>Excluded milestones ({excluded.length}) · obligations retained</summary>
              <ul>
                {excluded.map((n) => (
                  <li key={n.key}>
                    {n.sourceId} · required state: {n.state}
                  </li>
                ))}
              </ul>
            </details>
            <details id={`map-readiness-${panelKey}`}>
              <summary>
                Launch readiness ·{' '}
                {
                  included.filter(
                    (n) =>
                      n.kind === 'slice' &&
                      n.state === 'started' &&
                      !n.satisfied &&
                      n.blockers.length === 0,
                  ).length
                }{' '}
                slices have clear phase gates
              </summary>
              <p>
                Eligibility is a snapshot, not a launch promise. Before Start requirements,
                concurrency, resources and earlier queued work still apply.
              </p>
              {included
                .filter((n) => n.kind === 'slice' && n.state === 'started' && !n.satisfied)
                .map((n) => (
                  <div key={n.key}>
                    <button type="button" className="dependency-link" onClick={() => trace(n.key)}>
                      {n.sourceId}
                    </button>
                    <p>
                      {n.blockers.length
                        ? `${n.blockers.length} waiting requirements`
                        : 'Start phase gates clear'}
                    </p>
                    {n.blockers.length > 0 && (
                      <details>
                        <summary>Why this slice waits</summary>
                        <ul>
                          {n.blockers.map((b) => (
                            <li key={b}>{view.nodes.find((v) => v.key === b)?.title ?? b}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
            </details>
            <div className="cross-map-focus" id={`map-focus-${panelKey}`}>
              <label className="field">
                Focused dependency view
                <select value={focus} onChange={(e) => setFocus(e.target.value)}>
                  <option value="">Choose a blocked milestone to trace</option>
                  {included.map((n) => (
                    <option value={n.key} key={n.key}>
                      {n.sourceId} · required state: {n.state}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <>
                  <h4>
                    {selected.sourceId} · required state: {selected.state}
                  </h4>
                  <p>{selected.status}</p>
                  {selected.decisionCoverage?.map((c) => (
                    <p key={c.submissionId}>
                      {c.checkpoint}: early clauses approved for this slice before {c.phase}; full
                      ADR remains a later obligation.{' '}
                      <button
                        type="button"
                        onClick={() =>
                          revealElement(`${runtimePanelId}-submission-${c.submissionId}`)
                        }
                      >
                        Review clause approval
                      </button>
                    </p>
                  ))}
                  <h5>{phaseLabel(selected)}</h5>
                  <DependencyGraph
                    nodes={view.nodes}
                    selected={selected}
                    onTrace={trace}
                    onLocate={(key) => revealElement(nodeId(key))}
                  />
                  {selected.requirements.length === 0 && (
                    <p>
                      No graph prerequisites. Review its phase requirements and evidence
                      obligations.
                    </p>
                  )}
                  {selected.requirements.map((k) => {
                    const n = view.nodes.find((n) => n.key === k);
                    return n ? nodeCard(n) : <p key={k}>{k}</p>;
                  })}
                  {selected.blockers.length > 0 && (
                    <ul>
                      {distinct(selected.blockers).map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </SetupStepPart>
        </>
      )}
    </Section>
  );
}
