import { expect, it } from 'vitest';
import { type DemandNode, slicesWaitingOn } from './decision-demand.js';

const node = (
  key: string,
  requirements: readonly string[] = [],
  changes: Partial<DemandNode> = {},
): DemandNode => ({
  key,
  kind: key.startsWith('slice:')
    ? 'slice'
    : key.startsWith('checkpoint:')
      ? 'checkpoint'
      : 'work_item',
  sourceId: key.split(':')[1]!,
  included: true,
  satisfied: false,
  requirements,
  ...changes,
});

it('counts the distinct unfinished selected slices that wait on a decision, not milestones (R-C3b)', () => {
  const nodes = [
    node('checkpoint:ADR:passed'),
    // Slice a waits on the decision at start; its merge and verification follow from it.
    node('slice:a:started', ['checkpoint:ADR:passed']),
    node('slice:a:merged', ['slice:a:started']),
    node('slice:a:verified', ['slice:a:merged']),
    // Slice b waits on slice a; a finished slice c and an unselected slice d do not count.
    node('slice:b:started', ['slice:a:verified']),
    node('slice:c:started', ['checkpoint:ADR:passed'], { satisfied: true }),
    node('slice:d:started', ['checkpoint:ADR:passed'], { included: false }),
    node('work_item:W:accepted', ['slice:b:started']),
  ];
  expect(slicesWaitingOn(nodes, 'checkpoint:ADR:passed')).toBe(2);
  expect(slicesWaitingOn(nodes, 'slice:b:started')).toBe(0);
});
