import type { AgentRunSummary, ExecutionStatusResponse } from '@craftingtable/contracts';
import type { AgentRunId, WorkCycle, WorktreeId } from '@craftingtable/domain';
import { DesignQuestions } from '../design/DesignQuestions.js';
import { IntegrationConflict } from '../integration/IntegrationConflict.js';
import { ScopeRepair } from '../scope-repair/ScopeRepair.js';
import { WorkflowStatus } from '../../features/execution/WorkflowStatus.js';
import { sharedDecisionsRoute } from '../../lib/decision-links.js';
import { Link } from '../../lib/navigation.js';
import { CycleContinuation, continuationOf, ProviderRetry } from './CycleDecisions.js';

/**
 * Which of a cycle's decisions apply, from its state and the daemon's returned actions: the
 * continuation, design questions, a scope review's repair, and the integration conflict.
 */
export function cycleDecisions(
  cycle: WorkCycle,
  runs: readonly AgentRunSummary[],
  readOnly: boolean,
) {
  const latestRun = runs.find((run) => run.worktreeId === cycle.worktreeId);
  const idle = ['paused', 'needs-attention'].includes(cycle.status);
  const design =
    cycle.step === 'design' &&
    idle &&
    (!runs.some((run) => run.id === cycle.currentRunId) || latestRun?.id === cycle.currentRunId);
  const designFromRun = design && runs.some((run) => run.id === cycle.currentRunId);
  const continuation =
    !(designFromRun && continuationOf(cycle) === 'resume') &&
    cycle.integrationResolution?.status !== 'detected'
      ? continuationOf(cycle)
      : undefined;
  return {
    continuation,
    design,
    scopeRepair: readOnly && idle,
    integration: !readOnly,
  };
}

/**
 * A stopped cycle's decision (R-A6 increment 2a): the components its state calls for, without
 * the rest of the cycle panel. It renders in the cycle's inbox item, and in the cycle panel on
 * the work item page when no item carries the stop.
 */
export function CycleDecision({
  cycle,
  runs,
  readOnly,
  backends,
  csrfToken,
  canMutate,
  busy,
  onChanged,
  onOpenRun,
  onOpenWorktree,
  inInbox = false,
}: {
  cycle: WorkCycle;
  /** The work item's runs; the cycle's own are read from them. */
  runs: readonly AgentRunSummary[];
  /** A verification or acceptance review, which records evidence and never merges. */
  readOnly: boolean;
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  canMutate: boolean;
  busy: boolean;
  onChanged: () => void;
  onOpenRun: (id: AgentRunId) => void;
  /** Shows another worktree's cycle: a delegated repair's, once started. */
  onOpenWorktree: (id: WorktreeId) => void;
  /**
   * In the cycle's inbox item, which shows nothing else of the cycle: its questions, its run and
   * its shared decisions come with the decision (R-A6 review).
   */
  inInbox?: boolean;
}) {
  const disabled = busy || !canMutate;
  const liveRun = runs.some(
    (run) =>
      run.worktreeId === cycle.worktreeId &&
      ['starting', 'running', 'waiting'].includes(run.status),
  );
  const applies = cycleDecisions(cycle, runs, readOnly);
  const openDecisions = (cycle.actions ?? []).includes('open-shared-decisions');
  return (
    <>
      {inInbox && <WorkflowStatus cycle={cycle} />}
      {inInbox && (runs.some((run) => run.id === cycle.currentRunId) || openDecisions) && (
        <p className="inline-actions">
          {runs.some((run) => run.id === cycle.currentRunId) && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onOpenRun(cycle.currentRunId)}
            >
              Open current run
            </button>
          )}
          {openDecisions && (
            <Link className="primary-button" route={sharedDecisionsRoute(cycle)}>
              Open shared decisions ({cycle.unsettledDecisions?.length})
            </Link>
          )}
        </p>
      )}
      <ProviderRetry
        cycle={cycle}
        csrfToken={csrfToken}
        disabled={disabled}
        onChanged={onChanged}
      />
      {applies.scopeRepair && (
        <ScopeRepair
          key={`repair-${cycle.id}`}
          cycle={cycle}
          disabled={disabled || liveRun}
          csrfToken={csrfToken}
          onOpen={onOpenWorktree}
          onStarted={(repair) => {
            onOpenWorktree(repair.worktreeId as WorktreeId);
            onChanged();
          }}
        />
      )}
      {applies.continuation && (
        <CycleContinuation
          cycle={cycle}
          csrfToken={csrfToken}
          disabled={disabled || liveRun}
          onChanged={onChanged}
        />
      )}
      {applies.design && canMutate && (
        <div id={`cycle-design-${cycle.id}`}>
          <DesignQuestions
            key={`${cycle.id}-${cycle.currentRunId}`}
            cycle={cycle}
            backends={backends}
            csrfToken={csrfToken}
            onChanged={onChanged}
          />
        </div>
      )}
      {applies.integration && (
        <IntegrationConflict
          offerInspect={!inInbox}
          cycle={cycle}
          backends={backends}
          disabled={disabled}
          canMutate={canMutate}
          csrfToken={csrfToken}
          onChanged={onChanged}
          onOpenRun={onOpenRun}
          runIds={runs.map((run) => run.id)}
        />
      )}
    </>
  );
}
