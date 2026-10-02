import type { AttentionItemView } from '@craftingtable/contracts';
import type { PlanArtifactId, PlanVersionId, ProjectId } from '@craftingtable/domain';
import { useState } from 'react';
import { decisionsFor } from '../../decisions/registry.js';
import { FinalizationPanel } from '../../features/execution/FinalizationPanel.js';
import { PlanBranchPanel } from '../../features/execution/PlanBranchPanel.js';
import { PlanVersionPage } from '../../features/planning/PlanVersionPage.js';
import { ProjectPage } from '../../features/planning/ProjectPage.js';
import { SourceText } from '../../features/planning/SourceText.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { loadArtifactText } from '../../lib/planning-api.js';
import { useQueryStore } from '../../lib/query-store.js';
import { usePlanVersion, useProject } from '../reads.js';
import { useAlive, useGo, useSession, useWorkspaceScope } from '../session.js';

/** A plan's source artifact, opened from its project or plan version page. */
function useArtifact() {
  const { workspaceId } = useWorkspaceScope();
  const alive = useAlive();
  const [artifact, setArtifact] = useState<{ filename: string; text: string }>();
  const view = (artifactId: PlanArtifactId, filename: string): void => {
    void loadArtifactText(workspaceId, artifactId)
      .then((text) => {
        // An artifact for a page no longer shown is dropped (CT03-R2R3).
        if (alive()) setArtifact({ filename, text });
      })
      .catch(() => {
        if (alive()) setArtifact({ filename, text: 'The source artifact could not be loaded.' });
      });
  };
  const panel = artifact && (
    <section className="panel" aria-label="Source artifact">
      <h3>{artifact.filename}</h3>
      <SourceText text={artifact.text} label={`Source of ${artifact.filename}`} />
    </section>
  );
  return { view, panel };
}

export function ProjectRoute({ projectId }: { projectId: ProjectId }) {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const store = useQueryStore();
  const go = useGo();
  const artifact = useArtifact();
  const detail = useProject(workspaceId, projectId).data;
  if (detail?.project.id !== projectId) return null;
  return (
    <>
      <ProjectPage
        detail={detail}
        branchSettings={
          detail.activeVersion && (
            <PlanBranchPanel
              key={detail.activeVersion.version.id}
              workspaceId={workspaceId}
              planVersionId={detail.activeVersion.version.id}
              csrfToken={csrfToken}
              editable={canMutate}
              onChanged={() => store.refreshNow([queryKeys.project(workspaceId, projectId)])}
            />
          )
        }
        onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
        onOpenVersion={(planVersionId) =>
          go({ name: 'plan-version', workspaceId, projectId, planVersionId })
        }
        onViewArtifact={artifact.view}
      />
      {artifact.panel}
    </>
  );
}

export function PlanVersionRoute({
  projectId,
  planVersionId,
  attention,
}: {
  projectId: ProjectId;
  planVersionId: PlanVersionId;
  attention: readonly AttentionItemView[];
}) {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const store = useQueryStore();
  const go = useGo();
  const artifact = useArtifact();
  const detail = usePlanVersion(workspaceId, projectId, planVersionId).data;
  if (detail?.version.id !== planVersionId) return null;
  return (
    <>
      <PlanVersionPage
        workspaceId={workspaceId}
        detail={detail}
        branchSettings={
          <>
            <PlanBranchPanel
              key={planVersionId}
              workspaceId={workspaceId}
              planVersionId={planVersionId}
              csrfToken={csrfToken}
              editable={canMutate}
              onChanged={() =>
                store.refreshNow([queryKeys.planVersion(workspaceId, projectId, planVersionId)])
              }
            />
            <FinalizationPanel
              key={`finalize-${planVersionId}`}
              workspaceId={workspaceId}
              planVersionId={planVersionId}
              csrfToken={csrfToken}
              canMutate={canMutate}
              onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
              decisionItemFor={(finalizationId, finalizationCycleId) =>
                attention.find(
                  (item) =>
                    (item.refs.finalizationId === finalizationId ||
                      item.refs.cycleId === finalizationCycleId) &&
                    decisionsFor(item).some((d) => d.kind === 'finalization-decision'),
                )?.id
              }
            />
          </>
        }
        onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
        onViewArtifact={artifact.view}
      />
      {artifact.panel}
    </>
  );
}
