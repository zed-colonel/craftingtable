import { nativeHostDigest } from '@craftingtable/agents';
import { replayHost } from './replay-host.js';

/**
 * The digest of the workstation a native approval must name (ADR-054): the live host's, so an
 * approval lapses when the kernel or a native tool changes. A replay runs as the host its goldens
 * were recorded on instead (R-B4b, `controller:replay --host-digest`).
 */
export function workstationDigest(): string {
  return replayHost() ?? nativeHostDigest();
}
