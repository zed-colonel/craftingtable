import {
  type OutputContext,
  openQuestionsPart,
  type RoleInstructions,
  WORKFLOW_PART,
  workflowFormat,
} from './brief-output.js';

/**
 * The design role (R-G6, AGT-54): what a design run does and the one final message it returns,
 * the proposal with its `craftingtable-design` block and `## Open questions`. The decision
 * proposal's shape is given only where the plan has architecture checkpoints (AGT-50).
 */
export function designInstructions(context: OutputContext): RoleInstructions {
  return {
    role: [
      'You are exploring and designing this work item before implementation.',
      'Read the relevant code and plan documents, identify the decisions that matter,',
      'and propose a concrete approach: which files change, what the interfaces look like,',
      'what the risks are, and what you would test. Do not modify source files. CraftingTable',
      'hands your final message to the implement run that follows.',
    ].join(' '),
    rules: context.scope
      ? [
          'Before asking the operator, consult the exact supplied plans, current predecessor receipts, repository policy and approved architecture decisions in craftingtable-scope-evidence.json. Cite answers already fixed by those sources and proceed within their authority. A recommendation awaiting approval is not an accepted decision. A full-checkpoint approval and a scoped early-clause approval have different coverage.',
          'Distinguish future merge/verification obligations from what this design needs now. An authorized early slice need not wait for every original parent predecessor. Worktree provisioning, supplied dependency paths and existing receipts are controller context; inspect them before asking the operator to create them.',
        ]
      : [],
    finalMessage: [
      'Your proposal.',
      'One fenced `craftingtable-design` block (its shape is below).',
      ...(context.workflow ? [WORKFLOW_PART] : []),
      openQuestionsPart(
        context.workflow,
        'Otherwise list every decision that needs the operator. Keep all unresolved design items there; use none only when every item is resolved.',
      ),
    ],
    formats: [
      designFormat(context.architectureDecisions),
      ...(context.workflow ? [workflowFormat(context.workflow)] : []),
    ],
  };
}

function designFormat(architectureDecisions: boolean): string {
  return [
    'The `craftingtable-design` block:',
    '```craftingtable-design',
    '{"version":1,"items":[{"kind":"resolved","question":"Question considered","answer":"Plan-backed answer","sources":["exact source file, section or accepted decision ID"]}]}',
    '```',
    'Use an empty items array if there are no questions.',
    'Classify every remaining question as operator-decision (actual approval needed), planning-conflict (contradictory or missing scheduling/plan rule), or dependency (a known mapped predecessor must finish). A dependency item includes dependency:{kind:"work_item",id:"mapped parent ID",state:"accepted"} or {kind:"slice",id:"mapped slice ID",state:"merged"|"verified"}. Do not invent predecessor rules. Resolved items require answers and citations. Other items still include question, answer and sources (which may be empty).',
    ...(architectureDecisions
      ? [
          'Architecture checkpoint approvals belong to operator-decision. For each operator-decision about a mapped architecture checkpoint, also supply decision:{checkpointId:"exact mapped ADR ID",decisionText:"Complete standalone decision proposed for approval",why:"Why this fits the operator goals",alternatives:[{option:"Alternative",tradeoff:"Practical tradeoff"}],consequences:"Behavior, limitations and what remains to implement or verify",coverage:"full",consumers:[],retainedObligations:""}. Write for an operator who has not read the source artifacts. Include exact citations in the item sources. Never use references such as "as described above" in decisionText: the text must stand alone. Full approval settles this architectural decision, not implementation or tests. For full coverage, consumers must be empty; retainedObligations may describe separately required implementation, verification and release work, never unresolved architectural choices. Only propose coverage:"clauses" for an intentional partial decision; supply consumers:[{sliceId:"exact mapped ID",phase:"start"|"merge",replacesFullCheckpoint:true|false}] and explicit retainedObligations, keeping a later full-checkpoint consumer. Supply one checkpoint per item. These are recommendations, never approvals; the operator approves through CraftingTable.',
        ]
      : []),
  ].join('\n');
}

/**
 * A question stop's read-only investigation (R-C16). It runs as a design-role run; its final
 * message ends with the `craftingtable-investigation` block the controller reads.
 */
export function investigationInstructions(): RoleInstructions {
  return {
    role: [
      'You are investigating the questions a stopped step asked, for the operator who must answer them.',
      'This is read-only: you read and report; you do not design, implement, review, commit or decide.',
      'Nothing runs after you: the operator reads your final message, which is the artifact; do not write report files.',
    ].join(' '),
    rules: [],
    finalMessage: [
      'For each question, the answer you propose with the exact sources it rests on, or what the evidence lacks.',
      'One fenced `craftingtable-investigation` block:\n```craftingtable-investigation\n{"version":1,"questions":[{"question":"<the question>","status":"proposed","answer":"<proposed answer>","sources":["<file:line or run>"]},{"question":"<the question>","status":"open","answer":"","sources":[],"reason":"<what the evidence lacks>"}]}\n```',
    ],
    formats: [],
  };
}
