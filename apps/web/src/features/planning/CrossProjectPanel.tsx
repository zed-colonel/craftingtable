import { useCallback, useEffect, useState } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { Reasons } from '../../components/Reasons.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import type { CrossProjectView, ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  CYCLE_STEPS,
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_ROADMAP_AUTOMATION,
  type CrossProjectConfiguration,
  type CycleProfiles,
  type MapActivitySettings,
  type Roadmap,
  type WorkspaceId,
} from '@craftingtable/domain';
import {
  adoptCrossProject,
  previewCrossProject,
  saveCrossProject,
} from '../../lib/cross-project-api.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { buildPath } from '../../lib/route.js';
import { CycleSettingsFields } from '../execution/CycleSettingsFields.js';
import { RoadmapAutomationFields } from './RoadmapAutomationFields.js';
import { revealElement } from '../../lib/reveal-element.js';
import { DependencyGraph, PhaseRequirements, phaseLabel } from './DependencyRequirements.js';
export function CrossProjectPanel({
  workspaceId,
  definitionId,
  bindingRevision,
  targets,
  csrfToken,
  canMutate,
  roadmap,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  bindingRevision: number;
  targets: readonly { id: string; scope: string }[];
  csrfToken: string;
  canMutate: boolean;
  roadmap?: Roadmap;
}) {
  const saved = roadmap?.definition.crossProject;
  const panelKey = roadmap ? `roadmap-${roadmap.id}` : definitionId;
  const runtimePanelId = `runtime-evidence-${panelKey}`;
  const nodeId = (key: string) => `map-node-${panelKey}-${encodeURIComponent(key)}`;
  const trace = (key: string) => {
    setFocus(key);
    revealElement(`map-focus-${panelKey}`);
  };
  const [editingRevision, setEditingRevision] = useState(roadmap?.definition.revision);
  const staleSettings = !!roadmap && editingRevision !== roadmap.definition.revision;
  const [target, setTarget] = useState(saved?.targetId ?? ''),
    [selection, setSelection] = useState<'target-only' | 'prioritize-full'>(
      saved?.selection ?? 'target-only',
    );
  const [view, setView] = useState<CrossProjectView>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<MapActivitySettings | undefined>(saved?.defaults),
    [overrides, setOverrides] = useState<CrossProjectConfiguration['overrides']>(
      saved?.overrides ?? [],
    );
  const [parentAcceptance, setParentAcceptance] = useState<'manual' | 'automatic'>(
    saved?.parentAcceptance ?? 'manual',
  );
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  const [name, setName] = useState(roadmap?.definition.name ?? 'Cross-project roadmap');
  const [limit, setLimit] = useState(roadmap?.definition.scheduling?.maxInFlight ?? 2),
    [repoLimit, setRepoLimit] = useState(roadmap?.definition.scheduling?.maxPerRepository ?? 2),
    [refreshLimit, setRefreshLimit] = useState(
      roadmap?.definition.scheduling?.maxIntegrationRefreshes ?? 3,
    );
  const [rationale, setRationale] = useState(''),
    [approved, setApproved] = useState(false),
    [focus, setFocus] = useState('');
  const [overrideLevel, setOverrideLevel] = useState<'project' | 'activity' | 'individual'>(
      'project',
    ),
    [overrideKey, setOverrideKey] = useState('');
  const editing =
    canMutate && (!roadmap || ['draft', 'paused', 'needs-attention'].includes(roadmap.status));
  const refresh = useCallback(async () => {
    if (!target || !bindingRevision) return;
    setView(
      await previewCrossProject(
        workspaceId,
        { definitionId, bindingRevision, targetId: target, selection },
        csrfToken,
      ),
    );
  }, [workspaceId, definitionId, bindingRevision, target, selection, csrfToken]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === definitionId)
        void refresh().catch((e) =>
          setError(e instanceof Error ? e.message : 'Could not refresh prerequisites.'),
        );
    };
    window.addEventListener('craftingtable:runtime-saved', changed);
    return () => window.removeEventListener('craftingtable:runtime-saved', changed);
  }, [definitionId, refresh]);
  useEffect(() => {
    let live = true;
    void Promise.all([loadExecutionStatus(), loadRunProfiles(workspaceId)])
      .then(([s, p]) => {
        if (!live) return;
        setBackends(s.backends);
        setSettings(
          (old) =>
            old ?? {
              profiles: Object.fromEntries(
                CYCLE_STEPS.map((step) => {
                  const profile = p.profiles.find(
                    (p) => p.role === (step === 'remediate' ? 'implement' : step),
                  )!;
                  return [
                    step,
                    {
                      backend: profile.backend,
                      permissionMode: profile.permissionMode,
                      ...(profile.model ? { model: profile.model } : {}),
                    },
                  ];
                }),
              ) as CycleProfiles,
              policy: DEFAULT_COMPLETION_POLICY,
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
  useEffect(() => {
    let alive = true;
    let loading = false;
    setView(undefined);
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        if (target && bindingRevision) {
          const v = await previewCrossProject(
            workspaceId,
            { definitionId, bindingRevision, targetId: target, selection },
            csrfToken,
          );
          if (alive) setView(v);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not inspect the roadmap.');
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workspaceId, definitionId, bindingRevision, target, selection, csrfToken]);
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
  const adopt = () =>
    command(async () => {
      await adoptCrossProject(
        workspaceId,
        definitionId,
        bindingRevision,
        view?.decisions.map((d) => d.id) ?? [],
        rationale,
        csrfToken,
      );
      setApproved(false);
      setRationale('');
      setNotice(
        'Scheduling decisions adopted. Record independently reviewed checkpoint evidence separately.',
      );
    });
  const save = () =>
    command(async () => {
      if (!settings) return;
      const result = await saveCrossProject(
        workspaceId,
        {
          roadmapId: roadmap?.id ?? crypto.randomUUID(),
          expectedVersion: roadmap?.version ?? 0,
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
      if (roadmap) setEditingRevision(result.roadmap.definition.revision);
      setNotice(
        `Saved ${result.roadmap.definition.name}. Use its separate Start roadmap control below when the configuration and adoption checks are clear.`,
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
  const scopeLink = (id: string) =>
    buildPath({
      name: 'work-item',
      workspaceId,
      workItemId: id as import('@craftingtable/domain').WorkItemId,
    });
  const nodeCard = (n: CrossProjectView['nodes'][number]) => (
    <article className="cross-map-node" key={n.key}>
      <p>
        <strong>
          {n.sourceId} · required state: {n.state}
        </strong>
        <br />
        {n.title}
      </p>
      <p>{phaseLabel(n)}</p>
      <p>
        {n.status}
        {n.priority && selection === 'prioritize-full' ? ' · Target priority' : ''}
      </p>
      <ActionBar label="Milestone actions">
        <button type="button" className="secondary-button" onClick={() => trace(n.key)}>
          Trace requirements
        </button>
        {n.workItemId && <a href={scopeLink(n.workItemId)}>Open work item / advance scope</a>}
        {n.action === 'evidence' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => revealElement(`${runtimePanelId}-evidence`)}
          >
            Submit or review checkpoint evidence
          </button>
        )}
        {n.action === 'adopt' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => revealElement(`map-adoption-${panelKey}`)}
          >
            Review map decisions
          </button>
        )}
      </ActionBar>
      {n.blockers.length > 0 && (
        <details>
          <summary>{n.blockers.length} waiting requirements</summary>
          <ul>
            {n.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
  const actions = view ? (
    <ActionBar label="Cross-project roadmap actions">
      {editing && (
        <button
          type="button"
          className="primary-button"
          disabled={busy || staleSettings || !settings || !name.trim()}
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
      {view && (
        <>
          <p className="hint">Priority changes scheduling order; it never waives a requirement.</p>
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
          {actions}
          <ActionBar label="Roadmap setup">
            <button
              type="button"
              className="secondary-button"
              onClick={() => revealElement(`map-adoption-${panelKey}`)}
            >
              Review scheduling decisions
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
              {view.setupRequirements?.length ? (
                <ul>
                  {view.setupRequirements.map((requirement) => (
                    <li key={`${requirement.kind}:${requirement.message}`}>
                      <p>{requirement.message}</p>
                      {requirement.kind === 'adoption' && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => revealElement(`map-adoption-${panelKey}`)}
                        >
                          Resolve map adoption
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
                            revealElement(
                              roadmap ? `map-amendments-${roadmap.id}` : 'cross-project-imports',
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
          <details id={`map-adoption-${panelKey}`}>
            <summary>
              Map decision adoption · {view.decisions.filter((d) => d.adopted).length}/
              {view.decisions.length} approved
            </summary>
            <p>
              Adoption approves the preserved scheduling proposals and their named early-slice
              exceptions for binding {bindingRevision}. It does not pass technical or architecture
              checkpoints, grant qualification access, start agents, or approve final promotion.
            </p>
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
                <>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={approved}
                      disabled={busy}
                      onChange={(e) => setApproved(e.target.checked)}
                    />
                    I approve all listed scheduling proposals for these exact bindings.
                  </label>
                  <label className="field">
                    Adoption rationale
                    <textarea
                      value={rationale}
                      onChange={(e) => setRationale(e.target.value)}
                      maxLength={8000}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || !approved || !rationale.trim()}
                    onClick={() => void adopt()}
                  >
                    Adopt map decisions
                  </button>
                </>
              )}
            {view.adoptions.map((a) => (
              <p key={a.id}>
                Binding {a.bindingRevision} · {new Date(a.createdAt).toLocaleString()} ·{' '}
                {a.rationale}
              </p>
            ))}
          </details>
          <details id={`map-settings-${panelKey}`}>
            <summary>
              {roadmap ? 'Queued settings and overrides' : 'Roadmap agent and automation settings'}
            </summary>
            {!editing && (
              <p>
                Pause the roadmap to edit queued settings. Started attempts retain their saved
                profiles and policy.
              </p>
            )}
            {settings && (
              <>
                <label className="field">
                  Roadmap name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!editing || busy}
                    maxLength={120}
                  />
                </label>
                <div className="cycle-settings-grid">
                  {[
                    { label: 'Development in-flight limit', value: limit, set: setLimit, max: 16 },
                    {
                      label: 'Per-repository development limit',
                      value: repoLimit,
                      set: setRepoLimit,
                      max: 16,
                    },
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
                <CycleSettingsFields
                  policy={settings.policy}
                  setPolicy={(policy) => setSettings({ ...settings, policy })}
                  choices={settings.profiles}
                  setChoices={(profiles) => setSettings({ ...settings, profiles })}
                  instructions={settings.instructions}
                  setInstructions={(instructions) => setSettings({ ...settings, instructions })}
                  backends={backends}
                  disabled={!editing || busy}
                />
                <label className="field">
                  Independent reviewer responsibilities
                  <select
                    multiple
                    aria-label="Independent reviewer responsibilities"
                    value={[...(settings.reviewerRoles ?? [])]}
                    disabled={!editing || busy}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        reviewerRoles: Array.from(e.currentTarget.selectedOptions, (o) => o.value),
                      })
                    }
                  >
                    {view.reviewerRoles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">
                  Explicitly designate the review agent to cover these responsibilities
                  independently of the implementer. Each review still needs scope evidence. This
                  assignment grants no native/Kata execution or external-effect authority.
                </p>
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
                    onChange={(e) => setParentAcceptance(e.target.value as typeof parentAcceptance)}
                  >
                    <option value="manual">Require my explicit acceptance</option>
                    <option value="automatic">
                      Automatically record acceptance when all gates pass
                    </option>
                  </select>
                </label>
                <p>
                  Verification uses the review agent. Review findings or questions pause for
                  recovery; review snapshots cannot implement changes. Final promotion remains your
                  separate exact-commit decision.
                </p>
                <details>
                  <summary>Project, activity and individual overrides ({overrides.length})</summary>
                  <p>
                    Settings resolve in order: defaults → project → activity → individual. Each
                    override replaces the selected level's complete settings. Started attempts
                    retain their original settings.
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
                    const update = (s: MapActivitySettings) =>
                      setOverrides(
                        overrides.map((old, j) => (i === j ? { ...old, settings: s } : old)),
                      );
                    return (
                      <details key={`${o.level}:${o.key}`}>
                        <summary>
                          {o.level}: {o.key}
                        </summary>
                        <CycleSettingsFields
                          policy={o.settings.policy}
                          setPolicy={(policy) => update({ ...o.settings, policy })}
                          choices={o.settings.profiles}
                          setChoices={(profiles) => update({ ...o.settings, profiles })}
                          instructions={o.settings.instructions}
                          setInstructions={(instructions) =>
                            update({ ...o.settings, instructions })
                          }
                          backends={backends}
                          disabled={!editing || busy}
                        />
                        <label className="field">
                          Override reviewer responsibilities
                          <select
                            multiple
                            value={[...(o.settings.reviewerRoles ?? [])]}
                            disabled={!editing || busy}
                            onChange={(e) =>
                              update({
                                ...o.settings,
                                reviewerRoles: Array.from(
                                  e.currentTarget.selectedOptions,
                                  (o) => o.value,
                                ),
                              })
                            }
                          >
                            {view.reviewerRoles.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                        </label>
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
              </>
            )}
          </details>
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
              Eligibility is a current snapshot, not a promise of simultaneous launch. Before Start
              requirements, configured concurrency, resource availability and earlier queued work
              still apply.
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
                <h5>{phaseLabel(selected)}</h5>
                <DependencyGraph
                  nodes={view.nodes}
                  selected={selected}
                  onTrace={trace}
                  onLocate={(key) => revealElement(nodeId(key))}
                />
                {selected.requirements.length === 0 && (
                  <p>
                    No graph prerequisites. Review its phase requirements and evidence obligations.
                  </p>
                )}
                {selected.requirements.map((k) => {
                  const n = view.nodes.find((n) => n.key === k);
                  return n ? nodeCard(n) : <p key={k}>{k}</p>;
                })}
                {selected.blockers.length > 0 && (
                  <ul>
                    {selected.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
