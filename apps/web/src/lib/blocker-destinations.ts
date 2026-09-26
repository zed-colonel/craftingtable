import type { PhaseBlockerCode, WorkspaceId } from '@craftingtable/domain';
import { buildPath } from './route.js';

/**
 * Where the operator resolves a phase blocker, rendered as a link beside it (R-A5). Daemon
 * messages state the fact only; the destination comes from the code.
 */
export function blockerDestination(
  code: PhaseBlockerCode,
  workspaceId: WorkspaceId,
): { readonly label: string; readonly href: string } | undefined {
  switch (code) {
    case 'environment-approval':
    case 'resource-unsupported':
    case 'dependency-environment-missing':
    case 'upstream-pin-missing':
      return {
        label: 'Open verification environments',
        href: buildPath({ name: 'roadmaps', workspaceId }),
      };
    case 'reviewer-assignment':
      return {
        label: 'Assign reviewer responsibilities',
        href: buildPath({ name: 'roadmaps', workspaceId }),
      };
    case 'decision-checkpoint-evidence':
    case 'amendment-pending':
      return { label: 'Open Needs you', href: buildPath({ name: 'inbox', workspaceId }) };
    default:
      return undefined;
  }
}
