import type { PhaseBlocker, RoadmapEntry } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { operatorSetupItem } from '../src/services/operator-setup-item.js';

/**
 * R-E3b (R-A6 handoff e): the roadmap's setup item lists every entry only the operator can move
 * by setup, by the rule the status list uses. In the walkthrough two slices waited on exact
 * upstream pins: the status list put them under Needs you, but the item knew only reviewers and
 * verification environments, so Needs you had nothing for them.
 */

const entry = (id: string, sourceId: string) =>
  ({ id, sourceId, executionScope: { kind: 'slice', sourceId } }) as unknown as RoadmapEntry;
const pin = (alias: string): PhaseBlocker => ({
  kind: 'evidence',
  code: 'upstream-pin-missing',
  message: `wi must use an exact ${alias} upstream pin.`,
});
const setupPath = (section: string) => `/setup#runtime-evidence-roadmap-r${section}`;

it("lists entries held on upstream pins and opens the dependency step (the walkthrough's two slices)", () => {
  const item = operatorSetupItem({
    roadmapId: 'r',
    name: 'Cross-project roadmap',
    setupPath,
    entries: [
      { entry: entry('e1', 'wi/WI-01/implementation'), blockers: [pin('aq')] },
      { entry: entry('e2', 'exo/EXO-01/domain'), blockers: [pin('aq'), pin('wi')] },
      // A controller wait among the blockers: not the operator's alone.
      {
        entry: entry('e3', 'exo/EXO-02/domain'),
        blockers: [pin('aq'), { kind: 'dependency', code: 'slice-not-merged', message: 'Merge.' }],
      },
    ],
  })!;
  expect(item).toMatchObject({
    subjectKey: 'roadmap:r:environments',
    code: 'verification-setup',
    members: ['e1', 'e2'],
    path: '/setup#runtime-evidence-roadmap-r',
    refs: { roadmapId: 'r' },
  });
  expect(item.message.split('\n')).toEqual([
    'exo/EXO-01/domain: wi must use an exact aq upstream pin.',
    'exo/EXO-01/domain: wi must use an exact wi upstream pin.',
    'wi/WI-01/implementation: wi must use an exact aq upstream pin.',
  ]);
});

it('keeps reviewers and environments on the verification step, and raises nothing otherwise', () => {
  const reviewers = operatorSetupItem({
    roadmapId: 'r',
    name: 'Map',
    setupPath,
    entries: [
      {
        entry: entry('e1', 'wi/WI-01/domain'),
        blockers: [{ kind: 'review', code: 'reviewer-assignment', message: 'Assign a reviewer.' }],
      },
    ],
  });
  expect(reviewers?.path).toBe('/setup#runtime-evidence-roadmap-r-native');
  expect(
    operatorSetupItem({
      roadmapId: 'r',
      name: 'Map',
      setupPath,
      entries: [
        { entry: entry('e1', 'a'), blockers: [] },
        { entry: entry('e2', 'b'), blockers: undefined },
        {
          entry: entry('e3', 'c'),
          blockers: [
            {
              kind: 'evidence',
              code: 'decision-checkpoint-evidence',
              message: 'Approve ADR-1.',
              refs: { checkpointId: 'ADR-1' },
            },
          ],
        },
      ],
    }),
  ).toBeUndefined();
});

it("leaves the operator's stops to their own items (R-E3b review M2)", () => {
  expect(
    operatorSetupItem({
      roadmapId: 'r',
      name: 'Map',
      setupPath,
      entries: [
        {
          entry: entry('e1', 'wi/WI-01/domain'),
          blockers: [{ kind: 'authorization', code: 'amendment-pending', message: 'Decide it.' }],
        },
        {
          entry: entry('e2', 'wi/WI-02/domain'),
          blockers: [
            pin('aq'),
            { kind: 'authorization', code: 'binding-superseded', message: 'Rebind.' },
          ],
        },
      ],
    }),
  ).toBeUndefined();
});
