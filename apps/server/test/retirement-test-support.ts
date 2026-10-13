import { randomUUID } from 'node:crypto';
import {
  asRoadmapId,
  asRoadmapWindDownId,
  type PlanVersionId,
  type RetirementDisposition,
  type UserId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';

/**
 * Retires a plan version as a settled wind-down would (R-B11): a stopped roadmap of its own, its
 * settled record and the retirement. For gate tests that need a retired version without the
 * roadmap that ran it.
 */
export function retireVersion(
  storage: CraftingTableStorage,
  workspaceId: WorkspaceId,
  userId: UserId,
  planVersionId: PlanVersionId,
  disposition: RetirementDisposition = 'superseded',
): void {
  const at = new Date().toISOString();
  const roadmapId = asRoadmapId(randomUUID());
  const windDownId = asRoadmapWindDownId(randomUUID());
  storage.transaction((tx) => {
    tx.roadmaps.save(
      {
        id: roadmapId,
        workspaceId,
        version: 1,
        status: 'stopped',
        reason: 'Stopped',
        createdAt: at,
        updatedAt: at,
        createdByUserId: userId,
        attempts: [],
        definition: {
          roadmapId,
          revision: 1,
          name: 'Retired plan',
          entries: [],
          createdAt: at,
          createdByUserId: userId,
        },
      },
      0,
    );
    tx.windDowns.insert({
      id: windDownId,
      workspaceId,
      roadmapId,
      version: 1,
      status: 'settled',
      retire: [{ planVersionId, disposition }],
      abandonResolutions: [],
      previewDigest: '0'.repeat(64),
      requestedAt: at,
      requestedByUserId: userId,
      startedAt: at,
      settledAt: at,
    });
    tx.windDowns.retire({
      workspaceId,
      planVersionId,
      disposition,
      windDownId,
      retiredAt: at,
      retiredByUserId: userId,
    });
  });
}
