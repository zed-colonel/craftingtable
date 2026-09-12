# ADR-033: Delegated integration and explicit plan finalization

Status: accepted. Refines ADR-021, ADR-025, ADR-029 and ADR-032 merge authority.

## Decision

An owner/editor may delegate roadmap integration merges and conflict resolution separately,
with manual defaults and per-item overrides. The immutable revision bound to an attempt
controls its behavior. The daemon uses the existing clean-worktree, completion-policy,
current-review, exact-commit and membership gates; coding agents gain no merge authority.
Protected destinations (`main`, `master`, repository defaults, additional branch protections
and finalization targets) cannot receive automatic merges. Questions and failed recovery
still require operator input.

Reserve merges durably before Git. Pin source, target, review and authorizer; identify the
result with an operation marker and verify its exact parents during recovery. Record
completion before cleanup, making interrupted merges and cleanup independently recoverable.
Unknown history or later edits are preserved, never interpreted as permission to merge.

Finalization is manually initiated at plan-version scope after integrated completion, with
an explicit candidate branch and pinned integration snapshot. It holds further daemon
integration merges and performs a configured number of assessment → polish → verification
rounds, followed by an independent final review. Each phase receives all plan artifacts and
the work-item inventory. Findings, questions and budgets retain their existing gates.

The operator alone approves promotion of the exact reviewed candidate/destination pair.
Polish lands through that candidate directly into the final destination; the integration
snapshot remains unchanged. Restart never replays preparation or agent launches without
explicit resume. Pausing keeps the integration hold; stopping releases it and retains work.

## Consequences

Unattended roadmaps can finish normal integration and bounded conflict recovery. Important
items can retain explicit merge checkpoints. Final review addresses the combined plan,
including cross-item conformance and polish, without inventing a synthetic work item.
Schema 14 adds a plan execution subject while preserving existing work-item history.
External Git mutations are outside daemon locks and require refreshed review or a new
finalization snapshot. Cross-project dependency environments and planning Studio remain
separate later slices.
