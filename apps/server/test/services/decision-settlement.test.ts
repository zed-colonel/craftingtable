import type { ConcurrencyDefinition, WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  accepted: false,
  clauses: [] as string[],
  verified: new Set<string>(),
  acceptedParents: new Set<string>(),
  asked: [] as unknown[],
}));
vi.mock('../../src/services/runtime-evidence-policy.js', () => ({
  acceptedEvidence: () => (state.accepted ? { id: 'evidence' } : undefined),
  parentAccepted: (_tx: unknown, _ws: unknown, _d: unknown, _r: unknown, id: string) =>
    state.acceptedParents.has(id),
}));
vi.mock('../../src/services/architecture-decision-policy.js', () => ({
  approvedArchitectureDecisions: () =>
    state.clauses.length
      ? [
          {
            subject: { sourceId: 'ADR-1' },
            architectureDecision: {
              coverage: 'clauses',
              consumers: state.clauses.map((sliceId) => ({ sliceId })),
            },
          },
        ]
      : [],
}));
vi.mock('../../src/services/cross-project-service.js', () => ({
  milestoneSatisfied: (
    _tx: unknown,
    _ws: unknown,
    _d: unknown,
    _r: unknown,
    requirement: { id: string; state: string },
  ) => {
    state.asked.push(requirement);
    return requirement.state === 'verified' && state.verified.has(requirement.id);
  },
}));
const { decisionSettlement, settlementLines } = await import(
  '../../src/services/decision-settlement.js'
);

const needs = { kind: 'checkpoint', id: 'ADR-1', state: 'passed' } as const;
const slice = (id: string, phase: 'start' | 'merge' | 'verify') => ({
  id,
  work_item: 'WI',
  start_requires: phase === 'start' ? [needs] : [],
  merge_requires: phase === 'merge' ? [needs] : [],
  verify_requires: phase === 'verify' ? [needs] : [],
});
const definition = {
  id: 'd',
  source: {
    slices: [
      slice('a', 'start'),
      slice('b', 'merge'),
      slice('c', 'verify'),
      slice('x', 'merge'),
    ].map((s) => (s.id === 'x' ? { ...s, merge_requires: [] } : s)),
    work_items: [
      { id: 'WI', acceptance_requires: [needs] },
      { id: 'OTHER', acceptance_requires: [] },
    ],
  },
} as unknown as ConcurrencyDefinition;
const settle = () =>
  decisionSettlement({} as StorageRepositories, 'ws' as WorkspaceId, definition, 1, 'ADR-1');

beforeEach(() => {
  state.accepted = false;
  state.clauses = [];
  state.verified = new Set();
  state.acceptedParents = new Set();
  state.asked = [];
});

it('lists every consumer as still needing an undecided decision, work items included (LIVE-22)', () => {
  expect(settle()).toEqual({ settledFor: [], stillNeededBy: ['a', 'b', 'c', 'WI'] });
});

it('settles every consumer once the checkpoint has accepted evidence (LIVE-22 review)', () => {
  state.accepted = true;
  state.clauses = ['a'];
  expect(settle()).toEqual({ settledFor: ['a', 'b', 'c', 'WI'], stillNeededBy: [] });
});

it('settles only the slices the clause decision names, never a work item (LIVE-22)', () => {
  state.clauses = ['a', 'x'];
  expect(settle()).toEqual({ settledFor: ['a'], stillNeededBy: ['b', 'c', 'WI'] });
});

it('a started or merged slice still needs it until verified: start and merge gates are checked again later (LIVE-22 review)', () => {
  state.verified = new Set(['b']);
  state.acceptedParents = new Set(['WI']);
  expect(settle().stillNeededBy).toEqual(['a', 'c']);
  expect(state.asked).toEqual(
    ['a', 'b', 'c'].map((id) => ({ kind: 'slice', id, state: 'verified' })),
  );
});

it('names only the roadmap’s selected work, and says so when the need is indirect (LIVE-22 review)', () => {
  const settlement = { settledFor: ['a', 'z'], stillNeededBy: ['b', 'y'] };
  expect(settlementLines(settlement, new Set(['a', 'b']))).toBe(
    'Settled for: a\nStill needed by: b',
  );
  expect(settlementLines(settlement, new Set(['a']))).toBe(
    'Settled for: a\nStill needed by later work that depends on it through other milestones.',
  );
  expect(settlementLines(settlement, new Set(['q']))).toBeUndefined();
});
