import { ProviderRetry } from '../../decisions/cycle/CycleDecisions.js';
import type {
  AgentRunDetailResponse,
  ExecutionStatusResponse,
  FinalizationView,
  StartFinalizationRequest,
  WorktreeDiffResponse,
} from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  type AgentRunId,
  DEFAULT_COMPLETION_POLICY,
  type PlanVersionId,
  remediationAllowance,
  remediationUsed,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { loadPlanBranchSettings } from '../../lib/branch-api.js';
import {
  loadExecutionStatus,
  loadRun,
  loadRunProfiles,
  loadWorktreeDiff,
} from '../../lib/execution-api.js';
import {
  controlFinalization,
  type FinalizationControl,
  loadFinalizations,
  startFinalization,
} from '../../lib/finalization-api.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import { CYCLE_STATUS_LABELS } from './CyclePanel.js';
import { DiffView } from './DiffView.js';
import { FinalizationStageProgress } from './FinalizationStageProgress.js';
import { defaultFinalizationStages, FinalizationStageSetup } from './FinalizationStageSetup.js';
import { FinalPromotion } from '../../decisions/finalization/FinalPromotion.js';
import { Link } from '../../lib/navigation.js';
import { FinalizationStep } from '../../decisions/finalization/FinalizationStep.js';
import { IntegrationConflict } from '../../decisions/integration/IntegrationConflict.js';
import { ReviewFindings } from './ReviewFindings.js';
import { RunCompletionIssue, RunOutcome } from './RunOutcome.js';
import {
  WorktreeChangesRefusal,
  type WorktreeChangesRefused,
  worktreeChangesRefused,
} from './WorktreeChangesRefusal.js';

export function FinalizationPanel({
  workspaceId,
  planVersionId,
  csrfToken,
  canMutate,
  onOpenRun,
  decisionItemFor,
}: {
  workspaceId: WorkspaceId;
  planVersionId: PlanVersionId;
  csrfToken: string;
  canMutate: boolean;
  onOpenRun: (id: AgentRunId) => void;
  /** The open inbox item that carries a finalization's stop, outside the inbox (R-A6). */
  decisionItemFor?: (finalizationId: string, cycleId: string) => string | undefined;
}) {
  // The plan's finalizations follow their cycles', runs', worktrees' and branches' events, and
  // the branch settings, read from Git, also the visible tab's minute (R-D4).
  const store = useQueryStore();
  const finalizationsKey = queryKeys.finalizations(workspaceId, planVersionId);
  const branchesKey = queryKeys.planBranches(workspaceId, planVersionId);
  const finalizations = useQuery(finalizationsKey, () =>
    loadFinalizations(workspaceId, planVersionId),
  );
  const branchSettings = useQuery(branchesKey, () =>
    loadPlanBranchSettings(workspaceId, planVersionId),
  );
  const views = finalizations.data?.finalizations ?? [];
  const settings = branchSettings.data;
  /** After a command: the plan's finalizations and branches are read again at once. */
  const reload = () => store.refreshNow([finalizationsKey, branchesKey]);
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  const [draft, setDraft] = useState<StartFinalizationRequest>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commandError, setError] = useState<string>();
  const loadFailure = finalizations.error ?? branchSettings.error;
  const error =
    commandError ??
    (loadFailure === undefined
      ? undefined
      : loadFailure instanceof Error
        ? loadFailure.message
        : 'Could not load finalization.');
  const [removalRefused, setRemovalRefused] = useState<
    WorktreeChangesRefused & { readonly finalizationId: string }
  >();
  const [diff, setDiff] = useState<WorktreeDiffResponse>();
  useEffect(() => {
    let active = true;
    void Promise.all([loadExecutionStatus(), loadRunProfiles(workspaceId)])
      .then(([status, profiles]) => {
        if (!active) return;
        setBackends(status.backends);
        const fallback = {
          backend: status.backends.find((b) => b.available)?.kind ?? ('claude-code' as const),
          permissionMode: 'auto' as const,
        };
        const review = profiles.profiles.find((p) => p.role === 'review');
        const implement = profiles.profiles.find((p) => p.role === 'implement');
        const {
          role: _r,
          stored: _rs,
          ...reviewProfile
        } = review ?? { role: 'review', stored: false, ...fallback };
        const {
          role: _i,
          stored: _is,
          ...polishProfile
        } = implement ?? { role: 'implement', stored: false, ...fallback };
        setDraft({
          expectedBranchVersion: 1,
          targetBranch: 'main',
          // New finalizations are staged; legacy improvement rounds are retired (R-B10).
          rounds: [],
          stages: defaultFinalizationStages(reviewProfile, polishProfile),
          finalReview: reviewProfile,
          policy: { ...DEFAULT_COMPLETION_POLICY, maxNits: 0 },
          instructions: '',
        });
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not load agent profiles.');
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Finalization command failed.');
      reload();
    } finally {
      setBusy(false);
    }
  };
  const command = (view: FinalizationView, action: FinalizationControl['action']) =>
    perform(async () => {
      await controlFinalization(
        workspaceId,
        view.finalization.id,
        {
          action,
          expectedVersion: view.finalization.version,
          expectedCycleVersion: view.cycle?.version,
        },
        csrfToken,
      );
    });
  /** Removal never discards uncommitted work unless the operator chooses to after a refusal. */
  const removeWorktree = (view: FinalizationView, discardChanges = false) =>
    perform(async () => {
      setRemovalRefused(undefined);
      try {
        await controlFinalization(
          workspaceId,
          view.finalization.id,
          {
            action: 'remove-worktree',
            expectedVersion: view.finalization.version,
            expectedCycleVersion: view.cycle?.version,
            ...(discardChanges ? { discardChanges: true } : {}),
          },
          csrfToken,
        );
      } catch (e) {
        const refused = worktreeChangesRefused(e);
        if (refused !== undefined)
          setRemovalRefused({ ...refused, finalizationId: view.finalization.id });
        throw e;
      }
    });
  const live = views.some((v) => ['preparing', 'active'].includes(v.finalization.status));
  const current =
    views.find((v) => ['preparing', 'active'].includes(v.finalization.status)) ?? views[0];
  const attention =
    current?.cycle !== undefined &&
    ['needs-attention', 'awaiting-merge'].includes(current.cycle.status);
  const summary =
    current === undefined
      ? settings?.settings
        ? 'Not started.'
        : 'Configure Repository & branches before finalizing.'
      : current.finalization.status === 'completed'
        ? `Promoted into ${current.finalization.targetBranch}.`
        : current.finalization.status === 'stopped'
          ? 'Stopped.'
          : current.cycle
            ? `${CYCLE_STATUS_LABELS[current.cycle.status]} · ${current.finalization.integrationBranch} → ${current.finalization.targetBranch}`
            : 'Preparation needs completion.';
  return (
    <Section
      id="finalization"
      title="Finalize integration"
      summary={summary}
      {...(attention ? { tone: 'attention' as const } : {})}
      actions={
        canMutate && !live && !editing ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !settings?.settings || !draft}
            onClick={() => setEditing(true)}
          >
            Set up finalization
          </button>
        ) : undefined
      }
    >
      <About label="About finalization">
        <p>
          Review conformance against the entire plan, simplify and polish in a dedicated branch,
          then approve the final merge yourself. All plan items must have integration evidence
          before starting. Further merges into this integration branch are held until finalization
          finishes or stops.
        </p>
      </About>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {editing && draft && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            const branchVersion = settings?.settings?.version;
            if (branchVersion)
              void perform(async () => {
                await startFinalization(
                  workspaceId,
                  planVersionId,
                  {
                    ...draft,
                    expectedBranchVersion: branchVersion,
                    rounds: [],
                    stages: (draft.stages ?? []).map((s) => ({
                      ...s,
                      requiredChecks: [
                        ...new Set(s.requiredChecks.map((c) => c.trim()).filter(Boolean)),
                      ],
                    })),
                  },
                  csrfToken,
                );
                setEditing(false);
              });
          }}
        >
          <p>
            Source: <code>{settings?.settings?.integrationBranch}</code> · Scope: whole plan version{' '}
            <code>{planVersionId}</code>
          </p>
          <label className="field">
            Final destination branch
            <input
              required
              maxLength={255}
              value={draft.targetBranch}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, targetBranch: e.target.value })}
            />
          </label>
          <FinalizationStageSetup
            stages={draft.stages ?? []}
            onChange={(stages) => setDraft({ ...draft, stages })}
            backends={backends}
            disabled={busy}
          />
          <label className="field">
            Common finalization instructions
            <textarea
              maxLength={16000}
              value={draft.instructions}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            />
          </label>
          <div className="inline-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              Start finalization
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel setup
            </button>
          </div>
        </form>
      )}
      {views.map((view) => {
        const f = view.finalization;
        const cycle = view.cycle;
        const latest = view.runs.find((r) => r.id === cycle?.currentRunId);
        // An open item carries this finalization's stop: its next step is decided there (R-A6).
        const decided = decisionItemFor?.(f.id, f.cycleId);
        return (
          <section className="panel" key={f.id} aria-label="Finalization attempt">
            <h3>
              {f.integrationBranch} → {f.targetBranch}
            </h3>
            <p>
              <strong>
                {f.status === 'completed'
                  ? 'Promoted by operator'
                  : f.status === 'stopped'
                    ? 'Stopped'
                    : cycle
                      ? CYCLE_STATUS_LABELS[cycle.status]
                      : 'Preparation needs completion'}
              </strong>
              {cycle && !f.stages && (
                <>
                  {' '}
                  · {cycle.polishPhase} · {Math.min((cycle.polishRound ?? 0) + 1, f.rounds.length)}{' '}
                  of {f.rounds.length} improvement rounds
                </>
              )}
            </p>
            <p role="status">{f.status === 'completed' ? f.reason : (cycle?.reason ?? f.reason)}</p>
            <p style={{ overflowWrap: 'anywhere' }}>
              Integration snapshot <code>{f.integrationSha}</code>
              <br />
              Candidate <code>{view.worktree?.branchName ?? 'Preparing'}</code>
            </p>
            {cycle && (
              <p>
                {remediationUsed(cycle)} of {remediationAllowance(cycle)} remediation attempts used{' '}
                {f.stages ? 'in this stage' : 'across this finalization'}.
                {f.stages && ` Lifetime total: ${cycle.remediationRounds}.`}
              </p>
            )}
            {f.mapContext && (
              <p>
                Frozen cross-project context: binding {f.mapContext.bindingRevision} · runtime{' '}
                <code>{f.mapContext.runtimeId}</code>. Changed pins require reconciliation and a new
                finalization.
              </p>
            )}
            <FinalizationStageProgress view={view} />
            {cycle && (
              <ProviderRetry
                cycle={cycle}
                csrfToken={csrfToken}
                disabled={busy || !canMutate}
                onChanged={reload}
                onPause={() => void command(view, 'pause')}
              />
            )}

            {cycle?.finalizationAgentOverride && (
              <p>
                Remaining finalization runs:{' '}
                {AGENT_BACKEND_LABELS[cycle.finalizationAgentOverride.backend]} ·{' '}
                {cycle.finalizationAgentOverride.model ?? 'Backend default'}.
              </p>
            )}
            <div className="inline-actions">
              {latest && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onOpenRun(latest.id)}
                >
                  Open current run
                </button>
              )}
              {view.worktree?.status === 'active' && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      setDiff(await loadWorktreeDiff(workspaceId, f.worktreeId)),
                    )
                  }
                >
                  View complete candidate diff
                </button>
              )}
              {canMutate && ['active', 'preparing'].includes(f.status) && (
                <>
                  {cycle && ['running', 'awaiting-merge'].includes(cycle.status) && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void command(view, 'pause')}
                    >
                      Pause finalization
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary-button danger"
                    disabled={busy}
                    onClick={() => void command(view, 'stop')}
                  >
                    Stop finalization
                  </button>
                </>
              )}
              {canMutate && f.status === 'stopped' && view.worktree?.status === 'active' && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void removeWorktree(view)}
                >
                  Remove stopped finalization worktree
                </button>
              )}
              {canMutate &&
                removalRefused?.finalizationId === f.id &&
                view.worktree?.status === 'active' && (
                  <WorktreeChangesRefusal
                    refused={removalRefused}
                    busy={busy}
                    onDiscard={() => void removeWorktree(view, true)}
                    onKeep={() => {
                      setRemovalRefused(undefined);
                      setError(undefined);
                    }}
                  />
                )}
            </div>
            {f.status === 'completed' && (
              <fieldset className="stack-form">
                <legend>Integration branch cleanup</legend>
                {f.integrationCleanup?.status === 'removed' ? (
                  <p>
                    Local integration branch <code>{f.integrationBranch}</code> removed. Merged
                    commits and plan history are retained.
                  </p>
                ) : (
                  <>
                    <p style={{ overflowWrap: 'anywhere' }}>
                      Remove local branch <code>{f.integrationBranch}</code> at the recorded
                      snapshot <code>{f.integrationSha}</code>. Its commits remain in{' '}
                      <code>{f.targetBranch}</code>. Remote branches are unaffected.
                    </p>
                    {f.integrationCleanup?.status === 'pending' && (
                      <p role="status">
                        Promotion completed. Branch cleanup was requested and needs to be retried.
                      </p>
                    )}
                    {f.integrationCleanup?.error && (
                      <p role="status" className="error-state">
                        Promotion completed. Branch retained: {f.integrationCleanup.error}
                      </p>
                    )}
                    {canMutate && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void command(view, 'remove-integration-branch')}
                      >
                        {f.integrationCleanup
                          ? 'Retry integration branch cleanup'
                          : `Remove integration branch ${f.integrationBranch}`}
                      </button>
                    )}
                  </>
                )}
              </fieldset>
            )}
            {view.worktree?.mergeCleanupError && (
              <div className="error-state" role="status">
                <p>
                  Promotion succeeded. Cleanup needs attention: {view.worktree.mergeCleanupError}
                </p>
                {canMutate && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void command(view, 'retry-cleanup')}
                  >
                    Retry worktree cleanup
                  </button>
                )}
              </div>
            )}
            {canMutate &&
              (decided ? (
                <p className="attention-banner" role="status">
                  This finalization's next step is decided in Needs you.{' '}
                  <Link route={{ name: 'inbox', workspaceId, itemId: decided }}>
                    Open the decision
                  </Link>
                </p>
              ) : (
                <>
                  <FinalPromotion
                    workspaceId={workspaceId}
                    view={view}
                    csrfToken={csrfToken}
                    disabled={busy}
                    onDone={reload}
                  />
                  <FinalizationStep
                    key={`${f.id}:${cycle?.version}`}
                    workspaceId={workspaceId}
                    view={view}
                    csrfToken={csrfToken}
                    disabled={busy}
                    backends={backends}
                    onDone={reload}
                  />
                </>
              ))}
            {cycle && f.status === 'active' && (
              <IntegrationConflict
                cycle={cycle}
                backends={backends}
                disabled={busy}
                canMutate={canMutate}
                csrfToken={csrfToken}
                onChanged={reload}
                onOpenRun={onOpenRun}
                runIds={view.runs.map((r) => r.id)}
              />
            )}
            {latest && (
              <FinalizationOutcome
                key={latest.id}
                workspaceId={workspaceId}
                runId={latest.id}
                version={latest.version}
              />
            )}
            {!!cycle?.deferredNits?.length && (
              <details>
                <summary>Deferred nits ({cycle.deferredNits.length})</summary>
                <p>
                  Finding dispositions for the recorded commits. Findings remain open follow-up
                  work; changed commits or finding details invalidate an exemption.
                </p>
                {cycle.deferredNits.map((d) => (
                  <article key={d.finding.id}>
                    <strong>
                      {d.finding.id} · {d.finding.title}
                    </strong>
                    <p>{d.reason}</p>
                    <small>
                      Candidate {d.headSha.slice(0, 8)} · destination {d.targetSha.slice(0, 8)} ·{' '}
                      {d.createdAt}
                    </small>
                  </article>
                ))}
              </details>
            )}
            <details>
              <summary>Pass settings and run history</summary>
              {!f.stages && (
                <p>
                  Zero blocking, major or minor findings; up to {f.policy.maxNits} nits. Remediation
                  allowance: {cycle ? remediationAllowance(cycle) : f.policy.maxRemediationRounds}
                  {cycle?.additionalRemediationRounds
                    ? ` (${f.policy.maxRemediationRounds} initial + ${cycle.additionalRemediationRounds} authorized)`
                    : ''}
                  .
                </p>
              )}
              <pre className="roadmap-instructions">
                {JSON.stringify(
                  {
                    stages: f.stages,
                    rounds: f.rounds,
                    finalReview: f.finalReview,
                    instructions: f.instructions,
                    agentOverride: cycle?.finalizationAgentOverride ?? null,
                  },
                  null,
                  2,
                )}
              </pre>
              <ol>
                {view.runs.toReversed().map((r) => (
                  <li key={r.id}>
                    <button type="button" className="text-button" onClick={() => onOpenRun(r.id)}>
                      {r.role} · {r.resolvedModel ?? r.model ?? 'Backend default'} · {r.status}
                    </button>
                  </li>
                ))}
              </ol>
            </details>
            {diff?.worktree.id === f.worktreeId && (
              <>
                <button type="button" className="text-button" onClick={() => setDiff(undefined)}>
                  Close candidate diff
                </button>
                <DiffView diff={diff} />
              </>
            )}
          </section>
        );
      })}
    </Section>
  );
}
function FinalizationOutcome({
  workspaceId,
  runId,
  version,
}: {
  workspaceId: WorkspaceId;
  runId: AgentRunId;
  version: number;
}) {
  const [detail, setDetail] = useState<AgentRunDetailResponse>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the persisted outcome when this run advances.
  useEffect(() => {
    let active = true;
    void loadRun(workspaceId, runId)
      .then((d) => {
        if (active) setDetail(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [workspaceId, runId, version]);
  return (
    <>
      <RunCompletionIssue issue={detail?.completionIssue} />
      {detail?.latestOutcome && (
        <RunOutcome
          outcome={detail.latestOutcome}
          finished={detail.run.status === 'finished'}
          assessment={detail.reviewReport}
        />
      )}
      {detail?.reviewReport && <ReviewFindings assessment={detail.reviewReport} />}
    </>
  );
}
