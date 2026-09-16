import type {
  AgentRunDetailResponse,
  ControlFinalizationRequest,
  ExecutionStatusResponse,
  FinalizationView,
  PlanBranchSettingsResponse,
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
import { loadPlanBranchSettings } from '../../lib/branch-api.js';
import {
  loadExecutionStatus,
  loadRun,
  loadRunProfiles,
  loadWorktreeDiff,
} from '../../lib/execution-api.js';
import {
  controlFinalization,
  loadFinalizations,
  startFinalization,
} from '../../lib/finalization-api.js';
import { resolveIntegration } from '../../lib/work-cycle-api.js';
import { AgentProfileFields } from './AgentProfileFields.js';
import { CYCLE_STATUS_LABELS } from './CyclePanel.js';
import { DiffView } from './DiffView.js';
import { FinalizationStageDecision } from './FinalizationStageDecision.js';
import { FinalizationStageProgress } from './FinalizationStageProgress.js';
import { defaultFinalizationStages, FinalizationStageSetup } from './FinalizationStageSetup.js';
import { IntegrationResolutionPanel } from './IntegrationResolutionPanel.js';
import { ReviewFindings } from './ReviewFindings.js';
import { RunCompletionIssue, RunOutcome } from './RunOutcome.js';

export function FinalizationPanel({
  workspaceId,
  planVersionId,
  csrfToken,
  canMutate,
  onOpenRun,
}: {
  workspaceId: WorkspaceId;
  planVersionId: PlanVersionId;
  csrfToken: string;
  canMutate: boolean;
  onOpenRun: (id: AgentRunId) => void;
}) {
  const [views, setViews] = useState<FinalizationView[]>([]);
  const [settings, setSettings] = useState<PlanBranchSettingsResponse>();
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  const [draft, setDraft] = useState<StartFinalizationRequest>();
  const [editing, setEditing] = useState(false);
  const [roundKeys] = useState(() => Array.from({ length: 10 }, () => crypto.randomUUID()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<{
    id: string;
    head: string;
    target: string;
    version: number;
    cycleVersion: number;
    removeIntegrationBranch: boolean;
  }>();
  const [diff, setDiff] = useState<WorktreeDiffResponse>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: A completed command requests an immediate server refresh.
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const [result, branches] = await Promise.all([
          loadFinalizations(workspaceId, planVersionId),
          loadPlanBranchSettings(workspaceId, planVersionId),
        ]);
        if (active) {
          setViews(result.finalizations);
          setSettings(branches);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load finalization.');
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workspaceId, planVersionId, reload]);
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
          rounds: Array.from({ length: 2 }, () => ({
            review: reviewProfile,
            polish: polishProfile,
            instructions: '',
          })),
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
      setConfirm(undefined);
      setReload((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Finalization command failed.');
      setReload((v) => v + 1);
    } finally {
      setBusy(false);
    }
  };
  const command = (view: FinalizationView, action: ControlFinalizationRequest['action']) =>
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
  const live = views.some((v) => ['preparing', 'active'].includes(v.finalization.status));
  return (
    <section className="panel" aria-label="Finalize integration">
      <h2>Finalize integration</h2>
      <p>
        Review conformance against the entire plan, simplify and polish in a dedicated branch, then
        approve the final merge yourself. All plan items must have integration evidence before
        starting. Further merges into this integration branch are held until finalization finishes
        or stops.
      </p>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {canMutate && !live && !editing && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !settings?.settings || !draft}
          onClick={() => setEditing(true)}
        >
          Set up finalization
        </button>
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
                    ...(draft.stages
                      ? {
                          rounds: [],
                          stages: draft.stages.map((s) => ({
                            ...s,
                            requiredChecks: [
                              ...new Set(s.requiredChecks.map((c) => c.trim()).filter(Boolean)),
                            ],
                          })),
                        }
                      : {}),
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
          <label className="field">
            Finalization workflow
            <select
              value={draft.stages ? 'staged' : 'legacy'}
              disabled={busy}
              onChange={(e) => {
                const { stages: _stages, ...legacy } = draft;
                setDraft(
                  e.target.value === 'staged'
                    ? {
                        ...draft,
                        stages: defaultFinalizationStages(
                          draft.finalReview,
                          draft.rounds[0]?.polish ?? draft.finalReview,
                        ),
                      }
                    : legacy,
                );
              }}
            >
              <option value="staged">Focused stages</option>
              <option value="legacy">Legacy improvement rounds</option>
            </select>
          </label>
          {draft.stages ? (
            <FinalizationStageSetup
              stages={draft.stages}
              onChange={(stages) => setDraft({ ...draft, stages })}
              backends={backends}
              disabled={busy}
            />
          ) : (
            <>
              <label className="field">
                Improvement rounds
                <input
                  type="number"
                  required
                  min={0}
                  max={10}
                  value={draft.rounds.length}
                  disabled={busy}
                  onChange={(e) => {
                    const count = Math.min(10, Math.max(0, Number(e.target.value)));
                    setDraft({
                      ...draft,
                      rounds: Array.from(
                        { length: count },
                        (_, i) =>
                          draft.rounds[i] ?? {
                            review: draft.finalReview,
                            polish: draft.rounds[0]?.polish ?? draft.finalReview,
                            instructions: '',
                          },
                      ),
                    });
                  }}
                />
              </label>
              <p className="hint">
                Each round includes assessment, a polish pass, and independent verification. A final
                independent review always follows. Zero rounds runs only that final review. Budgets
                never waive findings or unanswered questions.
              </p>
              {draft.rounds.map((round, index) => (
                <details key={roundKeys[index]} open>
                  <summary>Round {index + 1}</summary>
                  <AgentProfileFields
                    label="Reviewer and verifier"
                    value={round.review}
                    onChange={(review) =>
                      setDraft({
                        ...draft,
                        rounds: draft.rounds.map((r, i) => (i === index ? { ...r, review } : r)),
                      })
                    }
                    backends={backends}
                    disabled={busy}
                  />
                  <AgentProfileFields
                    label="Polish agent"
                    value={round.polish}
                    onChange={(polish) =>
                      setDraft({
                        ...draft,
                        rounds: draft.rounds.map((r, i) => (i === index ? { ...r, polish } : r)),
                      })
                    }
                    backends={backends}
                    disabled={busy}
                  />
                  <label className="field">
                    Round focus
                    <textarea
                      value={round.instructions}
                      maxLength={16000}
                      disabled={busy}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          rounds: draft.rounds.map((r, i) =>
                            i === index ? { ...r, instructions: e.target.value } : r,
                          ),
                        })
                      }
                    />
                  </label>
                </details>
              ))}
              <AgentProfileFields
                label="Final independent reviewer"
                value={draft.finalReview}
                onChange={(finalReview) => setDraft({ ...draft, finalReview })}
                backends={backends}
                disabled={busy}
              />
              {(
                [
                  ['maxNits', 'Allowed final nits', 0, 100],
                  ['maxRemediationRounds', 'Initial remediation budget', 0, 20],
                  ['maxRunMinutes', 'Minutes per step', 1, 1440],
                ] as const
              ).map(([key, label, min, max]) => (
                <label key={key} className="field">
                  {label}
                  <input
                    type="number"
                    required
                    min={min}
                    max={max}
                    value={draft.policy[key]}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        policy: { ...draft.policy, [key]: Number(e.target.value) },
                      })
                    }
                  />
                </label>
              ))}
              <p className="hint">
                The initial remediation budget defaults to{' '}
                {DEFAULT_COMPLETION_POLICY.maxRemediationRounds} attempts and can be set from 0 to
                20 before starting. It belongs to this finalization, spans all improvement rounds
                and the final independent review, and is separate from scheduled polish passes. It
                is not copied from a work item or roadmap. You can authorize more attempts at a
                checkpoint.
              </p>
            </>
          )}
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
        const reviewed = latest?.reviewBranchContext;
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
                  {cycle &&
                    (cycle.status === 'awaiting-merge' || view.mergeRecoveryPending) &&
                    reviewed && (
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            id: f.id,
                            head: reviewed.headSha,
                            target: reviewed.targetSha,
                            version: f.version,
                            cycleVersion: cycle.version,
                            removeIntegrationBranch: false,
                          })
                        }
                      >
                        {view.mergeRecoveryPending
                          ? 'Recover approved promotion'
                          : 'Review final merge approval'}
                      </button>
                    )}
                </>
              )}
              {canMutate && f.status === 'stopped' && view.worktree?.status === 'active' && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void command(view, 'remove-worktree')}
                >
                  Remove stopped finalization worktree
                </button>
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
            {confirm?.id === f.id && (
              <fieldset className="stack-form">
                <legend>Approve final promotion</legend>
                <p style={{ overflowWrap: 'anywhere' }}>
                  Merge candidate <code>{confirm.head}</code> into <code>{f.targetBranch}</code> at{' '}
                  <code>{confirm.target}</code>. This requires your explicit approval and renewed
                  review if either commit changes.
                </p>
                {!view.mergeRecoveryPending && (
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={confirm.removeIntegrationBranch}
                      disabled={busy}
                      onChange={(e) =>
                        setConfirm({ ...confirm, removeIntegrationBranch: e.target.checked })
                      }
                    />
                    Remove local integration branch {f.integrationBranch} after successful promotion
                  </label>
                )}
                <p className="hint">
                  Branch removal preserves the merged commits and plan history. If the branch has
                  changed or is still in use, promotion stays completed and cleanup can be retried.
                </p>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        controlFinalization(
                          workspaceId,
                          f.id,
                          {
                            action: 'merge',
                            expectedVersion: confirm.version,
                            expectedCycleVersion: confirm.cycleVersion,
                            expectedHeadSha: confirm.head,
                            expectedTargetSha: confirm.target,
                            removeIntegrationBranch: confirm.removeIntegrationBranch,
                          },
                          csrfToken,
                        ),
                      )
                    }
                  >
                    Approve merge into {f.targetBranch}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => setConfirm(undefined)}
                  >
                    Cancel approval
                  </button>
                </div>
              </fieldset>
            )}
            {cycle && f.status === 'active' && (
              <IntegrationResolutionPanel
                cycle={cycle}
                backends={backends}
                busy={busy}
                canMutate={canMutate}
                onOpenRun={onOpenRun}
                runIds={view.runs.map((r) => r.id)}
                onCommand={(input) =>
                  void perform(() => resolveIntegration(cycle, input, csrfToken))
                }
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
                  Operator decisions for the recorded commits. Findings remain open follow-up work;
                  changed commits or finding details invalidate an exemption.
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
            {canMutate &&
              ['active', 'preparing'].includes(f.status) &&
              !view.mergeRecoveryPending &&
              (!cycle || ['paused', 'needs-attention'].includes(cycle.status)) &&
              (!cycle?.integrationResolution ||
                ['completed', 'abandoned'].includes(cycle.integrationResolution.status)) && (
                <FinalizationStageDecision
                  key={`${f.id}:${cycle?.version}`}
                  view={view}
                  busy={busy}
                  backends={backends}
                  onDecide={(input) =>
                    void perform(() => controlFinalization(workspaceId, f.id, input, csrfToken))
                  }
                />
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
    </section>
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
