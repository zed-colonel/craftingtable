import type { AgentRunRole, JsonValue, WorkItem } from '@craftingtable/domain';
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
  'This run remediates a review. The review findings are reproduced below, numbered as the',
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
  'Reconcile ALL findings raised anywhere in this run and the handoff lineage, including',
  'operator corrections. Keep prior IDs; never omit or recycle them. Use new IDs such as',
  'F-001, F-002. A later reviewer verifies fixes before marking a finding resolved.',
  'Retain withdrawn findings with the reason. Do not silently drop disagreements.',
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
    'switch branches, and do not modify anything outside this worktree.',
    'Finish with a summary of what changed, how you verified it, and anything left undone',
    'or worth the operator’s attention.',
  ].join(' '),
  review: [
    'You are an independent reviewer for this work item.',
    'Do not modify any file. Compare the branch in this worktree against its base',
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
  sections.push(`# Work item ${workItem.sourceId}: ${workItem.title}`);
  sections.push(`Project: ${input.projectName}\nRole: ${input.role}`);
  sections.push(`## Your role\n\n${ROLE_INSTRUCTIONS[input.role]}`);
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
  if (input.planDocuments.length > 0) {
    sections.push(
      [
        '## Plan documents',
        '',
        'The plan bundle this work item came from is available read-only at these paths.',
        'Read the parts that concern this work item before starting.',
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
        `Read the handoff manifest at \`${parent.handoff.manifestPath}\` and the conversation and report files it lists before starting.`,
        'These files include earlier messages, operator corrections, and prior runs in this lineage. Paths in the manifest are relative to its directory.',
        'Reports with status complete are structurally validated reviewer assertions. Unstructured or invalid reports require reconciliation against the conversation; ask the operator about unresolved ambiguity.',
        'Earlier findings may be corrected or withdrawn later. Do not treat every historical statement as a current finding. Preserve existing finding IDs across review rounds.',
        `The full recorded final message is at \`${parent.handoff.finalMessagePath}\`. The inline text below is only a preview when it ends with a truncation marker.`,
        ...parent.handoff.warnings.map((warning) => `Handoff warning: ${warning}`),
      ].join('\n\n'),
    );
  }
  if (
    parent !== undefined &&
    (parent.finalMessage.trim().length > 0 || parent.handoff !== undefined)
  ) {
    if (parent.role === 'review' && input.role === 'implement') {
      sections.push(`## Remediation\n\n${REMEDIATION_INSTRUCTIONS}`);
      sections.push(
        `## Review findings to address${
          parent.verdict === undefined ? '' : ` (verdict: ${parent.verdict})`
        }\n\n${parent.finalMessage.trim()}`,
      );
    } else if (parent.role === 'design' && input.role === 'implement') {
      sections.push(`## Accepted design\n\n${ACCEPTED_DESIGN_INSTRUCTIONS}`);
      sections.push(`## Design proposal\n\n${parent.finalMessage.trim()}`);
    } else if (parent.role === 'implement' && input.role === 'review') {
      sections.push(
        `## The implementation run's own summary\n\nTreat this as a claim to verify, not as evidence.\n\n${parent.finalMessage.trim()}`,
      );
    } else {
      sections.push(`## Previous ${parent.role} run\n\n${parent.finalMessage.trim()}`);
    }
  }
  if (input.instructions !== undefined && input.instructions.trim().length > 0) {
    sections.push(`## Operator instructions\n\n${input.instructions.trim()}`);
  }
  return `${sections.join('\n\n')}\n`;
}
