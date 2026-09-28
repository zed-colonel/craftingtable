import { readFileSync } from 'node:fs';
import type { FindingSeverity, FindingStatus } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { classifyRecoveryProgress, type RecoveryRoundReport } from './recovery-progress.js';

interface RecordedReview {
  readonly review: string;
  readonly verdict: 'mergeable' | 'changes-requested';
  readonly findings: readonly {
    readonly id: string;
    readonly severity: FindingSeverity;
    readonly status: FindingStatus;
  }[];
}
/** EXO-01's parent-acceptance reviews (HIST-04), redacted to finding identity and state. */
const exo01 = JSON.parse(
  readFileSync(
    new URL(
      '../../../../fixtures/records/exo-01-parent-acceptance-2026-09-18.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { readonly reviewWorktree: string; readonly reviews: readonly RecordedReview[] };
// The reports' substance (explanations, sampled examples) differed every round, so no two
// share a fingerprint: the exact-repeat guard never fired (HIST-04).
const exo01Reports: RecoveryRoundReport[] = exo01.reviews.map((review) => ({
  reviewWorktreeId: exo01.reviewWorktree,
  fingerprint: review.review,
  findings: review.findings,
}));

let reports = 0;
const report = (
  open: readonly (readonly [string, FindingSeverity])[],
  reviewWorktreeId = 'review',
  fingerprint = `report-${++reports}`,
  closed: readonly string[] = [],
): RecoveryRoundReport => ({
  reviewWorktreeId,
  fingerprint,
  findings: [
    ...open.map(([id, severity]) => ({ id, severity, status: 'open' as const })),
    ...closed.map((id) => ({ id, severity: 'major' as const, status: 'resolved' as const })),
  ],
});

describe('recovery progress (R-C5 increment 3, HIST-04)', () => {
  it('a replay of EXO-01 stops after two rounds instead of thirteen', () => {
    const requested = exo01.reviews.filter((r) => r.verdict === 'changes-requested');
    // What happened: 14 reviews asked for changes, so 13 repair rounds ran before F-003 closed.
    expect(
      requested
        .slice(0, 13)
        .every((r) => r.findings.some((f) => f.id === 'F-003' && f.status === 'open')),
    ).toBe(true);
    // The loop as automatic recovery would run it: each finished review is judged with every
    // earlier source report of the same review, and a round starts only while it converges.
    let rounds = 0;
    let escalations = 0;
    for (let reviewed = 1; reviewed <= exo01Reports.length; reviewed++) {
      const progress = classifyRecoveryProgress(exo01Reports.slice(0, reviewed));
      if (!progress.converging) {
        escalations++;
        break;
      }
      rounds++;
    }
    expect(escalations).toBe(1);
    expect(rounds).toBe(2);
    const escalated = classifyRecoveryProgress(exo01Reports.slice(0, 3));
    expect(escalated.rounds.map((r) => r.outcome)).toEqual(['stalled', 'stalled']);
    expect(escalated.rounds.at(-1)!.open).toEqual([{ id: 'F-003', severity: 'major' }]);
    expect(escalated.summary).toContain('F-003 (major)');
  });

  it('counts the round that finally closed F-003 as progress, though a new major opened', () => {
    const at = exo01.reviews.findIndex((r) => r.findings.some((f) => f.id === 'F-005'));
    const progress = classifyRecoveryProgress(exo01Reports.slice(at - 1, at + 1));
    expect(progress.rounds).toEqual([
      expect.objectContaining({
        outcome: 'progress',
        closed: ['F-003'],
        opened: ['F-005'],
      }),
    ]);
    expect(progress.converging).toBe(true);
  });

  it('judges a single round, and any round that closes, downgrades or removes a finding', () => {
    const first = report([['F-1', 'major']]);
    expect(classifyRecoveryProgress([first])).toMatchObject({ rounds: [], converging: true });
    // One stalled round is not yet a pattern.
    expect(classifyRecoveryProgress([first, report([['F-1', 'major']])]).converging).toBe(true);
    const downgraded = classifyRecoveryProgress([first, report([['F-1', 'minor']])]);
    expect(downgraded.rounds[0]).toMatchObject({ outcome: 'progress', downgraded: ['F-1'] });
    const fewer = classifyRecoveryProgress([
      report([
        ['F-1', 'major'],
        ['F-2', 'minor'],
      ]),
      report([['F-1', 'major']]),
    ]);
    expect(fewer.rounds[0]).toMatchObject({ outcome: 'progress', closed: ['F-2'] });
  });

  it('a new graver finding is a regression, and two rounds without progress stop', () => {
    const regressed = classifyRecoveryProgress([
      report([['F-1', 'minor']]),
      report([
        ['F-1', 'minor'],
        ['F-2', 'blocking'],
      ]),
    ]);
    expect(regressed.rounds[0]).toMatchObject({ outcome: 'regressed', opened: ['F-2'] });
    const closedButGraver = classifyRecoveryProgress([
      report([['F-1', 'minor']]),
      report([['F-2', 'major']]),
    ]);
    expect(closedButGraver.rounds[0]!.outcome).toBe('regressed');
    const stopped = classifyRecoveryProgress([
      report([['F-1', 'major']]),
      report([['F-1', 'major']]),
      report([
        ['F-1', 'major'],
        ['F-2', 'minor'],
      ]),
    ]);
    expect(stopped.rounds.map((r) => r.outcome)).toEqual(['stalled', 'regressed']);
    expect(stopped.converging).toBe(false);
    // Progress between two stalled rounds keeps it going.
    expect(
      classifyRecoveryProgress([
        report([['F-1', 'major']]),
        report([['F-1', 'major']]),
        report([['F-1', 'minor']]),
        report([['F-1', 'minor']]),
      ]).converging,
    ).toBe(true);
  });

  it('stops at once when a report repeats an earlier one exactly', () => {
    const repeated = classifyRecoveryProgress([
      report([['F-1', 'major']], 'review', 'same'),
      report([['F-1', 'minor']]),
      report([['F-1', 'major']], 'review', 'same'),
    ]);
    expect(repeated.rounds.map((r) => r.outcome)).toEqual(['progress', 'repeated']);
    expect(repeated.converging).toBe(false);
  });

  it('compares finding IDs only within one review worktree; across a replacement, only severities', () => {
    // A replaced review worktree may restart numbering, so F-1 there is not the same finding.
    const renumbered = classifyRecoveryProgress([
      report([
        ['F-1', 'major'],
        ['F-2', 'major'],
      ]),
      report([['F-1', 'major']], 'replacement'),
    ]);
    expect(renumbered.rounds[0]).toMatchObject({
      outcome: 'progress',
      closed: [],
      opened: [],
      comparable: false,
    });
    const same = classifyRecoveryProgress([
      report([['F-1', 'major']]),
      report([['F-9', 'major']], 'replacement'),
    ]);
    expect(same.rounds[0]).toMatchObject({ outcome: 'stalled', comparable: false });
  });
});
