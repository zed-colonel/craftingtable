import { type AgentRunRole, type ExecutionScope, V03_VOCABULARY } from '@craftingtable/domain';

/**
 * What an agent is asked to be and to return (R-G6, AGT-54). Each role's instructions live in
 * one module (`brief-review.ts`, `brief-implement.ts`, `brief-design.ts`), which states the
 * final message as one ordered list, so no two places ask for the same block or give it
 * different positions. The formats themselves are unchanged (G6-1): the `craftingtable-review`,
 * `-workflow`, `-design` and `-investigation` blocks, `## Open questions`, `## Review report`,
 * `## Resolution status` and the `VERDICT` line are read by their parsers as before.
 */
export interface OutputContext {
  readonly role: AgentRunRole;
  /** A question stop's read-only investigation (R-C16), which runs as a design-role run. */
  readonly investigation: boolean;
  /** The daemon-prepared integration merge this run resolves. */
  readonly resolvingIntegration: boolean;
  readonly planFinalization: boolean;
  /** An implement run remediating a review's findings. */
  readonly remediation: boolean;
  /** A scoped run, with what a review reports evidence for. */
  readonly scope?: {
    readonly identity: ExecutionScope;
    readonly cases: readonly string[];
    /** The parent's required slices, for a parent-acceptance review to name owners (LIVE-27). */
    readonly owningSlices?: readonly {
      readonly id: string;
      readonly scope: string;
      readonly excludes: readonly string[];
    }[];
  };
  /** The controller's workflow contract applies: one `craftingtable-workflow` block. */
  readonly workflow?: WorkflowOutput;
  /** The staged finalization stage a review reports on (R-B10). */
  readonly finalizationStage?: { readonly id: string; readonly fullChecks: boolean };
  /** The plan has architecture checkpoints a design may propose decisions for. */
  readonly architectureDecisions: boolean;
}

/** The workflow block's context: a separate checkpoint review adds its attestation. */
export interface WorkflowOutput {
  readonly checkpointId?: string;
}

export interface RoleInstructions {
  /** Who the agent is in this run and how it works. */
  readonly role: string;
  /** Further rules for this role in this context, each a paragraph. */
  readonly rules: readonly string[];
  /** The final message's parts, in order. */
  readonly finalMessage: readonly string[];
  /** The blocks those parts name. */
  readonly formats: readonly BlockFormat[];
}

/** A block's shape, which the brief always shows, and its rules, which may live in a file. */
export interface BlockFormat {
  /** The block's example and what this run must put in it. */
  readonly shape: string;
  /** The rules every such block follows. */
  readonly rules: readonly string[];
}

/**
 * The final message as the brief states it: one ordered list, then each block's shape; the
 * blocks' rules are where `rulesAt` says (AGT-50: schema prose in a file).
 */
export function finalMessageSection(
  instructions: RoleInstructions,
  rulesAt: string | undefined,
): string {
  return [
    '## Your final message',
    '',
    `End your final message with ${instructions.finalMessage.length === 1 ? 'this' : 'these parts, in this order'}:`,
    ...instructions.finalMessage.map((part, index) => `${index + 1}. ${part}`),
    ...instructions.formats.flatMap((format) => ['', format.shape]),
    ...(rulesAt && instructions.formats.some((format) => format.rules.length)
      ? ['', `Read the rules for these blocks in ${rulesAt} before you write them.`]
      : []),
  ].join('\n');
}

/** The controller's workflow contract, beside the step's own rules (`workflowRules`). */
export function workflowContract(): string {
  return `Technical review and permission to merge are separate. Assess source defects and required tests now. Pending merge checkpoints, predecessor work and separately scheduled reviews are controller obligations, not code defects or operator questions: record them as pending, never as passed; the controller enforces every transition gate. Withdraw obsolete administrative findings by their IDs with an explanation, without hiding source defects, and never waive architectural approvals, safety requirements, unproven tests or exceptions. A review's verdict judges the technical candidate; the daemon enforces permission to merge. Answer questions the approved plan, recorded decisions or supplied evidence already settle, citing them; only genuinely new architectural decisions need the operator.
For a security-sensitive change, declare in the workflow block the source requirement for a second security review, with citations: the controller schedules a DISTINCT read-only security review after remediation if the saved roadmap assigns ${V03_VOCABULARY.securityReviewerRole}, or on the operator's authority when no roadmap delegates this cycle. The ordinary reviewer does not claim two reviews; security requirements stand until a separate review of the same candidate and integration target succeeds.`;
}

/** The `## Open questions` part, shared by every role that ends with it. */
export function openQuestionsPart(
  workflow: WorkflowOutput | undefined,
  detail: string,
  finalization = false,
): string {
  return [
    'A section headed `## Open questions`: only `none` when no operator answer is needed.',
    detail,
    workflow
      ? 'It repeats each genuine operator question of the workflow block, never a pending controller obligation.'
      : '',
    finalization ? 'Genuine questions always stop progression.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export const WORKFLOW_PART = 'One fenced `craftingtable-workflow` block (shape below).';

/** The `craftingtable-workflow` block (the controller's workflow contract). */
export function workflowFormat(workflow: WorkflowOutput): BlockFormat {
  return {
    shape: [
      'The `craftingtable-workflow` block:',
      '```craftingtable-workflow',
      JSON.stringify({
        version: 1,
        questions: [],
        resolved: [],
        securityReview: { required: false, sources: [] },
      }),
      '```',
      'questions entries: {question, destination: "shared-decision" or "work-item", checkpointId?}; resolved entries: {question, answer, sources: at least one}; required: true needs its sources.',
      ...(workflow.checkpointId
        ? [
            `Add checkpoint:{id:${JSON.stringify(workflow.checkpointId)},passed:boolean,requirements:[{requirement:"exact required text",evidence:"observations and immutable references"}],caseIds:["actually verified case IDs"]} to the workflow block.`,
          ]
        : []),
    ].join('\n'),
    rules: [
      'craftingtable-workflow: a mapped ADR question goes to shared-decision with its exact checkpointId; local implementation choices, contradictions and unsupported controller actions go to work-item. A resolved entry cites the exact plan section or accepted evidence ID. A required security review cites the source policy.',
    ],
  };
}
