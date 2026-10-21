import { expect, it } from 'vitest';
import type {
  ConcurrencyDefinition,
  EvidenceSubmissionHead,
  Worktree,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import {
  decisionAffectedTrees,
  decisionApprovalWaits,
  decisionTreeWork,
  type DecisionTreeWork,
} from '../src/services/architecture-decision-policy.js';

/**
 * R-B6 increment 3 (decision 6): approving a shared decision waits only for the work in flight on
 * the trees whose decision packet it changes, as `decisionsForScope` reads a packet.
 */

const requires = (id: string) => [{ kind: 'checkpoint', id, state: 'passed' }];
const slice = (id: string, workItem: string, fields: Record<string, unknown> = {}) => ({
  id,
  work_item: workItem,
  start_requires: [],
  merge_requires: [],
  verify_requires: [],
  ...fields,
});
const definition = {
  id: 'map',
  workspaceId: 'ws',
  source: {
    work_items: [{ id: 'P' }, { id: 'Q' }],
    slices: [
      slice('P/start', 'P', { start_requires: requires('ADR') }),
      slice('P/merge', 'P', { merge_requires: requires('ADR') }),
      slice('Q/verify', 'Q', { verify_requires: requires('ADR') }),
      slice('Q/other', 'Q', { merge_requires: requires('OTHER') }),
      slice('Q/named', 'Q'),
    ],
  },
} as unknown as ConcurrencyDefinition;
const tree = (id: string, kind: string, sourceId: string, fields: Record<string, unknown> = {}) =>
  ({
    id,
    workspaceId: 'ws',
    branchName: `ct/${id}`,
    executionScope: { kind, definitionId: 'map', bindingRevision: 1, sourceId },
    ...fields,
  }) as unknown as Worktree;
const trees = [
  tree('start', 'slice', 'P/start'),
  tree('merge', 'slice', 'P/merge'),
  tree('verify', 'slice-verification', 'Q/verify'),
  tree('other', 'slice', 'Q/other'),
  tree('named', 'slice', 'Q/named'),
  tree('parent-p', 'parent-acceptance', 'P'),
  tree('parent-q', 'parent-acceptance', 'Q'),
  tree('old-binding', 'slice', 'P/merge', {
    executionScope: { kind: 'slice', definitionId: 'map', bindingRevision: 2, sourceId: 'P/merge' },
  }),
  tree('other-map', 'slice', 'P/merge', {
    executionScope: {
      kind: 'slice',
      definitionId: 'map-2',
      bindingRevision: 1,
      sourceId: 'P/merge',
    },
  }),
  tree('manual', 'slice', 'P/merge', { executionScope: undefined }),
];
const affected = (consumers: readonly string[] = [], displacedConsumers: readonly string[] = []) =>
  decisionAffectedTrees(
    {
      execution: { worktrees: { listActive: (ws: string) => (ws === 'ws' ? trees : []) } },
    } as unknown as StorageRepositories,
    definition,
    {
      bindingRevision: 1,
      subject: { kind: 'checkpoint', sourceId: 'ADR' },
      architectureDecision: { consumers: consumers.map((sliceId) => ({ sliceId })) },
    } as unknown as EvidenceSubmissionHead,
    [
      {
        subject: { kind: 'checkpoint', sourceId: 'ADR' },
        architectureDecision: { consumers: displacedConsumers.map((sliceId) => ({ sliceId })) },
      } as unknown as EvidenceSubmissionHead,
    ],
  ).map((t) => t.id);

it('an approval affects the trees of the map’s binding whose slices require its checkpoint, or a clause names', () => {
  // Start, merge and verify requirements; a parent acceptance reads its every slice.
  expect(affected()).toEqual(['start', 'merge', 'verify', 'parent-p', 'parent-q']);
  // A clause decision also reaches the slices it names as consumers, and their parents.
  expect(affected(['Q/named'])).toEqual([
    'start',
    'merge',
    'verify',
    'named',
    'parent-p',
    'parent-q',
  ]);
  // The approval it displaces (the newest of its checkpoint and coverage) leaves its own named
  // consumers' packets too (increment 3 review M-1).
  expect(affected([], ['Q/named'])).toEqual([
    'start',
    'merge',
    'verify',
    'named',
    'parent-p',
    'parent-q',
  ]);
});

it('what an affected tree has in flight holds the approval, each named; a quiet tree holds nothing', () => {
  const quiet: DecisionTreeWork = {
    branchName: 'ct/a',
    liveRun: false,
    launching: false,
    phaseReserved: false,
    mergeReserved: false,
  };
  expect(decisionApprovalWaits([quiet])).toEqual([]);
  const wait = (fields: Partial<DecisionTreeWork>) =>
    decisionApprovalWaits([{ ...quiet, ...fields }]);
  const inputs = 'this decision is one of its inputs.';
  expect(wait({ liveRun: true, phaseReserved: true })).toEqual([
    `Wait for the live run on ct/a to finish, or end the run: ${inputs}`,
  ]);
  expect(wait({ launching: true })).toEqual([
    `Wait for the run being launched on ct/a to finish: ${inputs}`,
  ]);
  expect(wait({ mergeReserved: true, phaseReserved: true })).toEqual([
    `Wait for the merge on ct/a to finish: ${inputs}`,
  ]);
  expect(wait({ phaseReserved: true })).toEqual([
    `Wait for the work holding its phase reservation on ct/a to finish: ${inputs}`,
  ]);
  for (const review of ['checkpoint', 'security', 'reassessment'] as const)
    expect(wait({ review })).toEqual([
      `Wait for the ${review} review on ct/a to finish: ${inputs}`,
    ]);
  expect(wait({ liveRun: true, review: 'checkpoint', mergeReserved: true })).toEqual([
    `Wait for the live run, the checkpoint review and the merge on ct/a to finish, or end the run: ${inputs}`,
  ]);
  // One sentence per tree.
  expect(
    decisionApprovalWaits([
      { ...quiet, liveRun: true },
      quiet,
      { ...quiet, branchName: 'ct/b', launching: true },
    ]),
  ).toHaveLength(2);
});

it('a tree’s work in flight is read from its runs, launches, reservations, merge and cycle', () => {
  const t = tree('t', 'slice', 'P/merge');
  const facts = (fields: {
    live?: number;
    launches?: readonly { workspaceId: string; worktreeId: string }[];
    phases?: readonly { worktreeId: string }[];
    merge?: string;
    review?: string;
    status?: string;
    investigations?: number;
  }) =>
    decisionTreeWork(
      {
        execution: {
          runs: {
            liveForWorktree: () => [
              ...Array.from({ length: fields.live ?? 0 }, () => ({})),
              ...Array.from({ length: fields.investigations ?? 0 }, () => ({
                profileSelection: { investigationId: 'i' },
              })),
            ],
          },
          merges: { latest: () => (fields.merge ? { status: fields.merge } : undefined) },
          cycles: {
            activeForWorktree: () => ({
              status: fields.status ?? 'running',
              ...(fields.review ? { workflow: { activeReview: { kind: fields.review } } } : {}),
            }),
          },
        },
        maintenance: { launchReservations: () => fields.launches ?? [] },
        phaseScheduling: { active: () => fields.phases ?? [] },
      } as unknown as StorageRepositories,
      t,
    );
  expect(facts({})).toEqual({
    branchName: 'ct/t',
    liveRun: false,
    launching: false,
    phaseReserved: false,
    mergeReserved: false,
  });
  expect(facts({ live: 1 }).liveRun).toBe(true);
  // A question stop's investigation freezes no digest (increment 3 review L-4).
  expect(facts({ investigations: 1 }).liveRun).toBe(false);
  expect(facts({ launches: [{ workspaceId: 'ws', worktreeId: 't' }] }).launching).toBe(true);
  expect(facts({ launches: [{ workspaceId: 'ws', worktreeId: 'u' }] }).launching).toBe(false);
  expect(facts({ launches: [{ workspaceId: 'ws-2', worktreeId: 't' }] }).launching).toBe(false);
  expect(facts({ phases: [{ worktreeId: 't' }] }).phaseReserved).toBe(true);
  expect(facts({ phases: [{ worktreeId: 'u' }] }).phaseReserved).toBe(false);
  expect(facts({ merge: 'reserved' }).mergeReserved).toBe(true);
  expect(facts({ merge: 'cleaned' }).mergeReserved).toBe(false);
  expect(facts({ review: 'security' }).review).toBe('security');
  // A review left at a stop holds nothing, unless its session is still live.
  for (const status of ['needs-attention', 'paused'])
    expect(facts({ review: 'checkpoint', status }).review).toBeUndefined();
  expect(facts({ review: 'checkpoint', status: 'paused', live: 1 }).review).toBe('checkpoint');
});
