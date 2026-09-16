import type { ExecutionScopeChoice, WorktreeSummary } from '@craftingtable/contracts';
import {
  executionScopeKey,
  type SourceRepositoryId,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { createWorktree } from '../../lib/execution-api.js';
import { loadExecutionScopes, recordScopeEvidence } from '../../lib/execution-scope-api.js';

export function ExecutionScopesPanel({
  workspaceId,
  workItemId,
  worktrees,
  csrfToken,
  canMutate,
  admitted,
  refreshToken,
  onChanged,
}: {
  workspaceId: WorkspaceId;
  workItemId: WorkItemId;
  worktrees: readonly WorktreeSummary[];
  csrfToken: string;
  canMutate: boolean;
  admitted: boolean;
  refreshToken: number;
  onChanged: () => void;
}) {
  const [choices, setChoices] = useState<ExecutionScopeChoice[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: journal events and commands explicitly refresh this projection.
  useEffect(() => {
    let alive = true;
    void loadExecutionScopes(workspaceId, workItemId)
      .then((r) => {
        if (alive) setChoices(r.choices);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load execution scopes.');
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, workItemId, refreshToken]);
  const command = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scope operation failed.');
    } finally {
      setBusy(false);
    }
  };
  if (!choices.length && !error) return null;
  return (
    <section className="panel" aria-label="Execution slices and parent acceptance">
      <h2>Execution slices and parent acceptance</h2>
      <p>
        Slice merges leave this work item incomplete. Verification and an independent parent
        acceptance review must cover every required slice and the original exit gate.
      </p>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {!admitted && <p className="hint">Admit the parent before creating an execution worktree.</p>}
      {choices.map((choice) => (
        <article className="import-binding" key={executionScopeKey(choice.scope)}>
          <h3>
            {choice.scope.sourceId} · {choice.title}
          </h3>
          <p>
            <strong>
              {
                {
                  'not-started': 'Not started',
                  prepared: 'Worktree prepared',
                  started: 'Execution started',
                  merged: 'Slice merged — verification pending',
                  verified: 'Slice verified',
                  accepted: 'Parent accepted',
                }[choice.status]
              }
            </strong>
          </p>
          <p>{choice.description}</p>
          {choice.excludes.length > 0 && (
            <details>
              <summary>Excluded from this slice</summary>
              <ul>
                {choice.excludes.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          {choice.blockers.length > 0 && (
            <details open>
              <summary>Requirements before execution ({choice.blockers.length})</summary>
              <ul>
                {choice.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="hint">
            Map binding revision {choice.scope.bindingRevision}. This selection does not approve
            decisions or external effects.
          </p>
          <button
            type="button"
            disabled={
              busy ||
              !canMutate ||
              !admitted ||
              !choice.repositoryId ||
              !!choice.blockers.length ||
              choice.status === 'accepted'
            }
            onClick={() =>
              void command(() =>
                createWorktree(
                  workspaceId,
                  workItemId,
                  {
                    repositoryId: choice.repositoryId as SourceRepositoryId,
                    executionScope: choice.scope,
                  },
                  csrfToken,
                ),
              )
            }
          >
            {choice.scope.kind === 'slice'
              ? 'Create slice worktree'
              : 'Create parent acceptance review'}
          </button>
          {choice.scope.kind === 'slice' && ['merged', 'verified'].includes(choice.status) && (
            <button
              type="button"
              disabled={
                busy || !canMutate || !admitted || !choice.repositoryId || !!choice.blockers.length
              }
              onClick={() =>
                void command(() =>
                  createWorktree(
                    workspaceId,
                    workItemId,
                    {
                      repositoryId: choice.repositoryId as SourceRepositoryId,
                      executionScope: { ...choice.scope, kind: 'slice-verification' },
                    },
                    csrfToken,
                  ),
                )
              }
            >
              Create fresh verification review
            </button>
          )}
          {worktrees
            .filter(
              (t) =>
                t.executionScope?.definitionId === choice.scope.definitionId &&
                t.executionScope.bindingRevision === choice.scope.bindingRevision &&
                t.executionScope.sourceId === choice.scope.sourceId &&
                (t.mergedAt || (t.status === 'active' && t.executionScope.kind !== 'slice')),
            )
            .map((tree) => (
              <p key={tree.id}>
                <code>{tree.branchName}</code>{' '}
                <button
                  type="button"
                  disabled={busy || !canMutate || !admitted || !!choice.blockers.length}
                  onClick={() =>
                    void command(() =>
                      recordScopeEvidence(workspaceId, tree.id, tree.version, csrfToken),
                    )
                  }
                >
                  {choice.scope.kind === 'parent-acceptance'
                    ? 'Accept parent after review'
                    : 'Record slice verification'}
                </button>
              </p>
            ))}
          {choice.scope.kind === 'parent-acceptance' && (
            <p className="hint">
              Launch a review run in the acceptance worktree below. After acceptance, remove its
              unused review worktree before plan finalization.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
