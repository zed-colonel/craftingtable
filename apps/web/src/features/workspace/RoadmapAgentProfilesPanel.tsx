import {
  type AgentRunProfileEntry,
  type ExecutionStatusResponse,
  type RoadmapAgents,
  roadmapAgentsSchema,
} from '@craftingtable/contracts';
import {
  type AgentSelections,
  agentSelections,
  CYCLE_STEPS,
  cycleProfilesFromDefaults,
  PROFILE_LABELS,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { Section } from '../../components/Section.js';
import { request } from '../../lib/api-client.js';
import { revealElement } from '../../lib/reveal-element.js';
import { AgentSelectionsEditor } from '../execution/AgentSelectionsEditor.js';
export function RoadmapAgentProfilesPanel({
  workspaceId,
  csrfToken,
  backends,
  profiles,
  canEdit,
}: {
  workspaceId: string;
  csrfToken: string;
  backends: ExecutionStatusResponse['backends'];
  profiles: readonly AgentRunProfileEntry[];
  canEdit: boolean;
}) {
  const [data, setData] = useState<RoadmapAgents>();
  const [selected, setSelected] = useState(
    () => new URLSearchParams(window.location.search).get('roadmap') ?? '',
  );
  const [target, setTarget] = useState('all');
  const [draft, setDraft] = useState<{
    version: number;
    entryIds: string[];
    selections: AgentSelections;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [notice, setNotice] = useState<string>();
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmaps/agent-profiles`;
  useEffect(() => {
    let alive = true;
    void request(url, roadmapAgentsSchema)
      .then((v) => {
        if (alive) {
          setData(v);
          if (window.location.hash === '#roadmap-agent-profiles')
            requestAnimationFrame(() => revealElement('roadmap-agent-profiles'));
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load roadmap profiles.');
      });
    return () => {
      alive = false;
    };
  }, [url]);
  const roadmap = data?.roadmaps.find((r) => r.id === selected) ?? data?.roadmaps[0];
  const entries =
    roadmap?.entries.filter(
      (e) =>
        target === 'all' ||
        (target.startsWith('project:') ? e.projectId === target.slice(8) : e.id === target),
    ) ?? [];
  const distinct = new Set(entries.map((e) => JSON.stringify(e.selections))).size;
  const stale = !!draft && draft.version !== roadmap?.version;
  const act = async (save: boolean) => {
    if (save && (!draft || !roadmap)) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await request(
        save
          ? `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmaps/${roadmap?.id}/agent-profiles`
          : url,
        roadmapAgentsSchema,
        save
          ? {
              method: 'POST',
              headers: { 'x-craftingtable-csrf': csrfToken },
              body: JSON.stringify({
                expectedVersion: draft?.version,
                entryIds: draft?.entryIds,
                selections: draft?.selections,
              }),
            }
          : undefined,
      );
      setData(result);
      if (save) {
        setDraft(undefined);
        setNotice(
          'Applied to future runs in the selected scopes, including later steps and recovery of existing attempts. Running sessions and accepted evidence retain their original records. Scheduling is unchanged.',
        );
      } else setNotice('Current profiles refreshed. Unsaved edits retain their original version.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update roadmap profiles.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      id="roadmap-agent-profiles"
      title="Roadmap agent profiles"
      summary="Change models for future runs without regenerating plan evidence."
    >
      {!data && !error && <p>Loading saved roadmaps…</p>}
      {data && !data.roadmaps.length && (
        <p>Save a roadmap first. New roadmap setup uses the workspace defaults above.</p>
      )}
      {roadmap && (
        <>
          <div className="form-row">
            <label className="field">
              Roadmap
              <select
                value={roadmap.id}
                disabled={busy || !!draft}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setTarget('all');
                  setNotice(undefined);
                }}
              >
                {data?.roadmaps.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Apply to
              <select
                value={target}
                disabled={busy || !!draft}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setNotice(undefined);
                }}
              >
                <option value="all">All current roadmap scopes</option>
                {[...new Set(roadmap.entries.map((e) => e.projectId))].map((id) => (
                  <option key={id} value={`project:${id}`}>
                    Project: {roadmap.entries.find((e) => e.projectId === id)?.projectName}
                  </option>
                ))}
                {roadmap.entries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p>
            {entries.length} selected scopes · {entries.filter((e) => e.started).length} already
            started. Changes take effect when a new run launches.
          </p>
          {roadmap.editBlocker && (
            <p className="attention-state">
              {roadmap.editBlocker} <a href={`/workspaces/${workspaceId}/roadmaps`}>Open roadmap</a>
            </p>
          )}
          {distinct > 1 && (
            <p className="hint">
              These scopes currently use {distinct} different profile sets. Applying one set here
              replaces their future model choices; select an individual scope to retain differences
              elsewhere.
            </p>
          )}
          {!draft && entries[0] && (
            <>
              <p className="hint">
                {distinct > 1 ? 'First selected scope' : 'Current selection'}:{' '}
                {CYCLE_STEPS.map(
                  (p) =>
                    `${PROFILE_LABELS[p]}: ${entries[0]?.selections[p].model ?? 'backend default'} (${entries[0]?.selections[p].reasoningEffort ?? 'local effort'})`,
                ).join(' · ')}
              </p>
              {entries[0].appliedAt && (
                <p className="hint">
                  Last applied: {new Date(entries[0].appliedAt).toLocaleString()}
                </p>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={!canEdit || busy || !!roadmap.editBlocker}
                onClick={() =>
                  setDraft({
                    version: roadmap.version,
                    entryIds: entries.map((e) => e.id),
                    selections: structuredClone(entries[0]!.selections),
                  })
                }
              >
                Edit future run profiles
              </button>
            </>
          )}
          {draft && (
            <form
              className="stack-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(true);
              }}
            >
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  setDraft({
                    ...draft,
                    selections: agentSelections(
                      cycleProfilesFromDefaults(profiles, {
                        backend: 'claude-code',
                        permissionMode: 'auto',
                      }),
                    ),
                  })
                }
              >
                Copy workspace defaults
              </button>
              <AgentSelectionsEditor
                value={draft.selections}
                onChange={(selections) => setDraft({ ...draft, selections })}
                backends={backends}
                disabled={busy || !canEdit}
              />
              <p className="hint">
                Updates backend, model and reasoning effort only. Permissions, reviewer
                responsibilities, retries, scope and merge policy retain their approved settings.
                Finalization has its own stage selections.
              </p>
              {stale && (
                <p role="alert">
                  The roadmap changed while you were editing. Close this editor and reopen it to
                  review the current selections before applying.
                </p>
              )}
              <div className="form-row">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!canEdit || busy || stale || !!roadmap.editBlocker}
                >
                  Apply to future runs
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setDraft(undefined)}
                >
                  Close editor
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => void act(false)}
      >
        Refresh agent settings
      </button>
      {notice && (
        <p role="status" className="success-state">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
    </Section>
  );
}
