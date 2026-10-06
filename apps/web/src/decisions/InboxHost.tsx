import type { AttentionItemView } from '@craftingtable/contracts';
import type {
  AgentRunId,
  PlanVersionId,
  WorkCycle,
  WorkItemId,
  WorktreeId,
} from '@craftingtable/domain';
import { Fragment, type ReactNode } from 'react';
import { useCycleFocus, useGo, useSession, useWorkspaceScope } from '../app/session.js';
import { FinalizationPanel } from '../features/execution/FinalizationPanel.js';
import {
  DelegationControls,
  ScopeControls,
  useWorkItem,
} from '../features/execution/WorkItemControls.js';
import { RoadmapPage } from '../features/planning/RoadmapsPage.js';
import { StoragePanel } from '../features/workspace/StoragePanel.js';
import { AcknowledgeMoves } from '../features/inbox/AcknowledgeMoves.js';
import { queryKeys } from '../lib/event-invalidations.js';
import { MERGE_GATE_LABELS } from '../lib/execution-labels.js';
import { Link } from '../lib/navigation.js';
import { loadRepositories } from '../lib/execution-api.js';
import { useQuery, useQueryStore } from '../lib/query-store.js';
import { AmendmentDecision } from './amendment/AmendmentDecision.js';
import { CheckAdoption } from './checks/CheckAdoption.js';
import { CheckpointPreparation } from './checkpoint/CheckpointPreparation.js';
import { CycleDecision } from './cycle/CycleDecision.js';
import { EnvironmentApproval } from './environment/EnvironmentApproval.js';
import { FinalizationDecision } from './finalization/FinalizationDecision.js';
import { MergeApproval, RetryMergeCleanup } from './merge/MergeApproval.js';
import { DependencyRefresh } from './refresh/DependencyRefresh.js';
import { type Decision, decisionsFor, type RoadmapItemPart } from './registry.js';
import { RoadmapAmendments, RoadmapRuntime } from './roadmap-runtime.js';
import { UpstreamTransitions } from './upstream/UpstreamTransitions.js';

/** Where a roadmap part opens: the held entry, or the step's own form (LIVE-11). */
function roadmapPartFocus(roadmapId: string, part: RoadmapItemPart): string | undefined {
  const runtime = `runtime-evidence-roadmap-${roadmapId}`;
  if (part.kind === 'controls')
    return part.entryId === undefined ? undefined : `roadmap-entry-${roadmapId}-${part.entryId}`;
  return {
    decisions: `${runtime}-decisions`,
    evidence: `${runtime}-evidence`,
    'plan-acceptance': `${runtime}-plan-acceptance`,
  }[part.step as string];
}

/**
 * The decisions that resolve one inbox item, chosen by its code through the registry (R-A6
 * increment 2a): each kind's own component, or one part of a roadmap. It reads its work item
 * like the item's page (R-D4 increment 4b).
 */
export function InboxHost({
  item,
  attention,
  workspaceCycles,
}: {
  item: AttentionItemView;
  attention: readonly AttentionItemView[];
  workspaceCycles: readonly WorkCycle[];
}) {
  const { workspaceId, canMutate, isOwner } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const go = useGo();
  const focus = useCycleFocus();
  const store = useQueryStore();
  const { workItemId, roadmapId, planVersionId, projectId, runId, cycleId } = item.refs;
  const work = useWorkItem(workItemId as WorkItemId | undefined);
  // A work item's view lists the repositories (R-D5); an item that names none, such as a
  // finalization's check adoption, reads them itself.
  const ownRepositories = useQuery(
    workItemId === undefined && decisionsFor(item).some((d) => d.kind === 'check-adoption')
      ? queryKeys.repositories(workspaceId)
      : undefined,
    () => loadRepositories(workspaceId),
  );
  const repositories =
    workItemId === undefined ? (ownRepositories.data?.repositories ?? []) : work.repositories;
  const loading = <p className="empty-state">Loading controls…</p>;
  const worktreeOf = (id: string | undefined) =>
    work.execution?.worktrees.find((tree) => tree.id === id);
  const render = (decision: Decision): ReactNode => {
    switch (decision.kind) {
      case 'cycle': {
        // The cycle's decision alone, chosen from its state (R-A6 increment 2a).
        // The item's cycles in full: the workspace list leaves out design-recovery detail.
        const view = work.cycles?.find((v) => v.cycle.id === cycleId);
        const worktree = worktreeOf(view?.cycle.worktreeId);
        if (!view || !worktree) return loading;
        return (
          <CycleDecision
            cycle={view.cycle}
            projection={view.projection}
            runs={work.execution?.runs ?? []}
            readOnly={!!worktree.executionScope && worktree.executionScope.kind !== 'slice'}
            backends={work.backends}
            csrfToken={csrfToken}
            canMutate={canMutate}
            busy={work.commands.busy}
            onChanged={work.refresh}
            inInbox
            onOpenRun={(id) => go({ name: 'run', workspaceId, runId: id })}
            onOpenWorktree={(id) => {
              focus.focus(id);
              if (workItemId)
                go({ name: 'work-item', workspaceId, workItemId: workItemId as WorkItemId });
            }}
          />
        );
      }
      case 'merge': {
        const worktree = worktreeOf(item.refs.worktreeId);
        const gate = worktree && work.execution?.mergeGates[worktree.id];
        if (!worktree) return loading;
        return worktree.mergeCleanupError ? (
          <RetryMergeCleanup
            workspaceId={workspaceId}
            worktree={worktree}
            csrfToken={csrfToken}
            disabled={!canMutate}
            onDone={work.merged}
          />
        ) : (
          <>
            <p>
              <code>{worktree.branchName}</code>:{' '}
              {gate ? MERGE_GATE_LABELS[gate.reason] : 'Loading the merge gate…'}
            </p>
            {gate && canMutate && (
              <MergeApproval
                workspaceId={workspaceId}
                worktree={worktree}
                gate={gate}
                csrfToken={csrfToken}
                disabled={false}
                onMerged={work.merged}
              />
            )}
          </>
        );
      }
      case 'checkpoint-preparation': {
        const worktree = worktreeOf(item.refs.worktreeId);
        return worktree?.executionScope?.kind === 'slice' ? (
          <CheckpointPreparation
            workspaceId={workspaceId}
            definitionId={worktree.executionScope.definitionId}
            worktreeId={worktree.id}
            csrfToken={csrfToken}
            canMutate={canMutate}
            onChanged={work.refresh}
          />
        ) : undefined;
      }
      case 'worktrees':
        return work.detail && work.execution ? (
          <DelegationControls item={work} attention={attention} workspaceCycles={workspaceCycles} />
        ) : (
          loading
        );
      case 'scope-evidence':
        return work.detail ? <ScopeControls item={work} attention={attention} inInbox /> : loading;
      case 'check-adoption': {
        const repositoryId =
          workspaceCycles.find((c) => c.id === cycleId)?.attention?.refs?.repositoryId ??
          worktreeOf(item.refs.worktreeId)?.repositoryId;
        const repository = repositories.find((r) => r.id === repositoryId);
        const worktree = worktreeOf(item.refs.worktreeId);
        return repository ? (
          <CheckAdoption
            key={`checks-${item.id}`}
            workspaceId={workspaceId}
            repository={repository}
            {...(item.refs.worktreeId ? { worktreeId: item.refs.worktreeId as WorktreeId } : {})}
            {...(worktree?.integrationBranch
              ? { integrationBranch: worktree.integrationBranch }
              : {})}
            csrfToken={csrfToken}
            editable={canMutate}
            onAdopted={() => {
              store.refreshNow([queryKeys.repositoryChecks(workspaceId, repository.id)]);
              work.refresh();
            }}
          />
        ) : (
          loading
        );
      }
      case 'finalization':
        return planVersionId !== undefined && projectId !== undefined ? (
          <FinalizationPanel
            key={`finalize-${planVersionId}`}
            workspaceId={workspaceId}
            planVersionId={planVersionId as PlanVersionId}
            csrfToken={csrfToken}
            canMutate={canMutate}
            onOpenRun={(id) => go({ name: 'run', workspaceId, runId: id })}
          />
        ) : undefined;
      case 'finalization-decision':
        return planVersionId !== undefined ? (
          <FinalizationDecision
            key={`finalization-${item.id}`}
            workspaceId={workspaceId}
            planVersionId={planVersionId as PlanVersionId}
            {...(item.refs.finalizationId ? { finalizationId: item.refs.finalizationId } : {})}
            {...(cycleId ? { cycleId } : {})}
            {...(item.refs.worktreeId ? { worktreeId: item.refs.worktreeId } : {})}
            csrfToken={csrfToken}
            canMutate={canMutate}
            onChanged={() =>
              store.refreshNow([
                queryKeys.attention(workspaceId),
                queryKeys.cycles(workspaceId),
                queryKeys.finalizations(workspaceId, planVersionId),
              ])
            }
            onOpenRun={(id) => go({ name: 'run', workspaceId, runId: id })}
          />
        ) : undefined;
      case 'environment-approval':
      case 'upstream-transitions':
      case 'dependency-refresh': {
        if (roadmapId === undefined) return undefined;
        const kind = decision.kind;
        return (
          <RoadmapRuntime
            key={`${kind}-${item.id}`}
            workspaceId={workspaceId}
            roadmapId={roadmapId}
          >
            {({ base, view, onSaved }) =>
              kind === 'environment-approval' ? (
                <EnvironmentApproval
                  base={base}
                  view={view}
                  csrfToken={csrfToken}
                  canMutate={canMutate}
                  onSaved={onSaved}
                />
              ) : kind === 'upstream-transitions' ? (
                <UpstreamTransitions
                  base={base}
                  view={view}
                  csrfToken={csrfToken}
                  canMutate={canMutate}
                  onSaved={onSaved}
                />
              ) : (
                <DependencyRefresh
                  base={base}
                  view={view}
                  csrfToken={csrfToken}
                  disabled={!canMutate}
                  onSaved={onSaved}
                />
              )
            }
          </RoadmapRuntime>
        );
      }
      case 'amendment':
        return roadmapId !== undefined ? (
          <RoadmapAmendments
            key={`amendment-${item.id}`}
            workspaceId={workspaceId}
            roadmapId={roadmapId}
          >
            {(roadmap) => (
              <AmendmentDecision
                key={`${roadmap.id}:${roadmap.definition.revision}`}
                workspaceId={workspaceId}
                roadmap={roadmap}
                csrfToken={csrfToken}
                canMutate={canMutate}
              />
            )}
          </RoadmapAmendments>
        ) : undefined;
      case 'run':
        return runId !== undefined ? (
          <p>
            <Link
              className="text-button"
              route={{ name: 'run', workspaceId, runId: runId as AgentRunId }}
            >
              Open the run
            </Link>
          </p>
        ) : undefined;
      case 'storage':
        return isOwner ? (
          <StoragePanel workspaceId={workspaceId} csrfToken={csrfToken} />
        ) : undefined;
      case 'acknowledge':
        return (
          <AcknowledgeMoves
            workspaceId={workspaceId}
            moveIds={item.members ?? []}
            csrfToken={csrfToken}
            canMutate={canMutate}
            onDone={() => store.refreshNow([queryKeys.attention(workspaceId)])}
          />
        );
      case 'roadmap': {
        if (roadmapId === undefined) return undefined;
        const partFocus = roadmapPartFocus(roadmapId, decision.part);
        return (
          <RoadmapPage
            key={`inbox-${item.id}`}
            workspaceId={workspaceId}
            roadmapId={roadmapId}
            tab="all"
            part={decision.part}
            csrfToken={csrfToken}
            canMutate={canMutate}
            onOpenWorkItem={(id) => go({ name: 'work-item', workspaceId, workItemId: id })}
            attention={attention}
            onOpenAttention={(id) => go({ name: 'inbox', workspaceId, itemId: id })}
            {...(partFocus ? { focus: partFocus } : {})}
          />
        );
      }
    }
  };
  return (
    <Fragment key={item.id}>
      {decisionsFor(item).map((decision, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an item's decisions are fixed by its code.
        <Fragment key={index}>{render(decision)}</Fragment>
      ))}
    </Fragment>
  );
}
