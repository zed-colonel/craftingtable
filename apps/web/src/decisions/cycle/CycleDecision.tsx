import type { AgentRunSummary, ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  type AgentRunId,
  type CycleProjection,
  stopCode,
  type WorkCycle,
  type WorktreeId,
} from '@craftingtable/domain';
import { DesignQuestions } from '../design/DesignQuestions.js';
import { IntegrationConflict } from '../integration/IntegrationConflict.js';
import { ScopeRepair } from '../scope-repair/ScopeRepair.js';
import { WorkflowStatus } from '../../features/execution/WorkflowStatus.js';
import { sharedDecisionsRoute } from '../../lib/decision-links.js';
import { Link } from '../../lib/navigation.js';
import { revealElement } from '../../lib/reveal-element.js';
import { answerFieldId, useStopDraft } from './answer-draft.js';
import { CycleContinuation, continuationOf, ProviderRetry } from './CycleDecisions.js';
import { CycleInvestigation } from './CycleInvestigation.js';

/**
 * Which of a cycle's decisions apply, from its state and the daemon's returned actions: the
 * continuation, design questions, a scope review's repair, and the integration conflict.
 */
export function cycleDecisions(
  cycle: WorkCycle,
  projection: CycleProjection,
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
    !(designFromRun && continuationOf(cycle, projection) === 'resume') &&
    cycle.integrationResolution?.status !== 'detected'
      ? continuationOf(cycle, projection)
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
  projection,
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
  /** What the daemon derived for the cycle when it was read (CTRL-22). */
  projection: CycleProjection;
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
  // One answer draft per stop, the cycle, the run it stopped on and why, as the daemon reads
  // a stop (a pause taken there keeps it). It is held for the session above this view: it
  // survives the form being hidden while an investigation runs and leaving the page, never
  // follows the operator to another stop, and proposals are added to it (R-C16 16b review).
  const answer = useStopDraft(
    `${cycle.id}:${cycle.currentRunId}:${stopCode(cycle) ?? cycle.status}`,
    cycle.investigation?.id,
  );
  const liveRun = runs.some(
    (run) =>
      run.worktreeId === cycle.worktreeId &&
      ['starting', 'running', 'waiting'].includes(run.status),
  );
  const applies = cycleDecisions(cycle, projection, runs, readOnly);
  const openDecisions = projection.actions.includes('open-shared-decisions');
  return (
    <>
      {inInbox && (
        <WorkflowStatus
          cycle={cycle}
          {...(projection.questionRoutes ? { questionRoutes: projection.questionRoutes } : {})}
        />
      )}
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
              Open shared decisions ({projection.unsettledDecisions?.length})
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
      <CycleInvestigation
        cycle={cycle}
        projection={projection}
        backends={backends}
        csrfToken={csrfToken}
        disabled={disabled}
        onChanged={onChanged}
        onOpenRun={onOpenRun}
        proposalsAdded={answer.added}
        {...(applies.continuation && applies.continuation !== 'resume'
          ? {
              // Only where a form takes the answer: guidance, a grant or a scope review's.
              onUseAnswers: (text: string) => {
                answer.append(text);
                // The answer, with its label, comes into view; the field takes the focus and
                // keeps its place in the Tab order.
                revealElement(`cycle-continuation-${cycle.id}`);
                document.getElementById(answerFieldId(cycle.id))?.focus({ preventScroll: true });
              },
            }
          : {})}
      />
      {applies.continuation && (
        <CycleContinuation
          cycle={cycle}
          projection={projection}
          csrfToken={csrfToken}
          disabled={disabled || liveRun}
          onChanged={onChanged}
          answer={answer}
        />
      )}
      {applies.design && canMutate && (
        <div id={`cycle-design-${cycle.id}`}>
          <DesignQuestions
            key={`${cycle.id}-${cycle.currentRunId}`}
            cycle={cycle}
            nextAgentSelections={projection.nextAgentSelections}
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
          nextAgentSelections={projection.nextAgentSelections}
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
