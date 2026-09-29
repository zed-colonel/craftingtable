import {
  currentDecisionPreparation,
  decisionPreparationForRun,
} from './decision-preparation-policy.js';
import { createHash } from 'node:crypto';
import {
  parseDesignReport,
  parseWorkflowReport,
  type ArchitectureDecisionInbox,
} from '@craftingtable/contracts';
import type { ConcurrencyDefinition, ExecutionScope } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import {
  architectureDecisionIssues,
  supportsArchitectureDecision,
} from './architecture-decision-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { prerequisiteIssues } from './runtime-evidence-policy.js';
import { worktreePlan } from './repository-policy.js';
import { unsettledDecisionsAt } from './workflow-policy.js';

/** A read-only decision inbox. Recommendations never become evidence by discovery. */
export function architectureDecisionInbox(
  source: StorageRepositories,
  d: ConcurrencyDefinition,
  scope?: ExecutionScope,
): ArchitectureDecisionInbox {
  const tx = mapReadSnapshot(source),
    ws = d.workspaceId;
  const binding = tx.imports.bindings(ws, d.id)[0];
  const revision = binding?.revision ?? 0;
  const blockers: string[] = [];
  if (!binding || (scope && scope.bindingRevision !== revision))
    blockers.push('Refresh the exact plan binding before approving decisions.');
  if (
    tx.roadmaps
      .list(ws)
      .some((r) => r.definition.crossProject?.definitionId === d.id && r.status === 'running')
  )
    blockers.push('Pause roadmap scheduling before approving decisions.');
  if (
    tx.execution.runs.listLive().some(
      (r) =>
        r.workspaceId === ws &&
        // A preparation run only proposes: its proposal is checked against its exact binding when
        // saved, and the operator reviews its text, so it does not hold approval (R-C3b, ADR-065).
        tx.execution.worktrees.find(ws, r.worktreeId)?.executionScope?.definitionId === d.id,
    )
  )
    blockers.push('Wait for live runs on this map to finish before approving decisions.');

  const checkpoints = d.source.checkpoints.filter((c) => supportsArchitectureDecision(d, c.id));
  const recommendations = new Map<
    string,
    NonNullable<ArchitectureDecisionInbox['decisions'][number]['recommendation']> & {
      sources: string[];
    }
  >();
  const cycles = tx.execution.cycles
    .listForWorkspace(ws)
    .filter((c) => c.executionScope?.definitionId === d.id);
  // Include stopped designs even after substantial activity elsewhere pushes them off the recent list.
  const runs = [
    ...tx.roadmaps
      .list(ws)
      .flatMap((r) => r.decisionPreparations ?? [])
      .filter((p) => p.definitionId === d.id)
      .flatMap((p) => {
        const run = tx.execution.runs.find(ws, p.runId);
        return run ? [run] : [];
      }),
    ...cycles.flatMap((c) => {
      const r = tx.execution.runs.find(ws, c.currentRunId);
      return r ? [r] : [];
    }),
    ...tx.execution.runs.listRecent(ws, 200),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seenTrees = new Set<string>();
  for (const run of runs) {
    if (seenTrees.has(run.worktreeId)) continue;
    seenTrees.add(run.worktreeId);
    if (run.status !== 'finished') continue;
    const tree = tx.execution.worktrees.find(ws, run.worktreeId);
    const preparation = decisionPreparationForRun(tx, ws, run.id);
    const preparedHere =
      preparation?.definitionId === d.id &&
      preparation.worktreeId === run.worktreeId &&
      currentDecisionPreparation(tx, preparation);
    if (
      !tree ||
      (!preparedHere &&
        (tree.executionScope?.definitionId !== d.id ||
          tree.executionScope.bindingRevision !== revision))
    )
      continue;
    const owner = binding?.bindings.find(
      (b) => b.planVersionId === worktreePlan(tx, tree) && b.repositoryId === tree.repositoryId,
    )?.alias;
    const event = tx.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
    if (
      event?.kind !== 'turn-completed' ||
      event.payload.outcome !== 'success' ||
      event.payload.truncated ||
      !event.payload.resultText
    )
      continue;
    const report = event.payload.resultText;
    const parsed = parseDesignReport(report);
    const workflow = parseWorkflowReport(report);
    const legacyQuestions = report
      .match(/^## Open questions[ \t]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]
      ?.trim();
    const questions = [
      ...(parsed.status !== 'complete' &&
      workflow.status !== 'complete' &&
      legacyQuestions &&
      checkpoints.some((c) => legacyQuestions.includes(c.id))
        ? [
            {
              kind: 'operator-decision' as const,
              question: legacyQuestions.slice(0, 4000),
              answer: '',
              sources: [
                `Run ${run.id}: original questions; structured classification is unavailable`,
              ],
              decision: undefined,
            },
          ]
        : []),
      ...(parsed.status === 'complete'
        ? parsed.report.items.filter((q) => q.kind === 'operator-decision')
        : []),
      ...(workflow.status === 'complete'
        ? workflow.report.questions
            .filter((q) => q.destination === 'shared-decision')
            .map((q) => ({
              kind: 'operator-decision' as const,
              question: q.question,
              answer: '',
              sources: [
                q.checkpointId ?? '',
                `Run ${run.id}: classified shared architecture question`,
              ],
              decision: undefined,
            }))
        : []),
    ];
    for (const question of questions) {
      const tokens = new Set(
        [question.question, ...question.sources]
          .join('\n')
          .match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}\b/g) ?? [],
      );
      const candidates = checkpoints.filter(
        (c) =>
          c.owner === owner &&
          (!preparation || preparation.checkpointId === c.id) &&
          (question.decision ? question.decision.checkpointId === c.id : tokens.has(c.id)),
      );
      for (const c of candidates) {
        if (recommendations.has(c.id)) continue;
        recommendations.set(c.id, {
          sourceRunId: run.id,
          investigation:
            run.profileSelection?.purpose === 'investigation' ||
            cycles.some(
              (c) => c.designRecovery?.runId === run.id && c.designRecovery.mode === 'investigate',
            ),
          ...(parsed.status === 'invalid' ? { classificationIssue: parsed.reason } : {}),
          sourceReportDigest: createHash('sha256').update(report).digest('hex'),
          ...(run.workItemId ? { workItemId: run.workItemId } : {}),
          ...(tree.executionScope ? { sliceId: tree.executionScope.sourceId } : {}),
          question: question.question,
          answer: question.answer,
          sources: question.sources,
          ...(question.decision ? { brief: question.decision } : {}),
        });
      }
    }
  }
  const submissions = tx.runtimeEvidence.submissions(ws, d.id);
  const decisions = tx.runtimeEvidence.decisions(ws);
  const slices = d.source.slices.filter(
    (s) =>
      !scope ||
      s.id === scope.sourceId ||
      (scope.kind === 'parent-acceptance' && s.work_item === scope.sourceId),
  );
  const relevant = new Set(
    slices
      .flatMap((s) => [...s.start_requires, ...s.merge_requires, ...s.verify_requires])
      .filter((r) => r.kind === 'checkpoint')
      .map((r) => r.id),
  );
  // Decisions a slice is stopped on now get a card even before any brief exists, so the stop
  // can be answered from one place (LIVE-18).
  const stopped = new Map<string, string[]>();
  for (const cycle of tx.execution.cycles.listForWorkspace(ws))
    if (
      cycle.executionScope?.definitionId === d.id &&
      cycle.executionScope.bindingRevision === revision &&
      ['needs-attention', 'paused'].includes(cycle.status)
    )
      for (const id of unsettledDecisionsAt(tx, cycle))
        stopped.set(id, [...(stopped.get(id) ?? []), cycle.executionScope.sourceId]);
  const cards = checkpoints.flatMap((c) => {
    const recommendation = recommendations.get(c.id);
    const records = submissions
      .filter((s) => s.subject.sourceId === c.id && s.architectureDecision)
      .map((s) => ({
        id: s.id,
        proposal: {
          ...s.architectureDecision!,
          consumers: s.architectureDecision!.consumers.map((c) => ({ ...c })),
        },
        decision: decisions.find((a) => a.submissionId === s.id),
        issues: architectureDecisionIssues(tx, d, s),
        applicable:
          !scope ||
          (s.bindingRevision === scope.bindingRevision &&
            (s.architectureDecision!.coverage === 'full' ||
              s.architectureDecision!.consumers.some((consumer) =>
                slices.some((slice) => slice.id === consumer.sliceId),
              ))),
      }));
    if (
      scope &&
      !relevant.has(c.id) &&
      !records.some((r) => r.proposal.coverage === 'clauses' && r.applicable) &&
      !slices.some((s) => s.id === recommendation?.sliceId)
    )
      return [];
    if (!records.length && !recommendation && !stopped.has(c.id)) return [];
    const refs = [
      `Imported map ${d.mapId} ${d.revision}; exact plan binding ${revision}; checkpoint ${c.id}.`,
      ...c.source_refs.map((ref) => JSON.stringify(ref)),
      ...(recommendation?.sources ?? []),
      ...(recommendation
        ? [
            `Attached source run ${recommendation.sourceRunId}; SHA-256 ${recommendation.sourceReportDigest}.`,
          ]
        : []),
    ].join('\n');
    return [
      {
        checkpointId: c.id,
        title: c.title,
        requirements: [...c.pass_criteria],
        blockers: prerequisiteIssues(tx, d, revision, { kind: 'checkpoint', sourceId: c.id }),
        sourceReferences: refs,
        consumers: d.source.slices.flatMap((s) =>
          (['start', 'merge', 'verify'] as const).flatMap((phase) =>
            s[`${phase}_requires`].some((r) => r.kind === 'checkpoint' && r.id === c.id)
              ? [{ sliceId: s.id, phase }]
              : [],
          ),
        ),
        ...(stopped.has(c.id) ? { stoppedSlices: [...new Set(stopped.get(c.id))] } : {}),
        ...(recommendation ? { recommendation } : {}),
        records,
      },
    ];
  });
  return {
    workspaceId: ws,
    definitionId: d.id,
    bindingRevision: revision,
    blockers,
    decisions: cards,
  };
}
