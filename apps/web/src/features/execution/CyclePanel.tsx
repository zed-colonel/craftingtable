import {
  CycleRemediationRecovery,
  type CycleRemediationGrant,
} from './CycleRemediationRecovery.js';
import { HistoricalEvidencePanel } from './HistoricalEvidencePanel.js';
import { IntegrationResolutionPanel } from './IntegrationResolutionPanel.js';
import { CycleSettingsFields } from './CycleSettingsFields.js';
import type {
  AgentRunSummary,
  IntegrationResolutionRequest,
  ExecutionStatusResponse,
  StartWorkCycleRequest,
  WorktreeSummary,
} from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  type AgentRunId,
  CYCLE_STEPS,
  type CycleProfiles,
  DEFAULT_COMPLETION_POLICY,
  remediationAllowance,
  type WorkCycle,
  type WorktreeId,
} from '@craftingtable/domain';
import { useState, type ReactNode } from 'react';
import { About } from '../../components/About.js';
import { ActionBar } from '../../components/ActionBar.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { CYCLE_STATUS_LABELS, PERMISSION_MODE_LABELS } from '../../lib/execution-labels.js';
import type { ProfileEntry } from './handoff.js';

export { CYCLE_STATUS_LABELS } from '../../lib/execution-labels.js';
export function CyclePanel({
  cycles,
  worktrees,
  runs,
  backends,
  profiles,
  canMutate,
  busy,
  admitted,
  onStart,
  onControl,
  onAuthorizeRemediation,
  onOpenRun,
  onResolution,
  selectedWorktreeId,
  onSelectWorktree,
  renderDesignRecovery,
  renderReviewRecovery,
}: {
  renderReviewRecovery?: (cycle: WorkCycle, liveRun: boolean) => ReactNode;
  selectedWorktreeId?: WorktreeId;
  onSelectWorktree?: (id: WorktreeId) => void;
  renderDesignRecovery?: (cycle: WorkCycle) => ReactNode;
  cycles: readonly WorkCycle[];
  worktrees: readonly WorktreeSummary[];
  runs: readonly AgentRunSummary[];
  backends: ExecutionStatusResponse['backends'];
  profiles: readonly ProfileEntry[];
  canMutate: boolean;
  busy: boolean;
  admitted: boolean;
  onStart: (input: StartWorkCycleRequest) => void;
  onControl: (cycle: WorkCycle, action: 'pause' | 'resume' | 'stop') => void;
  onOpenRun: (id: AgentRunId) => void;
  onAuthorizeRemediation?: (cycle: WorkCycle, input: CycleRemediationGrant) => void;
  onResolution?: (
    cycle: WorkCycle,
    input: Omit<IntegrationResolutionRequest, 'expectedVersion'>,
  ) => void;
}) {
  const activeWorktrees = worktrees.filter((worktree) => worktree.status === 'active');
  const preferred =
    activeWorktrees.find((t) =>
      cycles.some(
        (c) =>
          c.worktreeId === t.id &&
          !c.scopeReviewWait &&
          ['needs-attention', 'paused'].includes(c.status),
      ),
    ) ??
    activeWorktrees.find((t) =>
      cycles.some((c) => c.worktreeId === t.id && !['completed', 'stopped'].includes(c.status)),
    ) ??
    activeWorktrees.find((t) => !t.executionScope || t.executionScope.kind === 'slice') ??
    activeWorktrees[0];
  // Once visible, keep the inspected worktree selected while siblings change state.
  const [worktreeId, setWorktreeId] = useState(() => preferred?.id ?? '');
  const selected =
    activeWorktrees.find((worktree) => worktree.id === (selectedWorktreeId ?? worktreeId))?.id ??
    preferred?.id ??
    '';
  const readOnly = activeWorktrees.some(
    (t) => t.id === selected && t.executionScope && t.executionScope.kind !== 'slice',
  );
  const active =
    cycles.find(
      (cycle) =>
        (!selected || cycle.worktreeId === selected) &&
        !['stopped', 'completed'].includes(cycle.status),
    ) ??
    (readOnly
      ? cycles.find((cycle) => cycle.worktreeId === selected && cycle.status === 'completed')
      : undefined);
  const latestRun = runs.find((run) => run.worktreeId === selected);
  const recoverableDesign =
    active?.step === 'design' &&
    (!runs.some((run) => run.id === active.currentRunId) || latestRun?.id === active.currentRunId);
  const [policy, setPolicy] = useState(DEFAULT_COMPLETION_POLICY);
  const [instructions, setInstructions] = useState('');
  const [choices, setChoices] = useState<CycleProfiles>(
    () =>
      Object.fromEntries(
        CYCLE_STEPS.map((step) => {
          const profile = profiles.find(
            (entry) => entry.role === (step === 'remediate' ? 'implement' : step),
          );
          return [
            step,
            {
              backend:
                profile?.backend ??
                backends.find((backend) => backend.available)?.kind ??
                'claude-code',
              permissionMode: profile?.permissionMode ?? 'auto',
              ...(profile?.model === undefined ? {} : { model: profile.model }),
            },
          ];
        }),
      ) as CycleProfiles,
  );
  const disabled = busy || !canMutate;
  const unavailable = CYCLE_STEPS.some(
    (step) => !backends.find((backend) => backend.kind === choices[step].backend)?.available,
  );
  const liveRun = runs.some(
    (run) => run.worktreeId === selected && ['starting', 'running', 'waiting'].includes(run.status),
  );
  const exhaustedReview =
    active &&
    onAuthorizeRemediation &&
    ['paused', 'needs-attention'].includes(active.status) &&
    active.step === 'review' &&
    active.reason.startsWith('Remediation limit reached.') &&
    active.remediationRounds >= remediationAllowance(active) &&
    (!active.executionScope || active.executionScope.kind === 'slice') &&
    (!active.integrationResolution ||
      ['completed', 'abandoned'].includes(active.integrationResolution.status));
  const previous = cycles.filter((cycle) => ['stopped', 'completed'].includes(cycle.status));
  const attention =
    active !== undefined &&
    !active.scopeReviewWait &&
    ['needs-attention', 'awaiting-merge'].includes(active.status);
  const statusLabel = active?.scopeReviewWait
    ? 'Waiting for prerequisite work'
    : active && readOnly && active.status === 'awaiting-merge'
      ? 'Ready for scope acceptance'
      : active
        ? CYCLE_STATUS_LABELS[active.status]
        : '';
  return (
    <Section
      id="automation"
      title="Automated cycle"
      summary={
        active
          ? `${statusLabel} · ${active.step} step`
          : previous.length > 0
            ? 'No cycle running.'
            : 'Design → Implement → Review → Remediate as needed → your merge approval.'
      }
      {...(attention ? { tone: 'attention' as const } : {})}
    >
      {activeWorktrees.length > 1 && (
        <label className="field">
          Cycle worktree
          <select
            value={selected}
            onChange={(e) => {
              setWorktreeId(e.target.value);
              onSelectWorktree?.(e.target.value as WorktreeId);
            }}
          >
            {activeWorktrees.map((t) => (
              <option key={t.id} value={t.id}>
                {t.executionScope?.sourceId ?? t.branchName}
                {t.executionScope ? ` · ${t.executionScope.kind}` : ''} · {t.branchName}
              </option>
            ))}
          </select>
        </label>
      )}
      {active ? (
        <>
          <p role="status">{active.scopeReviewWait ?? active.reason}</p>
          <StatusStrip
            label="Cycle status"
            facts={[
              {
                label: 'Status',
                value: statusLabel,
                accent: attention ? 'var(--color-attention)' : 'var(--color-active)',
              },
              { label: 'Step', value: active.step },
              ...(!readOnly
                ? [
                    {
                      label: 'Remediation',
                      value: `${active.remediationRounds} of ${remediationAllowance(active)}`,
                    },
                  ]
                : []),
              { label: 'Allowed nits', value: active.policy.maxNits },
              { label: 'Minutes per step', value: active.policy.maxRunMinutes },
            ]}
          />
          <ActionBar label="Cycle controls">
            {runs.some((run) => run.id === active.currentRunId) && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => onOpenRun(active.currentRunId)}
              >
                Open current run
              </button>
            )}
            {['running', 'awaiting-merge'].includes(active.status) && (
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={() => onControl(active, 'pause')}
              >
                Pause automation
              </button>
            )}
            {['paused', 'needs-attention'].includes(active.status) &&
              !exhaustedReview &&
              !(readOnly && renderReviewRecovery) &&
              active.integrationResolution?.status !== 'detected' &&
              !(
                renderDesignRecovery &&
                recoverableDesign &&
                runs.some((run) => run.id === active.currentRunId)
              ) && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={disabled}
                  onClick={() => onControl(active, 'resume')}
                >
                  Resume automation
                </button>
              )}
            {active.status !== 'completed' && (
              <button
                type="button"
                className="secondary-button danger"
                disabled={disabled}
                onClick={() => onControl(active, 'stop')}
              >
                Stop automation
              </button>
            )}
          </ActionBar>
          {readOnly && (
            <p className="hint">
              This is an independent review snapshot. Address code or documentation findings through
              the owning slice, then verify the changed integration before parent acceptance.{' '}
              <a href="#slices">Open execution slices and verification controls</a>.
            </p>
          )}
          {readOnly &&
            renderReviewRecovery &&
            ['paused', 'needs-attention', 'completed'].includes(active.status) &&
            renderReviewRecovery(active, liveRun)}
          {exhaustedReview && onAuthorizeRemediation && (
            <CycleRemediationRecovery
              key={`${active.id}:${active.version}`}
              cycle={active}
              disabled={disabled || liveRun}
              onAuthorize={(input) => onAuthorizeRemediation(active, input)}
            />
          )}
          {renderDesignRecovery &&
            canMutate &&
            recoverableDesign &&
            ['paused', 'needs-attention'].includes(active.status) &&
            renderDesignRecovery(active)}
          {active.baselinePreparation && <HistoricalEvidencePanel cycle={active} />}
          {onResolution && !readOnly && (
            <IntegrationResolutionPanel
              cycle={active}
              backends={backends}
              busy={disabled}
              canMutate={canMutate}
              onCommand={(input) => onResolution(active, input)}
              onOpenRun={onOpenRun}
              runIds={runs.map((run) => run.id)}
            />
          )}
          <details>
            <summary>Cycle settings</summary>
            <ul>
              {(readOnly ? (['review'] as const) : CYCLE_STEPS).map((step) => (
                <li key={step}>
                  {step}: {AGENT_BACKEND_LABELS[active.profiles[step].backend]} ·{' '}
                  {active.profiles[step].model ?? 'Backend default'} ·{' '}
                  {PERMISSION_MODE_LABELS[active.profiles[step].permissionMode]}
                </li>
              ))}
            </ul>
            {active.instructions && <pre>{active.instructions}</pre>}
          </details>
          <About label="About cycle controls">
            {readOnly ? (
              <p>
                Independent reviews collect evidence and report findings. Resume starts a fresh
                review after its phase requirements clear. Address source changes through the owning
                slice; recording verification or accepting the parent remains a separate guarded
                command.
              </p>
            ) : (
              <p>
                The cycle completes when zero blocking, major, or minor findings remain and at most
                the allowed nits. Pause leaves the agent session available for manual work. Stop
                cancels its current process and ends the cycle. Resume adopts a manual run handed
                off from this cycle. Agent settings stay fixed; an exhausted review allowance can be
                extended explicitly.
              </p>
            )}
          </About>
        </>
      ) : readOnly ? (
        <p className="hint">
          This worktree is a review snapshot. Use Delegation to launch its review; implementation
          cycles belong to an owning slice.
        </p>
      ) : (
        <details>
          <summary>Set up a cycle</summary>
          <About label="About automated cycles">
            <p>
              Design advances only when its final Open questions section says none. Incomplete
              reports, failed steps, time limits, or two unchanged remediation rounds pause for
              attention. The cycle ends at your merge approval.
            </p>
          </About>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onStart({
                worktreeId: selected as WorktreeId,
                policy,
                profiles: choices,
                instructions,
              });
            }}
          >
            <label className="field">
              Worktree
              <select
                value={selected}
                onChange={(event) => setWorktreeId(event.target.value)}
                disabled={disabled}
              >
                {activeWorktrees.length === 0 && (
                  <option value="">Create a worktree below first</option>
                )}
                {activeWorktrees.map((worktree) => (
                  <option key={worktree.id} value={worktree.id}>
                    {worktree.branchName}
                  </option>
                ))}
              </select>
            </label>
            <CycleSettingsFields
              policy={policy}
              setPolicy={setPolicy}
              choices={choices}
              setChoices={setChoices}
              instructions={instructions}
              setInstructions={setInstructions}
              backends={backends}
              disabled={disabled}
            />
            <button
              className="primary-button"
              type="submit"
              disabled={disabled || !admitted || !selected || unavailable || liveRun}
            >
              Start automated cycle
            </button>
            {!admitted && (
              <p className="hint">
                Admit this work item first. All required predecessors must be completed.
              </p>
            )}
            {liveRun && (
              <p className="hint">End open sessions in this worktree before starting automation.</p>
            )}
          </form>
        </details>
      )}
      {previous.slice(0, 3).map((cycle) => (
        <div key={cycle.id}>
          <p className="hint">
            Previous cycle: {CYCLE_STATUS_LABELS[cycle.status]} — {cycle.reason}
          </p>
          {cycle.baselinePreparation && <HistoricalEvidencePanel cycle={cycle} />}
        </div>
      ))}
    </Section>
  );
}
