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
