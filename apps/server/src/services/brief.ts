import type { AgentRunRole, JsonValue, ReviewBranchContext, WorkItem } from '@craftingtable/domain';
import type { HandoffFiles } from './run-handoff.js';

/**
 * Composes the prompt handed to an agent as its first message.
 *
 * The brief is pure data in, text out. Role templates are the composition
 * seam for orchestrated cycles: a review run reads the same work item with a
 * different role and a `parentRunId`, and a later orchestrator can chain them
 * without new vocabulary.
 */

export interface BriefDependency {
  readonly sourceId: string;
  readonly title: string;
  readonly status: WorkItem['status'];
}

export interface BriefPlanDocument {
  readonly filename: string;
  readonly role: string;
  /** Absolute path where the daemon wrote the document for this run. */
  readonly path: string;
}

export interface BriefInput {
  readonly resolvingIntegration?: boolean;
  readonly planFinalization?: boolean;
  readonly reviewReportRetry?: {
    readonly issues: readonly string[];
    readonly reuseVerification: boolean;
  };
  readonly temporaryDirectory?: string;
  readonly reviewBranchContext?: ReviewBranchContext;
  readonly role: AgentRunRole;
  readonly projectName: string;
  readonly workItem: {
    readonly sourceId: string;
    readonly title: string;
    readonly risk: string;
    readonly phase?: string;
    readonly primaryAreas: readonly string[];
    readonly exitGate: string;
    readonly sourceFields: JsonValue;
  };
  readonly requiredDependencies: readonly BriefDependency[];
  readonly recommendedDependencies: readonly BriefDependency[];
  readonly worktree: {
    readonly path: string;
    readonly branchName: string;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly integrationBranch?: string;
  };
  readonly planDocuments: readonly BriefPlanDocument[];
  readonly instructions?: string;
  /** The run this one continues from, with its final message. */
  readonly parentRun?: BriefParentRun;
}

export interface BriefParentRun {
  readonly role: AgentRunRole;
  readonly verdict?: 'mergeable' | 'changes-requested';
  /** The parent's final message: a review's findings, an implementation's summary. */
  readonly finalMessage: string;
  readonly handoff?: Omit<HandoffFiles, 'sources'>;
}

const REMEDIATION_INSTRUCTIONS = [
  'This run remediates a review. The review findings are supplied in the handoff as the',
  'reviewer wrote them. Read the handoff files and reconcile earlier messages with later',
  'corrections and withdrawals. Preserve finding IDs. Work through every open finding: fix it, or if you disagree explain',
  'precisely why in your final message. Run the quality checks, commit on this branch,',
  'and finish with a disposition for each finding (fixed, disagreed, or deferred with a',
  'reason) followed by your usual summary. Your disposition is a claim for the next',
  'reviewer to verify; it does not itself close the finding.',
].join(' ');

const ACCEPTED_DESIGN_INSTRUCTIONS = [
  'Implement this design. The operator accepted the proposal reproduced below from a',
  'design run on this work item; treat it as the plan. Deviate only where the code forces',
  'it, and say exactly where and why in your summary. If the proposal lists open',
  'questions, resolve each one with the simplest choice consistent with the exit gate',
  'and state the choice you made.',
].join(' ');

const REVIEW_REPORT_INSTRUCTIONS = [
  'Immediately before that final verdict line, include exactly one fenced JSON block',
  'with the language craftingtable-review. It is your authoritative consolidated report.',
  'A later reviewer verifies fixes before marking a finding resolved. Do not silently drop disagreements.',
  'Finding IDs must start with a letter or digit and contain only letters, digits, periods, underscores or hyphens, at most 64 characters; use F-001 or AQ-11.F-009, never slashes.',
  'Keep exitGate.evidence concise: summarize current checks and conformance, cite detailed evidence, and stay below its 20,000-character limit. Never append evidence from prior reports. Each explanation, recommendation and disposition also has a 20,000-character limit; titles have a 500-character limit.',
  'The report shape is:',
  '```craftingtable-review',
  '{"version":1,"complete":true,"verdict":"changes-requested","exitGate":{"met":false,"evidence":"Explain which criteria and checks passed or failed."},"findings":[{"id":"F-001","severity":"major","status":"open","title":"Short title","location":{"path":"src/example.ts","line":10},"explanation":"What is wrong and why.","recommendation":"What would resolve it."}]}',
  '```',
  'Allowed severities: blocking, major, minor, nit. Allowed statuses: open, resolved,',
  'withdrawn. Location is optional for findings that have no file location. Resolved and',
  'withdrawn findings require a disposition string with evidence or a reason. Use an',
  'empty findings array when none exist. The verdict must match your final VERDICT line.',
  'Set complete to true only once you have consolidated the entire review. A mergeable',
  'report requires exitGate.met=true and no open blocking or major findings.',
].join('\n');

const ROLE_INSTRUCTIONS: Readonly<Record<AgentRunRole, string>> = {
  implement: [
    'You are the implementation agent for this work item.',
    'Implement it completely inside this worktree. Write focused tests where behaviour is',
    'non-trivial, run the project’s quality checks, and commit your work on this branch',
    'with clear commit messages as you reach coherent increments. Do not push, do not',
    'switch branches, and keep source changes inside this worktree. Use the provided temporary directory for scratch files.',
    'After all verification, inspect git status including untracked files. Commit intended source changes; explicitly stage any intended new source files even if you cannot finish the commit. Never stage generated test output, scratch files, credentials, or unrelated files. Report remaining paths and why they remain.',
    'Finish with a summary of what changed, how you verified it, and anything left undone',
    'or worth the operator’s attention.',
  ].join(' '),
  review: [
    'You are an independent reviewer for this work item.',
    'Run the repository-required verification checks on this exact branch, including the combined integration changes. Record the commands and results in exitGate.evidence. Do not change or commit code during review; request remediation when changes are needed.',
    'Do not modify repository files. Verification records belong in the provided temporary directory. Compare the branch in this worktree against its base',
    'revision, read the changed code and its tests, and run the quality checks read-only.',
    'Summarize your conclusion in prose and include every finding in the structured',
    'report below; do not duplicate the full findings in prose. State explicitly',
    'whether the work meets the exit gate. The very last line of your final message must',
    'be exactly `VERDICT: mergeable` if the branch can be merged as it stands, or',
    '`VERDICT: changes-requested` if anything blocking or major remains. CraftingTable',
    'reads that line; a merge is only offered after a mergeable verdict.',
    REVIEW_REPORT_INSTRUCTIONS,
  ].join(' '),
  design: [
    'You are exploring and designing this work item before implementation.',
    'Read the relevant code and plan documents, identify the decisions that matter,',
    'and propose a concrete approach: which files change, what the interfaces look like,',
    'what the risks are, and what you would test. Do not modify source files; write your',
    'proposal as your final message. End it with a section headed `## Open questions`',
    'listing every decision that needs the operator, or the single word `none` if it can',
    'be implemented as written. CraftingTable hands your final message to the implement',
    'run that follows.',
  ].join(' '),
};

const FINALIZATION_FINDINGS_INSTRUCTIONS = [
  'Finalization reports cover active findings and changes in reviewer disposition.',
  'Report every previously OPEN finding with its current status, plus every new or reopened finding. Verify a fix before reporting its resolution, with a concise disposition.',
  'Unchanged resolved or withdrawn findings may be omitted from later reports. They remain in the journal and closed-findings history; omission does not reopen, erase or re-resolve them. Never recycle their IDs.',
  'Do not import closed work-item findings into the finalization report merely to recount history. Assess the combined implementation against the plan; reopen a historical concern only if current evidence warrants it.',
  'Reconcile findings and operator corrections from this run and the handoff, including observations in invalid reports. An invalid report cannot establish closure or approval.',
  'Use an empty findings array only when no new findings exist and no previously open findings require a current disposition. A report that silently omits an open finding is rejected.',
].join(' ');

function formatDependencies(entries: readonly BriefDependency[]): string {
  if (entries.length === 0) {
    return '- none';
  }
  return entries.map((entry) => `- ${entry.sourceId}: ${entry.title} (${entry.status})`).join('\n');
}

function formatSourceFields(value: JsonValue): string {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  return serialized.length > 20_000 ? `${serialized.slice(0, 20_000)}\n…(truncated)` : serialized;
}

export function composeBrief(input: BriefInput): string {
  const { workItem, worktree } = input;
  const sections: string[] = [];
  sections.push(
    input.planFinalization
      ? `# Plan finalization: ${workItem.title}`
      : `# Work item ${workItem.sourceId}: ${workItem.title}`,
  );
  sections.push(`Project: ${input.projectName}\nRole: ${input.role}`);
  sections.push(
    `## Your role\n\n${input.resolvingIntegration ? 'Resolve the daemon-prepared integration merge in this worktree. Stage intended changes and verify the combined behavior. Do not commit, switch branches, start another merge, abort the merge, or move any branch. The daemon owns completion. Follow the pinned resolution instructions below.' : ROLE_INSTRUCTIONS[input.role]}`,
  );
  if (input.role === 'review' && !input.resolvingIntegration) {
    sections.push(
      `## Findings continuity\n\n${
        input.planFinalization
          ? FINALIZATION_FINDINGS_INSTRUCTIONS
          : 'Reconcile ALL findings raised anywhere in this run and the handoff lineage, including operator corrections. Keep prior IDs; never omit or recycle them. Retain resolved and withdrawn findings with their dispositions.'
      }`,
    );
  }
  if (input.planFinalization && input.role !== 'review') {
    sections.push(
      '## Findings scope\n\nAddress the open findings and report dispositions for work done in this attempt. Previously closed findings remain in the recorded history; do not repeat or re-resolve them without new evidence.',
    );
  }
  sections.push(
    [
      '## Objective and exit gate',
      '',
      `Exit gate: ${workItem.exitGate}`,
      '',
      `Risk: ${workItem.risk}${workItem.phase === undefined ? '' : `\nPhase: ${workItem.phase}`}`,
      `Primary areas: ${workItem.primaryAreas.length === 0 ? 'unspecified' : workItem.primaryAreas.join(', ')}`,
    ].join('\n'),
  );
  sections.push(
    [
      '## Dependencies',
      '',
      'Required predecessors:',
      formatDependencies(input.requiredDependencies),
      '',
      'Recommended predecessors:',
      formatDependencies(input.recommendedDependencies),
    ].join('\n'),
  );
  sections.push(
    [
      '## Working environment',
      '',
      `You are in a dedicated Git worktree at \`${worktree.path}\` on branch \`${worktree.branchName}\`,`,
      `created from \`${worktree.baseBranch}\` at \`${worktree.baseSha}\`.`,
      'This is the only place you may change files. The primary checkout and other worktrees',
      'of this repository are off limits.',
    ].join('\n'),
  );
  if (worktree.integrationBranch !== undefined) {
    sections.push(
      `Integration destination: ${worktree.integrationBranch}. Only the daemon may merge into it under the operator’s approval or recorded integration policy.`,
    );
  }
  if (input.reviewBranchContext !== undefined) {
    const context = input.reviewBranchContext;
    sections.push(
      `Review baseline: item commit ${context.headSha}; integration branch ${context.targetBranch} at ${context.targetSha}. Verify this combined state and report the checks you ran. Do not move either branch during review.`,
    );
  }
  if (input.temporaryDirectory) {
    sections.push(
      [
        '## Temporary files',
        `TMPDIR, TMP, and TEMP point to ${input.temporaryDirectory}. Use this controller-owned directory for test temporary files and scratch output. It is outside the Git worktree and available to this run. Do not redirect temporary files to the worktree root. Do not commit test artifacts. Preserve verification results in your final message. Reuse the project’s normal build cache across runs (for example, the existing Cargo target directory). Avoid creating a fresh full build cache per run unless verification requires isolation. Scratch is disposable: recognized build caches may be removed after merge and worktree removal, and other scratch may expire under the storage policy. Source edits remain restricted to the worktree; this directory is for temporary data only.`,
      ].join('\n\n'),
    );
  }
  if (input.planDocuments.length > 0) {
    sections.push(
      [
        '## Plan documents',
        '',
        'The plan bundle this work item came from is available read-only at these paths.',
        input.planFinalization
          ? 'Read the entire plan and work-item inventory before starting.'
          : 'Read the parts that concern this work item before starting.',
        '',
        ...input.planDocuments.map((document) => `- ${document.role}: \`${document.path}\``),
      ].join('\n'),
    );
  }
  sections.push(
    [
      '## Source definition',
      '',
      'Every field of this work item as written in the plan:',
      '',
      '```json',
      formatSourceFields(workItem.sourceFields),
      '```',
    ].join('\n'),
  );
  const parent = input.parentRun;
  if (parent?.handoff !== undefined) {
    sections.push(
      [
        '## Handoff source files',
        '',
        input.planFinalization
          ? `Start with the handoff manifest at \`${parent.handoff.manifestPath}\`, the active findings snapshot and the immediate parent's complete outcome. Consult source conversations for operator decisions, corrections, uncertain observations and evidence; older reports are history, not text to reproduce.`
          : `Read the handoff manifest at \`${parent.handoff.manifestPath}\` and the conversation and report files it lists before starting.`,
        'These files include earlier messages, operator corrections, and prior runs in this lineage. Paths in the manifest are relative to its directory.',
        'Reports with status complete are structurally validated reviewer assertions. Unstructured or invalid reports require reconciliation against the conversation; ask the operator about unresolved ambiguity.',
        'Earlier findings may be corrected or withdrawn later. Do not treat every historical statement as a current finding. Preserve existing finding IDs across review rounds.',
        `The full recorded final message is at \`${parent.handoff.finalMessagePath}\`.`,
        ...(parent.handoff.findingsPath
          ? [
              `Active findings and closed-history index: \`${parent.handoff.findingsPath}\`. This is derived from valid reports at the delivered event cursors. Omitted closed findings retain their last reviewer disposition.`,
            ]
          : []),
        ...parent.handoff.warnings.map((warning) => `Handoff warning: ${warning}`),
      ].join('\n\n'),
    );
  }
  const parentMessage =
    input.planFinalization && parent?.handoff
      ? `Read the complete outcome at \`${parent.handoff.finalMessagePath}\`. Use the active findings snapshot; do not copy the historical report into your response.`
      : (parent?.finalMessage.trim() ?? '');
  if (
    parent !== undefined &&
    (parent.finalMessage.trim().length > 0 || parent.handoff !== undefined)
  ) {
    if (!input.resolvingIntegration && parent.role === 'review' && input.role === 'implement') {
      sections.push(`## Remediation\n\n${REMEDIATION_INSTRUCTIONS}`);
      sections.push(
        `## Review findings to address${
          parent.verdict === undefined ? '' : ` (verdict: ${parent.verdict})`
        }\n\n${parentMessage}`,
      );
    } else if (
      !input.resolvingIntegration &&
      parent.role === 'design' &&
      input.role === 'implement'
    ) {
      sections.push(`## Accepted design\n\n${ACCEPTED_DESIGN_INSTRUCTIONS}`);
      sections.push(`## Design proposal\n\n${parentMessage}`);
    } else if (parent.role === 'implement' && input.role === 'review') {
      sections.push(
        `## The implementation run's own summary\n\nTreat this as a claim to verify, not as evidence.\n\n${parentMessage}`,
      );
    } else {
      sections.push(`## Previous ${parent.role} run\n\n${parentMessage}`);
    }
  }
  if (input.instructions !== undefined && input.instructions.trim().length > 0) {
    sections.push(`## Operator instructions\n\n${input.instructions.trim()}`);
  }
  if (input.reviewReportRetry) {
    sections.push(
      [
        '## Correct the rejected review report',
        `The preceding report was rejected: ${input.reviewReportRetry.issues.join(' ')}`,
        'Read its complete final message and reconcile all its findings, including new findings and dispositions not yet accepted by the controller. Return a corrected, concise report using the current findings-continuity rules; do not append prior evidence or repeat unchanged closed findings. Retain the required Open questions section and matching final VERDICT line.',
        input.reviewReportRetry.reuseVerification
          ? 'The daemon confirmed that the preceding successful, untruncated review recorded the same candidate and destination commits. Recheck those commits and worktree cleanliness. Where its findings and verification evidence are complete and applicable, reuse them with explicit references; do not rerun the whole suite solely to repair report formatting. Perform any additional investigation needed to resolve substantive uncertainty. If either commit or relevant verification conditions changed, perform a fresh review and rerun affected checks.'
          : 'The prior review is incomplete or its candidate/destination snapshot cannot be reused. Perform a fresh review and run the required verification; do not carry its approval forward.',
        'This recovery instruction applies only to this attempt. Later polish and independent review steps follow their normal verification requirements.',
      ].join('\n\n'),
    );
  }
  return `${sections.join('\n\n')}\n`;
}
