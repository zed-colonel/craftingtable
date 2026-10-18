import type { AgentRunId, WorkspaceId } from '@craftingtable/domain';
import type { LiveRun } from './shared.js';

export class RunState {
  readonly preparationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly live = new Map<string, LiveRun>();
  /** Each launched run's short private temporary directory, until the run ends (LIVE-31). */
  readonly processTemporaryDirectories = new Map<string, string>();
  /** Runs whose supervision failed; their killed sessions have not reported exit yet. */
  readonly orphaned = new Set<LiveRun>();
  readonly pendingCycleLaunches = new Map<AgentRunId, () => void>();
  /**
   * Reviews whose adopted checks run before their agent starts (R-G13 increment 3): how to cancel
   * each, and the launch that continues after them. A drain counts and cancels them like a
   * launch; `quiesce` waits for the launches, as it waits for cleanups.
   */
  readonly checkingLaunches = new Map<
    string,
    {
      readonly workspaceId: WorkspaceId;
      readonly runId: AgentRunId;
      readonly cancel: () => void;
      readonly done: Promise<void>;
    }
  >();
  /**
   * Launches past their last drain check that are not yet live or in their checks: Git
   * preflight, the pinned evidence, the baseline. A drain counts them and waits for them
   * (R-G13 increment 3 verification).
   */
  readonly startingLaunches = new Set<{
    workspaceId?: WorkspaceId;
    runId?: AgentRunId;
    done?: Promise<unknown>;
  }>();
  /** A restart is ending live sessions now: a launch that completes meanwhile is ended too. */
  interrupting = false;
  /** A restart drain is in progress: no new run may start (R-B9). */
  draining = false;
  /**
   * The daemon itself is being stopped by a signal. The service manager's stop signal may
   * reach agent process groups too, so a run killed by a signal from now on was stopped by
   * the restart. A drain a deploy requested stops nothing else, so there a signal is a
   * failure like any other.
   */
  serviceStopping = false;
  /** Post-run cleanup still running; the controller skips a worktree until it settles. */
  readonly cleanups = new Set<Promise<unknown>>();
  /** Runs and records the checks agents ask for (R-G4); absent, launchers run them inline. */
  checks: import('../check-request-service.js').CheckRequestService | undefined;
  /** Protected-ref snapshots around each run (R-G5, SEC-02d). */
  refWatch:
    | {
        readonly watch: import('../ref-watch.js').RefWatch;
        readonly git: import('@craftingtable/git').GitOperations;
      }
    | undefined;
}
