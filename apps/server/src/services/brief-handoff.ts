import { resolve } from 'node:path';
import type { AgentRunRole } from '@craftingtable/domain';
import { type CutOffRecord, type HandoffFiles, oneLine, shownPath } from './run-handoff.js';

/**
 * The run a brief continues from, as the brief carries it (ADR-024, amended by R-G6): the
 * handoff files hold everything the parent wrote; the brief holds a bounded digest of its final
 * message and points to them (G6-2, AGT-53).
 */
export interface BriefParentRun {
  readonly role: AgentRunRole;
  readonly verdict?: 'mergeable' | 'changes-requested';
  /** The parent's final message: a review's findings, an implementation's summary. */
  readonly finalMessage: string;
  /** A review parent's findings, from its valid structured report. */
  readonly findings?: readonly BriefFinding[];
  /** That report's exit gate: a gate not met is the review's finding too, findings or not. */
  readonly exitGate?: { readonly met: boolean; readonly evidence: string };
  /** Why a review parent's report is not a valid structured report, when it is not. */
  readonly reportIssues?: readonly string[];
  /** Paths the message cites under the runs root that no longer exist (AGT-57). */
  readonly expiredPaths?: readonly string[];
  readonly handoff?: Omit<HandoffFiles, 'sources'>;
}

export interface BriefFinding {
  readonly id: string;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
}

/** How much of a parent's message a digest quotes. */
const SUMMARY_BYTES = 600;
/** How many open findings a digest lists, and how long a title it keeps. */
const LISTED_FINDINGS = 40;
const TITLE_CHARACTERS = 200;
/** How much of a review's evidence for an unmet exit gate a digest gives. */
const GATE_BYTES = 600;
/** How many different handoff warnings the brief repeats; the manifest has them all. */
const LISTED_WARNINGS = 3;

/**
 * The absolute paths a message cites under the runs root (AGT-57), in order, each once and as
 * written: the daemon checks which still exist before the brief quotes the message. A path
 * whose `..` segments lead outside the root is not one of them.
 */
export function citedRunPaths(text: string, runsRoot: string): string[] {
  const root = runsRoot.replace(/\/+$/, '');
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paths = [...text.matchAll(new RegExp(`${escaped}(?:/[^\\s\`'"()<>\\[\\]]*)?`, 'g'))]
    // A trailing `:line` or `:line:column`, sentence punctuation and emphasis are not part of
    // the path.
    .map((match) => {
      let path = match[0];
      for (let previous = ''; previous !== path; ) {
        previous = path;
        path = path.replace(/(?::\d+)+$/, '').replace(/[.,;:*_~]+$/, '');
      }
      return path;
    })
    .filter((path) => path.length > root.length && resolve(path).startsWith(`${root}/`));
  return [...new Set(paths)];
}

function markExpired(text: string, expired: readonly string[] | undefined): string {
  if (!expired?.length) return text;
  // One pass, longest first, so a path is never marked inside a longer one or twice.
  const alternatives = [...expired]
    .sort((a, b) => b.length - a.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(alternatives.join('|'), 'g'), (path) => `[expired: ${path}]`);
}

/**
 * A quoted, bounded opening of a message (G6-2): CraftingTable's structured blocks are left out
 * (the handoff has them), headings become bold text, and every line is quoted, so nothing in it
 * reads as the brief's own section, block or verdict.
 */
function quotedOpening(message: string, expired: readonly string[] | undefined): string {
  const lines: string[] = [];
  let fence = '';
  let skipping = false;
  for (const line of markExpired(message.trim(), expired).split('\n')) {
    const opener = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (opener && opener[1]!.startsWith(fence) && !opener[2]!.trim()) {
        fence = '';
        if (skipping) {
          skipping = false;
          continue;
        }
      } else if (skipping) continue;
      lines.push(line);
      continue;
    }
    if (opener) {
      fence = opener[1]!;
      skipping = /^craftingtable-/.test(opener[2]!.trim());
      if (skipping) continue;
      lines.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    lines.push(heading ? `**${heading[1]!.trim()}**` : line);
  }
  const collapsed = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let opening = collapsed;
  if (Buffer.byteLength(collapsed) > SUMMARY_BYTES) {
    opening = Buffer.from(collapsed).subarray(0, SUMMARY_BYTES).toString('utf8').replace(/�$/, '');
    const cut = opening.lastIndexOf('\n');
    if (cut > SUMMARY_BYTES / 2) opening = opening.slice(0, cut);
    opening = `${opening.trimEnd()}\n…`;
  }
  return opening
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** Text cut to a byte bound at a word, with an ellipsis when cut. */
function bounded(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (Buffer.byteLength(trimmed) <= limit) return trimmed;
  const cut = Buffer.from(trimmed)
    .subarray(0, limit)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit / 2)).trimEnd()}…`;
}

/** A message whole, inside a fence longer than any it contains (an accepted design, G6-2). */
function fenced(message: string, expired: readonly string[] | undefined): string {
  const text = markExpired(message.trim(), expired);
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(Math.max(4, longest + 1));
  return `${fence}markdown\n${text}\n${fence}`;
}

/** A review's findings as a digest: the open ones by id, severity and title; the closed by id. */
function findingsDigest(parent: BriefParentRun, findings: readonly BriefFinding[]): string {
  const open = findings.filter((finding) => finding.status === 'open');
  const closed = findings.filter((finding) => finding.status !== 'open');
  // A title is the reviewer's text: one line, so it never opens a section or a block (M4).
  const title = (text: string) => {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > TITLE_CHARACTERS ? `${line.slice(0, TITLE_CHARACTERS)}…` : line;
  };
  // The files to read name the report; it holds each finding's explanation and recommendation.
  const where = parent.handoff?.reportPath ? ' (each explained in its review report)' : '';
  return markExpired(
    [
      `The review's report has ${open.length} open ${open.length === 1 ? 'finding' : 'findings'}${where}.`,
      ...open
        .slice(0, LISTED_FINDINGS)
        .map((finding) => `- ${finding.id} (${finding.severity}): ${title(finding.title)}`),
      ...(open.length > LISTED_FINDINGS
        ? [`- and ${open.length - LISTED_FINDINGS} more in the report`]
        : []),
      ...(closed.length
        ? [
            `Closed in that report: ${['resolved', 'withdrawn']
              .map((status) => [status, closed.filter((f) => f.status === status)] as const)
              .filter(([, group]) => group.length)
              .map(([status, group]) => `${group.map((f) => f.id).join(', ')} (${status})`)
              .join('; ')}.`,
          ]
        : []),
      ...(parent.exitGate && !parent.exitGate.met
        ? [`Its exit gate is not met: ${bounded(parent.exitGate.evidence, GATE_BYTES)}`]
        : []),
    ].join('\n'),
    parent.expiredPaths,
  );
}

/** The digest of a parent's final message: its findings, or a quoted opening (G6-2). */
function digest(parent: BriefParentRun, at: (path: string) => string): string {
  if (parent.findings) return findingsDigest(parent, parent.findings);
  const where = parent.handoff ? `\`${at(parent.handoff.finalMessagePath)}\`` : 'the handoff';
  const lead =
    parent.role === 'review'
      ? `The review has no valid structured report (${parent.reportIssues?.join(' ') || 'none was recorded'}), so its findings are only in its final message, ${where}; reconcile them from there. Its opening:`
      : `Its full final message is ${where}. Its opening:`;
  return `${lead}\n\n${quotedOpening(parent.finalMessage, parent.expiredPaths)}`;
}

/**
 * The sections a brief gives the run it continues from (G6-2), headed as before: a remediation's
 * findings, an accepted design, an implementation's claims, or another previous run.
 */
export function parentSections(
  parent: BriefParentRun | undefined,
  at: (path: string) => string,
  context: {
    readonly role: AgentRunRole;
    readonly resolvingIntegration: boolean;
    readonly planFinalization: boolean;
    readonly remediationInstructions: string;
    readonly acceptedDesignInstructions: string;
  },
): string[] {
  if (!parent || (!parent.finalMessage.trim() && !parent.handoff)) return [];
  const body =
    context.planFinalization && parent.handoff
      ? `Read the complete outcome at \`${at(parent.handoff.finalMessagePath)}\`. Use the active findings snapshot; do not copy the historical report into your response.`
      : digest(parent, at);
  if (!context.resolvingIntegration && parent.role === 'review' && context.role === 'implement')
    return [
      `## Remediation\n\n${context.remediationInstructions}`,
      `## Review findings to address${parent.verdict === undefined ? '' : ` (verdict: ${parent.verdict})`}\n\n${body}`,
    ];
  if (!context.resolvingIntegration && parent.role === 'design' && context.role === 'implement')
    return [
      `## Accepted design\n\n${context.acceptedDesignInstructions}`,
      `## Design proposal\n\n${context.planFinalization && parent.handoff ? body : fenced(parent.finalMessage, parent.expiredPaths)}`,
    ];
  if (parent.role === 'implement' && context.role === 'review')
    return [
      `## The implementation run's own summary\n\nTreat this as a claim to verify, not as evidence. ${body}`,
    ];
  return [`## Previous ${parent.role} run\n\n${body}`];
}

/**
 * Where a parent stopped that never completed a turn, or whose latest completed turn ended in
 * error (R-C17 part 2 and its L-4): its record, and the worktree as this run starts from it, so
 * the next run begins from them.
 */
function cutOffParagraph(record: CutOffRecord, at: (path: string) => string): string {
  const uncommitted = record.uncommitted;
  const head = record.headSha && `head commit \`${record.headSha.slice(0, 12)}\``;
  const files = !uncommitted?.total
    ? 'with nothing uncommitted'
    : `and ${uncommitted.total} uncommitted ${uncommitted.total === 1 ? 'file' : 'files'}: ${uncommitted.paths
        .map(({ path, untracked }) => `\`${shownPath(path)}\`${untracked ? ' (untracked)' : ''}`)
        .join(
          ', ',
        )}${uncommitted.total > uncommitted.paths.length ? `, and ${uncommitted.total - uncommitted.paths.length} more` : ''}`;
  const worktree =
    record.unreadable === undefined
      ? `the worktree as this run starts: ${head}, ${files}${record.conflicted ? '; Git reports conflicts or an operation in progress' : ''}`
      : head
        ? `the worktree as this run starts: ${head}; its uncommitted files could not be read (${oneLine(record.unreadable)})`
        : `the worktree could not be read (${oneLine(record.unreadable)})`;
  const messages =
    record.messages === 0
      ? 'it recorded no assistant message'
      : `its last ${record.messages === 1 ? 'assistant message' : `${record.messages} assistant messages`}`;
  const ended = record.endedInError
    ? "The previous run's last completed turn ended in error, so its final-message file holds only that turn's result."
    : 'The previous run ended without completing a turn, so its final-message file holds only its summary.';
  return `${ended} Where it stopped is in \`${at(record.path)}\`: ${messages}; ${worktree}. Read it and check the worktree before redoing its work.`;
}

/** The handoff in the files to read: where the lineage is; how to read it is in its manifest. */
export function handoffParagraphs(
  parent: BriefParentRun | undefined,
  planFinalization: boolean,
  at: (path: string) => string,
): string[] {
  const handoff = parent?.handoff;
  if (!handoff) return [];
  const warnings = [...new Set(handoff.warnings)];
  return [
    [
      planFinalization
        ? `Handoff: start with \`${at(handoff.manifestPath)}\`, the active findings snapshot and the immediate parent's complete outcome; consult the source conversations for operator decisions, corrections, uncertain observations and evidence (older reports are history, not text to reproduce).`
        : `Handoff: \`${at(handoff.manifestPath)}\` lists this lineage's conversations and reports, with earlier messages and operator corrections, and how to read them; read them before starting.`,
      `The previous run's full final message is \`${at(handoff.finalMessagePath)}\`${handoff.reportPath ? `, its review report \`${at(handoff.reportPath)}\`` : ''}${handoff.findingsPath ? `; active findings and closed history: \`${at(handoff.findingsPath)}\`` : ''}.`,
    ].join(' '),
    ...(handoff.cutOff ? [cutOffParagraph(handoff.cutOff, at)] : []),
    ...(warnings.length
      ? [
          `Handoff warnings${warnings.length > LISTED_WARNINGS ? ` (${warnings.length} different, all in the manifest)` : ''}:\n${warnings
            .slice(0, LISTED_WARNINGS)
            .map((warning) => `- ${warning}`)
            .join('\n')}`,
        ]
      : []),
  ];
}
