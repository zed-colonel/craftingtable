import {
  type BlockFormat,
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
          'Before asking the operator, consult the supplied plans, current predecessor receipts, repository policy and approved architecture decisions in craftingtable-scope-evidence.json; cite answers they already fix and proceed within their authority. A recommendation awaiting approval is not an accepted decision, and a full-checkpoint approval covers more than a scoped early-clause one.',
          'Separate future merge or verification obligations from what this design needs now: an authorized early slice need not wait for every original parent predecessor. Worktree provisioning, supplied dependency paths and existing receipts are controller context to inspect, not things to ask the operator for.',
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

function designFormat(architectureDecisions: boolean): BlockFormat {
  return {
    shape: [
      'The `craftingtable-design` block:',
      '```craftingtable-design',
      '{"version":1,"items":[{"kind":"resolved","question":"Question considered","answer":"Plan-backed answer","sources":["exact source file, section or accepted decision ID"]}]}',
      '```',
      'Use an empty items array if there are no questions. Every other question is an operator-decision (approval needed), a planning-conflict (a contradictory or missing scheduling or plan rule) or a dependency (a known mapped predecessor must finish); never invent predecessor rules.',
    ].join('\n'),
    rules: [
      'craftingtable-design: a dependency item carries dependency:{kind:"work_item",id:"mapped parent ID",state:"accepted"} or {kind:"slice",id:"mapped slice ID",state:"merged"|"verified"}. A resolved item needs its answer and citations; others still give question, answer and sources (which may be empty).',
      ...(architectureDecisions
        ? [
            'An architecture checkpoint approval is an operator-decision; for one about a mapped architecture checkpoint also supply decision:{checkpointId:"exact mapped ADR ID",decisionText:"Complete standalone decision proposed for approval",why:"Why this fits the operator goals",alternatives:[{option:"Alternative",tradeoff:"Practical tradeoff"}],consequences:"Behavior, limitations and what remains to implement or verify",coverage:"full",consumers:[],retainedObligations:""}, one checkpoint per item. Write for an operator who has not read the sources: exact citations in the item sources, and a decisionText that stands alone (never "as described above"). Full approval settles the architectural decision, not implementation or tests: its consumers are empty, and retainedObligations may name separately required implementation, verification and release work, never open architectural choices. Propose coverage:"clauses" only for an intentional partial decision, with consumers:[{sliceId:"exact mapped ID",phase:"start"|"merge",replacesFullCheckpoint:true|false}] and explicit retainedObligations, keeping a later full-checkpoint consumer. These are recommendations; the operator approves through CraftingTable.',
          ]
        : []),
    ],
  };
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
