import type {
  AgentRunSummary,
  ExecutionStatusResponse,
  MergeGate,
  RepositoryBranchesResponse,
  SourceRepositorySummary,
  WorktreeSummary,
} from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  AGENT_PERMISSION_MODES,
  AGENT_RUN_ROLES,
  type AgentBackendKind,
  type AgentPermissionMode,
  type AgentRunId,
  type AgentRunRole,
  type SourceRepositoryId,
  type WorktreeId,
} from '@craftingtable/domain';
import { type CSSProperties, type FormEvent, Fragment, useState } from 'react';
import {
  formatCost,
  isLiveStatus,
  MERGE_GATE_LABELS,
  PERMISSION_MODE_LABELS,
  RUN_ROLE_DESCRIPTIONS,
  RUN_ROLE_LABELS,
  RUN_STATUS_ACCENTS,
  RUN_STATUS_LABELS,
  shortSha,
  VERDICT_ACCENTS,
  VERDICT_LABELS,
} from '../../lib/execution-labels.js';
import {
  handoffDefaults,
  type LaunchInput,
  previousImplementerHint,
  type ProfileEntry,
  profileChoice,
} from './handoff.js';
import { HandoffForm } from './HandoffForm.js';
import { ModelField } from './ModelField.js';

export type { LaunchInput } from './handoff.js';
export { ModelField, type ModelOption } from './ModelField.js';

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/** Long agent summaries start collapsed so the table scans quickly. */
function OutcomeCell({ text }: { text: string | undefined }) {
  if (text === undefined || text.trim().length === 0) {
    return <span className="hint">—</span>;
  }
  const summary = firstLine(text);
  const oneLiner = text.trim() === summary;
  return oneLiner ? (
    <span className="outcome-cell">{summary}</span>
  ) : (
    <details className="outcome-details">
      <summary>{summary}</summary>
      <pre className="outcome-cell outcome-full">{text}</pre>
    </details>
  );
}

/**
 * The delegation half of a work item page: worktrees with their merge gate,
 * the launch form, and the runs. Everything here is a request to the daemon;
 * the browser never chooses a path or a command, and the Merge action only
 * appears when the daemon says the gate is open.
 */
export function DelegationPanel({
  repositories,
  worktrees,
  runs,
  mergeGates,
  branches,
  backends,
  itemCompleted,
  canMutate,
  busy,
  error,
  onCreateWorktree,
  onRemoveWorktree,
  onMergeWorktree,
  onLoadBranches,
  onLaunch,
  onOpenRun,
  onOpenDiff,
  profiles,
}: {
  repositories: readonly SourceRepositorySummary[];
  worktrees: readonly WorktreeSummary[];
  runs: readonly AgentRunSummary[];
  mergeGates: Readonly<Record<string, MergeGate>>;
  /** Branches of the repository a merge is being prepared for, once loaded. */
  branches?: RepositoryBranchesResponse;
  backends: ExecutionStatusResponse['backends'];
  itemCompleted: boolean;
  canMutate: boolean;
  busy: boolean;
  error?: string;
  onCreateWorktree: (repositoryId: SourceRepositoryId) => void;
  onRemoveWorktree: (worktreeId: WorktreeId) => void;
  onMergeWorktree: (worktreeId: WorktreeId, targetBranch: string) => void;
  onLoadBranches: (repositoryId: SourceRepositoryId) => void;
  onLaunch: (input: LaunchInput) => void;
  onOpenRun: (runId: AgentRunId) => void;
  onOpenDiff: (worktreeId: WorktreeId) => void;
  /** Per-role defaults the form and every handoff start from; absent until loaded. */
  profiles?: readonly ProfileEntry[];
}) {
  const roleProfiles = profiles ?? [];
  const initialChoice = profileChoice('implement', roleProfiles);
  const availableBackends = backends.filter((backend) => backend.available);
  const [backendKind, setBackendKind] = useState<AgentBackendKind | ''>(
    initialChoice?.backend ?? '',
  );
  const selectedBackend =
    backends.find((backend) => backend.kind === backendKind) ?? availableBackends[0];
  const models = selectedBackend?.models ?? [];
  const backendAvailable = selectedBackend?.available === true;
  const activeRepositories = repositories.filter((repository) => repository.status === 'active');
  const activeWorktrees = worktrees.filter((worktree) => worktree.status === 'active');
  const mergedWorktrees = worktrees.filter((worktree) => worktree.mergedAt !== undefined);
  const [repositoryId, setRepositoryId] = useState<string>('');
  const [worktreeId, setWorktreeId] = useState<string>('');
  const [role, setRole] = useState<AgentRunRole>('implement');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    initialChoice?.permissionMode ?? 'auto',
  );
  const [model, setModel] = useState(initialChoice?.model ?? '');
  const [instructions, setInstructions] = useState('');
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [mergeOpen, setMergeOpen] = useState<string>();
  /** The run whose handoff form is open, if any. */
  const [handoffOpen, setHandoffOpen] = useState<AgentRunId>();

  /** Changing the role applies that role's profile; the operator can still edit after. */
  const applyRole = (next: AgentRunRole): void => {
    setRole(next);
    const choice = profileChoice(next, roleProfiles);
    if (choice !== undefined) {
      setBackendKind(choice.backend);
      setModel(choice.model ?? '');
      setPermissionMode(choice.permissionMode);
    }
  };

  const selectedRepository = repositoryId || activeRepositories[0]?.id || '';
  const selectedWorktree = worktreeId || activeWorktrees[0]?.id || '';
  const liveRuns = runs.filter((run) => isLiveStatus(run.status));
  const latestFinished = runs.find(
    (run) => run.worktreeId === selectedWorktree && !isLiveStatus(run.status),
  );
  const runById = new Map(runs.map((run) => [run.id, run]));

  const createWorktree = (event: FormEvent): void => {
    event.preventDefault();
    if (selectedRepository.length > 0) {
      onCreateWorktree(selectedRepository as SourceRepositoryId);
    }
  };

  const launch = (event: FormEvent): void => {
    event.preventDefault();
    if (selectedWorktree.length === 0 || !backendAvailable) {
      return;
    }
    const trimmedModel = model.trim();
    const trimmedInstructions = instructions.trim();
    onLaunch({
      backend: selectedBackend.kind,
      worktreeId: selectedWorktree as WorktreeId,
      role,
      permissionMode,
      ...(trimmedModel.length === 0 ? {} : { model: trimmedModel }),
      ...(trimmedInstructions.length === 0 ? {} : { instructions: trimmedInstructions }),
      ...(role === 'review' && latestFinished !== undefined
        ? { parentRunId: latestFinished.id }
        : {}),
    });
    setInstructions('');
  };

  const openMerge = (worktree: WorktreeSummary): void => {
    setMergeOpen(worktree.id);
    setMergeTargets((current) =>
      current[worktree.id] === undefined
        ? { ...current, [worktree.id]: worktree.baseBranch }
        : current,
    );
    onLoadBranches(worktree.repositoryId);
  };

  return (
    <section className="panel" aria-label="Delegation">
      <div className="panel-header">
        <div>
          <h3>Delegation</h3>
          <p className="hint">
            Create a worktree on a fresh branch, launch an implement run, then a review run. A
            mergeable review opens the Merge action, which lands the branch where you choose and
            completes the item.
          </p>
        </div>
      </div>
      {error !== undefined && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}

      <h4>Worktrees ({activeWorktrees.length})</h4>
      {activeWorktrees.length === 0 ? (
        <p className="empty-state">
          {mergedWorktrees.length > 0
            ? `No active worktree. Merged: ${mergedWorktrees
                .map((worktree) => `${worktree.branchName} → ${shortSha(worktree.mergeSha ?? '')}`)
                .join(', ')}.`
            : 'No worktree yet.'}
        </p>
      ) : (
        <ul className="worktree-list">
          {activeWorktrees.map((worktree) => {
            const gate = mergeGates[worktree.id];
            const hasLiveRun = liveRuns.some((run) => run.worktreeId === worktree.id);
            const target = mergeTargets[worktree.id] ?? worktree.baseBranch;
            const listId = `branches-${worktree.id}`;
            return (
              <li key={worktree.id} className="worktree-item">
                <div>
                  <span className="mono">{worktree.branchName}</span>
                  <span className="hint">
                    {' '}
                    from {worktree.baseBranch} @ {shortSha(worktree.baseSha)}
                  </span>
                  <div className="hint mono">{worktree.path}</div>
                  {gate !== undefined && (
                    <div className="worktree-gate">
                      <span
                        className="status-badge"
                        style={
                          {
                            '--badge-accent': gate.mergeable
                              ? 'var(--color-ready)'
                              : gate.reason === 'changes-requested'
                                ? 'var(--color-attention)'
                                : 'var(--color-text-muted)',
                          } as CSSProperties
                        }
                      >
                        {MERGE_GATE_LABELS[gate.reason]}
                      </span>
                      {gate.reviewRunId !== undefined && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => gate.reviewRunId && onOpenRun(gate.reviewRunId)}
                        >
                          open review
                        </button>
                      )}
                    </div>
                  )}
                  {gate?.mergeable === true && canMutate && mergeOpen === worktree.id && (
                    <form
                      className="inline-form merge-form"
                      aria-label="Merge target"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (target.trim().length > 0) {
                          onMergeWorktree(worktree.id, target.trim());
                        }
                      }}
                    >
                      <label className="field">
                        Merge into
                        <input
                          type="text"
                          list={listId}
                          value={target}
                          onChange={(event) =>
                            setMergeTargets((current) => ({
                              ...current,
                              [worktree.id]: event.target.value,
                            }))
                          }
                          disabled={busy}
                          maxLength={255}
                          spellCheck={false}
                          required
                        />
                        <datalist id={listId}>
                          {(branches?.branches ?? [])
                            .filter((name) => name !== worktree.branchName)
                            .map((name) => (
                              <option key={name} value={name} />
                            ))}
                        </datalist>
                      </label>
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={busy || target.trim().length === 0}
                      >
                        Merge
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setMergeOpen(undefined)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                      <span className="hint">
                        An existing branch, or a new one created from {worktree.baseBranch}.
                        {branches?.checkedOut !== undefined
                          ? ` The primary checkout is on ${branches.checkedOut}.`
                          : ''}
                      </span>
                    </form>
                  )}
                </div>
                <div className="inline-actions">
                  {gate?.mergeable === true && canMutate && mergeOpen !== worktree.id && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => openMerge(worktree)}
                      disabled={busy}
                    >
                      Merge…
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpenDiff(worktree.id)}
                  >
                    View diff
                  </button>
                  <button
                    type="button"
                    className="text-button danger"
                    onClick={() => onRemoveWorktree(worktree.id)}
                    disabled={!canMutate || busy || hasLiveRun}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {canMutate && !itemCompleted && (
        <form
          className="inline-form"
          onSubmit={createWorktree}
          style={{ marginTop: 'var(--space-3)' }}
        >
          <label className="field">
            Repository
            <select
              value={selectedRepository}
              onChange={(event) => setRepositoryId(event.target.value)}
              disabled={busy || activeRepositories.length === 0}
            >
              {activeRepositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="secondary-button"
            disabled={busy || activeRepositories.length === 0}
          >
            Create worktree
          </button>
          {activeRepositories.length === 0 && <p className="hint">Register a repository first.</p>}
        </form>
      )}

      {canMutate && !itemCompleted && (
        <form className="stack-form" onSubmit={launch} aria-label="Launch an agent">
          <h4>Launch an agent</h4>
          {availableBackends.length === 0 && (
            <p className="warning-state" role="note">
              No agent backend was found on the workstation, so runs cannot start. See the
              Repositories page for the tool status.
            </p>
          )}
          <div className="form-row">
            <label className="field">
              Worktree
              <select
                value={selectedWorktree}
                onChange={(event) => setWorktreeId(event.target.value)}
                disabled={busy || activeWorktrees.length === 0}
              >
                {activeWorktrees.map((worktree) => (
                  <option key={worktree.id} value={worktree.id}>
                    {worktree.branchName}
                  </option>
                ))}
              </select>
            </label>
            {backends.length > 1 && (
              <label className="field">
                Agent
                <select
                  value={selectedBackend?.kind ?? ''}
                  onChange={(event) => {
                    setBackendKind(event.target.value as AgentBackendKind);
                    setModel('');
                  }}
                  disabled={busy}
                >
                  {backends.map((backend) => (
                    <option key={backend.kind} value={backend.kind} disabled={!backend.available}>
                      {backend.label}
                      {backend.available ? '' : ' (not found)'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Role
              <select
                value={role}
                onChange={(event) => applyRole(event.target.value as AgentRunRole)}
                disabled={busy}
              >
                {AGENT_RUN_ROLES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {RUN_ROLE_LABELS[candidate]}
                  </option>
                ))}
              </select>
            </label>
            <ModelField
              key={`${selectedBackend?.kind}:${role}`}
              models={models}
              value={model}
              onChange={setModel}
              disabled={busy}
            />
          </div>
          <p className="hint">{RUN_ROLE_DESCRIPTIONS[role]}</p>
          <label className="field">
            Permissions
            <select
              value={permissionMode}
              onChange={(event) => setPermissionMode(event.target.value as AgentPermissionMode)}
              disabled={busy}
            >
              {AGENT_PERMISSION_MODES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {PERMISSION_MODE_LABELS[candidate]}
                </option>
              ))}
            </select>
          </label>
          {selectedBackend?.kind === 'codex' && (
            <p className="hint">
              On Codex, Auto uses the workspace-write sandbox with automatic approval review.
              Edit-only denies requests to expand access.
            </p>
          )}
          <label className="field">
            Instructions for this run (optional)
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={3}
              disabled={busy}
              maxLength={20000}
            />
          </label>
          <div>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || activeWorktrees.length === 0 || !backendAvailable}
            >
              {busy ? 'Working…' : `Launch ${RUN_ROLE_LABELS[role].toLowerCase()} run`}
            </button>
          </div>
        </form>
      )}

      <h4>Runs ({runs.length})</h4>
      {runs.length === 0 ? (
        <p className="empty-state">No agent runs yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Agent runs</caption>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Verdict</th>
                <th scope="col">Model</th>
                <th scope="col">Turns</th>
                <th scope="col">Cost</th>
                <th scope="col">Outcome</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const parent =
                  run.parentRunId === undefined ? undefined : runById.get(run.parentRunId);
                const handoffDefault = handoffDefaults('implement', roleProfiles, run, runs);
                const handoffHint =
                  run.role === 'review'
                    ? previousImplementerHint(runs, run.worktreeId, handoffDefault)
                    : undefined;
                return (
                  <Fragment key={run.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => onOpenRun(run.id)}
                        >
                          {new Date(run.createdAt).toLocaleString()}
                        </button>
                      </td>
                      <td>
                        {RUN_ROLE_LABELS[run.role]}
                        {parent !== undefined && (
                          <div className="hint">
                            after{' '}
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => onOpenRun(parent.id)}
                            >
                              {RUN_ROLE_LABELS[parent.role].toLowerCase()}
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <span
                          className="status-badge"
                          style={
                            { '--badge-accent': RUN_STATUS_ACCENTS[run.status] } as CSSProperties
                          }
                        >
                          {RUN_STATUS_LABELS[run.status]}
                        </span>
                      </td>
                      <td>
                        {run.verdict === undefined ? (
                          <span className="hint">—</span>
                        ) : (
                          <span
                            className="status-badge"
                            style={
                              { '--badge-accent': VERDICT_ACCENTS[run.verdict] } as CSSProperties
                            }
                          >
                            {VERDICT_LABELS[run.verdict]}
                          </span>
                        )}
                      </td>
                      <td className="mono">
                        {backends.length > 1 ? `${AGENT_BACKEND_LABELS[run.backend]} · ` : ''}
                        {run.resolvedModel ?? run.model ?? 'default'}
                      </td>
                      <td className="numeric">{run.turnCount}</td>
                      <td className="numeric">{formatCost(run.costUsd, run.billing)}</td>
                      <td>
                        <OutcomeCell text={run.outcomeSummary} />
                      </td>
                      <td>
                        {run.role === 'review' &&
                          run.verdict !== undefined &&
                          canMutate &&
                          !itemCompleted && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => setHandoffOpen(run.id)}
                              disabled={busy || availableBackends.length === 0}
                              title="Launch an implement run in this worktree with these findings as its brief"
                            >
                              Remediate
                            </button>
                          )}
                        {run.role === 'design' &&
                          run.status === 'finished' &&
                          canMutate &&
                          !itemCompleted && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => setHandoffOpen(run.id)}
                              disabled={busy || availableBackends.length === 0}
                              title="Launch an implement run in this worktree with this design as its plan"
                            >
                              Implement
                            </button>
                          )}
                      </td>
                    </tr>
                    {handoffOpen === run.id && (
                      <tr className="handoff-row">
                        <td colSpan={9}>
                          <HandoffForm
                            label={run.role === 'review' ? 'Remediate with' : 'Implement with'}
                            backends={backends}
                            defaults={handoffDefault}
                            {...(handoffHint === undefined ? {} : { hint: handoffHint })}
                            busy={busy}
                            onLaunch={(choice) => {
                              onLaunch({
                                backend: choice.backend,
                                worktreeId: run.worktreeId,
                                role: 'implement',
                                permissionMode: choice.permissionMode,
                                ...(choice.model === undefined ? {} : { model: choice.model }),
                                parentRunId: run.id,
                              });
                              setHandoffOpen(undefined);
                            }}
                            onCancel={() => setHandoffOpen(undefined)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
