import { createHash } from 'node:crypto';
import { parseInvestigationReport } from '@craftingtable/contracts';
import {
  type AgentRun,
  type AgentRunId,
  type CycleInvestigation,
  INVESTIGATION_STOPS,
  isTerminalAgentRunStatus,
  openQuestionsCheckpoint,
  stopCode,
  type WorkCycle,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { StorageRepositories } from '@craftingtable/storage';
import { runLineage } from './run-handoff.js';

/**
 * A question stop's read-only investigation (R-C16, ADR-059, ADR-065). It reads the stop's
 * questions, the reports that led to them and the branch, and proposes an answer to each with
 * its sources. It changes nothing and decides nothing: the operator answers through the stop's
 * own control, with the proposals to start from.
 */

const MAX_QUESTIONS = 40;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_LINEAGE = 6;
const MAX_RECEIPT_LINES = 50;

/** The run whose report asked the stop's questions, and the questions it asked. */
export interface StopQuestions {
  readonly sourceRunId: AgentRunId;
  readonly questions: readonly string[];
}

/**
 * The questions an investigation can work on at this stop, or none. A slice's report routes
 * its questions (`cycle.workflow`): the work item's are investigated, a shared decision's keep
 * decision preparation. Any other step asks them in its report's "## Open questions".
 */
export function stopQuestions(
  tx: Pick<StorageRepositories, 'execution'>,
  cycle: WorkCycle,
): StopQuestions | undefined {
  if (cycle.status !== 'needs-attention' && cycle.status !== 'paused') return undefined;
  const code = stopCode(cycle);
  if (code === undefined || !INVESTIGATION_STOPS.has(code)) return undefined;
  const run = tx.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
  if (!run || !isTerminalAgentRunStatus(run.status)) return undefined;
  const routed = cycle.workflow?.questions ?? [];
  if (routed.length || code === 'shared-decision-required') {
    const questions = routed
      .filter((q) => q.destination === 'work-item')
      .map((q) => q.question)
      .slice(0, MAX_QUESTIONS);
    return questions.length ? { sourceRunId: run.id, questions } : undefined;
  }
  const questions = openQuestions(finalText(tx, run));
  return questions.length ? { sourceRunId: run.id, questions } : undefined;
}

/** The items of a report's single "## Open questions" section; its text if it has no list. */
export function openQuestions(text: string): readonly string[] {
  if (openQuestionsCheckpoint(text) !== 'questions') return [];
  const section = /^## Open questions[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1];
  if (!section?.trim()) return [];
  const items: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const item = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) items.push(item[1]!.trim());
    else if (items.length && line.trim()) items[items.length - 1] += `\n${line.trim()}`;
  }
  const questions = items.length ? items : [section.trim()];
  return questions.filter((q) => q.trim()).slice(0, MAX_QUESTIONS);
}

export const questionsDigest = (questions: readonly string[]) =>
  createHash('sha256').update(JSON.stringify(questions)).digest('hex');

/** The cycle holds an investigation whose run has not been read back yet. */
export const investigationLive = (cycle: Pick<WorkCycle, 'investigation'>): boolean =>
  !!cycle.investigation && !cycle.investigation.result;

function finalText(tx: Pick<StorageRepositories, 'execution'>, run: AgentRun): string {
  const turn = tx.execution.runEvents.latestOfKind(run.workspaceId, run.id, 'turn-completed');
  return turn?.kind === 'turn-completed' ? turn.payload.resultText : (run.outcomeSummary ?? '');
}

/** What the daemon reads from an investigation's ended run, for the cycle's record. */
export function investigationResult(
  tx: Pick<StorageRepositories, 'execution'>,
  run: AgentRun,
  endedAt: string,
): NonNullable<CycleInvestigation['result']> {
  if (run.status !== 'finished') {
    const ended = tx.execution.runEvents.latestOfKind(run.workspaceId, run.id, 'run-finished');
    const message = ended?.kind === 'run-finished' ? ended.payload.message : undefined;
    return {
      endedAt,
      outcome: run.status === 'cancelled' || run.status === 'interrupted' ? run.status : 'failed',
      ...(message ? { message: message.slice(0, 4000) } : {}),
    };
  }
  const parsed = parseInvestigationReport(finalText(tx, run));
  return parsed.status === 'complete'
    ? { endedAt, outcome: 'finished', findings: parsed.report.questions }
    : {
        endedAt,
        outcome: 'finished',
        message:
          parsed.status === 'absent'
            ? 'The investigation ended without a craftingtable-investigation block. Read its report on the run.'
            : `${parsed.reason} Read its report on the run.`,
      };
}

/** One line on what an ended investigation found, for the stop's item and its page. */
export function investigationSummary(result: NonNullable<CycleInvestigation['result']>): string {
  if (result.outcome !== 'finished') {
    const what =
      result.outcome === 'failed'
        ? 'failed'
        : result.outcome === 'cancelled'
          ? 'was ended'
          : 'was interrupted';
    return `The investigation ${what}${result.message ? `: ${result.message}` : '.'} Start another if needed.`;
  }
  if (!result.findings) return `The investigation finished. ${result.message ?? ''}`.trim();
  const proposed = result.findings.filter((f) => f.status === 'proposed').length;
  const open = result.findings.length - proposed;
  return `The investigation finished: ${proposed} proposed ${proposed === 1 ? 'answer' : 'answers'}, ${open} still open. Review them before answering.`;
}

/** The rules the run is briefed with, beside the work item's own brief. */
export function investigationRules(investigation: CycleInvestigation): string {
  return [
    `Investigate the questions this work item's stop (${investigation.code}) asks, for the operator who must answer them. This is a read-only investigation, not implementation, review or remediation.`,
    'Read the worktree as it is, investigation/questions.md, investigation/context.json, investigation/branch.json and investigation/patch.diff, the handoff from the run that asked the questions, the plan documents and any recorded evidence. Do not change source, commit, merge, run commands or builds, provision environments, approve decisions or claim that tests passed.',
    'For each question, propose an answer and cite the exact sources it rests on (file and line, commit, run report or recorded evidence), separating facts from proposals. When the evidence does not settle a question, keep it open and say what is missing. You propose; the operator decides.',
    'End your final message with one craftingtable-investigation block:',
    '```craftingtable-investigation',
    '{"version":1,"questions":[{"question":"<the question>","status":"proposed","answer":"<proposed answer>","sources":["<file:line or run>"]},{"question":"<the question>","status":"open","answer":"","sources":[],"reason":"<what the evidence lacks>"}]}',
    '```',
    'Your final message is the artifact; do not write report files.',
  ].join('\n\n');
}

/**
 * The run's `investigation/` context: the questions, the stop, the lineage of reports with
 * their recorded check receipts, and the branch against its integration target. A read-only
 * Claude run cannot run Git, so the daemon supplies the branch.
 */
export async function investigationDocuments(
  tx: StorageRepositories,
  git: GitOperations | undefined,
  cycle: WorkCycle,
  investigation: CycleInvestigation,
  questions: readonly string[],
): Promise<readonly { readonly name: string; readonly content: string }[]> {
  const ws = cycle.workspaceId;
  const source = tx.execution.runs.find(ws, investigation.sourceRunId);
  const lineage = source ? runLineage(tx.execution, source).slice(0, MAX_LINEAGE) : [];
  const receipts = lineage.flatMap((run) => {
    const built = tx.runtimeEvidence.build(ws, run.id);
    const lines = built
      ? built.receipts.split('\n')
      : tx.runtimeEvidence.checkReceipts(ws, run.id).map((r) => r.receipt);
    const kept = lines.filter((line) => line.trim()).slice(0, MAX_RECEIPT_LINES);
    return kept.length ? [{ runId: run.id, role: run.role, receipts: kept }] : [];
  });
  const branch = await branchSummary(tx, git, cycle);
  return [
    {
      name: 'questions.md',
      content: `# The stop's questions\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`,
    },
    {
      name: 'context.json',
      content: JSON.stringify(
        {
          kind: 'investigation-context-v1',
          cycle: { id: cycle.id, step: cycle.step, status: cycle.status, reason: cycle.reason },
          stop: investigation.code,
          sourceRunId: investigation.sourceRunId,
          questionsDigest: investigation.questionsDigest,
          lineage: lineage.map((run) => ({
            runId: run.id,
            role: run.role,
            status: run.status,
            ...(run.verdict ? { verdict: run.verdict } : {}),
            createdAt: run.createdAt,
          })),
          receipts,
        },
        null,
        2,
      ),
    },
    { name: 'branch.json', content: JSON.stringify(branch.summary, null, 2) },
    { name: 'patch.diff', content: branch.patch },
  ];
}

async function branchSummary(
  tx: StorageRepositories,
  git: GitOperations | undefined,
  cycle: WorkCycle,
): Promise<{ summary: unknown; patch: string }> {
  const tree = tx.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
  const repository =
    tree && tx.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
  const unavailable = (reason: string) => ({
    summary: { available: false, reason },
    patch: `# The branch could not be read: ${reason}\n`,
  });
  if (!tree || !repository || !git) return unavailable('Git is unavailable to the daemon.');
  let base = tree.baseSha;
  if (tree.integrationBranch) {
    const target = await git.resolveBranch(repository.rootPath, tree.integrationBranch);
    const state = await git.inspectRepository(tree.path);
    if (!target.ok || !state.ok)
      return unavailable('The integration branch or worktree is unavailable.');
    const ancestor = await git.commonAncestor(
      repository.rootPath,
      target.value,
      state.value.headSha,
    );
    if (!ancestor.ok) return unavailable(ancestor.failure.message);
    base = ancestor.value;
  }
  const diff = await git.worktreeDiff({
    worktreePath: tree.path,
    baseSha: base,
    maxPatchBytes: MAX_PATCH_BYTES,
  });
  if (!diff.ok) return unavailable(diff.failure.message);
  return {
    summary: {
      available: true,
      branch: tree.branchName,
      integrationBranch: tree.integrationBranch,
      baseSha: diff.value.baseSha,
      headSha: diff.value.headSha,
      commits: diff.value.commits,
      files: diff.value.files,
      patchTruncated: diff.value.patchTruncated,
    },
    patch: diff.value.patch,
  };
}
