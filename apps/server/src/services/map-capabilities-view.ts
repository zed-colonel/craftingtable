import type { MapCapabilitiesView } from '@craftingtable/contracts';
import { type ConcurrencySource, mapCapabilities, scopedBuildScope } from '@craftingtable/domain';

/**
 * What the runtime view shows of a map's recognized capabilities (R-F2 part 5): the typed gaps
 * `mapCapabilities` finds, and each slice's build classification (ADR-053), from the map alone.
 * A slice whose upstream links have all moved to their current pins is held to a current
 * upstream build on its tree (ADR-069); the classification here is the map's.
 */
export function mapCapabilitiesView(source: ConcurrencySource): MapCapabilitiesView {
  return {
    gaps: mapCapabilities(source).gaps.map((gap) =>
      structuredClone(gap),
    ) as MapCapabilitiesView['gaps'],
    builds: source.slices.map((slice) => ({
      sliceId: slice.id,
      mode: scopedBuildScope(source, { kind: 'slice', sourceId: slice.id })
        ? 'scoped-checks'
        : 'current-upstream-build',
    })),
  };
}
