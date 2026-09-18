import type { ExecutionScopeChoice, WorktreeSummary } from '@craftingtable/contracts';
import {
  executionScopeKey,
  type SourceRepositoryId,
  type WorkCycle,
  type WorktreeId,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { Reasons } from '../../components/Reasons.js';
import { Section } from '../../components/Section.js';
import { createWorktree } from '../../lib/execution-api.js';
import {
  authorizeScopeScheduling,
  loadExecutionScopes,
  recordScopeEvidence,
} from '../../lib/execution-scope-api.js';

export function ExecutionScopesPanel({
  workspaceId,
  workItemId,
  worktrees,
  csrfToken,
  canMutate,
  admitted,
  refreshToken,
  onChanged,
  cycles = [],
  onOpenCycle,
}: {
  cycles?: readonly WorkCycle[];
  onOpenCycle?: (id: WorktreeId) => void;
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
    <Section
      id="slices"
      title="Execution slices and parent acceptance"
      count={choices.length}
      summary={
        choices.length === 0
          ? undefined
          : `${choices.filter((c) => c.status === 'verified' || c.status === 'accepted').length} of ${choices.length} scopes verified or accepted.`
      }
    >
      <About label="About slices and parent acceptance">
        <p>
          Slice merges leave this work item incomplete. Verification and an independent parent
          acceptance review must cover every required slice and the original exit gate.
        </p>
        <p>
          Development and verification use separate admission slots. A reservation coordinates
          daemon work; it is not evidence of isolation or a test pass. Selecting a slice does not
          approve map decisions or external effects.
        </p>
      </About>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {!admitted && <p className="hint">Admit the parent before creating an execution worktree.</p>}
      {choices.map((choice) => {
        const existing = worktrees.find(
          (tree) =>
            tree.status === 'active' &&
            tree.executionScope &&
            executionScopeKey(tree.executionScope) === executionScopeKey(choice.scope),
        );
        const cycle =
          existing &&
          cycles.find(
            (entry) =>
              entry.worktreeId === existing.id && !['stopped', 'completed'].includes(entry.status),
          );
        const verificationTree =
          choice.scope.kind === 'slice'
            ? worktrees.find(
                (tree) =>
                  tree.status === 'active' &&
                  tree.executionScope &&
                  executionScopeKey(tree.executionScope) ===
                    executionScopeKey({ ...choice.scope, kind: 'slice-verification' }),
              )
            : undefined;
        const verificationCycle =
          verificationTree &&
          cycles.find(
            (entry) => entry.worktreeId === verificationTree.id && entry.status !== 'stopped',
          );
        return (
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
            <details open={choice.phases.some((p) => p.blockers.length > 0)}>
              <summary>Transition requirements and reservations</summary>
              {choice.phases.map((p) => (
                <div key={p.phase}>
                  <h4>
                    {
                      {
                        start: 'Start development',
                        merge: 'Merge into integration',
                        verify: 'Verify merged slice',
                        accept: 'Accept parent',
                      }[p.phase]
                    }
                  </h4>
                  <Reasons
                    reasons={p.blockers.map((b) => ({ kind: b.kind, text: b.message }))}
                    satisfied="Phase requirements satisfied; current review and branch checks still apply."
                  />
                  {p.resources.map((r) => (
                    <p key={r.key} className="hint">
                      <code>{r.key}</code>: {r.capacity} admission slot(s).
                    </p>
                  ))}
                  {p.reservations
                    .filter((r) => r.phase === p.phase)
                    .map((r) => (
                      <p key={r.id}>
                        <code>{r.resourceKey}</code> reserved since{' '}
                        {new Date(r.acquiredAt).toLocaleString()} (capacity {r.capacity}).
                      </p>
                    ))}
                </div>
              ))}
            </details>
            {choice.earlyDevelopment && (
              <p className="hint">
                {choice.earlyDevelopmentAuthorized
                  ? 'Early development authorized for this exact slice binding. Original predecessor acceptance still applies to the parent.'
                  : 'The imported early-development exception has not been authorized.'}
              </p>
            )}
            {choice.canAuthorizeEarlyDevelopment && !choice.earlyDevelopmentAuthorized && (
              <button
                type="button"
                disabled={busy || !canMutate}
                onClick={() =>
                  void command(() =>
                    authorizeScopeScheduling(workspaceId, workItemId, choice.scope, csrfToken),
                  )
                }
              >
                Authorize this slice’s early-development rule
              </button>
            )}
            <p className="hint">Map binding revision {choice.scope.bindingRevision}.</p>
            {existing && onOpenCycle && (choice.scope.kind === 'slice' || cycle) ? (
              <div className="stack">
                {cycle && <p role="status">{cycle.reason}</p>}
                <button type="button" onClick={() => onOpenCycle(existing.id)}>
                  {cycle?.step === 'design' && ['paused', 'needs-attention'].includes(cycle.status)
                    ? 'Open cycle to resolve design questions'
                    : choice.scope.kind === 'parent-acceptance'
                      ? 'Open parent acceptance recovery'
                      : 'Open existing slice cycle'}
                </button>
              </div>
            ) : (
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
            )}
            {choice.scope.kind === 'slice' &&
              ['merged', 'verified'].includes(choice.status) &&
              (verificationTree ? (
                <div className="stack">
                  <p className="hint">
                    A verification worktree already exists. Review again reuses its clean snapshot,
                    updates it from integration, and retains the assigned reviewer and previous
                    evidence.
                  </p>
                  <button
                    type="button"
                    disabled={busy || !onOpenCycle}
                    onClick={() => onOpenCycle?.(verificationTree.id)}
                  >
                    {verificationCycle?.status === 'completed'
                      ? 'Review again with existing verification cycle'
                      : verificationCycle
                        ? 'Open verification recovery'
                        : 'Open existing verification worktree'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={
                    busy ||
                    !canMutate ||
                    !admitted ||
                    !choice.repositoryId ||
                    !!choice.phases.find((p) => p.phase === 'verify')?.blockers.length
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
                  Create verification worktree
                </button>
              ))}
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
                  {onOpenCycle &&
                    cycles.some(
                      (c) =>
                        c.worktreeId === tree.id && !['completed', 'stopped'].includes(c.status),
                    ) && (
                      <button type="button" onClick={() => onOpenCycle(tree.id)}>
                        Open review cycle
                      </button>
                    )}
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !canMutate ||
                      !admitted ||
                      !!choice.phases.find(
                        (p) =>
                          p.phase ===
                          (choice.scope.kind === 'parent-acceptance' ? 'accept' : 'verify'),
                      )?.blockers.length
                    }
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
        );
      })}
    </Section>
  );
}
