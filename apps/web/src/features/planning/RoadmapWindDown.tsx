import type {
  CleanupAction,
  RepositoryCleanup,
  RetirementDisposition,
  Roadmap,
  WindDownPreview,
  WorkspaceId,
} from '@craftingtable/domain';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import {
  cleanUpRoadmap,
  loadRoadmapCleanup,
  loadRoadmapWindDown,
  windDownRoadmap,
} from '../../lib/roadmap-api.js';

/**
 * Stopping, winding down and cleaning up a roadmap (R-B11, ADR-073). One component owns the
 * preview, the choices, the progress and the typed refusals of both commands; it replaces the
 * board's Stop. It is the roadmap's lifecycle control, not a recovery panel for a stop: what it
 * shows is the daemon's preview, and it posts the digest of what the operator saw.
 */

type Choice = 'keep' | RetirementDisposition;
type Panel = 'wind-down' | 'cleanup';

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const ended = (roadmap: Pick<Roadmap, 'status'>) =>
  roadmap.status === 'stopped' || roadmap.status === 'completed';

const DISPOSITIONS: readonly { value: Choice; label: string }[] = [
  { value: 'keep', label: 'Keep' },
  { value: 'superseded', label: 'Retire, superseded' },
  { value: 'parked', label: 'Retire, parked' },
];

export function RoadmapWindDown({
  roadmap,
  workspaceId,
  csrfToken,
  canMutate,
  isOwner,
  onChanged,
}: {
  roadmap: Roadmap;
  workspaceId: WorkspaceId;
  csrfToken: string;
  /** An owner or an editor: winding down is an editor's. */
  canMutate: boolean;
  /** Cleaning up is an owner's (R-B11 decision 5). */
  isOwner: boolean;
  /** Told after a command, so the page reads the roadmap again. */
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const store = useQueryStore();
  const windDownKey = queryKeys.roadmapWindDown(workspaceId, roadmap.id);
  const windDown = useQuery(windDownKey, () => loadRoadmapWindDown(workspaceId, roadmap.id));
  const woundDown = windDown.data?.record?.status === 'settled';
  if (!canMutate) return null;
  const toggle = (next: Panel) => setPanel((open) => (open === next ? undefined : next));
  return (
    <>
      <div className="wind-down-controls">
        <button
          type="button"
          className="secondary-button danger"
          aria-expanded={panel === 'wind-down'}
          onClick={() => toggle('wind-down')}
        >
          {ended(roadmap) ? 'Wind down…' : 'Stop or wind down…'}
        </button>
        {woundDown && (
          <button
            type="button"
            className="secondary-button"
            aria-expanded={panel === 'cleanup'}
            onClick={() => toggle('cleanup')}
          >
            Clean up repositories…
          </button>
        )}
      </div>
      {panel === 'wind-down' && windDown.data && (
        <WindDownForm
          roadmap={roadmap}
          workspaceId={workspaceId}
          csrfToken={csrfToken}
          preview={windDown.data.preview}
          settling={windDown.data.record?.status === 'settling'}
          incomplete={windDown.data.record?.incomplete?.message}
          onDone={() => {
            store.invalidate([windDownKey]);
            onChanged();
          }}
        />
      )}
      {panel === 'wind-down' && windDown.status === 'error' && (
        <p role="alert" className="error-state">
          {errorText(windDown.error, 'The wind-down preview could not be read.')}
        </p>
      )}
      {panel === 'cleanup' && woundDown && (
        <CleanupForm
          roadmapId={roadmap.id}
          workspaceId={workspaceId}
          csrfToken={csrfToken}
          isOwner={isOwner}
          onDone={onChanged}
        />
      )}
    </>
  );
}

function WindDownForm({
  roadmap,
  workspaceId,
  csrfToken,
  preview,
  settling,
  incomplete,
  onDone,
}: {
  roadmap: Roadmap;
  workspaceId: WorkspaceId;
  csrfToken: string;
  preview: WindDownPreview;
  settling: boolean;
  incomplete: string | undefined;
  onDone: () => void;
}) {
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const retire = preview.versions.flatMap((v) => {
    const choice = choices[v.planVersionId] ?? 'keep';
    return choice === 'keep' || v.retired
      ? []
      : [{ planVersionId: v.planVersionId, disposition: choice }];
  });
  const refused = preview.refusals.length > 0;
  const action = ended(roadmap) ? 'Retire versions' : retire.length ? 'Wind down' : 'Stop roadmap';
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await windDownRoadmap(
        workspaceId,
        roadmap.id,
        { expectedDigest: preview.digest, retire },
        csrfToken,
      );
      setChoices({});
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wind-down was refused.');
    } finally {
      setBusy(false);
    }
  };
  const resolutions = preview.cycles.filter((c) => c.abandonsResolution);
  return (
    <Section
      id={`wind-down-${roadmap.id}`}
      title="Stop or wind down"
      tone={refused ? 'blocked' : undefined}
      summary={
        settling
          ? 'Settling'
          : `${preview.cycles.length} cycle${preview.cycles.length === 1 ? '' : 's'} to stop`
      }
    >
      {settling && <p role="status">Settling: stopping its cycles and preparations.</p>}
      {incomplete && (
        <p role="alert" className="warning-state">
          {incomplete}
        </p>
      )}
      {preview.refusals.map((refusal) => (
        <p key={refusal.code} role="alert" className="error-state">
          {refusal.message}
        </p>
      ))}
      {!ended(roadmap) && (
        <ul aria-label="What stops" className="plain-list">
          {preview.cycles.map((cycle) => (
            <li key={cycle.cycleId}>
              <span className="mono">{cycle.label}</span> · {cycle.status}
              {cycle.liveRunId ? ' · its session ends' : ''}
              {cycle.abandonsResolution ? ' · its integration resolution is abandoned' : ''}
            </li>
          ))}
          {preview.preparations.map((p) => (
            <li key={p.preparationId}>
              Preparation of <span className="mono">{p.checkpointId}</span> ends
            </li>
          ))}
          {preview.amendmentId && <li>The pending amendment is rejected as moot</li>}
          {preview.cycles.length + preview.preparations.length === 0 && !preview.amendmentId && (
            <li>Nothing is running</li>
          )}
        </ul>
      )}
      {resolutions.length > 0 && (
        <p role="status" className="warning-state">
          {resolutions.length} integration resolution{resolutions.length === 1 ? '' : 's'} will be
          abandoned; edits stay in the worktree.
        </p>
      )}
      {preview.attention.length > 0 && (
        <ul aria-label="Needs you items that resolve" className="plain-list">
          {preview.attention.map((item) => (
            <li key={item.itemId}>{item.title}</li>
          ))}
        </ul>
      )}
      <fieldset className="wind-down-versions">
        <legend>Plan versions</legend>
        {preview.versions.map((version) => (
          <div key={version.planVersionId} className="wind-down-version">
            <p>
              <strong>{version.projectName}</strong> · version {version.versionNumber}
              {version.active ? ' · active' : ''} · {version.admittedItems} admitted ·{' '}
              {version.activeWorktrees} worktrees
            </p>
            {version.retired ? (
              <p role="status">Retired as {version.retired}.</p>
            ) : version.refusal ? (
              <p role="status" className="warning-state">
                {version.refusal.message}
              </p>
            ) : (
              <div
                role="radiogroup"
                aria-label={`Version ${version.versionNumber} of ${version.projectName}`}
              >
                {DISPOSITIONS.map((option) => (
                  <label key={option.value} className="inline-choice">
                    <input
                      type="radio"
                      name={`retire-${version.planVersionId}`}
                      checked={(choices[version.planVersionId] ?? 'keep') === option.value}
                      onChange={() =>
                        setChoices((current) => ({
                          ...current,
                          [version.planVersionId]: option.value,
                        }))
                      }
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      <button
        type="button"
        className="secondary-button danger"
        disabled={busy || settling || refused || (ended(roadmap) && retire.length === 0)}
        onClick={() => void submit()}
      >
        {action}
      </button>
      <About label="About winding down">
        <p>
          Stop ends the roadmap and its cycles; their worktrees stay for manual work. Retiring a
          version also releases it: its admitted items and worktrees no longer hold the project,
          capacity or its repository policy, and no roadmap can name it again.
        </p>
        <p>
          Superseded means other work replaces it. Parked means its work resumes later from a
          revised version on the same integration branch. Retiring asks for your password again.
        </p>
      </About>
    </Section>
  );
}

const counts = (cleanup: RepositoryCleanup) => ({
  done: cleanup.actions.filter((a) => a.state === 'done').length,
  left: cleanup.actions.filter((a) => a.state === 'planned' || a.state === 'authorized').length,
  kept: cleanup.actions.filter((a) => a.state === 'kept' || a.state === 'refused').length,
});

function actionLine(action: CleanupAction): string {
  if (action.kind === 'remove-worktree')
    return `Worktree of ${action.branchName}${action.code ? `: ${action.note ?? action.code}` : ''}`;
  const keeper =
    action.keeper.kind === 'parked-tag'
      ? `kept in tag ${action.keeper.tag}`
      : `contained in ${action.keeper.branch}`;
  return `${action.branchName}, ${keeper}${action.code ? `: ${action.note ?? action.code}` : ''}`;
}

function CleanupForm({
  roadmapId,
  workspaceId,
  csrfToken,
  isOwner,
  onDone,
}: {
  roadmapId: string;
  workspaceId: WorkspaceId;
  csrfToken: string;
  isOwner: boolean;
  onDone: () => void;
}) {
  const store = useQueryStore();
  const cleanupKey = queryKeys.roadmapCleanup(workspaceId, roadmapId);
  const view = useQuery(cleanupKey, () => loadRoadmapCleanup(workspaceId, roadmapId));
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const data = view.data;
  const running = data?.running;
  const preview = data?.preview;
  const planned = preview?.actions.filter((a) => a.state === 'planned') ?? [];
  const held = preview?.actions.filter((a) => a.state !== 'planned') ?? [];
  const dirty = held.some((a) => a.kind === 'remove-worktree' && a.code === 'dirty');
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await cleanUpRoadmap(
        workspaceId,
        roadmapId,
        running
          ? { expectedDigest: running.planDigest, discardDirty: running.discardDirty }
          : { expectedDigest: preview?.digest ?? '', discardDirty: discard },
        csrfToken,
      );
      store.invalidate([cleanupKey]);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The cleanup was refused.');
    } finally {
      setBusy(false);
    }
  };
  const progress = running && counts(running);
  return (
    <Section
      id={`cleanup-${roadmapId}`}
      title="Clean up repositories"
      summary={
        progress
          ? `${progress.done} done, ${progress.left} left`
          : `${planned.length} change${planned.length === 1 ? '' : 's'} planned`
      }
    >
      {view.status === 'error' && (
        <p role="alert" className="error-state">
          {errorText(view.error, 'The cleanup plan could not be read.')}
        </p>
      )}
      {running?.incomplete && (
        <p role="alert" className="warning-state">
          {running.incomplete.message}
        </p>
      )}
      {preview?.refusals.map((refusal) => (
        <p key={refusal.code} role="alert" className="error-state">
          {refusal.message}
        </p>
      ))}
      {preview && (
        <>
          <ul aria-label="Planned changes" className="plain-list">
            {planned.map((action) => (
              <li key={`${action.kind}:${action.branchName}`} className="mono">
                {action.kind === 'remove-worktree' ? 'Remove ' : 'Delete '}
                {actionLine(action)}
              </li>
            ))}
            {planned.length === 0 && <li>Nothing to clean up</li>}
          </ul>
          {held.length > 0 && (
            <ul aria-label="Kept" className="plain-list">
              {held.map((action) => (
                <li key={`${action.kind}:${action.branchName}`} className="mono">
                  Keep {actionLine(action)}
                </li>
              ))}
            </ul>
          )}
          {dirty && (
            <label className="inline-choice">
              <input
                type="checkbox"
                checked={discard}
                onChange={(event) => setDiscard(event.target.checked)}
              />
              Discard uncommitted changes in the dirty worktrees
            </label>
          )}
        </>
      )}
      {data?.latest?.status === 'done' && !running && (
        <p role="status">
          Last cleanup: {counts(data.latest).done} done, {counts(data.latest).kept} kept.
        </p>
      )}
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {!isOwner && <p role="status">Only an owner cleans up repositories.</p>}
      <button
        type="button"
        className="secondary-button danger"
        disabled={
          busy ||
          !isOwner ||
          (!running && (!preview || preview.refusals.length > 0 || planned.length === 0))
        }
        onClick={() => void submit()}
      >
        {running ? 'Resume cleanup' : 'Clean up repositories'}
      </button>
      <About label="About cleaning up">
        <p>
          Removes the worktrees this roadmap made and deletes their branches. A branch whose work is
          in its integration branch is deleted; any other is first kept in a local tag
          repository/parked/name. Default and integration branches, existing tags and
          craftingtable/checks are never touched. It always asks for your password again.
        </p>
      </About>
    </Section>
  );
}
