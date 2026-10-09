import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  changedInputs,
  planAcceptanceInputs,
  planInputsDigest,
} from '../../src/services/plan-acceptance-policy.js';

// The saved facts as `collectSavedPlanSnapshot` builds them, cut down to what the inputs read
// plus the fields that must not count (R-C6 D1).
const facts = () => ({
  map: {
    id: 'definition',
    digest: 'a'.repeat(64),
    sourceArchives: [
      { alias: 'aq', revision: 'r1', role: 'implemented_upstream' },
      { alias: 'wi', revision: 'r5', role: 'planned_application' },
    ],
  },
  binding: { revision: 4, createdAt: '2026-09-17T00:00:00.000Z', bindings: [{ alias: 'aq' }] },
  planArchives: [{ alias: 'wi', planVersionId: 'plan-1' }],
  adoption: {
    id: 'adoption-1',
    decisionIds: ['CS-D02', 'CS-D01'],
    rationale: 'Agreed.',
    createdAt: '2026-09-17T01:00:00.000Z',
  },
  architectureStaging: [
    {
      id: 'staged-1',
      subject: { kind: 'checkpoint', sourceId: 'WI-ADR-012' },
      architectureDecision: { coverage: 'clauses', consumers: [{ sliceId: 'wi/a' }] },
      createdAt: '2026-09-19T00:00:00.000Z',
    },
  ],
  runtime: {
    id: 'runtime-9',
    generation: 9,
    createdAt: '2026-10-01T00:00:00.000Z',
    environments: [{ id: 'local' }],
    consumers: [
      { alias: 'wi', upstreams: ['aq'] },
      { alias: 'exo', upstreams: ['wi', 'aq'] },
    ],
    pins: [
      {
        alias: 'wi',
        ref: 'wi-fabric-2',
        commitSha: '1'.repeat(40),
        packages: [{ name: 'wi', path: '.' }],
      },
      {
        alias: 'aq',
        ref: 'main',
        commitSha: '2'.repeat(40),
        conformanceRevision: '16',
        packages: [
          { name: 'aq_b', path: 'b' },
          { name: 'aq_a', path: 'a' },
        ],
      },
    ],
  },
  roadmap: {
    revision: 11,
    name: 'Cross-project roadmap',
    createdAt: '2026-09-19T00:00:00.000Z',
    crossProject: {
      targetId: 'FULL-STACK-RELEASE',
      selection: 'prioritize-full',
      parentAcceptance: 'manual',
    },
    scheduling: { mode: 'parallel', maxInFlight: 4 },
    entries: [
      {
        id: 'entry-2',
        workItemId: 'item-wi',
        executionScope: { kind: 'slice', sourceId: 'wi/b' },
        reviewerRoles: ['security', 'maintainer'],
        instructions: 'Keep scope.',
        profiles: { implement: { model: 'a' } },
        policy: { maxReviewRounds: 2 },
        automation: { integrationMerge: 'manual' },
      },
      {
        id: 'entry-1',
        workItemId: 'item-wi',
        executionScope: { kind: 'slice', sourceId: 'wi/a' },
        instructions: 'Keep scope.',
      },
    ],
  },
  resources: {
    profiles: [{ id: 'isolated' }],
    locks: [{ id: 'wi-target-branch' }],
    developmentCapacity: 4,
    verificationCapacity: 3,
  },
});
type Facts = ReturnType<typeof facts>;
const inputs = (change: (f: Facts) => void = () => undefined) => {
  const f = facts();
  change(f);
  return planAcceptanceInputs(f);
};

describe('canonical JSON', () => {
  it('sorts keys at every depth and leaves out undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: undefined, w: null }], c: 'é' } })).toBe(
      '{"a":{"c":"é","d":[2,{"w":null,"y":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    // Arrays keep their order; an undefined member is null, as in JSON.
    expect(canonicalJson([undefined, 'a'])).toBe('[null,"a"]');
  });
});

describe('plan-acceptance inputs (R-C6 D1)', () => {
  it('reads exactly the inputs the checkpoint covers', () => {
    expect(inputs()).toEqual({
      map: facts().map,
      binding: facts().binding,
      planArchives: facts().planArchives,
      adoptedDecisions: ['CS-D01', 'CS-D02'],
      stagedDecisions: [
        {
          id: 'staged-1',
          checkpoint: 'WI-ADR-012',
          decision: { coverage: 'clauses', consumers: [{ sliceId: 'wi/a' }] },
        },
      ],
      reviewerRoles: [
        { entry: 'slice:wi/a', roles: [] },
        { entry: 'slice:wi/b', roles: ['maintainer', 'security'] },
      ],
      target: { targetId: 'FULL-STACK-RELEASE', selection: 'prioritize-full' },
      resources: { profiles: [{ id: 'isolated' }], locks: [{ id: 'wi-target-branch' }] },
      upstreamPins: {
        pins: [
          {
            alias: 'aq',
            commitSha: '2'.repeat(40),
            conformanceRevision: '16',
            packages: [
              { name: 'aq_a', path: 'a' },
              { name: 'aq_b', path: 'b' },
            ],
          },
        ],
        // Each consumer's supply of implemented upstreams (operator, 2026-10-08, R-C6 OD2).
        supply: [
          { consumer: 'exo', upstreams: ['aq'] },
          { consumer: 'wi', upstreams: ['aq'] },
        ],
      },
    });
  });

  // Done-when (a): none of these re-opens plan acceptance.
  it.each<[string, (f: Facts) => void]>([
    [
      'the roadmap name and revision',
      (f) => Object.assign(f.roadmap, { name: 'Renamed', revision: 12 }),
    ],
    ['instructions', (f) => Object.assign(f.roadmap.entries[0]!, { instructions: 'New.' })],
    [
      'model profiles',
      (f) => Object.assign(f.roadmap.entries[0]!, { profiles: { implement: { model: 'b' } } }),
    ],
    [
      'entry policy',
      (f) => Object.assign(f.roadmap.entries[0]!, { policy: { maxReviewRounds: 5 } }),
    ],
    [
      'automation',
      (f) =>
        Object.assign(f.roadmap.entries[0]!, { automation: { integrationMerge: 'automatic' } }),
    ],
    [
      'parent acceptance policy',
      (f) => Object.assign(f.roadmap.crossProject, { parentAcceptance: 'automatic' }),
    ],
    ['roadmap scheduling', (f) => Object.assign(f.roadmap.scheduling, { maxInFlight: 1 })],
    ['timestamps', (f) => Object.assign(f.roadmap, { createdAt: '2026-10-08T00:00:00.000Z' })],
    [
      'a new adoption of the same proposals',
      (f) =>
        Object.assign(f.adoption, {
          id: 'adoption-2',
          decisionIds: ['CS-D01', 'CS-D02'],
          createdAt: 'later',
        }),
    ],
    [
      'a consumer integration pin',
      (f) => Object.assign(f.runtime.pins[0]!, { commitSha: '3'.repeat(40) }),
    ],
    [
      'the runtime generation',
      (f) => Object.assign(f.runtime, { id: 'runtime-10', generation: 10, environments: [] }),
    ],
    [
      'an upstream ref name at the same commit',
      (f) => Object.assign(f.runtime.pins[1]!, { ref: 'release' }),
    ],
    [
      'a consumer link to a planned application, and supply order',
      (f) => {
        f.runtime.consumers[1]!.upstreams = ['aq'];
        f.runtime.consumers.reverse();
      },
    ],
    [
      'host capacities',
      (f) => Object.assign(f.resources, { developmentCapacity: 1, verificationCapacity: 1 }),
    ],
    [
      'entry order and role order',
      (f) => {
        f.roadmap.entries.reverse();
        f.roadmap.entries[1]!.reviewerRoles = ['maintainer', 'security'];
      },
    ],
  ])('ignores %s', (_label, change) => {
    expect(changedInputs(inputs(), inputs(change))).toEqual([]);
    expect(planInputsDigest(inputs(change))).toBe(planInputsDigest(inputs()));
  });

  // Done-when (b): each of these does.
  it.each<[string, (f: Facts) => void, string]>([
    [
      'reviewer roles',
      (f) => Object.assign(f.roadmap.entries[1]!, { reviewerRoles: ['maintainer'] }),
      'reviewerRoles',
    ],
    [
      'the target',
      (f) => Object.assign(f.roadmap.crossProject, { targetId: 'WI-PROOF' }),
      'target',
    ],
    [
      'the selection',
      (f) => Object.assign(f.roadmap.crossProject, { selection: 'target-only' }),
      'target',
    ],
    [
      'adopted decisions',
      (f) => Object.assign(f.adoption, { decisionIds: ['CS-D01'] }),
      'adoptedDecisions',
    ],
    [
      'a clause approval',
      (f) => f.architectureStaging.push({ ...f.architectureStaging[0]!, id: 'staged-2' }),
      'stagedDecisions',
    ],
    [
      'the implemented-upstream pin',
      (f) => Object.assign(f.runtime.pins[1]!, { commitSha: '4'.repeat(40) }),
      'upstreamPins',
    ],
    [
      'a consumer no longer taking an implemented upstream another still takes',
      (f) => Object.assign(f.runtime.consumers[0]!, { upstreams: [] }),
      'upstreamPins',
    ],
    ['the map', (f) => Object.assign(f.map, { digest: 'b'.repeat(64) }), 'map'],
    ['the binding', (f) => Object.assign(f.binding, { revision: 5 }), 'binding'],
    [
      'the plan archives',
      (f) => Object.assign(f.planArchives[0]!, { planVersionId: 'plan-2' }),
      'planArchives',
    ],
    [
      'resource locks',
      (f) => Object.assign(f.resources.locks[0]!, { id: 'exo-target-branch' }),
      'resources',
    ],
  ])('re-opens for %s', (_label, change, key) => {
    expect(changedInputs(inputs(), inputs(change))).toEqual([key]);
    expect(planInputsDigest(inputs(change))).not.toBe(planInputsDigest(inputs()));
  });

  it('reads a consumer that takes two implemented upstreams in any order the same', () => {
    const twoUpstreams = (upstreams: string[]) =>
      inputs((f) => {
        f.map.sourceArchives.push({ alias: 'aq2', revision: 'r1', role: 'implemented_upstream' });
        f.runtime.consumers[0]!.upstreams = upstreams;
      });
    expect(planInputsDigest(twoUpstreams(['aq2', 'aq']))).toBe(
      planInputsDigest(twoUpstreams(['aq', 'aq2'])),
    );
    expect(twoUpstreams(['aq2', 'aq']).upstreamPins).toMatchObject({
      supply: expect.arrayContaining([{ consumer: 'wi', upstreams: ['aq', 'aq2'] }]),
    });
  });

  it('keys an entry without an execution scope by its id and work item', () => {
    const unscoped = (workItemId: string) =>
      inputs((f) => {
        f.roadmap.entries[1] = { id: 'entry-1', workItemId, instructions: 'Keep scope.' } as never;
      });
    expect(changedInputs(unscoped('item-a'), unscoped('item-b'))).toEqual(['reviewerRoles']);
  });

  it('reads facts recorded as JSON the same as the live facts', () => {
    const recorded = JSON.parse(JSON.stringify(facts())) as Facts;
    expect(planInputsDigest(planAcceptanceInputs(recorded))).toBe(planInputsDigest(inputs()));
  });
});
