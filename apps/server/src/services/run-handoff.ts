import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentRun,
  AgentRunEvent,
  ReviewFinding,
  ReviewReportAssessment,
  RunHandoffSource,
} from '@craftingtable/domain';
import { stagedFollowUpIds } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError } from './errors.js';
import { assessReviewReport } from './review-report.js';

type Execution = StorageRepositories['execution'];

/** Read journal pages, never a clipped first page or a bounded run summary. */
export function* runEvents(
  execution: Execution,
  run: AgentRun,
  throughSequence = Number.MAX_SAFE_INTEGER,
): Generator<AgentRunEvent> {
  let after = 0;
  for (;;) {
    const page = execution.runEvents.listAfter({
      workspaceId: run.workspaceId,
      runId: run.id,
      after,
      limit: 100,
    });
    if (page.length === 0) return;
    for (const event of page) {
      if (event.sequence > throughSequence) return;
      yield event;
    }
    after = page.at(-1)?.sequence ?? after;
  }
}

/** The newest run first; lineage must stay inside the worktree and workspace. */
export function runLineage(execution: Execution, run: AgentRun): readonly AgentRun[] {
  const runs: AgentRun[] = [];
  const seen = new Set<string>();
  let current: AgentRun | undefined = run;
  while (current !== undefined) {
    if (
      seen.has(current.id) ||
      runs.length >= 1000 ||
      current.worktreeId !== run.worktreeId ||
      current.workItemId !== run.workItemId
    ) {
      throw new ExecutionRequestError(
        'conflict',
        'Run lineage cannot be handed off: it is cyclic, too long, or crosses worktrees',
      );
    }
    runs.push(current);
    seen.add(current.id);
    if (current.parentRunId === undefined) break;
    current = execution.runs.find(run.workspaceId, current.parentRunId);
    if (current === undefined)
      throw new ExecutionRequestError(
        'conflict',
        'A source run is missing from the handoff lineage',
      );
  }
  return runs;
}

/** Inherited context is pinned to the source messages actually delivered at launch. */
function sourceRuns(
  execution: Execution,
  run: AgentRun,
): readonly { run: AgentRun; throughSequence?: number }[] {
  const first = execution.runEvents.listAfter({
    workspaceId: run.workspaceId,
    runId: run.id,
    after: 0,
    limit: 1,
  })[0];
  const sources = first?.kind === 'user-message' ? first.payload.handoffSources : undefined;
  if (sources === undefined) return runLineage(execution, run).map((source) => ({ run: source }));
  return [
    { run },
    ...sources.map((source) => {
      const found = execution.runs.find(run.workspaceId, source.runId);
      if (
        found === undefined ||
        found.worktreeId !== run.worktreeId ||
        found.workItemId !== run.workItemId ||
        found.id === run.id
      ) {
        throw new ExecutionRequestError(
          'conflict',
          'A handoff source is missing or outside this worktree',
        );
      }
      return { run: found, throughSequence: source.throughSequence };
    }),
  ];
}

/** Later lifecycle events cannot rewrite an already-delivered source snapshot. */
function incompleteRun(
  execution: Execution,
  run: AgentRun,
  throughSequence = Number.MAX_SAFE_INTEGER,
) {
  const ended = execution.runEvents.latestOfKind(run.workspaceId, run.id, 'run-finished');
  return (
    ended?.kind === 'run-finished' && ended.sequence <= throughSequence && ended.payload.reason
  );
}

/** Latest valid reviewer disposition, replayed only from the delivered source snapshots. */
export function recordedFindings(execution: Execution, run: AgentRun) {
  const findings = new Map<
    string,
    { finding: ReviewFinding; runId: AgentRun['id']; sequence: number }
  >();
  for (const { run: source, throughSequence } of sourceRuns(execution, run).toReversed()) {
    if (source.role !== 'review') continue;
    const incomplete = incompleteRun(execution, source, throughSequence);
    for (const event of runEvents(execution, source, throughSequence)) {
      if (event.kind === 'turn-completed' && event.payload.reviewReport?.status === 'complete') {
        for (const finding of event.payload.reviewReport.report.findings) {
          // Preserve concerns, but an incomplete run cannot supply closure evidence.
          if (!incomplete || finding.status === 'open')
            findings.set(finding.id, { finding, runId: source.id, sequence: event.sequence });
        }
      }
    }
  }
  return findings;
}

export function requiredFindingIds(execution: Execution, run: AgentRun): ReadonlySet<string> {
  const cycle = execution.cycles.activeForWorktree(run.workspaceId, run.worktreeId);
  const followUps = cycle ? stagedFollowUpIds(cycle) : new Set<string>();
  return new Set(
    [...recordedFindings(execution, run).values()]
      .filter(
        ({ finding }) =>
          !run.planVersionId || (finding.status === 'open' && !followUps.has(finding.id)),
      )
      .map(({ finding }) => finding.id),
  );
}

export function latestReviewReport(
  execution: Execution,
  run: AgentRun,
  throughSequence?: number,
): ReviewReportAssessment | undefined {
  if (run.role !== 'review') return undefined;
  if (incompleteRun(execution, run, throughSequence))
    return {
      status: 'invalid',
      issues: [
        'The review exited before background verification and reporting completed. Its provisional report cannot close findings or authorize a merge.',
      ],
    };
  let event: AgentRunEvent | undefined;
  if (throughSequence === undefined)
    event = execution.runEvents.latestOfKind(run.workspaceId, run.id, 'turn-completed');
  else
    for (const candidate of runEvents(execution, run, throughSequence)) {
      if (candidate.kind === 'turn-completed') event = candidate;
    }
  if (event?.kind !== 'turn-completed')
    return { status: 'unstructured', issues: ['The review has no completed turn yet.'] };
  return (
    event.payload.reviewReport ??
    assessReviewReport(event.payload.resultText, event.payload.truncated)
  );
}

export interface HandoffFiles {
  readonly manifestPath: string;
  readonly finalMessagePath: string;
  readonly warnings: readonly string[];
  readonly sources: readonly RunHandoffSource[];
  readonly findingsPath?: string;
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
    for (const event of runEvents(execution, run, limit)) {
      throughSequence = event.sequence;
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
  };
}
