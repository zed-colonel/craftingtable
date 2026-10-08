import type { AgentRunRole, ExecutionScope } from '@craftingtable/domain';

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
  /** The shapes and rules of the blocks those parts name, each a paragraph. */
  readonly formats: readonly string[];
}

/** The final message as the brief states it: one ordered list, then the formats. */
export function finalMessageSection(instructions: RoleInstructions): string {
  return [
    '## Your final message',
    '',
    `End your final message with ${instructions.finalMessage.length === 1 ? 'this' : 'these parts, in this order'}:`,
    ...instructions.finalMessage.map((part, index) => `${index + 1}. ${part}`),
    ...instructions.formats.flatMap((format) => ['', format]),
  ].join('\n');
}

/** The `## Open questions` part, shared by every role that ends with it. */
export function openQuestionsPart(
  workflow: WorkflowOutput | undefined,
  detail: string,
  finalization = false,
): string {
  return [
    'A section headed `## Open questions`, containing only `none` when no operator answer is needed.',
    detail,
    workflow
      ? 'Repeat there every genuine operator question of the workflow block; never put controller-managed pending obligations there.'
      : '',
    finalization ? 'Genuine questions always stop progression.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export const WORKFLOW_PART = 'One fenced `craftingtable-workflow` block (its shape is below).';

/** The `craftingtable-workflow` block's shape (the controller's workflow contract). */
export function workflowFormat(workflow: WorkflowOutput): string {
  return [
    'The `craftingtable-workflow` block:',
    '```craftingtable-workflow',
    JSON.stringify({
      version: 1,
      questions: [],
      resolved: [],
      securityReview: { required: false, sources: [] },
    }),
    '```',
    'questions entries: {question, destination:"shared-decision"|"work-item", checkpointId?:"exact ADR ID"}; a mapped ADR question goes to shared-decision with its exact checkpointId, and local implementation choices, contradictions and unsupported controller actions to work-item. resolved entries: {question, answer, sources:["exact plan section or accepted evidence ID"]}. If a security review is required, set required:true and cite the source policy.',
    ...(workflow.checkpointId
      ? [
          `Add checkpoint:{id:${JSON.stringify(workflow.checkpointId)},passed:boolean,requirements:[{requirement:"exact required text",evidence:"observations and immutable references"}],caseIds:["actually verified case IDs"]} to the workflow block.`,
        ]
      : []),
  ].join('\n');
}
