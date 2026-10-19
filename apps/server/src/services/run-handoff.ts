import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRun, RunHandoffSource } from '@craftingtable/domain';
import { fitsUtf8Bytes, truncateUtf8Bytes, truncateUtf16 } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError } from './errors.js';
import {
  incompleteRun,
  latestReviewReport,
  type RunCutOff,
  recordedFindings,
  requiredFindingIds,
  runEvents,
  sourceRuns,
} from './run-lineage.js';

type Execution = StorageRepositories['execution'];

/** How to read a handoff, written into its manifest; the brief points there (R-G6). */
export const HANDOFF_READING =
  'Paths here are relative to this manifest. Reports with status complete are structurally validated reviewer assertions; reconcile unstructured or invalid reports against the conversation, and ask the operator about unresolved ambiguity. Earlier findings may be corrected or withdrawn later: do not treat every historical statement as a current finding, and preserve finding IDs across review rounds. The findings file, when there is one, is derived from valid reports at the delivered event cursors; an omitted closed finding keeps its last reviewer disposition.';

/**
 * Where a run's worktree stood when its handoff was written: its head commit and uncommitted
 * files (and whether Git reports conflicts or an operation in progress), or why they could not be
 * read, with the head when that alone could be.
 */
export type StoppedWorktree =
  | {
      readonly headSha: string;
      readonly changed: readonly string[];
      readonly untracked: readonly string[];
      readonly conflicted?: boolean;
    }
  | { readonly headSha?: string; readonly unreadable: string };

/** How much of a cut-off run its handoff carries (R-C17 part 2). */
export const CUT_OFF_BOUNDS = {
  /** Its last assistant messages, each cut to a size. */
  messages: 5,
  messageBytes: 4 * 1024,
  /** The uncommitted files the record lists, and the few the brief names, each cut to a length. */
  paths: 200,
  briefPaths: 10,
  pathChars: 300,
} as const;

/**
 * Where a parent stopped that was cut off (`RunCutOff`: it never completed a turn, its latest
 * completed turn ended in error, or it was cut off in a turn after that; R-C17 part 2, its L-4
 * and part 4): the record's path and what the brief repeats of it.
 */
export interface CutOffRecord {
  readonly path: string;
  readonly messages: number;
  readonly headSha?: string;
  /** The first uncommitted files, tracked then untracked, and how many there are. */
  readonly uncommitted?: {
    readonly paths: readonly { readonly path: string; readonly untracked: boolean }[];
    readonly total: number;
  };
  readonly unreadable?: string;
  /** Git reported conflicts or an operation in progress (a merge, cherry-pick, revert or rebase). */
  readonly conflicted?: boolean;
  /**
   * Its latest completed turn ended in error (R-C17 part 2 L-4), or it was cut off in a turn after
   * its latest completed one (part 4); absent when it never completed a turn.
   */
  readonly end?: Exclude<RunCutOff, 'no-turn'>;
}

export interface HandoffFiles {
  readonly manifestPath: string;
  readonly finalMessagePath: string;
  readonly warnings: readonly string[];
  readonly sources: readonly RunHandoffSource[];
  readonly findingsPath?: string;
  /** The immediate parent's review report, when it has one. */
  readonly reportPath?: string;
  /** Where the immediate parent stopped, when it was cut off (`RunCutOff`). */
  readonly cutOff?: CutOffRecord;
}

/** A repository path or message as one line: control characters and backticks shown as `?`. */
export function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are replaced
  return text.replace(/[\u0000-\u001f\u007f`]/g, '?');
}

/** A repository path as one line, cut to a length (R-C17 part 2). */
export function shownPath(path: string): string {
  // Cut on a character, never inside a surrogate pair.
  return truncateUtf16(oneLine(path), CUT_OFF_BOUNDS.pathChars + 1);
}

/** A message inside a fence longer than any backtick run it holds, so it opens no section. */
function fencedMessage(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * The record of where a run stopped that was cut off: it never completed a turn, its latest
 * completed turn ended in error (a provider failure or quota; R-C17 part 2 L-4), or it was cut off
 * in a turn after its latest completed one (part 4). Its head commit and the worktree's
 * uncommitted files, as the handoff found them, and its last assistant messages.
 */
export function cutOffRecord(
  run: Pick<AgentRun, 'id' | 'role' | 'status'>,
  messages: readonly {
    readonly sequence: number;
    readonly occurredAt: string;
    readonly text: string;
  }[],
  total: number,
  worktree: StoppedWorktree | undefined,
  end: RunCutOff = 'no-turn',
): { readonly text: string; readonly summary: Omit<CutOffRecord, 'path'> } {
  const ended =
    end === 'error-turn'
      ? `(${run.status}) ended its last completed turn in error, so its final message holds only that turn's result`
      : end === 'later-turn'
        ? `(${run.status}) was cut off in a turn after its last completed one, so its final message holds only that earlier turn's result`
        : `ended (${run.status}) without completing a turn, so it left no final message`;
  const lines = [
    `# Where run ${run.id} stopped`,
    '',
    `The ${run.role} run ${ended}. Below: the worktree as this handoff was written, which the next run starts from (it can hold changes made after the run stopped, by the operator or CraftingTable), and the run's last assistant messages.`,
    '',
    '## The worktree as this handoff was written',
    '',
  ];
  let summary: Omit<CutOffRecord, 'path'> = {
    messages: messages.length,
    ...(end === 'no-turn' ? {} : { end }),
  };
  const state = worktree ?? { unreadable: 'it was not read' };
  if ('unreadable' in state) {
    if (state.headSha)
      lines.push(
        `Head commit: ${state.headSha}`,
        '',
        `Its uncommitted files could not be read: ${oneLine(state.unreadable)}`,
      );
    else lines.push(`The worktree could not be read: ${oneLine(state.unreadable)}`);
    summary = {
      ...summary,
      ...(state.headSha ? { headSha: state.headSha } : {}),
      unreadable: state.unreadable,
    };
  } else {
    const paths = [
      ...state.changed.map((path) => ({ path, untracked: false })),
      ...state.untracked.map((path) => ({ path, untracked: true })),
    ];
    const shown = ({ path, untracked }: (typeof paths)[number]) =>
      `${shownPath(path)}${untracked ? ' (untracked)' : ''}`;
    lines.push(`Head commit: ${state.headSha}`, '');
    if (state.conflicted)
      lines.push(
        'Git reports conflicts or an operation in progress (a merge, cherry-pick, revert or rebase).',
        '',
      );
    if (!paths.length) lines.push('Nothing uncommitted: the worktree matched its head commit.');
    else {
      lines.push(
        `${paths.length} uncommitted ${paths.length === 1 ? 'file' : 'files'}, tracked then untracked:`,
      );
      for (const path of paths.slice(0, CUT_OFF_BOUNDS.paths)) lines.push(`- ${shown(path)}`);
      if (paths.length > CUT_OFF_BOUNDS.paths)
        lines.push(
          `- and ${paths.length - CUT_OFF_BOUNDS.paths} more (git status in the worktree lists them)`,
        );
    }
    summary = {
      ...summary,
      headSha: state.headSha,
      uncommitted: { paths: paths.slice(0, CUT_OFF_BOUNDS.briefPaths), total: paths.length },
      ...(state.conflicted ? { conflicted: true } : {}),
    };
  }
  lines.push(
    '',
    '## Its last assistant messages',
    '',
    messages.length
      ? `The last ${messages.length} of its ${total} assistant ${total === 1 ? 'message' : 'messages'}, oldest first, each in a fence; its conversation file has every message whole.`
      : 'It recorded no assistant message.',
  );
  for (const message of messages) {
    const cut = !fitsUtf8Bytes(message.text, CUT_OFF_BOUNDS.messageBytes);
    lines.push(
      '',
      `### Event ${message.sequence} (${message.occurredAt})`,
      '',
      fencedMessage(
        cut ? truncateUtf8Bytes(message.text, CUT_OFF_BOUNDS.messageBytes, '') : message.text,
      ),
      ...(cut ? ['', '[cut here; the conversation file has the rest]'] : []),
    );
  }
  return { text: `${lines.join('\n')}\n`, summary };
}

/**
 * Copy the recorded conversation, including earlier turns and operator corrections.
 * Files preserve all recorded text; only the inline prompt preview is bounded.
 * A size limit rejects the handoff instead of silently discarding its tail.
 */
export function writeRunHandoff(
  execution: Execution,
  parent: AgentRun,
  directory: string,
  /**
   * How the parent was cut off (`runCutOff`, which the launch reads once) and where its worktree
   * stands now; the immediate parent's record is written exactly when this is given.
   */
  cutOffAt?: { readonly end: RunCutOff; readonly worktree: StoppedWorktree },
): HandoffFiles {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let byteLength = 0;
  const write = (path: string, text: string, append = false): void => {
    byteLength += Buffer.byteLength(text, 'utf8');
    if (byteLength > 32 * 1024 * 1024) {
      throw new ExecutionRequestError(
        'conflict',
        'The handoff exceeds 32 MiB. No run was launched and no text was dropped. Start an independent run with an explicitly consolidated brief.',
      );
    }
    if (append) appendFileSync(path, text, { mode: 0o600 });
    else writeFileSync(path, text, { mode: 0o600 });
  };
  const warnings: string[] = [];
  let cutOff: CutOffRecord | undefined;
  const inherited = sourceRuns(execution, parent);
  if (inherited.length > 1000)
    throw new ExecutionRequestError('conflict', 'The handoff exceeds 1000 source runs');
  const sources = inherited.map(({ run, throughSequence: limit }, index) => {
    const prefix = String(index).padStart(4, '0');
    const conversation = `${prefix}-conversation.md`;
    const finalMessage = `${prefix}-final.md`;
    write(
      join(directory, conversation),
      `# ${run.role} run ${run.id}\n\nRecorded messages in journal order. Earlier findings may be revised or withdrawn later.\n`,
    );
    let throughSequence = 0;
    let messageCount = 0;
    let lastFinal = limit === undefined ? (run.outcomeSummary ?? '') : '';
    let hasFinal = false;
    let truncatedMessages = 0;
    // The immediate parent's last assistant messages, in case it gets a cut-off record.
    const lastMessages: { sequence: number; occurredAt: string; text: string }[] = [];
    let assistantMessages = 0;
    for (const event of runEvents(execution, run, limit)) {
      throughSequence = event.sequence;
      if (index === 0 && event.kind === 'assistant-message') {
        assistantMessages += 1;
        lastMessages.push({
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          text: event.payload.text,
        });
        if (lastMessages.length > CUT_OFF_BOUNDS.messages) lastMessages.shift();
      }
      if (
        event.kind !== 'assistant-message' &&
        event.kind !== 'user-message' &&
        event.kind !== 'turn-completed'
      )
        continue;
      const text = event.kind === 'turn-completed' ? event.payload.resultText : event.payload.text;
      if (event.kind === 'turn-completed') {
        lastFinal = text;
        hasFinal = true;
      }
      if (
        (event.kind !== 'user-message' && event.payload.truncated === true) ||
        text.endsWith('…[truncated by CraftingTable]')
      )
        truncatedMessages += 1;
      messageCount += 1;
      write(
        join(directory, conversation),
        `\n## Event ${event.sequence}: ${event.kind} (${event.occurredAt})\n\n${text}\n`,
        true,
      );
    }
    write(join(directory, finalMessage), lastFinal);
    if (!hasFinal)
      warnings.push(
        `${run.id}: no completed turn; the final-message file contains only the available summary.`,
      );
    // A parent cut off with no completed turn (at the step limit, or interrupted) left no final
    // message; one whose latest completed turn ended in error (a provider failure or quota), or
    // that was cut off in a turn after its latest completed one, left only that turn's result:
    // its record gives where it stopped (R-C17 part 2, its L-4 and part 4). The warnings stay as
    // they were: only a run with no completed turn has one.
    const record = index === 0 && cutOffAt !== undefined ? `${prefix}-cut-off.md` : undefined;
    if (record !== undefined && cutOffAt !== undefined) {
      const made = cutOffRecord(
        run,
        lastMessages,
        assistantMessages,
        cutOffAt.worktree,
        cutOffAt.end,
      );
      write(join(directory, record), made.text);
      cutOff = { path: join(directory, record), ...made.summary };
    }
    if (truncatedMessages > 0)
      warnings.push(
        `${run.id}: ${truncatedMessages} recorded message(s) were already truncated upstream. Their missing text cannot be recovered from this journal.`,
      );
    if (incompleteRun(execution, run, throughSequence))
      warnings.push(
        `${run.id}: the agent exited before collecting background work and reporting completion; inspect its preserved verification records before continuing.`,
      );
    const review = latestReviewReport(execution, run, throughSequence);
    const report = review === undefined ? undefined : `${prefix}-review.json`;
    if (report !== undefined) write(join(directory, report), JSON.stringify(review, null, 2));
    if (review !== undefined && review.status !== 'complete')
      warnings.push(`${run.id}: ${review.issues.join(' ')}`);
    return {
      runId: run.id,
      role: run.role,
      throughSequence,
      messageCount,
      truncatedMessages,
      conversation,
      finalMessage,
      ...(report === undefined ? {} : { report }),
      ...(record === undefined ? {} : { cutOff: record }),
    };
  });
  let findingsPath: string | undefined;
  if (parent.planVersionId) {
    const findings = [...recordedFindings(execution, parent).values()];
    const open = findings.filter(({ finding }) => finding.status === 'open');
    const closed = findings.filter(({ finding }) => finding.status !== 'open');
    findingsPath = join(directory, 'findings.json');
    write(
      join(directory, 'closed-findings.json'),
      JSON.stringify({ version: 1, findings: closed }, null, 2),
    );
    write(
      findingsPath,
      JSON.stringify(
        {
          version: 1,
          scope: 'finalization',
          requiredFindingIds: [...requiredFindingIds(execution, parent)],
          openFindings: open,
          closedFindingIds: closed.map(({ finding }) => finding.id),
          closedHistory: 'closed-findings.json',
          instructions:
            'Report every ID in requiredFindingIds with its current status, plus new or reopened findings. Controller-retained optional follow-ups are listed in the staged ledger and may be omitted while unchanged. Unchanged closed findings may be omitted; their reviewer dispositions remain in the recorded history. Invalid reports do not update this snapshot; reconcile their observations from the source files.',
        },
        null,
        2,
      ),
    );
  }
  const manifestPath = join(directory, 'manifest.json');
  write(
    manifestPath,
    JSON.stringify(
      {
        version: 1,
        sourceRunId: parent.id,
        order: 'newest run first; messages within each file are chronological',
        reading: HANDOFF_READING,
        warnings,
        sources,
        ...(findingsPath ? { findings: 'findings.json' } : {}),
      },
      null,
      2,
    ),
  );
  return {
    manifestPath,
    finalMessagePath: join(directory, '0000-final.md'),
    warnings,
    sources: sources.map(({ runId, throughSequence }) => ({ runId, throughSequence })),
    ...(findingsPath ? { findingsPath } : {}),
    ...(sources[0]?.report ? { reportPath: join(directory, sources[0].report) } : {}),
    ...(cutOff ? { cutOff } : {}),
  };
}
