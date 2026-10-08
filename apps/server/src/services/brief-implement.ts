import {
  type OutputContext,
  openQuestionsPart,
  type RoleInstructions,
  WORKFLOW_PART,
  workflowFormat,
} from './brief-output.js';

/**
 * The implement role (R-G6, AGT-54), and the remediation and accepted-design runs it takes:
 * what the agent does and the one final message it returns, ending with `## Open questions`.
 */
export function implementInstructions(context: OutputContext): RoleInstructions {
  return {
    role: [
      'You are the implementation agent for this work item.',
      'Implement it completely inside this worktree. Write focused tests where behaviour is non-trivial, run the project’s quality checks, and commit your work on this branch with clear commit messages as you reach coherent increments. Do not push, do not switch branches, and keep source changes inside this worktree. Use the provided temporary directory for scratch files.',
      'After all verification, inspect git status including untracked files. Commit intended source changes; explicitly stage any intended new source files even if you cannot finish the commit. Never stage generated test output, scratch files, credentials, or unrelated files.',
    ].join(' '),
    rules: context.planFinalization
      ? [
          'Findings scope: address the open findings and report dispositions for work done in this attempt. Previously closed findings remain in the recorded history; do not repeat or re-resolve them without new evidence.',
        ]
      : [],
    finalMessage: [
      ...(context.remediation
        ? [
            'A disposition for each finding: fixed, disagreed (say precisely why) or deferred with a reason. Your disposition is a claim for the next reviewer to verify; it does not itself close the finding.',
          ]
        : []),
      'A summary of what changed, how you verified it, the paths git status still lists and why they remain, and anything left undone or worth the operator’s attention.',
      ...(context.workflow ? [WORKFLOW_PART] : []),
      openQuestionsPart(
        context.workflow,
        'Otherwise put every unresolved approval, exception or policy decision there, with a concrete question and proposed resolution; do not bury a request only in a finding disposition or verification summary. An unanswered operator decision must not be treated as another implementation task.',
        !!context.finalizationStage,
      ),
    ],
    formats: context.workflow ? [workflowFormat(context.workflow)] : [],
  };
}

/** What a remediation run does with the review it follows (its final message is above). */
export const REMEDIATION_INSTRUCTIONS = [
  'This run remediates a review. The review findings are supplied in the handoff as the',
  'reviewer wrote them. Read the handoff files and reconcile earlier messages with later',
  'corrections and withdrawals. Preserve finding IDs. Work through the required findings and any explicitly selected batch: fix each, or if you disagree explain',
  'precisely why in your final message. Run the quality checks and commit on this branch.',
  'When the supplied scope retains optional ideas as follow-up, do not implement those unselected ideas.',
].join(' ');

/** What an implement run does with the design the operator accepted. */
export const ACCEPTED_DESIGN_INSTRUCTIONS = [
  'Implement this design. The operator accepted the proposal reproduced below from a',
  'design run on this work item; treat it as the plan. Deviate only where the code forces',
  'it, and say exactly where and why in your summary. If the proposal lists open',
  'questions, resolve each one with the simplest choice consistent with the exit gate',
  'and state the choice you made.',
].join(' ');

/**
 * A daemon-owned integration conflict resolution: the daemon completes the merge, and the
 * final message ends with `## Resolution status`.
 */
export function resolutionInstructions(): RoleInstructions {
  return {
    role: 'Resolve the daemon-prepared integration merge in this worktree. Stage intended changes and verify the combined behavior. Do not commit, switch branches, start another merge, abort the merge, or move any branch. The daemon owns completion. Follow the pinned resolution instructions below.',
    rules: [],
    finalMessage: [
      'The checks you ran on the combined state with their outcomes, and any semantic decisions.',
      'A section headed `## Resolution status`, followed by `ready` only when every conflict is resolved, intended changes are staged and checks pass; otherwise explain what remains and follow it with `blocked`. A successful process exit alone is not approval.',
    ],
    formats: [],
  };
}
