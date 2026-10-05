# ADR-059: Shared design decisions and bounded predecessor waits

Accepted: 2026-09-19

Design recovery must distinguish approved facts, outstanding predecessor work, actual
operator choices and planning conflicts. Each new design supplies a structured
classification alongside its complete proposal and Open questions checkpoint. Legacy
reports remain readable; invalid or contradictory classifications cannot authorize
implementation. Exact mapped slice/parent waits may cause at most two automatic design
rechecks. Waiting is durable and does not run an agent; roadmap pause and ordinary
admission gates still apply. Explicit investigation continues to stop for operator review.

Architecture decisions use immutable evidence submissions and separate authenticated
operator decisions. The supported decision-review profile requires repository-maintainer
approval; other reviewer contracts and test/qualification gates retain the external
evidence path. A source design is an attached proposal, never an approval. Decisions bind
the exact imported map and plan binding, independently of incidental runtime pin changes.

A proposal may explicitly stage early clauses for named slices. Approval authorizes only
the listed gate substitutions/additions, keeps a later full-checkpoint consumer, and
requires renewed saved-plan acceptance. It never passes the full ADR or waives parent,
verification or publication requirements. Original imported requirements remain preserved;
the reviewed overlay and its retained obligations accompany affected runs.

Approval requires paused scheduling and no live map runs. Relevant approval identities
are frozen in run environments; changing them invalidates affected review receipts without
rewriting history or invalidating unrelated predecessors. Predecessor receipts carry an
explicit current/stale indication, and phase requirements are distinguished from observed
readiness in the supplied evidence ledger.

The shared decision inbox is a read-only projection of current bound design reports and
immutable approval records, reused by roadmap supervision and work-item recovery. Optional
structured decision briefs carry complete proposed text, alternatives, consequences and
explicit full/limited coverage. Legacy summaries are never promoted into complete proposals
automatically. Preparing from a brief pins its source report digest and supplies references;
the existing proposal and authenticated approval commands remain separate. Discovery and
clarification navigation grant no approval or execution authority. Approval visibility is
scope-aware and does not rewrite the originating design's historical questions.

Full decision coverage forbids named consumer substitutions, but may retain descriptive
implementation, verification and release obligations. Those obligations are visible in the
recommendation, saved proposal and explicit approval; they cannot waive any separate gate.
The inbox includes report-validation errors and on-demand access to the original journaled
report. Investigation evidence remains readable without a valid structured recommendation;
it never becomes an approval by discovery. Existing reports are projected without rewriting
the journal or requesting a replacement run.

## Amendment 2026-09-25: an answered investigation continues (R-C3a)

An explicit investigation still stops for operator review, unless its design classification is
complete and every item is `resolved`: each has an answer and cited sources, no operator
decision or planning conflict remains, and Open questions is `none`. If the stop it started
from already named an operator decision or planning conflict, it always stops: an
investigation gathers evidence for a decision and never makes it. Then the controller starts
the continue run the operator would have started with Resolve design questions. That run uses
the investigation's evidence, the operator's guidance and attachments, the design agent, and
an ordinary deadline. It is a new step: the investigation's service retries, repairs and
guidance end with it. It is recorded as `automatic` and judged as an ordinary design. If it
cannot be prepared, for example because the design backend is unavailable, the investigation
stops as before. This
happens at most once per operator-started investigation. An investigation without a
classification, or one that classified nothing, still stops.

## Amendment 2026-10-02: investigating any question stop (R-C16)

Any stop that carries questions offers Investigate beside its own control. The stops are
`work-item-questions`, `implementation-open-questions`, `review-open-questions`,
`review-open-questions-at-limit`, `scope-review-open-questions`, `remediation-exhausted` when
its report still asks something, and the work-item questions of `shared-decision-required`.
Design stops keep Resolve design questions; shared ADR questions keep decision preparation.

An investigation is a read-only run beside the cycle, never its current run. It uses decision
preparation's launch (ADR-065): Codex's read-only sandbox with escalation denied, Claude
restricted to reading tools, no MCP servers, and the session ends after its turn. It runs on
the cycle's worktree at its current commit and reads:
- the stop's questions;
- the handoff from the run that asked them, and the lineage's recorded check receipts;
- the branch's commits and diff against its integration target, which the daemon supplies;
- the operator's prompt.

The run carries `profileSelection.investigationId`. The worktree's lineage reads leave such a
run out, so no resume, adoption or newest-run rule takes it for the cycle's work. Every
live-run check includes it, because it holds the worktree while it runs.

It returns one `craftingtable-investigation` block. For each question there is a proposed
answer with the sources it rests on, or the reason the evidence does not settle it. The cycle
stays at its stop and records the result on `cycle.investigation`. The operator answers through
the stop's own control. Nothing continues automatically, even when every question has a
proposed answer: an investigation gathers evidence for a decision and never makes it.

While it runs:
- the stop accepts no command but ending it;
- its item says it is investigating, and its reminders wait;
- it uses no remediation round and holds no development capacity, whatever the roadmap's state.

Stopping the roadmap ends it; pausing or resuming an item leaves it running. It has the cycle's
Evidence investigation profile and a 30-minute limit by default. A failure, the deadline or a
restart ends it with an explicit retry; nothing retries or resumes it automatically. Leaving the
stop clears its record and cancels a run that is still live.

## Amendment 2026-10-05: the daemon checks that an investigation left the worktree unchanged (R-C16)

Read-only is the agent's sandbox's promise; the daemon now checks it (operator decision
2026-10-05, from TS-M3 and RC F-7). As an investigation starts, the daemon records the
worktree: HEAD, branch, the tracked diff, the contents of untracked files, ignored files (an
ignored directory by its own entry), and the repository's config, hooks and info files. It
compares once the run has ended and no agent of it is still exiting: after End, after its
deadline, and after an End pressed while it was still launching. End records that it was asked,
and by whom; the comparison, and the result, follow the process's exit.

A difference fails the investigation as `worktree-changed`, whatever its run found:
- the stop's existing item pages, even after the operator's own End; there is no new panel or
  attention code;
- the stop's commands are refused, with the typed reason `investigation-worktree-changed`,
  until the operator acknowledges the change (a command on the stop) or the tree matches its
  record again; stopping the cycle stays allowed (operator decision 2026-10-05);
- the proposals are shown and never offered to Use proposed answers (operator decision
  2026-10-05);
- a roadmap records the held stop as the operator's wait, as it records the stop itself;
- the daemon never resets the tree, and says the tree changed, not that the agent changed it.

A record started before the check is not compared. A roadmap's Stop ends its stops'
investigations at once, uncompared, since nothing will build on those trees.
