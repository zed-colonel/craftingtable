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
  type CycleStatus,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
  type WorktreeId,
} from '@craftingtable/domain';
import { useState } from 'react';
import { PERMISSION_MODE_LABELS } from '../../lib/execution-labels.js';
import type { ProfileEntry } from './handoff.js';

export const CYCLE_STATUS_LABELS: Record<CycleStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  'needs-attention': 'Needs attention',
  'awaiting-merge': 'Awaiting merge approval',
  stopped: 'Stopped',
  completed: 'Completed',
};
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
  onOpenRun,
  onResolution,
}: {
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
  onResolution?: (
    cycle: WorkCycle,
    input: Omit<IntegrationResolutionRequest, 'expectedVersion'>,
  ) => void;
}) {
  const activeWorktrees = worktrees.filter(
    (worktree) =>
      worktree.status === 'active' &&
      (!worktree.executionScope || worktree.executionScope.kind === 'slice'),
  );
  const [worktreeId, setWorktreeId] = useState(activeWorktrees[0]?.id ?? '');
  const selected =
    activeWorktrees.find((worktree) => worktree.id === worktreeId)?.id ??
    activeWorktrees[0]?.id ??
    '';
  const active = cycles.find(
    (cycle) =>
      (!selected || cycle.worktreeId === selected) &&
      !['stopped', 'completed'].includes(cycle.status),
  );
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
  return (
    <section className="panel cycle-panel" aria-label="Automated cycle">
      {activeWorktrees.length > 1 && (
        <label className="field">
          Cycle worktree
          <select value={selected} onChange={(e) => setWorktreeId(e.target.value)}>
            {activeWorktrees.map((t) => (
              <option key={t.id} value={t.id}>
                {t.executionScope?.sourceId ?? t.branchName} · {t.branchName}
              </option>
            ))}
          </select>
        </label>
      )}
      <h2>Automated cycle</h2>
      {active ? (
        <>
          <p>
            <strong>{CYCLE_STATUS_LABELS[active.status]}</strong> · {active.step} · Remediation{' '}
            {active.remediationRounds} of {active.policy.maxRemediationRounds}
          </p>
          <p role="status">{active.reason}</p>
          <p className="hint">
            Zero open blocking, major, or minor findings; at most {active.policy.maxNits} nits. Each
            step has {active.policy.maxRunMinutes} minutes.
          </p>
          <div className="inline-actions">
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
              active.integrationResolution?.status !== 'detected' && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={disabled}
                  onClick={() => onControl(active, 'resume')}
                >
                  Resume automation
                </button>
              )}
            <button
              type="button"
              className="secondary-button danger"
              disabled={disabled}
              onClick={() => onControl(active, 'stop')}
            >
              Stop automation
            </button>
          </div>
          {onResolution && (
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
              {CYCLE_STEPS.map((step) => (
                <li key={step}>
                  {step}: {AGENT_BACKEND_LABELS[active.profiles[step].backend]} ·{' '}
                  {active.profiles[step].model ?? 'Backend default'} ·{' '}
                  {PERMISSION_MODE_LABELS[active.profiles[step].permissionMode]}
                </li>
              ))}
            </ul>
            {active.instructions && <pre>{active.instructions}</pre>}
          </details>
          <p className="hint">
            Pause leaves the agent session available for manual work. Stop cancels its current
            process and ends the cycle. Resume adopts a manual run handed off from this cycle.
            Settings stay fixed for this cycle.
          </p>
        </>
      ) : (
        <details>
          <summary>Set up a cycle</summary>
          <p>Design → Implement → Review → Remediate as needed → Your merge approval.</p>
          <p className="hint">
            Design advances only when its final Open questions section says none. Incomplete
            reports, failed steps, time limits, or two unchanged remediation rounds pause for
            attention.
          </p>
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
      {cycles
        .filter((cycle) => ['stopped', 'completed'].includes(cycle.status))
        .slice(0, 3)
        .map((cycle) => (
          <p className="hint" key={cycle.id}>
            Previous cycle: {CYCLE_STATUS_LABELS[cycle.status]} — {cycle.reason}
          </p>
        ))}
    </section>
  );
}
