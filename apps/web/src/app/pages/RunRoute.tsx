import type { RunEventEnvelope, WorktreeDiffResponse } from '@craftingtable/contracts';
import type { AgentRunId, WorkCycle, WorkItemId } from '@craftingtable/domain';
import { useCallback, useEffect, useState } from 'react';
import { ProviderRetry } from '../../decisions/cycle/CycleDecisions.js';
import type { LaunchInput } from '../../features/execution/DelegationPanel.js';
import { RunPage } from '../../features/execution/RunPage.js';
import { ApiError } from '../../lib/api-client.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import {
  cancelRun,
  endRun,
  loadRunEvents,
  loadWorktreeDiff,
  sendRunMessage,
  startRun,
} from '../../lib/execution-api.js';
import { useQueryStore } from '../../lib/query-store.js';
import { useRunEventStream } from '../../lib/use-run-event-stream.js';
import type { ConnectionState } from '../../lib/workspace-projection.js';
import { useCommands } from '../commands.js';
import { useExecutionStatus, useRun, useRunProfiles, useWorkItemExecution } from '../reads.js';
import { useAlive, useCycleFocus, useGo, useSession, useWorkspaceScope } from '../session.js';

/** Pages the initial run-event load walks before handing over to the stream. */
const RUN_EVENT_PAGE_LIMIT = 20;

/**
 * One run, followed live: its committed events are loaded once, then the tail streams from the
 * last committed sequence. Leaving the page drops both.
 */
export function RunRoute({ runId, cycles }: { runId: AgentRunId; cycles: readonly WorkCycle[] }) {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken, expire } = useSession();
  const store = useQueryStore();
  const go = useGo();
  const focus = useCycleFocus();
  const alive = useAlive();
  const detail = useRun(workspaceId, runId).data;
  const run = detail?.run.id === runId ? detail : undefined;
  const workItemId = run?.run.workItemId as WorkItemId | undefined;
  const execution = useWorkItemExecution(workspaceId, workItemId).data;
  const status = useExecutionStatus().data;
  const profiles = useRunProfiles(workspaceId).data;
  /** What a run's command or end changes: the run, its work item and the workspace's cycles. */
  const refreshKeys = useCallback(
    () => [
      queryKeys.run(workspaceId, runId),
      queryKeys.cycles(workspaceId),
      ...(workItemId === undefined ? [] : [queryKeys.workItem(workspaceId, workItemId)]),
    ],
    [workspaceId, runId, workItemId],
  );
  const commands = useCommands(() => store.refreshNow(refreshKeys()));
  const [events, setEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [streamAfter, setStreamAfter] = useState<number>();
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [diff, setDiff] = useState<WorktreeDiffResponse>();
  useEffect(() => {
    let canceled = false;
    void (async () => {
      const collected: RunEventEnvelope[] = [];
      let after = 0;
      for (let page = 0; page < RUN_EVENT_PAGE_LIMIT; page += 1) {
        const response = await loadRunEvents(workspaceId, runId, after);
        collected.push(...response.events);
        if (response.events.length === 0 || response.nextAfter === after) break;
        after = response.nextAfter;
      }
      if (!canceled) {
        setEvents(collected);
        setStreamAfter(after);
        setConnection('connecting');
      }
    })().catch(() => {
      if (!canceled) setConnection('disconnected');
    });
    return () => {
      canceled = true;
    };
  }, [workspaceId, runId]);
  const onOpen = useCallback(() => setConnection('open'), []);
  const onError = useCallback((sourceClosed: boolean) => {
    setConnection(sourceClosed ? 'disconnected' : 'reconnecting');
  }, []);
  const onEvent = useCallback(
    (event: RunEventEnvelope) => {
      setEvents((current) =>
        current.some((existing) => existing.sequence >= event.sequence)
          ? current
          : [...current, event],
      );
      if (
        event.kind === 'run-finished' ||
        event.kind === 'turn-completed' ||
        event.kind === 'session-started'
      )
        store.invalidate(refreshKeys());
    },
    [store, refreshKeys],
  );
  const onInvalidEvent = useCallback(() => undefined, []);
  useRunEventStream(
    streamAfter === undefined ? undefined : workspaceId,
    streamAfter === undefined ? undefined : runId,
    streamAfter ?? 0,
    { onOpen, onError, onEvent, onInvalidEvent, onAuthenticationExpired: expire },
  );
  if (run === undefined) return null;
  const launch = (input: LaunchInput): void => {
    if (workItemId === undefined) return;
    commands.run(async () => {
      const response = await startRun(workspaceId, workItemId, input, csrfToken);
      if (alive()) go({ name: 'run', workspaceId, runId: response.run.id });
    });
  };
  const loadDiff = (): void => {
    commands.setError(undefined);
    void loadWorktreeDiff(workspaceId, run.worktree.id)
      .then((response) => {
        if (alive()) setDiff(response);
      })
      .catch((error: unknown) => {
        if (alive())
          commands.setError(
            error instanceof ApiError ? error.message : 'The diff could not be loaded',
          );
      });
  };
  return (
    <RunPage
      detail={run}
      providerRecovery={cycles
        .filter(
          (c) =>
            c.worktreeId === run.worktree.id && c.currentRunId === run.run.id && c.providerRecovery,
        )
        .map((cycle) => (
          <ProviderRetry
            key={cycle.id}
            cycle={cycle}
            csrfToken={csrfToken}
            disabled={!canMutate || commands.busy}
            onChanged={() => store.refreshNow(refreshKeys())}
          />
        ))}
      events={events}
      connection={connection}
      {...(diff?.worktree.id === run.worktree.id ? { diff } : {})}
      canMutate={canMutate}
      busy={commands.busy}
      {...(commands.error === undefined ? {} : { error: commands.error })}
      onSend={(text) =>
        commands.run(async () => {
          const response = await sendRunMessage(workspaceId, runId, text, csrfToken);
          if (!response.accepted)
            throw new ApiError(409, 'conflict', 'The run is no longer accepting messages');
        })
      }
      onEnd={() => commands.run(() => endRun(workspaceId, runId, csrfToken))}
      onCancel={() => commands.run(() => cancelRun(workspaceId, runId, csrfToken))}
      onOpenWorkItem={() =>
        run.run.workItemId
          ? go({ name: 'work-item', workspaceId, workItemId: run.run.workItemId })
          : run.run.planVersionId &&
            go({
              name: 'plan-version',
              workspaceId,
              projectId: run.run.projectId,
              planVersionId: run.run.planVersionId,
            })
      }
      onLoadDiff={loadDiff}
      onCloseDiff={() => setDiff(undefined)}
      {...(status === undefined ? {} : { backends: status.backends })}
      {...(profiles === undefined ? {} : { profiles: profiles.profiles })}
      {...(canMutate &&
      run.run.workItemId &&
      cycles.some(
        (cycle) =>
          cycle.worktreeId === run.worktree.id &&
          cycle.step === 'design' &&
          ['paused', 'needs-attention'].includes(cycle.status),
      )
        ? {
            onResolveDesign: () => {
              focus.focus(run.worktree.id);
              if (run.run.workItemId)
                go({ name: 'work-item', workspaceId, workItemId: run.run.workItemId });
            },
          }
        : {})}
      {...(execution !== undefined && execution.workItemId === run.run.workItemId
        ? { runs: execution.runs }
        : {})}
      {...(canMutate && run.run.workItemId && run.worktree.status === 'active'
        ? { onHandoff: launch }
        : {})}
    />
  );
}
