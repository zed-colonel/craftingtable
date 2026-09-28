import {
  FINDING_SEVERITIES,
  type FindingSeverity,
  type FindingStatus,
} from '@craftingtable/domain';

/**
 * Whether automatic scope recovery is converging (R-C5 increment 3, HIST-04).
 *
 * Each recovery round starts from a pinned source review report; the next report of the same
 * review shows what the round's repair achieved. The classifier compares consecutive reports
 * only: it never follows a review's finding history (ADR-056's `parentRunId` lineage), which a
 * replaced review worktree loses. Finding IDs are compared only between reports of the same
 * review worktree, where reviewers carry them forward; across a replacement only the severity
 * profile of the open findings is compared.
 *
 * It is a conservative guard, not a proof of semantic progress (ADR-057): a round makes
 * progress when an open finding closes or is downgraded, or the open findings get less grave,
 * and nothing graver opens. EXO-01's parent acceptance kept one major finding open for 13
 * rounds while each round fixed that round's sampled examples; here that is two stalled rounds.
 */

export interface RecoveryRoundReport {
  /** The review worktree whose reviewer wrote the report. */
  readonly reviewWorktreeId: string;
  /** The open findings' substance apart from their IDs (`findingFingerprint`). */
  readonly fingerprint: string;
  readonly findings: readonly {
    readonly id: string;
    readonly severity: FindingSeverity;
    readonly status: FindingStatus;
  }[];
}

export type RoundOutcome = 'progress' | 'stalled' | 'regressed' | 'repeated';

export interface RoundProgress {
  readonly outcome: RoundOutcome;
  /** Whether finding IDs could be compared (the same review worktree). */
  readonly comparable: boolean;
  /** Finding IDs open before the round and not after it. */
  readonly closed: readonly string[];
  /** Finding IDs open after the round and not before it. */
  readonly opened: readonly string[];
  /** Finding IDs still open after the round, at a lower severity. */
  readonly downgraded: readonly string[];
  /** The findings open after the round, gravest first. */
  readonly open: readonly { readonly id: string; readonly severity: FindingSeverity }[];
}

export interface RecoveryProgress {
  /** One entry per round: between each report and the one before it. */
  readonly rounds: readonly RoundProgress[];
  /** False when automatic recovery should stop and ask the operator. */
  readonly converging: boolean;
  /** For display only; never parsed. */
  readonly summary: string;
}

/** Consecutive rounds without progress after which automatic recovery stops. */
export const STALLED_ROUND_LIMIT = 2;

const rank = (severity: FindingSeverity) => FINDING_SEVERITIES.indexOf(severity);

function openFindings(report: RecoveryRoundReport) {
  return report.findings
    .filter((f) => f.status === 'open')
    .map(({ id, severity }) => ({ id, severity }))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));
}

/** Compares open findings per severity, gravest first: negative when `a` is less grave. */
function compareProfiles(a: RecoveryRoundReport, b: RecoveryRoundReport): number {
  for (const severity of FINDING_SEVERITIES) {
    const count = (r: RecoveryRoundReport) =>
      r.findings.filter((f) => f.status === 'open' && f.severity === severity).length;
    const difference = count(a) - count(b);
    if (difference) return difference;
  }
  return 0;
}

function judge(
  before: RecoveryRoundReport,
  after: RecoveryRoundReport,
  earlier: readonly RecoveryRoundReport[],
): RoundProgress {
  const comparable = before.reviewWorktreeId === after.reviewWorktreeId;
  const was = new Map(openFindings(before).map((f) => [f.id, f.severity]));
  const open = openFindings(after);
  const is = new Map(open.map((f) => [f.id, f.severity]));
  const closed = comparable ? [...was.keys()].filter((id) => !is.has(id)) : [];
  const opened = comparable ? [...is.keys()].filter((id) => !was.has(id)) : [];
  const downgraded = comparable
    ? [...is].filter(([id, s]) => was.has(id) && rank(s) > rank(was.get(id)!)).map(([id]) => id)
    : [];
  const profile = compareProfiles(after, before);
  const outcome: RoundOutcome = earlier.some((r) => r.fingerprint === after.fingerprint)
    ? 'repeated'
    : profile > 0
      ? 'regressed'
      : profile < 0 || closed.length || downgraded.length
        ? 'progress'
        : 'stalled';
  return { outcome, comparable, closed, opened, downgraded, open };
}

/**
 * Judges the rounds between consecutive source reports of one review, oldest first. The last
 * report is the review that just finished; the rounds so far are the ones between.
 */
export function classifyRecoveryProgress(
  reports: readonly RecoveryRoundReport[],
): RecoveryProgress {
  const rounds = reports
    .slice(1)
    .map((after, index) => judge(reports[index]!, after, reports.slice(0, index + 1)));
  const recent = rounds.slice(-STALLED_ROUND_LIMIT);
  const converging =
    rounds.at(-1)?.outcome !== 'repeated' &&
    !(recent.length === STALLED_ROUND_LIMIT && recent.every((r) => r.outcome !== 'progress'));
  return { rounds, converging, summary: summarize(rounds) };
}

const named = (findings: readonly { readonly id: string; readonly severity: string }[]) =>
  findings.map((f) => `${f.id} (${f.severity})`).join(', ');

function summarize(rounds: readonly RoundProgress[]): string {
  return rounds
    .map((round, index) => {
      const parts = [
        `Round ${index + 1}: ${round.outcome}`,
        round.closed.length ? `closed ${round.closed.join(', ')}` : '',
        round.downgraded.length ? `downgraded ${round.downgraded.join(', ')}` : '',
        round.opened.length ? `opened ${round.opened.join(', ')}` : '',
        round.open.length ? `still open ${named(round.open)}` : 'nothing open',
        round.comparable ? '' : 'review replaced, severities compared',
      ].filter(Boolean);
      return `${parts.join('; ')}.`;
    })
    .join(' ');
}
