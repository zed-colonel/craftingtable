import {
  type CheckDeclarationPreview,
  checkDeclarationPreviewSchema,
  type RepositoryChecksView,
  repositoryChecksViewSchema,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * AdoptChecks' commands (R-A6, R-G13): a checks file's preview and its adoption. Private to this
 * kind: only modules in its directory may import it (R-A6; the operator kept the boundary
 * structural in R-H5's review, 2026-10-11).
 */
const encode = encodeURIComponent;
const checksUrl = (workspaceId: WorkspaceId, repositoryId: string) =>
  `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/checks`;

/** What adopting the repository's checks file at `ref` would record; it changes nothing. */
export function previewChecks(
  workspaceId: WorkspaceId,
  repositoryId: string,
  ref: string,
  csrfToken: string,
): Promise<CheckDeclarationPreview> {
  return request(`${checksUrl(workspaceId, repositoryId)}/preview`, checkDeclarationPreviewSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify({ ref }),
  });
}

/**
 * `decisions/checks/CheckAdoption#AdoptChecks`: adopt the checks file at the commit the operator
 * reviewed (R-G13, R-A6).
 */
export function adoptChecks(
  workspaceId: WorkspaceId,
  repositoryId: string,
  input: { ref: string; expectedCommit: string; rationale: string },
  csrfToken: string,
): Promise<RepositoryChecksView> {
  return request(`${checksUrl(workspaceId, repositoryId)}/adopt`, repositoryChecksViewSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}
