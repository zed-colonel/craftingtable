import type {
  ExecutionScopeChoice,
  ExecutionScopeChoices,
  WorktreeSummary,
} from '@craftingtable/contracts';
import {
  executionScopeKey,
  PHASE_BLOCKERS,
  type CycleView,
  type SourceRepositoryId,
  type WorktreeId,
  type WorkItemId,
  type WorkItemStatus,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { blockerDestination } from '../../lib/blocker-destinations.js';
import { Reasons } from '../../components/Reasons.js';
import { Section } from '../../components/Section.js';
import { CheckpointPreparation } from '../../decisions/checkpoint/CheckpointPreparation.js';
import { createWorktree } from '../../lib/execution-api.js';
import { AuthorizeEarlyDevelopment } from '../../decisions/early-development/AuthorizeEarlyDevelopment.js';
import { RecordScopeEvidence } from '../../decisions/scope-evidence/RecordScopeEvidence.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import { nextPhaseOf, sliceAnchor } from '../planning/SliceStrip.js';

const PHASE_TITLES = {
  start: 'Start development',
  merge: 'Merge into integration',
  verify: 'Verify merged slice',
  accept: 'Accept parent',
} as const;

export function ExecutionScopesPanel({
  workspaceId,
  workItemId,
  worktrees,
  csrfToken,
  canMutate,
  itemStatus,
  onChanged,
  cycles: views = [],
  scopes,
  loadError,
  onOpenCycle,
  decisionItemFor,
}: {
  /** The item's slices and their phase readiness, read with its page region (R-D5). */
  scopes: ExecutionScopeChoices | undefined;
  /** Why the region could not be read; the slices last read stay shown. */
  loadError?: unknown;
  /** The work item's cycles as the daemon read them: each record beside its projection. */
  cycles?: readonly CycleView[];
  /** The open inbox item that carries a worktree's merge: its checkpoint is decided there (R-A6). */
  decisionItemFor?: (worktreeId: string) => string | undefined;
  onOpenCycle?: (id: WorktreeId) => void;
  workspaceId: WorkspaceId;
  workItemId: WorkItemId;
  worktrees: readonly WorktreeSummary[];
  csrfToken: string;
  canMutate: boolean;
  itemStatus: WorkItemStatus;
  onChanged: () => void;
}) {
  // The daemon's rule (execution-service createWorktree): scoped work needs an admitted or
  // completed parent. A completed parent still takes fresh verification and acceptance when
  // its evidence goes stale, for example after a decision is approved.
  const admitted = itemStatus === 'admitted' || itemStatus === 'completed';
  const cycles = views.map((view) => view.cycle);
  const reviewWait = (id: string) =>
    views.find((view) => view.cycle.id === id)?.projection.scopeReviewWait;
  // Read with the item's region, again on its events and after its commands (R-D5).
  const choices: readonly ExecutionScopeChoice[] = scopes?.choices ?? [];
  const [busy, setBusy] = useState(false),
    [commandError, setError] = useState<string>();
  const error =
    commandError ??
    (loadError !== undefined
      ? loadError instanceof Error
        ? loadError.message
        : 'Could not load execution scopes.'
      : undefined);
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
          approve scheduling proposals or external effects.
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
        const next = nextPhaseOf(choice);
        const phaseBlock = (p: ExecutionScopeChoice['phases'][number]) => (
          <div key={p.phase}>
            <h4>{p.phase === next ? `Next: ${PHASE_TITLES[p.phase]}` : PHASE_TITLES[p.phase]}</h4>
            <Reasons
              reasons={p.blockers.map((b) => {
                const destination = blockerDestination(b.code, workspaceId, {
                  definitionId: choice.scope.definitionId,
                  roadmapId: cycles.find(
                    (c) =>
                      c.executionScope?.definitionId === choice.scope.definitionId &&
                      c.owner?.roadmapId !== undefined,
                  )?.owner?.roadmapId,
                });
                return {
                  kind: b.kind,
                  text: b.message,
                  owner: PHASE_BLOCKERS[b.code].owner,
                  ...(destination ? { destination } : {}),
                };
              })}
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
        );
        const verificationCycle =
          verificationTree &&
          cycles.find(
            (entry) => entry.worktreeId === verificationTree.id && entry.status !== 'stopped',
          );
        return (
          <article
            className="import-binding"
            key={executionScopeKey(choice.scope)}
            id={sliceAnchor(choice.scope)}
          >
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
              </strong>{' '}
              <span className="hint">· map binding revision {choice.scope.bindingRevision}</span>
            </p>
            <p>{choice.description}</p>
            {choice.followUps && (
              <details>
                <summary>Verification follow-ups ({choice.followUps.length})</summary>
                <p className="hint">
                  Minor and nit findings the verification kept open as follow-up work (R-C7 D7).
                </p>
                {choice.followUps.map((f) => (
                  <article key={f.id} className="review-finding">
                    <h4>
                      {f.id} · {f.severity} · {f.title}
                    </h4>
                    <p>{f.explanation}</p>
                    <p>Suggested change: {f.recommendation}</p>
                  </article>
                ))}
              </details>
            )}
            {choice.excludes.length > 0 && (
              <details>
                <summary>Excluded from this slice</summary>
                <ul>
                  {distinct(choice.excludes).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
            {choice.phases.filter((p) => p.phase === next).map(phaseBlock)}
            {choice.phases.some((p) => p.phase !== next) && (
              <details>
                <summary>
                  {next === undefined
                    ? 'Transition requirements and reservations'
                    : `Other phases (${choice.phases.filter((p) => p.phase !== next).length})`}
                </summary>
                {choice.phases.filter((p) => p.phase !== next).map(phaseBlock)}
              </details>
            )}
            {existing &&
              choice.scope.kind === 'slice' &&
              choice.phases.some(
                (p) =>
                  p.phase === 'merge' &&
                  p.blockers.some((b) =>
                    ['checkpoint-evidence', 'decision-checkpoint-evidence'].includes(b.code),
                  ),
              ) &&
              (decisionItemFor?.(existing.id) ? (
                <p className="attention-banner" role="status">
                  This checkpoint is decided in Needs you.{' '}
                  <Link
                    route={{
                      name: 'inbox',
                      workspaceId,
                      itemId: decisionItemFor(existing.id)!,
                    }}
                  >
                    Open the decision
                  </Link>
                </p>
              ) : (
                <CheckpointPreparation
                  workspaceId={workspaceId}
                  definitionId={choice.scope.definitionId}
                  worktreeId={existing.id}
                  csrfToken={csrfToken}
                  canMutate={canMutate}
                  onChanged={onChanged}
                />
              ))}
            {choice.earlyDevelopment && (
              <p className="hint">
                {choice.earlyDevelopmentAuthorized
                  ? 'Early development authorized for this exact slice binding. Original predecessor acceptance still applies to the parent.'
                  : 'The imported early-development exception has not been authorized.'}
              </p>
            )}
            {choice.canAuthorizeEarlyDevelopment && !choice.earlyDevelopmentAuthorized && (
              <AuthorizeEarlyDevelopment
                workspaceId={workspaceId}
                workItemId={workItemId}
                scope={choice.scope}
                csrfToken={csrfToken}
                disabled={busy || !canMutate}
                onAuthorized={onChanged}
              />
            )}
            {existing && onOpenCycle && (choice.scope.kind === 'slice' || cycle) ? (
              <div className="stack">
                {cycle && <p role="status">{reviewWait(cycle.id) ?? cycle.reason}</p>}
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
                    A verification worktree exists. Reviewing again reuses its clean snapshot,
                    updated from integration, and keeps the assigned reviewer and prior evidence.
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
                  <RecordScopeEvidence
                    workspaceId={workspaceId}
                    worktree={tree}
                    parentAcceptance={choice.scope.kind === 'parent-acceptance'}
                    csrfToken={csrfToken}
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
                    onRecorded={onChanged}
                  />
                </p>
              ))}
            {/* It points at the acceptance worktree, so only once there is one (R-E4). */}
            {choice.scope.kind === 'parent-acceptance' && existing && (
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
