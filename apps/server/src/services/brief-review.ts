import {
  type BlockFormat,
  type OutputContext,
  openQuestionsPart,
  type RoleInstructions,
  WORKFLOW_PART,
  workflowFormat,
} from './brief-output.js';

/**
 * The review role (R-G6, AGT-54): what a reviewer does and the one final message it returns,
 * ending with the `craftingtable-review` block and the `VERDICT` line (ADR-024).
 */
export function reviewInstructions(context: OutputContext): RoleInstructions {
  const scope = context.scope;
  return {
    role: [
      'You are an independent reviewer for this work item, read-only: request remediation rather than change or commit source, and keep verification records in the temporary directory.',
      'Compare this branch with its base revision, read the changed code and its tests, and run the repository-required checks on this exact branch, combined integration changes included; record commands and results in exitGate.evidence and say whether the work meets the exit gate.',
      ...(scope
        ? [
            `${scope.identity.kind === 'parent-acceptance' ? 'This parent-acceptance review independently assesses the full original exit gate and retained source-plan obligations.' : 'This slice review approves its scope, never its parent.'} Never claim that missing verification or outside-scope obligations passed.`,
          ]
        : []),
    ].join(' '),
    rules: [
      context.planFinalization
        ? 'Findings continuity: report every previously open finding the handoff manifest requires, with its current status, and every new or reopened finding; the rules file says what may be omitted.'
        : 'Findings continuity: reconcile ALL findings of this run and its handoff lineage, operator corrections included, and keep their IDs; the rules file says more.',
    ],
    finalMessage: [
      'Your conclusion in prose; the findings go in the report, not repeated in prose.',
      ...(context.workflow ? [WORKFLOW_PART] : []),
      openQuestionsPart(
        context.workflow,
        'Otherwise each unresolved operator approval, exception or policy choice as a concrete question, even if also a finding (never delegated as a code repair).',
        !!context.finalizationStage,
      ),
      'A section headed `## Review report` with exactly one fenced `craftingtable-review` block, your consolidated report (shape below).',
      'As the very last line, exactly `VERDICT: mergeable` if the branch can merge as it stands, or `VERDICT: changes-requested` if anything blocking or major remains, matching the report.',
    ],
    formats: [
      ...(context.workflow ? [workflowFormat(context.workflow)] : []),
      reviewFormat(context),
    ],
  };
}

const FINALIZATION_FINDINGS_INSTRUCTIONS = [
  'Findings continuity: finalization reports cover active findings and changes in reviewer disposition.',
  'Report every previously OPEN finding required by the handoff manifest with its current status, plus every new or reopened finding. In staged finalization, unchanged optional follow-ups retained in the controller ledger may be omitted. Verify a fix before reporting its resolution, with a concise disposition.',
  'Unchanged resolved or withdrawn findings may be omitted from later reports. They remain in the journal and closed-findings history; omission does not reopen, erase or re-resolve them. Never recycle their IDs.',
  'Do not import closed work-item findings into the finalization report merely to recount history. Assess the combined implementation against the plan; reopen a historical concern only if current evidence warrants it.',
  'Reconcile findings and operator corrections from this run and the handoff, including observations in invalid reports. An invalid report cannot establish closure or approval.',
  'Use an empty findings array only when no new findings exist and no previously open findings require a current disposition. A report that silently omits an open finding is rejected.',
].join(' ');

/**
 * The `craftingtable-review` block: one example with every field this run reports, so a scoped
 * review's `scopeEvidence` is shown at the top level, beside the verdict (LIVE-32).
 */
function reviewFormat(context: OutputContext): BlockFormat {
  const scope = context.scope;
  const stage = context.finalizationStage;
  const example = {
    version: 1,
    complete: true,
    verdict: 'changes-requested',
    exitGate: { met: false, evidence: 'Which criteria and checks passed or failed' },
    findings: [
      {
        id: 'F-001',
        severity: 'major',
        status: 'open',
        title: 'Title',
        location: { path: 'src/a.ts', line: 10 },
        explanation: 'What is wrong and why.',
        recommendation: 'What resolves it.',
        ...(scope?.owningSlices?.length ? { owningSlice: scope.owningSlices[0]!.id } : {}),
      },
    ],
    // A staged finalization review's stage object, with this stage's id (R-G6 review M1).
    ...(stage
      ? {
          finalization: {
            stageId: stage.id,
            fullChecks: stage.fullChecks,
            checks: [
              {
                name: 'Exact configured check name',
                status: 'passed',
                evidence: 'Command and result',
              },
            ],
            obligations: [],
          },
        }
      : {}),
    ...(scope
      ? {
          scopeEvidence: {
            scope: scope.identity,
            requirements: [
              {
                requirement: 'An evidence obligation, word for word',
                evidence: 'Commands, results and durable references',
              },
            ],
            caseIds: scope.cases,
          },
        }
      : {}),
  };
  return {
    shape: [
      'The `craftingtable-review` block:',
      '```craftingtable-review',
      JSON.stringify(example),
      '```',
      'Severities: blocking, major, minor, nit; statuses: open, resolved, withdrawn (resolved or withdrawn needs a disposition: evidence or a reason); location optional; a finding id is a letter or digit, then letters, digits, periods, underscores or hyphens, at most 64; texts under 20,000 characters, titles under 500; complete true only once consolidated; mergeable only with exitGate.met true and no open blocking or major finding.',
      ...(stage
        ? [
            `finalization: this stage's stageId and fullChecks as shown; checks: every configured requiredChecks name exactly, at least one, each with status passed, failed or not-run and its evidence; obligations: entries {id, status: met, gap or change-requested (with proposedRequirement), evidence}, adding source, requirement and workItemSourceId only for a new obligation. A met exitGate needs every reported check passed and obligation met.`,
          ]
        : []),
      scope
        ? 'scopeEvidence is a top-level field beside verdict, never inside exitGate or its evidence text: this exact scope identity, a requirements entry per evidence obligation you verified, with the obligation’s text copied exactly as its requirement, and caseIds for the cases you checked.'
        : 'Omit scopeEvidence: this run has no controller-owned scope.',
      ...(scope?.owningSlices?.length
        ? [
            [
              'For each open finding, set "owningSlice" in the craftingtable-review report to the required slice whose scope covers its fix, so the repair goes there; omit it only when no single slice can own the fix. The required slices:',
              ...scope.owningSlices.map(
                (slice) =>
                  `- ${slice.id}: ${slice.scope}${slice.excludes.length ? ` Excludes: ${slice.excludes.join(' ')}` : ''}`,
              ),
            ].join('\n'),
          ]
        : []),
    ].join('\n'),
    rules: [
      context.planFinalization
        ? FINALIZATION_FINDINGS_INSTRUCTIONS
        : 'Findings continuity: reconcile ALL findings raised in this run and its handoff lineage, operator corrections included. Keep their IDs, never omit or recycle one, and keep resolved and withdrawn findings with their dispositions. Verify a fix before marking its finding resolved; never silently drop a disagreement.',
      'craftingtable-review: findings may be empty. Finding IDs look like F-001 or AQ-11.F-009, never with slashes. Keep exitGate.evidence a concise summary of current checks and conformance that cites detailed evidence, never appending earlier reports.',
    ],
  };
}
