# ADR-055: Repository policy and operator decisions across execution scopes

Status: accepted
Date: 2026-09-17

Repository administration obligations occur in imported source plans, but worktree
existence is not protection evidence and a release procedure cannot silently defer an
earlier freeze. Design guidance formerly stayed on its implementation cycle, leaving
independent verification and parent acceptance without the operator's interpretation.

Record immutable operator-adopted repository policy revisions against an exact plan,
repository, integration branch and branch-settings version. Keep policy revisioning
separate from execution-map binding so adopting governance does not rewrite imported
plans or introduce unrelated scheduling changes. The same typed command can be used by
future planning interfaces. The initial policy describes controller-local integration
controls, an optional experimental freeze at an observed full commit, a separately due
remote-publication obligation, and the operator's explicit interpretation.

Every run receives current local Git observations and the adopted policy, with limits
stated explicitly: no remote protection is configured or verified, and direct Git or
filesystem writes are not prevented. Ordinary controller merges into a frozen branch
are rejected; explicit final promotion remains the exception. Freeze drift or stale
branch settings cannot establish valid review evidence. Policy versions are pinned in
review context, and policy changes expire prior review/scope acceptance evidence.

Provide related operator instructions across slice/verification/parent transitions,
and the plan's instructions during finalization. Preserve source cycle/scope/run IDs;
never turn agent assertions, imported declarations, or guidance into passing evidence.
Bound the materialized guidance and fail rather than truncate it. A policy clarifies
local workflow requirements; it does not fabricate hosting receipts or silently waive
a more specific incompatible obligation. Conflicts still require an explicit decision.

This adds no hosting integration, credential access, agent merge authority, or OS-level
security boundary. Existing authenticated commands and audit records own adoption.
