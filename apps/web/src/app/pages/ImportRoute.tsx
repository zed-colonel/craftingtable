import type { PlanImportResponse, ProjectSummary } from '@craftingtable/contracts';
import { useState } from 'react';
import { ImportPlanPage } from '../../features/planning/ImportPlanPage.js';
import { ApiError } from '../../lib/api-client.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { importPlanBundle, type PlanImportUpload } from '../../lib/planning-api.js';
import { useQueryStore } from '../../lib/query-store.js';
import { useAlive, useGo, useSession, useWorkspaceScope } from '../session.js';

/** Imports a plan bundle; a success opens its project. */
export function ImportRoute({ projects }: { projects: readonly ProjectSummary[] }) {
  const { workspaceId } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const store = useQueryStore();
  const go = useGo();
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlanImportResponse>();
  const [error, setError] = useState<string>();
  /** An import changes the workspace's projects and agenda. */
  const refresh = () =>
    store.refreshNow([
      queryKeys.snapshot(workspaceId),
      ['project', workspaceId],
      ['agenda', workspaceId],
    ]);
  const submit = (upload: PlanImportUpload): void => {
    setBusy(true);
    setResult(undefined);
    setError(undefined);
    void importPlanBundle(workspaceId, upload, csrfToken)
      .then((response) => {
        // An outcome for a workspace no longer shown is dropped (CT03-R2R3).
        if (!alive()) return;
        setResult(response);
        refresh();
        if (response.outcome === 'succeeded')
          go({ name: 'project', workspaceId, projectId: response.projectId });
      })
      .catch((failure: unknown) => {
        if (alive())
          setError(
            failure instanceof ApiError ? failure.message : 'The plan import request failed',
          );
      })
      .finally(() => {
        if (alive()) setBusy(false);
      });
  };
  return (
    <ImportPlanPage
      workspaceId={workspaceId}
      csrfToken={csrfToken}
      onZipImported={refresh}
      projects={projects}
      onImport={submit}
      busy={busy}
      {...(result === undefined ? {} : { result })}
      {...(error === undefined ? {} : { error })}
    />
  );
}
