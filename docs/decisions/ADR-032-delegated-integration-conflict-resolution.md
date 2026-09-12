# ADR-032: Delegated integration conflict resolution

Status: accepted. Date: 2026-09-12.

## Context

Parallel siblings can legitimately edit the same files. AQ-10 merged successfully, but
refreshing AQ-09 conflicted. The previous update command aborted safely and left the
operator with no managed web recovery path.

## Decision

The first version adds an explicit resolution operation to an existing automated cycle.
Normal refresh still aborts conflicts, recording their paths, diagnostic output and exact
item/integration commits. Older failures can be inspected from the cycle panel. Inspection
uses merge-tree: it may create unreachable Git objects, but changes no refs, working files
or index. All commands use authenticated, version-checked owner/editor routes.

The operator chooses Resolve integration conflicts, optionally changing the remediation
agent/model/permissions and supplying instructions. The cycle reserves a pinned merge and
agent run before Git. The daemon prepares the merge with no commit and deliberately retains
conflicts. The implementation backend receives a dedicated resolution brief, existing item
handoff, plan files, pinned commits and incoming-change context. It resolves, stages and
verifies the combined behavior, including files merged automatically. It must report ready
explicitly; unresolved questions or failed checks leave the attempt needing attention.

The daemon owns completion. It requires the expected item HEAD and pending integration
commit, no unresolved index entries, no unstaged or untracked files, and no newly added
conflict markers. It reserves the exact staged tree before committing. Recovery accepts
only the expected two parents, tree and resolution-labelled commit subject. Hooks remain
enabled. A clean commit or agent readiness assertion does not prove correctness: completion
always launches a fresh review, retaining normal findings/remediation and final operator
merge gates. Integration advancing again still requires refresh and review.

The durable operation owns its worktree through preparation, resolution and commit.
Unrelated manual launches, branch updates, retargeting, removal and final merge cannot
compete. Repository mutation locks cover Git operations, not the agent's entire run, so
independent items continue. A transient daemon lock waits instead of generating attention.
Pause permits guidance to the existing agent. Stop cancels the agent and preserves the
resolution in a paused cycle, including when its roadmap stops. Explicit abandonment
aborts only the pinned pending merge after a browser confirmation. Merge-resolution edits
are discarded; Git may preserve unrelated edits, and untracked files are retained. Ordinary stopping becomes available afterward.

Startup never resumes an operation automatically. Explicit resume reconciles prepared
merges and committed-but-unrecorded results. Agent retries preserve edits, handoffs and
operator guidance, with a maximum of three agent attempts per authorized resolution.
These attempts do not consume the separate code-review remediation allowance. Existing
attention notifications and reminder scheduling cover questions, failures and limits.

## Consequences

The operator can inspect, delegate, guide, retry or abandon an integration conflict from
the web UI. Additive schema-12 cycle JSON and audit metadata persist the operation and
attempt IDs; existing manual flows remain available outside an owned resolution.
Standalone worktrees without a cycle, a browser conflict editor and automatic delegation
on conflict remain later increments. External Git processes remain outside daemon locking.

## Alternatives considered

Prompting a generic implementation agent to merge grants poorly recorded authority and
leaves ambiguous recovery. Keeping only an error message forces shell access. Automatically
choosing one side can discard sibling behavior. A full browser three-way editor is useful
but unnecessary for this first supervised delegation path.
