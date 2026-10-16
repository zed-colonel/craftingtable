import { ROADMAP_ATTENTION_CODES, roadmapAttention } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { REFUSAL_STOPS } from '../../src/services/errors.js';
import {
  HOLD_RELEASE,
  type HoldOrigin,
  heldEntry,
  holdRelease,
  roadmapHeld,
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
    // A code that names its own fact keeps it, whatever cause it also records.
    const own = (code: string, name: string) => [
      `${code}:${name}`,
      ...REFUSAL_STOPS.map((cause) => `${code}/${cause}:${name}`),
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

  it('leaves a refusal without a typed cause to the operator', () =>
    expect(holdRelease({ kind: 'stop', code: 'entry-preparation-failed' })).toMatchObject({
      operator: true,
    }));
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
