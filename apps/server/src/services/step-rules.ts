/**
 * Step rules the controller gives every cycle run, or every scope repair (R-G6). They are named
 * so the brief-size replay renders them as a launch does.
 */
export const STEP_RULES = {
  scopeRepair:
    'Read craftingtable-scope-repair.json among your records: pinned findings from independent slice and parent reviews. Address every namespaced finding ID, older parent reviews’ included; identical original IDs from different runs are separate obligations, and the examples every round cited remain work until verified fixed. Reviewers must report each namespaced finding with a supported disposition. Current adopted policy answers superseded administrative questions; invent no new policy. Source changes belong only to this owning slice. When a finding names a broad or recurring family, audit that family systematically in bounded batches, including analogous producers, consumers, assertions and evidence, and explain coverage, corrections, remaining gaps and reproducible checks; do not merely patch cited examples or weaken acceptance checks. Ask for genuinely new decisions without expanding scope. Commit intended changes; do not merge.',
  detach:
    'Keep verification commands in the agent session (no nohup, disown or setsid); wait for background commands, collect their results and stop your monitors before the final outcome.',
  automated:
    'This run is one step of an operator-authorized automated cycle: do not merge; finish this step with your final message, and the controller takes the next.',
} as const;
