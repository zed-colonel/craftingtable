import type { PhaseBlockerCode, WorkspaceId } from '@craftingtable/domain';
import { buildPath, type Route } from './route.js';

/** The roadmap that owns the blocked scope, or the map it comes from, when known. */
export interface BlockerContext {
  readonly roadmapId?: string | undefined;
  readonly definitionId?: string | undefined;
}

/**
 * Where the operator resolves a phase blocker, rendered as a link beside it (R-A5). Daemon
 * messages state the fact only; the destination comes from the code. Setup is on the owning
 * roadmap's setup page, else on the map's page (R-E2).
 */
export function blockerDestination(
  code: PhaseBlockerCode,
  workspaceId: WorkspaceId,
  context: BlockerContext = {},
): { readonly label: string; readonly href: string } | undefined {
  const setup = (roadmapSection: string, mapSection: string): Route =>
    context.roadmapId !== undefined
      ? {
          name: 'roadmap',
          workspaceId,
          roadmapId: context.roadmapId,
          tab: 'setup',
          focus: roadmapSection.replace('<id>', context.roadmapId),
        }
      : context.definitionId !== undefined
        ? {
            name: 'roadmap-map',
            workspaceId,
            definitionId: context.definitionId,
            focus: mapSection.replace('<id>', context.definitionId),
          }
        : { name: 'roadmaps', workspaceId };
  switch (code) {
    case 'environment-approval':
    case 'resource-unsupported':
    case 'dependency-environment-missing':
    case 'upstream-pin-missing':
      return {
        label: 'Open verification environments',
        href: buildPath(
          setup('runtime-evidence-roadmap-<id>-native', 'runtime-evidence-<id>-native'),
        ),
      };
    case 'reviewer-assignment':
      return {
        label: 'Assign reviewer responsibilities',
        href: buildPath(setup('map-reviewers-roadmap-<id>', 'map-reviewers-<id>')),
      };
    case 'decision-checkpoint-evidence':
    case 'amendment-pending':
      return { label: 'Open Needs you', href: buildPath({ name: 'inbox', workspaceId }) };
    default:
      return undefined;
  }
}
