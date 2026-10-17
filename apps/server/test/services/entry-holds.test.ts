import { ROADMAP_ATTENTION_CODES, roadmapAttention } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { lastChange } from '../../src/services/cross-project-service.js';
import { REFUSAL_STOPS } from '../../src/services/errors.js';
import {
  cycleCarriesOn,
  gatePhase,
  HOLD_RELEASE,
  type HoldOrigin,
  heldEntry,
  holdCheck,
  holdOrigin,
  holdRelease,
  phaseGateClears,
  selfReverification,
  roadmapHeld,
  stopCheck,
} from '../../src/services/entry-holds.js';

/** R-C10's follow-up: which stored stops and holds the scheduler may clear by itself. */
describe('HOLD_RELEASE', () => {
  it('classifies every roadmap stop code and every typed cause, and fails on one left out', () => {
    for (const code of ROADMAP_ATTENTION_CODES)
      expect(Object.hasOwn(HOLD_RELEASE.codes, code), `stop code ${code}`).toBe(true);
    for (const cause of REFUSAL_STOPS)
      expect(Object.hasOwn(HOLD_RELEASE.causes, cause), `cause ${cause}`).toBe(true);
    // Nothing classified that is no longer a code or a cause.
    expect(Object.keys(HOLD_RELEASE.codes).toSorted()).toEqual(
      [...ROADMAP_ATTENTION_CODES].toSorted(),
    );
    expect(Object.keys(HOLD_RELEASE.causes).toSorted()).toEqual([...REFUSAL_STOPS].toSorted());
  });

  it('clears by itself exactly the kinds the decisions name; every other stop is the operator’s', () => {
    const released: string[] = [];
    const origins: HoldOrigin[] = [
      { kind: 'pause' as const },
      { kind: 'adoption' as const },
      { kind: 'unattributed' as const },
      ...ROADMAP_ATTENTION_CODES.flatMap((code) => [
        { kind: 'stop' as const, code },
        ...REFUSAL_STOPS.map((cause) => ({ kind: 'stop' as const, code, cause })),
      ]),
    ];
    for (const origin of origins) {
      const release = holdRelease(origin);
      if ('fact' in release)
        released.push(
          origin.kind === 'stop'
            ? `${origin.code}${origin.cause ? `/${origin.cause}` : ''}:${release.fact}`
            : origin.kind,
        );
      else expect(release.because.length).toBeGreaterThan(0);
    }
    const byCause = (code: string) => [
      `${code}/phase-gate:phase-gate`,
      `${code}/predecessor-merge-missing:predecessor-merge`,
    ];
    // A code that names its own fact keeps it, unless its cause is one the operator owns (an
    // item the item gate refuses, increment 2 review L-1).
    const own = (code: string, name: string) => [
      `${code}:${name}`,
      `${code}/phase-gate:${name}`,
      `${code}/predecessor-merge-missing:${name}`,
    ];
    expect(released.toSorted()).toEqual(
      [
        ...own('entry-blocked', 'blocker'),
        ...own('evidence-not-current', 'reverify'),
        ...own('cycle-needs-attention', 'cycle'),
        ...byCause('scheduler-error'),
        ...byCause('entry-preparation-failed'),
      ].toSorted(),
    );
  });

  it('leaves a cause it does not know to the operator, whatever the code (review N-2)', () => {
    expect(
      holdRelease({ kind: 'stop', code: 'scheduler-error', cause: 'step-incomplete' }),
    ).toMatchObject({ operator: true });
    expect(
      holdRelease({ kind: 'stop', code: 'entry-blocked', cause: 'item-unavailable' }),
    ).toMatchObject({ operator: true });
    // A code with its own fact does not release on a cause the table does not know.
    expect(
      holdRelease({ kind: 'stop', code: 'entry-blocked', cause: 'step-incomplete' }),
    ).toMatchObject({ operator: true });
  });

  it('leaves a refusal without a typed cause to the operator', () =>
    expect(holdRelease({ kind: 'stop', code: 'entry-preparation-failed' })).toMatchObject({
      operator: true,
    }));
});

describe('the phase gate a hold asks again (increment 4)', () => {
  it('asks a slice’s start before its cycle exists, its merge after', () => {
    expect(gatePhase({ kind: 'slice' }, false)).toBe('start');
    expect(gatePhase({ kind: 'slice' }, true)).toBe('merge');
    expect(gatePhase({ kind: 'slice-verification' }, true)).toBe('verify');
    expect(gatePhase({ kind: 'parent-acceptance' }, false)).toBe('accept');
  });
  it('clears once every blocker left waits, and not while one stops', () => {
    const blocker = (code: 'binding-changed' | 'slice-not-merged') => ({
      kind: 'dependency' as const,
      code,
      message: code,
    });
    expect(phaseGateClears([])).toBe(true);
    expect(phaseGateClears([blocker('slice-not-merged')])).toBe(true);
    expect(phaseGateClears([blocker('slice-not-merged'), blocker('binding-changed')])).toBe(false);
  });
});

describe('the cycle a stored cycle-needs-attention stop waits on (increment 4 review LOW-2)', () => {
  it('carries on once its cycle runs or is at its merge, or its entry completed', () => {
    expect(cycleCarriesOn('running', false)).toBe(true);
    expect(cycleCarriesOn('awaiting-merge', false)).toBe(true);
    expect(cycleCarriesOn(undefined, true)).toBe(true);
    expect(cycleCarriesOn('stopped', true)).toBe(true);
    for (const status of ['needs-attention', 'paused', 'stopped', 'completed'] as const)
      expect(cycleCarriesOn(status, false)).toBe(false);
    expect(cycleCarriesOn(undefined, false)).toBe(false);
  });
});

describe('lastChange, the settle window’s time (increment 5)', () => {
  const decision = (submissionId: string, outcome: 'accepted' | 'rejected', decidedAt: string) => ({
    submissionId: submissionId as never,
    outcome,
    decidedAt,
  });
  it('is the latest acceptance of the scope’s own decisions, or the policy’s adoption if later', () => {
    const decisions = [
      decision('mine', 'accepted', '2026-10-16T10:00:00.000Z'),
      decision('mine', 'rejected', '2026-10-16T12:00:00.000Z'),
      decision('other', 'accepted', '2026-10-16T13:00:00.000Z'),
    ];
    expect(lastChange(['mine'], decisions, undefined)).toBe('2026-10-16T10:00:00.000Z');
    expect(lastChange(['mine'], decisions, '2026-10-16T11:00:00.000Z')).toBe(
      '2026-10-16T11:00:00.000Z',
    );
    expect(lastChange(['mine'], decisions, '2026-10-16T09:00:00.000Z')).toBe(
      '2026-10-16T10:00:00.000Z',
    );
    expect(lastChange([], decisions, undefined)).toBeUndefined();
  });
});

describe('selfReverification (increment 5, decision 4)', () => {
  const now = new Date('2026-10-16T12:00:00.000Z');
  const reverifies = {
    granted: true,
    inPlace: true,
    automatic: true,
    reasons: ['repository-policy'],
    receiptRunId: 'run-1',
    sourceRunId: 'run-1',
    changedAt: '2026-10-16T11:50:00.000Z',
    now,
  };
  it('re-verifies only when every condition holds', () => {
    expect(selfReverification(reverifies)).toBe('reverifies');
    expect(selfReverification({ ...reverifies, reasons: ['decisions', 'repository-policy'] })).toBe(
      'reverifies',
    );
    expect(selfReverification({ ...reverifies, changedAt: undefined })).toBe('reverifies');
  });
  it('names the first condition that fails', () => {
    expect(selfReverification({ ...reverifies, granted: false })).toBe('not-granted');
    expect(selfReverification({ ...reverifies, inPlace: false })).toBe('not-in-place');
    expect(selfReverification({ ...reverifies, automatic: false })).toBe('not-automatic');
    expect(selfReverification({ ...reverifies, reasons: [] })).toBe('no-reason');
    // Any reason a fresh review does not answer, or the operator did not cause, keeps the hold.
    for (const reason of [
      'binding',
      'native-approval',
      'dependency-environment',
      'no-receipt',
      'merged-again',
      'parent-incomplete',
    ])
      expect(selfReverification({ ...reverifies, reasons: ['decisions', reason] })).toBe(
        'reason-not-answered',
      );
    // Approvals settle for ten minutes: 9:59 is not enough, 10:00 is.
    expect(selfReverification({ ...reverifies, changedAt: '2026-10-16T11:50:01.000Z' })).toBe(
      'settling',
    );
    expect(selfReverification({ ...reverifies, changedAt: '2026-10-16T11:50:00.000Z' })).toBe(
      'reverifies',
    );
    // Once per stale review run: one is already queued for it, or the stale receipt is not its own.
    expect(selfReverification({ ...reverifies, reverifiedRunId: 'run-1' })).toBe(
      'already-reverified',
    );
    expect(selfReverification({ ...reverifies, reverifiedRunId: 'run-0' })).toBe('reverifies');
    expect(selfReverification({ ...reverifies, receiptRunId: 'run-0' })).toBe('already-reverified');
    expect(selfReverification({ ...reverifies, receiptRunId: undefined })).toBe(
      'already-reverified',
    );
  });
  it('leaves a stale-evidence hold naming another entry to the operator (review NIT-1)', () => {
    const hold = (entryId?: string) => ({
      status: 'needs-attention' as const,
      reason: 'Held.',
      attention: roadmapAttention(
        'evidence-not-current',
        entryId ? { entryId: entryId as never } : undefined,
      ),
    });
    expect(holdCheck('review', hold())).toEqual({
      fact: 'reverify',
      entryId: 'review',
      asRound: false,
    });
    expect(holdCheck('review', hold('other'))).toBeUndefined();
  });
  it('leaves a roadmap’s own stop for stale evidence to the operator', () => {
    expect(
      stopCheck(roadmapAttention('evidence-not-current', { entryId: 'review' as never })),
    ).toBeUndefined();
  });
});

describe('holdOrigin (increment 2 review M-2)', () => {
  const needs = (code: Parameters<typeof roadmapAttention>[0], refs?: object) => ({
    status: 'needs-attention' as const,
    reason: 'Held.',
    attention: roadmapAttention(code, refs as never),
  });
  it('tells a stored hold’s origin from what it records, never from its text', () => {
    expect(holdOrigin('e', { status: 'paused', reason: 'Item paused by operator.' })).toEqual({
      kind: 'pause',
    });
    // A failed adoption is the one hold that names a cycle.
    expect(
      holdOrigin('e', needs('entry-preparation-failed', { entryId: 'e', cycleId: 'repair' })),
    ).toEqual({ kind: 'adoption' });
    // LIVE-06's stored hold (2026-09-30d) names its own entry, not the round's owner.
    expect(holdOrigin('e', needs('entry-blocked', { entryId: 'e' }))).toEqual({
      kind: 'unattributed',
    });
    expect(holdRelease(holdOrigin('e', needs('entry-blocked', { entryId: 'e' })))).toMatchObject({
      operator: true,
    });
    // A hold of its own gate names none; a round's hold names the owner it was asked of.
    expect(holdOrigin('e', needs('entry-blocked'))).toEqual({
      kind: 'stop',
      code: 'entry-blocked',
      cause: undefined,
    });
    expect(holdOrigin('e', needs('entry-blocked', { entryId: 'owner' }))).toMatchObject({
      kind: 'stop',
      code: 'entry-blocked',
    });
    expect(
      holdOrigin('e', needs('entry-preparation-failed', { cause: 'predecessor-merge-missing' })),
    ).toEqual({
      kind: 'stop',
      code: 'entry-preparation-failed',
      cause: 'predecessor-merge-missing',
    });
    // A hold stored before codes is legacy, the operator's.
    expect(holdOrigin('e', { status: 'needs-attention', reason: 'Old.' })).toEqual({
      kind: 'stop',
      code: 'legacy-attention',
      cause: undefined,
    });
  });
});

describe('holdCheck and stopCheck (increment 4)', () => {
  const needs = (code: Parameters<typeof roadmapAttention>[0], refs?: object) => ({
    status: 'needs-attention' as const,
    reason: 'Held.',
    attention: roadmapAttention(code, refs as never),
  });
  it('asks a hold’s gate of the entry it names, as a round for a round’s owner', () => {
    expect(holdCheck('e', needs('entry-blocked'))).toEqual({
      fact: 'blocker',
      entryId: 'e',
      asRound: false,
    });
    expect(holdCheck('e', needs('entry-blocked', { entryId: 'owner' }))).toEqual({
      fact: 'blocker',
      entryId: 'owner',
      asRound: true,
    });
    expect(
      holdCheck('e', needs('entry-preparation-failed', { cause: 'phase-gate', entryId: 'target' })),
    ).toEqual({ fact: 'phase-gate', entryId: 'target', asRound: true });
    // A predecessor's merge stored naming its own entry is asked of that entry.
    expect(
      holdCheck(
        'e',
        needs('entry-preparation-failed', { cause: 'predecessor-merge-missing', entryId: 'e' }),
      ),
    ).toEqual({ fact: 'predecessor-merge', entryId: 'e', asRound: false });
    expect(holdCheck('e', needs('evidence-not-current'))?.fact).toBe('reverify');
  });
  it('asks nothing of what stays the operator’s', () => {
    expect(holdCheck('e', needs('entry-blocked', { entryId: 'e' }))).toBeUndefined();
    expect(
      holdCheck('e', needs('entry-preparation-failed', { cause: 'phase-gate', cycleId: 'c' })),
    ).toBeUndefined();
    expect(holdCheck('e', { status: 'paused', reason: 'Paused.' })).toBeUndefined();
    expect(holdCheck('e', needs('recovery-not-converging'))).toBeUndefined();
    expect(holdCheck('e', needs('entry-preparation-failed'))).toBeUndefined();
  });
  it('asks a roadmap’s stop of the entry, and the cycle, it names', () => {
    expect(stopCheck(roadmapAttention('entry-blocked', { entryId: 'e' as never }))).toEqual({
      fact: 'blocker',
      entryId: 'e',
      asRound: false,
    });
    expect(
      stopCheck(
        roadmapAttention('cycle-needs-attention', { entryId: 'e' as never, cycleId: 'c' as never }),
      ),
    ).toEqual({ fact: 'cycle', entryId: 'e', asRound: false, cycleId: 'c' });
    expect(
      stopCheck(roadmapAttention('scheduler-error', { entryId: 'e' as never, cause: 'phase-gate' }))
        ?.fact,
    ).toBe('phase-gate');
    // A stop that names no entry, or a cycle stop without its cycle, stays the operator's.
    expect(stopCheck(roadmapAttention('scheduler-error', { cause: 'phase-gate' }))).toBeUndefined();
    expect(stopCheck(roadmapAttention('restart-resume'))).toBeUndefined();
    expect(
      stopCheck(roadmapAttention('cycle-needs-attention', { entryId: 'e' as never })),
    ).toBeUndefined();
    expect(stopCheck(undefined)).toBeUndefined();
  });
});

describe('heldEntry (decision 3)', () => {
  const sequential = {
    scheduling: {
      mode: 'sequential' as const,
      maxInFlight: 1,
      maxPerRepository: 1,
      maxIntegrationRefreshes: 1,
    },
  };
  const stopped = (code: Parameters<typeof roadmapAttention>[0], entryId?: string) => ({
    definition: sequential,
    status: 'needs-attention' as const,
    reason: 'Stopped.',
    attention: roadmapAttention(code, entryId ? { entryId: entryId as never } : undefined),
  });

  it('reads a sequential roadmap’s stop on an entry as that entry’s hold', () => {
    expect(heldEntry(stopped('evidence-not-current', 'e'), 'e')).toEqual({
      status: 'needs-attention',
      reason: 'Stopped.',
      attention: roadmapAttention('evidence-not-current', { entryId: 'e' as never }),
    });
    expect(heldEntry(stopped('scheduler-error', 'e'), 'e')?.attention?.code).toBe(
      'scheduler-error',
    );
    // Another entry, a stop that names none, or the cycle's own stop is no hold of this entry.
    expect(heldEntry(stopped('evidence-not-current', 'e'), 'f')).toBeUndefined();
    expect(heldEntry(stopped('restart-resume'), 'e')).toBeUndefined();
    expect(heldEntry(stopped('cycle-needs-attention', 'e'), 'e')).toBeUndefined();
  });

  it('reads a stored hold first, and a parallel roadmap’s stop as no hold', () => {
    const hold = { status: 'paused' as const, reason: 'Item paused by operator.' };
    expect(heldEntry({ ...stopped('entry-blocked', 'e'), entryHolds: { e: hold } }, 'e')).toBe(
      hold,
    );
    expect(
      heldEntry(
        {
          ...stopped('entry-blocked', 'e'),
          definition: { scheduling: { ...sequential.scheduling, mode: 'parallel' } },
        },
        'e',
      ),
    ).toBeUndefined();
    expect(heldEntry({ ...stopped('entry-blocked', 'e'), status: 'running' }, 'e')).toBeUndefined();
  });
});

describe('roadmapHeld', () => {
  const roadmap = (status: 'running' | 'stopped' | 'completed' = 'running') => ({
    id: 'r' as never,
    workspaceId: 'w' as never,
    status,
    definition: { entries: [{ planVersionId: 'v1' as never }, { planVersionId: 'v2' as never }] },
  });
  const tx = (
    facts: { settling?: boolean; amendment?: boolean; retired?: string; retiring?: string } = {},
  ) =>
    ({
      windDowns: {
        find: () => (facts.settling ? { status: 'settling' } : undefined),
        retirement: (_ws: string, version: string) =>
          version === facts.retired ? { planVersionId: version } : undefined,
        settling: () =>
          facts.retiring ? [{ workspaceId: 'w', retire: [{ planVersionId: facts.retiring }] }] : [],
      },
      amendments: { pending: () => (facts.amendment ? { id: 'a' } : undefined) },
    }) as never;

  it('names what holds a whole roadmap, in order, and nothing for a roadmap free to go on', () => {
    expect(roadmapHeld(tx(), roadmap())).toBeUndefined();
    expect(roadmapHeld(tx({ settling: true }), roadmap('stopped'))).toBe('ended');
    expect(roadmapHeld(tx(), roadmap('completed'))).toBe('ended');
    expect(roadmapHeld(tx({ settling: true, amendment: true }), roadmap())).toBe('settling');
    expect(roadmapHeld(tx({ amendment: true }), roadmap())).toBe('amendment-pending');
    expect(roadmapHeld(tx({ retired: 'v2' }), roadmap())).toBe('version-retired');
    expect(roadmapHeld(tx({ retiring: 'v1' }), roadmap())).toBe('version-retired');
  });

  it('asks only the entry’s own plan version when given one', () => {
    expect(
      roadmapHeld(tx({ retired: 'v2' }), roadmap(), { planVersionId: 'v1' as never }),
    ).toBeUndefined();
    expect(roadmapHeld(tx({ retired: 'v2' }), roadmap(), { planVersionId: 'v2' as never })).toBe(
      'version-retired',
    );
  });
});
