# ADR-029: Sequential roadmap execution

Status: accepted. Date: 2026-09-11.

## Context

The operator has exercised single-item automation, branch mechanics, and Pushover delivery.
The first roadmap increment should delegate a useful sequence while retaining the explicit
merge checkpoint and the definition/execution boundaries proposed in ADR-028.

## Decision

A workspace may have one delegated sequential roadmap, with multiple saved drafts and
historical ended roadmaps. A definition contains ordered whole-item entries bound to exact
project/plan-version/work-item identities, repository/integration branch, effective step
profiles, completion policy, and instructions. Saving does not execute. Start delegates
admission, worktree creation, and cycles to the recorded owner/editor; every background
preparation rechecks that authority. Browser sessions are not fabricated or prolonged.

Schema 12 stores immutable definition revisions and version-checked control state with
separate attempt identities. An attempt reserves worktree and cycle IDs before Git creation;
cycle insertion and attempt attachment share a transaction. Pending operations recheck the
roadmap generation and authority before launching. Superseded creation may leave a recorded
worktree for manual use, but cannot launch a cycle. Git/SQLite crash gaps remain explicit.

The scheduler chooses the first unfinished entry and never skips it to launch an independent
later entry. Required prerequisites outside the selected scope remain visible blockers.
Other unmerged worktrees in the same registered checkout consume repository capacity;
existing manual cycles/worktrees are not silently adopted. The existing cycle controller owns
design, implementation, review, remediation, time limits, findings policy, and handoffs.
Only merging the attempt's own worktree completes a started entry. A review verdict or manual
completion flag cannot release the next entry. Prior completions remain usable subject to
existing predecessor integration-evidence checks at worktree creation and launch.

Pause suspends scheduling and pauses a running cycle for manual intervention; an existing
merge checkpoint stays intact. Resume explicitly resumes the owned cycle through its normal
handoff checks. Queued entries can change while paused/attention-stopped, creating a new
revision; the started prefix and effective settings stay fixed. Stop ends the owned cycle
and retains worktrees and history. Restart requires explicit roadmap resume, including when
an item merged while the daemon was down. No automatic merge or integration refresh is added.

Pushover continues delivering item checkpoints. Scheduler failures without an equivalent
item alert receive the existing persistent attention/reminder treatment. Dependency and
capacity waits stay visible; completion appears in the app and activity journal.

## Consequences

The roadmap is usable without implementing parallel scheduling, the supplied sidecar,
slices/checkpoints, or Planning Studio. Independent workspaces may have their own sequential
queues; this is not a configurable parallel roadmap scheduler. Branch bindings and run
settings cannot drift with workspace defaults or later plan imports. Manual takeover is
explicit, while the operator retains the normal item review and merge workflow.

## Alternatives considered

Having the browser advance the queue would lose authority when it disconnects. Inferring
cross-project gates from prose or numbering would activate unreviewed semantics. Reusing
item IDs as attempt IDs or overwriting definitions would erase execution provenance. Taking
over arbitrary existing worktrees would expand delegation beyond the reviewed queue.
