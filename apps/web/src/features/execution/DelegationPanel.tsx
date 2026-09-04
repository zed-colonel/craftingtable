import type {
  AgentRunSummary,
  SourceRepositorySummary,
  WorktreeSummary,
} from '@craftingtable/contracts';
import {
  AGENT_PERMISSION_MODES,
  AGENT_RUN_ROLES,
  type AgentPermissionMode,
  type AgentRunId,
  type AgentRunRole,
  type SourceRepositoryId,
  type WorktreeId,
} from '@craftingtable/domain';
import { type CSSProperties, type FormEvent, useState } from 'react';
import {
  formatCost,
  isLiveStatus,
  PERMISSION_MODE_LABELS,
  RUN_ROLE_DESCRIPTIONS,
  RUN_ROLE_LABELS,
  RUN_STATUS_ACCENTS,
  RUN_STATUS_LABELS,
  shortSha,
} from '../../lib/execution-labels.js';

export interface LaunchInput {
  readonly worktreeId: WorktreeId;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
  readonly instructions?: string;
  readonly parentRunId?: AgentRunId;
}

/**
 * The delegation half of a work item page: worktrees, runs, and the two
 * actions that start the loop. Everything here is a request to the daemon;
 * the browser never chooses a path, a branch, or a command.
 */
export function DelegationPanel({
  repositories,
  worktrees,
  runs,
  canMutate,
  busy,
  error,
  backendAvailable,
  onCreateWorktree,
  onRemoveWorktree,
  onLaunch,
  onOpenRun,
  onOpenDiff,
}: {
  repositories: readonly SourceRepositorySummary[];
  worktrees: readonly WorktreeSummary[];
  runs: readonly AgentRunSummary[];
  canMutate: boolean;
  busy: boolean;
  error?: string;
  backendAvailable: boolean;
  onCreateWorktree: (repositoryId: SourceRepositoryId) => void;
  onRemoveWorktree: (worktreeId: WorktreeId) => void;
  onLaunch: (input: LaunchInput) => void;
  onOpenRun: (runId: AgentRunId) => void;
  onOpenDiff: (worktreeId: WorktreeId) => void;
}) {
  const activeRepositories = repositories.filter((repository) => repository.status === 'active');
  const activeWorktrees = worktrees.filter((worktree) => worktree.status === 'active');
  const [repositoryId, setRepositoryId] = useState<string>('');
  const [worktreeId, setWorktreeId] = useState<string>('');
  const [role, setRole] = useState<AgentRunRole>('implement');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('auto');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');

  const selectedRepository = repositoryId || activeRepositories[0]?.id || '';
  const selectedWorktree = worktreeId || activeWorktrees[0]?.id || '';
  const liveRuns = runs.filter((run) => isLiveStatus(run.status));
  const latestFinished = runs.find((run) => !isLiveStatus(run.status));

  const createWorktree = (event: FormEvent): void => {
    event.preventDefault();
    if (selectedRepository.length > 0) {
      onCreateWorktree(selectedRepository as SourceRepositoryId);
    }
  };

  const launch = (event: FormEvent): void => {
    event.preventDefault();
    if (selectedWorktree.length === 0) {
      return;
    }
    const trimmedModel = model.trim();
    const trimmedInstructions = instructions.trim();
    onLaunch({
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

  return (
    <section className="panel" aria-label="Delegation">
      <h3>Delegation</h3>
      <p className="hint">
        Create a worktree on a fresh branch, then launch an agent with this work item as its brief.
        Watch it live, steer it, and inspect the diff when it is done.
      </p>
      {error !== undefined && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}

      <h4>Worktrees ({activeWorktrees.length})</h4>
      {activeWorktrees.length === 0 ? (
        <p className="empty-state">No worktree yet.</p>
      ) : (
        <ul className="worktree-list">
          {activeWorktrees.map((worktree) => (
            <li key={worktree.id} className="worktree-item">
              <div>
                <span className="mono">{worktree.branchName}</span>
                <span className="hint">
                  {' '}
                  from {worktree.baseBranch} @ {shortSha(worktree.baseSha)}
                </span>
                <div className="hint mono">{worktree.path}</div>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onOpenDiff(worktree.id)}
                >
                  View diff
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onRemoveWorktree(worktree.id)}
                  disabled={
                    !canMutate || busy || liveRuns.some((run) => run.worktreeId === worktree.id)
                  }
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canMutate && (
        <form className="inline-form" onSubmit={createWorktree}>
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

      <h4>Runs ({runs.length})</h4>
      {runs.length === 0 ? (
        <p className="empty-state">No agent runs yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="work-item-table">
            <caption className="visually-hidden">Agent runs</caption>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Turns</th>
                <th scope="col">Cost</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <button type="button" className="link-button" onClick={() => onOpenRun(run.id)}>
                      {new Date(run.createdAt).toLocaleString()}
                    </button>
                  </td>
                  <td>{RUN_ROLE_LABELS[run.role]}</td>
                  <td>
                    <span
                      className="readiness-badge"
                      style={{ '--badge-accent': RUN_STATUS_ACCENTS[run.status] } as CSSProperties}
                    >
                      {RUN_STATUS_LABELS[run.status]}
                    </span>
                  </td>
                  <td>{run.turnCount}</td>
                  <td>{formatCost(run.costUsd)}</td>
                  <td className="outcome-cell">{run.outcomeSummary ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canMutate && (
        <form className="stack-form" onSubmit={launch} aria-label="Launch an agent">
          <h4>Launch an agent</h4>
          {!backendAvailable && (
            <p className="warning-state" role="note">
              Claude Code was not found on the workstation, so runs cannot start. See the
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
            <label className="field">
              Role
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as AgentRunRole)}
                disabled={busy}
              >
                {AGENT_RUN_ROLES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {RUN_ROLE_LABELS[candidate]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Model (optional)
              <input
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="default"
                disabled={busy}
                maxLength={100}
              />
            </label>
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
          <button
            type="submit"
            className="primary-button"
            disabled={busy || activeWorktrees.length === 0 || !backendAvailable}
          >
            {busy ? 'Working…' : `Launch ${RUN_ROLE_LABELS[role].toLowerCase()} run`}
          </button>
        </form>
      )}
    </section>
  );
}
