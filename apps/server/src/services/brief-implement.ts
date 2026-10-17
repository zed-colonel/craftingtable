import {
  type OutputContext,
  openQuestionsPart,
  type RoleInstructions,
  WORKFLOW_PART,
  workflowFormat,
} from './brief-output.js';

/**
 * How an implement or remediate run treats slow and hanging tests (R-C17 part 3, found live
 * 2026-10-16: an agent ran one hung test directly, without a timeout, for 42 minutes): one
 * sentence each, for every language.
 */
export const HANGING_TEST_RULES = [
  'When a test is slow or seems to hang, run it alone under a hard timeout to find out why before rerunning whole suites.',
  'Put a timeout on every test command you run directly, so a hanging test cannot spend the step’s time.',
] as const;

/**
 * The implement role (R-G6, AGT-54), and the remediation and accepted-design runs it takes:
 * what the agent does and the one final message it returns, ending with `## Open questions`.
 */
export function implementInstructions(context: OutputContext): RoleInstructions {
  return {
    role: [
      'You are the implementation agent for this work item. Implement it completely inside this worktree, with focused tests where behaviour is non-trivial, run the project’s quality checks, and commit your work on this branch with clear commit messages as you reach coherent increments. Do not push or switch branches; scratch files go in the temporary directory.',
      'After all verification, inspect git status including untracked files: commit intended source changes, and stage any intended new source file even if you cannot finish the commit, but never generated test output, scratch files, credentials or unrelated files.',
    ].join(' '),
    rules: [
      HANGING_TEST_RULES.join(' '),
      ...(context.planFinalization
        ? [
            'Findings scope: address the open findings and report dispositions for this attempt’s work; closed findings stay in the recorded history, not repeated or re-resolved without new evidence.',
          ]
        : []),
    ],
    finalMessage: [
      ...(context.remediation
        ? [
            'A disposition for each finding: fixed, disagreed (say precisely why) or deferred with a reason; a claim for the next reviewer to verify, not the finding’s closure.',
          ]
        : []),
      'A summary of what changed, how you verified it, any paths git status still lists and why, and anything left undone or worth the operator’s attention.',
      ...(context.workflow ? [WORKFLOW_PART] : []),
      openQuestionsPart(
        context.workflow,
        'Otherwise every unresolved approval, exception or policy decision is there, as a concrete question with a proposed resolution, never only in a disposition or summary; an unanswered operator decision is not another implementation task.',
        !!context.finalizationStage,
      ),
    ],
    formats: context.workflow ? [workflowFormat(context.workflow)] : [],
  };
}

/** What a remediation run does with the review it follows (its final message is above). */
export const REMEDIATION_INSTRUCTIONS =
  'This run remediates a review whose findings are in the handoff as the reviewer wrote them: read them, reconciling earlier messages with later corrections and withdrawals, and preserve finding IDs. Fix each required finding and any explicitly selected batch, or say precisely why you disagree; run the quality checks and commit on this branch. Optional ideas the scope keeps as follow-up are not to be implemented.';

/** What an implement run does with the design the operator accepted. */
export const ACCEPTED_DESIGN_INSTRUCTIONS =
  'Implement this design. The operator accepted the proposal below from a design run on this work item: it is the plan. Deviate only where the code forces it, saying where and why in your summary, and resolve any open questions it lists with the simplest choice consistent with the exit gate, stating each choice.';

/**
 * A daemon-owned integration conflict resolution: the daemon completes the merge, and the
 * final message ends with `## Resolution status`.
 */
export function resolutionInstructions(): RoleInstructions {
  return {
    role: 'Resolve the daemon-prepared integration merge in this worktree. Stage intended changes and verify the combined behavior. Do not commit, switch branches, start another merge, abort the merge, or move any branch: the daemon completes it. Follow the pinned resolution instructions below.',
    rules: [],
    finalMessage: [
      'The checks you ran on the combined state with their outcomes, and any semantic decisions.',
      'A section headed `## Resolution status`, followed by `ready` only when every conflict is resolved, intended changes are staged and checks pass; otherwise explain what remains and follow it with `blocked`. A successful process exit alone is not approval.',
    ],
    formats: [],
  };
}
