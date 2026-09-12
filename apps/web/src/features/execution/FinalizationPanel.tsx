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
  DEFAULT_COMPLETION_POLICY,
  type AgentRunId,
  type PlanVersionId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import {
  controlFinalization,
  loadFinalizations,
  startFinalization,
} from '../../lib/finalization-api.js';
import { loadPlanBranchSettings } from '../../lib/branch-api.js';
import {
  loadExecutionStatus,
  loadRunProfiles,
  loadRun,
  loadWorktreeDiff,
} from '../../lib/execution-api.js';
import { resolveIntegration } from '../../lib/work-cycle-api.js';
import { AgentProfileFields } from './AgentProfileFields.js';
import { IntegrationResolutionPanel } from './IntegrationResolutionPanel.js';
import { RunOutcome } from './RunOutcome.js';
import { ReviewFindings } from './ReviewFindings.js';
import { DiffView } from './DiffView.js';
import { CYCLE_STATUS_LABELS } from './CyclePanel.js';

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
  }>();
  const [guidance, setGuidance] = useState<Record<string, string>>({});
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
    perform(() =>
      controlFinalization(
        workspaceId,
        view.finalization.id,
        {
          action,
          expectedVersion: view.finalization.version,
          expectedCycleVersion: view.cycle?.version,
          ...(action === 'resume' && guidance[view.finalization.id]?.trim()
            ? { instructions: guidance[view.finalization.id] }
            : {}),
        },
        csrfToken,
      ),
    );
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
                  { ...draft, expectedBranchVersion: branchVersion },
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
              ['maxRemediationRounds', 'Additional remediation rounds', 0, 20],
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
                  setDraft({ ...draft, policy: { ...draft.policy, [key]: Number(e.target.value) } })
                }
              />
            </label>
          ))}
          <label className="field">
            Conformance and polish instructions
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
              {cycle && (
                <>
                  {' '}
                  · {cycle.polishPhase} · {Math.min((cycle.polishRound ?? 0) + 1, f.rounds.length)}{' '}
                  of {f.rounds.length} improvement rounds
                </>
              )}
            </p>
            <p role="status">{cycle?.reason ?? f.reason}</p>
            <p style={{ overflowWrap: 'anywhere' }}>
              Integration snapshot <code>{f.integrationSha}</code>
              <br />
              Candidate <code>{view.worktree?.branchName ?? 'Preparing'}</code>
            </p>
            {canMutate &&
              cycle &&
              ['paused', 'needs-attention'].includes(cycle.status) &&
              (!cycle.integrationResolution ||
                ['completed', 'abandoned'].includes(cycle.integrationResolution.status)) && (
                <label className="field">
                  Answers or guidance for the next attempt
                  <textarea
                    value={guidance[f.id] ?? ''}
                    maxLength={16000}
                    disabled={busy}
                    onChange={(e) => setGuidance({ ...guidance, [f.id]: e.target.value })}
                  />
                </label>
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
                  {(!cycle || ['paused', 'needs-attention'].includes(cycle.status)) &&
                    cycle?.integrationResolution?.status !== 'detected' && (
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy}
                        onClick={() => void command(view, 'resume')}
                      >
                        Resume finalization
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
            <details>
              <summary>Pass settings and run history</summary>
              <p>
                Zero blocking, major or minor findings; up to {f.policy.maxNits} nits. Additional
                remediation budget: {f.policy.maxRemediationRounds}.
              </p>
              <pre className="roadmap-instructions">
                {JSON.stringify(
                  { rounds: f.rounds, finalReview: f.finalReview, instructions: f.instructions },
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
