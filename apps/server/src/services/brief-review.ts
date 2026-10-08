import {
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
      'You are an independent reviewer for this work item.',
      'Run the repository-required verification checks on this exact branch, including the combined integration changes, and record the commands and results in exitGate.evidence.',
      'Do not modify repository source files, and do not change or commit code; request remediation when changes are needed. Verification records belong in the provided temporary directory.',
      'Compare the branch in this worktree against its base revision, read the changed code and its tests, and run the quality checks read-only. State explicitly whether the work meets the exit gate.',
      ...(scope
        ? [
            'A slice review approves integration of its scope; it never accepts its parent. A parent-acceptance review independently assesses the full original exit gate and retained source-plan obligations. Never claim that missing verification or outside-scope obligations passed.',
          ]
        : []),
    ].join(' '),
    rules: [
      context.planFinalization
        ? FINALIZATION_FINDINGS_INSTRUCTIONS
        : 'Findings continuity: reconcile ALL findings raised anywhere in this run and the handoff lineage, including operator corrections. Keep prior IDs; never omit or recycle them. Retain resolved and withdrawn findings with their dispositions. A later reviewer verifies fixes before marking a finding resolved. Do not silently drop disagreements.',
    ],
    finalMessage: [
      'Your conclusion in prose. Every finding goes in the report below; do not repeat the findings in prose.',
      ...(context.workflow ? [WORKFLOW_PART] : []),
      openQuestionsPart(
        context.workflow,
        'Otherwise put each unresolved operator approval, exception or policy choice there as a concrete question, even when it is also a finding. Do not repeatedly delegate an unanswered approval as a code repair.',
        !!context.finalizationStage,
      ),
      'A section headed `## Review report`, holding exactly one fenced `craftingtable-review` block: your authoritative consolidated report (its shape is below).',
      'As the very last line, exactly `VERDICT: mergeable` if the branch can be merged as it stands, or `VERDICT: changes-requested` if anything blocking or major remains. It must match the report’s verdict. CraftingTable reads that line; a merge is only offered after a mergeable verdict.',
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
function reviewFormat(context: OutputContext): string {
  const scope = context.scope;
  const stage = context.finalizationStage;
  const example = {
    version: 1,
    complete: true,
    verdict: 'changes-requested',
    exitGate: { met: false, evidence: 'Explain which criteria and checks passed or failed.' },
    findings: [
      {
        id: 'F-001',
        severity: 'major',
        status: 'open',
        title: 'Short title',
        location: { path: 'src/example.ts', line: 10 },
        explanation: 'What is wrong and why.',
        recommendation: 'What would resolve it.',
        ...(scope?.owningSlices?.length ? { owningSlice: scope.owningSlices[0]!.id } : {}),
      },
    ],
    ...(scope
      ? {
          scopeEvidence: {
            scope: scope.identity,
            requirements: [
              {
                requirement: 'One entry per evidence obligation, its text copied exactly',
                evidence: 'Concise commands/results and durable evidence references',
              },
            ],
            caseIds: scope.cases,
          },
        }
      : {}),
  };
  return [
    'The `craftingtable-review` block:',
    '```craftingtable-review',
    JSON.stringify(example),
    '```',
    'Allowed severities: blocking, major, minor, nit. Allowed statuses: open, resolved, withdrawn; resolved and withdrawn findings require a disposition string with evidence or a reason. Location is optional for findings that have no file location. Use an empty findings array when none exist.',
    'Finding IDs must start with a letter or digit and contain only letters, digits, periods, underscores or hyphens, at most 64 characters; use F-001 or AQ-11.F-009, never slashes.',
    'Keep exitGate.evidence concise: summarize current checks and conformance, cite detailed evidence, and stay below its 20,000-character limit. Never append evidence from prior reports. Each explanation, recommendation and disposition also has a 20,000-character limit; titles have a 500-character limit.',
    'Set complete to true only once you have consolidated the entire review. A mergeable report requires exitGate.met=true and no open blocking or major findings.',
    scope
      ? 'scopeEvidence is a top-level field of the report, beside version, verdict, exitGate and findings, never inside exitGate or its evidence text. Give this exact scope identity, one requirements entry for each evidence obligation under Goal and acceptance that you actually verified, with the obligation’s text copied exactly as its requirement, and caseIds for the cases you actually checked.'
      : 'Omit scopeEvidence: this run has no controller-owned scope.',
    ...(scope?.owningSlices?.length
      ? [
          [
            'For each open finding, set "owningSlice" in the craftingtable-review report to the required slice whose scope covers its fix, so the repair goes there without asking the operator. Omit it only when no single slice can own the fix. The required slices:',
            ...scope.owningSlices.map(
              (slice) =>
                `- ${slice.id}: ${slice.scope}${slice.excludes.length ? ` Excludes: ${slice.excludes.join(' ')}` : ''}`,
            ),
          ].join('\n'),
        ]
      : []),
    ...(stage
      ? [
          `Add a finalization object to the report: {"stageId":${JSON.stringify(stage.id)},"fullChecks":${stage.fullChecks},"checks":[{"name":"exact configured check name or repository check","status":"passed|failed|not-run","evidence":"concise command/result and log location"}],"obligations":[{"id":"stable obligation ID from ledger or new plan obligation","source":"exact adopted source citation","requirement":"exact adopted requirement","workItemSourceId":"only if present in ledger","status":"met|gap|change-requested","evidence":"implementation location and verification evidence"}]}. Use actual values, not these placeholders. Report all configured requiredChecks by exact name. Include at least one relevant verification check. A met exitGate requires all reported checks passed and all reported obligations met.`,
        ]
      : []),
  ].join('\n');
}
