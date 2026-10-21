import type {
  ExecutionScopeChoice,
  ExecutionStatusResponse,
  RoadmapAgentSettings,
  RunProfilesResponse,
  StepPermissions,
  WorkspaceWorkItemListResponse,
} from '@craftingtable/contracts';
import {
  type AgentSelections,
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_ROADMAP_SCHEDULING,
  executionScopeKey,
  type Roadmap,
  type RoadmapView,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import { loadWorkspaceWorkItems } from '../../lib/planning-api.js';
import { cycleDefaultMinutes } from '../../lib/cycle-defaults-api.js';
import {
  agentGroups,
  applyRoadmapAgents,
  loadRoadmapAgents,
  type RoadmapSave,
  saveRoadmap,
} from '../../lib/roadmap-api.js';
import { CycleSettingsFields } from '../execution/CycleSettingsFields.js';
import { defaultStepPermissions, stepPermissionsOf } from '../execution/step-permissions.js';
import { RoadmapAgentsFields } from './RoadmapAgentsFields.js';
import { RoadmapAutomationFields } from './RoadmapAutomationFields.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';

export type Draft = RoadmapSave & { id: string };

/**
 * What the roadmap editor offers: the workspace's work items, backends and the permissions a new
 * entry starts from (the workspace defaults'; a new entry's agents are the workspace defaults the
 * daemon stores, R-E5b).
 */
function useEditorChoices(workspaceId: WorkspaceId, onError: (message: string) => void) {
  const [items, setItems] = useState<WorkspaceWorkItemListResponse['items']>([]);
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  const [defaults, setDefaults] = useState<StepPermissions>();
  const [workspaceAgents, setWorkspaceAgents] = useState<RunProfilesResponse>();
  // The workspace's default step time limit, which a new entry starts with (R-C17 part 4).
  const [minutes, setMinutes] = useState(DEFAULT_COMPLETION_POLICY.maxRunMinutes);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      loadWorkspaceWorkItems(workspaceId, 'all'),
      loadExecutionStatus(),
      loadRunProfiles(workspaceId),
      cycleDefaultMinutes(workspaceId),
    ])
      .then(([listing, status, profiles, defaultMinutes]) => {
        if (!alive) return;
        setItems(listing.items);
        setBackends(status.backends);
        setDefaults(defaultStepPermissions(profiles.agents));
        setWorkspaceAgents(profiles);
        setMinutes(defaultMinutes);
      })
      .catch((e) => {
        if (alive) onError(e instanceof Error ? e.message : 'Could not load work items.');
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, onError]);
  return { items, backends, defaults, workspaceAgents, minutes };
}

/** A saved roadmap's agents as its setup edits them, read again with each version (R-E5b). */
function useRoadmapAgents(
  workspaceId: WorkspaceId,
  current: Roadmap | undefined,
  onError: (message: string) => void,
) {
  const [agents, setAgents] = useState<RoadmapAgentSettings>();
  const id = current?.id,
    version = current?.version;
  useEffect(() => {
    let alive = true;
    if (id !== undefined && version !== undefined)
      void loadRoadmapAgents(workspaceId, id)
        .then((read) => {
          if (alive) setAgents(read);
        })
        .catch((e) => {
          if (alive) onError(e instanceof Error ? e.message : 'Could not load the agents.');
        });
    return () => {
      alive = false;
    };
  }, [workspaceId, id, version, onError]);
  return agents;
}

/** The draft's content, without what dates it: its id, version and revision. */
const contentOf = ({ id: _, expectedVersion: _v, expectedRevision: _r, ...input }: Draft) => input;
/**
 * Whether the roadmap moved on from the draft: a running roadmap writes itself as its items
 * move, so it is dated by its revision (R-B6, decision 10); any other by its version.
 */
const outdated = (baseline: Roadmap, draft: Draft) =>
  baseline.status === 'running'
    ? baseline.definition.revision !== draft.expectedRevision
    : baseline.version !== draft.expectedVersion;

export function draftOf(roadmap: Roadmap): Draft {
  return {
    id: roadmap.id,
    expectedVersion: roadmap.version,
    expectedRevision: roadmap.definition.revision,
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
        permissions: stepPermissionsOf(profiles),
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
export function RoadmapEditor({
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
  /**
   * After saving: the view the definition save answered (none when only agents changed), and
   * whether an agent assignment moved the roadmap on since (R-E5b).
   */
  onSaved: (view: RoadmapView | undefined, assigned: boolean) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { items, backends, defaults, workspaceAgents, minutes } = useEditorChoices(
    workspaceId,
    setError,
  );
  // Where a save this editor made stands when its agents then failed: the next save starts there.
  const [savedHere, setSavedHere] = useState<{
    readonly view?: RoadmapView;
    readonly roadmap: Roadmap;
  }>();
  const baseline =
    savedHere && (!current || savedHere.roadmap.version >= current.version)
      ? savedHere.roadmap
      : current;
  const roadmapAgents = useRoadmapAgents(workspaceId, baseline, setError);
  /** Each entry's changed agents, applied as assignments once the definition is saved (R-E5b). */
  const [agentDrafts, setAgentDrafts] = useState<ReadonlyMap<string, AgentSelections>>(
    () => new Map(),
  );
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
  const updateEntry = (index: number, changes: Partial<RoadmapSave['entries'][number]>) =>
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
          const { id, ...input } = draft;
          // The definition holds each step's permissions; an unchanged one is not saved again.
          const unchanged =
            baseline !== undefined &&
            JSON.stringify(contentOf(draft)) === JSON.stringify(contentOf(draftOf(baseline)));
          let saved = savedHere?.view;
          try {
            if (!unchanged) saved = await saveRoadmap(workspaceId, id, input, csrfToken);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save roadmap.');
            setBusy(false);
            return;
          }
          // The agents go to ADR-064 assignments, applied after the save (E5-1 as amended).
          const groups = agentGroups(
            new Map(
              [...agentDrafts].filter(([entryId]) => input.entries.some((e) => e.id === entryId)),
            ),
          );
          const start = unchanged ? baseline : saved?.roadmap;
          const applied: string[] = [];
          let version = start?.version;
          try {
            if (groups.length > 0 && version !== undefined)
              await applyRoadmapAgents(workspaceId, id, version, groups, csrfToken, (g, latest) => {
                applied.push(...g.entryIds);
                version = latest.version;
              });
            onSaved(saved, groups.length > 0);
          } catch (e) {
            // What took effect stays done: the saved definition, and each group applied before
            // the refusal; the editor goes on from there (review LOW-1, MEDIUM-2's sequential twin).
            if (start && version !== undefined) {
              setSavedHere({
                ...(saved ? { view: saved } : {}),
                roadmap: { ...start, version },
              });
              setDraft({
                ...draft,
                expectedVersion: version,
                expectedRevision: start.definition.revision,
              });
            }
            setAgentDrafts(
              (drafts) => new Map([...drafts].filter(([entryId]) => !applied.includes(entryId))),
            );
            const message = e instanceof Error ? e.message : 'Could not apply the agents.';
            setError(
              applied.length
                ? `Some agents were applied (${applied.length} entries); the rest were not: ${message}`
                : saved && !unchanged
                  ? `The roadmap was saved, but its agents were not applied: ${message}`
                  : message,
            );
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
                    section: 'capacity',
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
                    permissions: defaults,
                    policy: { ...DEFAULT_COMPLETION_POLICY, maxRunMinutes: minutes },
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
                  <p className="hint">
                    This entry has started. Its settings stay fixed; its agents apply from its next
                    step, and a step running now keeps its agent.
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
                  {(() => {
                    // A saved entry's agents are the roadmap's, read; until then they are
                    // unknown, never the workspace defaults (review LOW-2).
                    const saved = baseline?.definition.entries.some((e) => e.id === entry.id);
                    const savedEntry = roadmapAgents?.entries.find((e) => e.id === entry.id);
                    const source = saved ? savedEntry : workspaceAgents;
                    return (
                      <RoadmapAgentsFields
                        legend="Agents"
                        agents={source?.agents}
                        selections={source?.selections}
                        value={agentDrafts.get(entry.id)}
                        onChange={(value) =>
                          setAgentDrafts((drafts) => {
                            const next = new Map(drafts);
                            if (value) next.set(entry.id, value);
                            else next.delete(entry.id);
                            return next;
                          })
                        }
                        backends={backends}
                        disabled={busy}
                        locked={roadmapAgents?.editBlocker}
                      />
                    );
                  })()}
                  <CycleSettingsFields
                    policy={entry.policy}
                    setPolicy={(policy) => updateEntry(index, { policy })}
                    permissions={entry.permissions}
                    setPermissions={(permissions) => updateEntry(index, { permissions })}
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
        {baseline?.status === 'running' && (
          <p>
            Started items keep their saved settings except their agents, which apply from each
            entry’s next step; steps running now keep theirs.
          </p>
        )}
        {baseline && outdated(baseline, draft) && (
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
              busy || draft.entries.length === 0 || !!(baseline && outdated(baseline, draft))
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
