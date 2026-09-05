# ADR-021 — Work item lifecycle and the review-gated merge

- **Status:** accepted
- **Date:** 2026-09-05
- **Supersedes:** ADR-014 (the work-contract draft)

## Context

After the first real session the operator could delegate a work item and read the
diff, but nothing could finish: items stayed "Admitted" forever, the CT-03 draft
contract that admission produced meant nothing to anyone, and the only way to land a
branch was by hand. The operator asked for a pull-request-like flow: a review that
returns "mergeable" unlocks a merge into the default branch.

## Decision

1. **Three stored states, one derived.** Work items are `proposed`, `admitted`, or
   `completed`. "In progress" is derived in the browser from an active worktree or a
   live run. Completion is a row in `work_item_completions`, joined on read, so the
   CT-03 admission-only trigger on `work_items` stays untouched; SQLite cannot widen a
   CHECK constraint in place and a rebuild of a table with foreign-key children was not
   worth the risk.
2. **The work-contract draft is removed**, not deprecated. Its table is dropped in
   migration 0006 along with its domain, planning, contract, and storage code.
   Admission is an agenda decision and says so.
3. **Review runs end with a verdict line.** The review brief instructs the agent to
   finish with `VERDICT: mergeable` or `VERDICT: changes-requested`; the daemon
   parses the last such line of the turn's result and stores it on the run. The
   convention is CraftingTable's, not the vendor's, so it lives in the brief and the
   run service rather than in the adapter.
4. **The merge gate is computed, not stored.** A worktree is mergeable when its most
   recent run is a review with a `mergeable` verdict and no run is live in it. Any
   later run of any role supersedes the review because it may have changed the
   branch. The browser renders the gate the daemon reports; the single merge route
   carries at most a target branch name and re-evaluates the gate before acting.
5. **Merge is a merge commit into a branch the operator names**, defaulting to the
   repository's default branch; a branch that does not exist yet is created from the
   default branch first. When the primary checkout has the target checked out the merge
   happens there and the checkout must be clean; otherwise it happens in a scratch
   worktree so the operator's checkout is never touched. The worktree must be clean. A
   conflict is aborted and reported, leaving everything as it was (including deleting a
   target created for the attempt). On success the worktree is removed, its branch
   deleted, and the work item completed, recorded in one transaction after the Git work.
   (Amended 2026-09-05: the target branch was originally fixed to the default branch.)
6. **Provenance on runs.** The model the backend actually used and its billing
   source (`subscription` when Claude Code reports `apiKeySource: none`) are stored
   from the init message. Cost is shown as an estimate for subscription sessions.
7. **Noise stays out of the journal.** Claude Code's `thinking_tokens` pings and
   task bookkeeping messages are dropped in the adapter; task lifecycle becomes
   readable notices.
8. **Remediation is a run with a parent.** An implement run started with a review as
   its `parentRunId` receives the review's full final message from the journal under
   "Review findings to address" and is instructed to give each finding a disposition.
   No new run type or vocabulary is needed; lineage was already the seam.

## Consequences

- The route inventory's forbidden fragments no longer include `merge`; the test
  documents why. `approve`, `command`, `shell`, and `exec/` remain forbidden.
- Marking an item complete by hand is allowed for admitted items, for work that
  landed outside CraftingTable.
- Workspaces can be created and renamed, and users can change their password; these
  are prerequisites for the couch-and-workstation setup rather than new authority.
- Automated implement → review → merge cycles can now be composed from existing
  commands: every step is a run role or a gated route.
