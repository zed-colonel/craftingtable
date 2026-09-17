# ADR-052: Controller-owned historical baseline preparation

Status: accepted
Date: 2026-09-17

Early WI/EXO designs mixed genuine decisions with missing repository preparation and historical evidence.
Their original dependencies differ from the current pinned runtime; routing characterization through the
current Cargo launcher cannot reproduce the old applications faithfully.

An explicit idle-design command previews exact bound repository baselines and a retained pre-redesign
upstream tag. The operator confirms historical refs and proposed local source tags. The daemon reserves
preparation durably before exporting sources or creating tags. Application baselines and tag names come
from bound plans; tags use create-only ref updates and are never moved or published. Existing coding
worktrees and integration branches remain in place. Interrupted/failed preparation preserves its record
and any completed local tags, and requires explicit retry. A retry verifies existing tags rather than
rolling back or overwriting repository history.

Source snapshots live in configured worktree storage, separate from shared downloaded Cargo packages.
Explicit design recovery regenerates isolated sibling sources from exact Git objects in registered run
scratch. The historical Cargo launcher enforces original lockfiles and source hashes, rejects resolved path dependencies outside the prepared sources, bounds commands
and output, and records failures as well as successes outside disposable caches. Browser previews expose
those logs. Historical receipts have no runtime generation and cannot satisfy current verification gates.
Build targets use existing post-run cleanup; source snapshots and downloaded registry packages remain
retained. Future retention controls can reclaim them without removing evidence.

Preparation does not start agents, approve requirements, invent measurements, choose ADR owners or
configure remote branch protection. Architectural and implementation questions remain operator decisions.
Existing recovery retains its model choice, timeout, handoff and investigate/continue checkpoint semantics.
No new process authority, shell endpoint, workflow language or agent merge permission is introduced.
