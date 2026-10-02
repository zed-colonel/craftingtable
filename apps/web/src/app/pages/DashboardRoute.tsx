import type { AttentionItemView } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { ActivityPanel } from '../../components/ActivityPanel.js';
import { AuditPanel } from '../../components/AuditPanel.js';
import { NeedsYou } from '../../components/NeedsYou.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { StatusCards } from '../../components/StatusCards.js';
import { RunList } from '../../features/execution/RunsPage.js';
import { ProjectCards } from '../../features/planning/ProjectCards.js';
import { OperatorWaitSection } from '../../features/workspace/OperatorWaitSection.js';
import { isLiveStatus } from '../../lib/execution-labels.js';
import type { WorkspaceProjectionState } from '../../lib/workspace-projection.js';
import { RefreshFailed } from '../RefreshFailed.js';
import { useAudit, useRuns } from '../reads.js';
import { useGo, useWorkspaceScope } from '../session.js';

/** The workspace's dashboard: what needs the operator, live runs, projects and activity. */
export function DashboardRoute({
  projection,
  attention,
  cycles,
}: {
  projection: WorkspaceProjectionState;
  attention: readonly AttentionItemView[];
  cycles: readonly WorkCycle[];
}) {
  const { workspaceId, workspace, isOwner } = useWorkspaceScope();
  const go = useGo();
  // The dashboard reads only live runs; the runs page the recent list (PERF-12).
  const runs = useRuns(workspaceId, 'live');
  // The audit log is owner-only (PERF-12, PERF-15).
  const audit = useAudit(isOwner ? workspaceId : undefined);
  const liveRuns = (runs.data?.runs ?? []).filter((entry) => isLiveStatus(entry.status));
  const count = projection.planningSummary.projectCount;
  return (
    <div className="page">
      <RefreshFailed failed={runs.error !== undefined} />
      <PageHeader
        title={projection.workspace?.name ?? workspace.name}
        subtitle={`${count} project${count === 1 ? '' : 's'}`}
        actions={
          <button
            type="button"
            className="secondary-button"
            onClick={() => go({ name: 'import', workspaceId })}
          >
            Import plan
          </button>
        }
      />
      <NeedsYou items={attention} workspaceId={workspaceId} variant="section" onNavigate={go} />
      <OperatorWaitSection
        workspaceId={workspaceId}
        refreshKey={cycles
          .map(
            (cycle) =>
              `${cycle.id}:${cycle.status}:${cycle.attention?.code ?? ''}:${cycle.attention?.owner ?? ''}`,
          )
          .join(',')}
      />
      <StatusCards
        summary={projection.statusSummary}
        onOpen={(target) => {
          if (target.kind === 'runs') go({ name: 'runs', workspaceId });
          else if (target.kind === 'import') go({ name: 'import', workspaceId });
          else go({ name: 'agenda', workspaceId, filter: target.filter });
        }}
      />
      <Section
        title="Live runs"
        count={liveRuns.length}
        summary={
          liveRuns.length === 0
            ? 'No agent is working right now.'
            : `${liveRuns.filter((entry) => entry.status === 'waiting').length} waiting for you.`
        }
        actions={
          <button
            type="button"
            className="text-button"
            onClick={() => go({ name: 'runs', workspaceId })}
          >
            All runs
          </button>
        }
      >
        <RunList
          runs={liveRuns}
          onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
          onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
        />
      </Section>
      <ProjectCards
        projects={projection.projects}
        onOpen={(projectId) => go({ name: 'project', workspaceId, projectId })}
        onImport={() => go({ name: 'import', workspaceId })}
      />
      <ActivityPanel
        events={projection.events}
        invalidPayloadCount={projection.invalidPayloadCount}
        foreignWorkspaceEventCount={projection.foreignWorkspaceEventCount}
      />
      <AuditPanel records={audit.data?.records ?? []} />
    </div>
  );
}
