import {
  operatorSetupOnly,
  type PhaseBlocker,
  type PhaseBlockerCode,
  phaseBlockerCode,
  type RoadmapEntry,
} from '@craftingtable/domain';
import type { ProjectedItem } from './attention-projector.js';

/** Blockers the operator settles in the roadmap's dependency environment step. */
const DEPENDENCY_SETUP: ReadonlySet<PhaseBlockerCode> = new Set([
  'dependency-environment-missing',
  'upstream-pin-missing',
]);

/**
 * A roadmap's setup item (R-A4, R-E3b): every entry held only on the operator's setup
 * (`operatorSetupOnly`: environments, resources, dependency environments, upstream pins,
 * qualification, reviewers), one line per blocker. It opens the dependency step when any of them
 * is a dependency environment's, else verification. The operator's stops have their own items.
 */
export function operatorSetupItem(input: {
  readonly roadmapId: string;
  readonly name: string;
  readonly entries: readonly {
    readonly entry: Pick<RoadmapEntry, 'id' | 'sourceId' | 'executionScope'>;
    readonly blockers: readonly PhaseBlocker[] | undefined;
  }[];
  /** The roadmap's setup path to a section of its dependency and evidence panel. */
  readonly setupPath: (section: string) => string;
}): ProjectedItem | undefined {
  const held = input.entries.filter(({ blockers }) => operatorSetupOnly(blockers));
  if (!held.length) return undefined;
  const members = [...new Set(held.map(({ entry }) => entry.id))].sort();
  const lines = [
    ...new Set(
      held.flatMap(({ entry, blockers }) =>
        blockers!.map((b) => `${entry.executionScope?.sourceId ?? entry.sourceId}: ${b.message}`),
      ),
    ),
  ].sort();
  const dependency = held.some(({ blockers }) =>
    blockers!.some((b) => DEPENDENCY_SETUP.has(phaseBlockerCode(b))),
  );
  return {
    subjectKey: `roadmap:${input.roadmapId}:environments`,
    code: 'verification-setup',
    kind: 'attention',
    title: `${input.name} · Setup needed: reviewers, environments or dependencies`,
    message: lines.join('\n'),
    path: input.setupPath(dependency ? '' : '-native'),
    refs: { roadmapId: input.roadmapId },
    members,
  };
}
