# ADR-065: Future delegation and independent decision preparation

Accepted: 2026-09-22

Started roadmap attempts retain immutable definitions. An explicit, authenticated grant may
replace integration automation and reviewer responsibilities for named entries' future actions.
The roadmap must be paused (or unstarted), with no live workspace runs or running cycles.
Grants are append-only, version-checked and audited with the operator's rationale. They do not
change scope, prerequisites, findings policy, protected promotion or accepted plan identity.
Historical reviews use the responsibilities granted before their launch, never a later grant.
Revocation prevents future delegated actions without relabeling accepted historical evidence.
This extends operational delegation separately from model selection (ADR-064).

Supported local checkpoint reviewer roles appear alongside slice and parent responsibilities.
Unsupported external qualifications remain separate; selecting a responsibility does not create
an adapter or evidence. A fresh, separately attested checkpoint review is still required.

Architecture preparation cannot depend on development admission: a later slice may own the
choice needed by an earlier merge. An explicit preparation command therefore reserves a bounded
investigation independently of development gates, in a separate plan worktree at a pinned
integration commit. Its durable record binds the exact map, plan binding, owner, run, model,
deadline and operator. Bounded source collection uses only the exact imported archives and
current recorded decisions. Codex uses its read-only sandbox with escalation denied; Claude
uses restricted mode with only file-reading tools and no ambient MCP servers. The controller
ends the session after its result, enforces its deadline, and never resumes interrupted
preparations automatically. Failures and interruption remain visible with an explicit retry.

The run proposes only its named checkpoint. Its complete report and digest join the shared
inbox and existing proposal/approval path. Binding changes invalidate that source association.
Preparation worktrees cannot merge or start implementation cycles. Work-item admission,
checkpoint test evidence, architecture approval and protected final promotion remain separate.
Using fabricated slice/finalization records or weakening work-item start gates was rejected.

## Amendment 2026-09-28: preparation beside a running roadmap (R-C3b)

Operator decision (2026-09-28): shared architecture decisions are prepared ahead of the slices
that need them, while the roadmap runs, so they are answered once, in a batch (HIST-03: 10 of 11
started cross-project slices stopped at design; WI-ADR-016 alone was asked for in 4 stops).

- A preparation binds to the exact map, binding revision and binding digest, the preparation's own
  record and its deadline. It no longer binds to the roadmap's version, which every scheduler pass
  changes. A draft, paused, needs-attention or running roadmap may prepare a decision; the
  scheduler's own work is unaffected, since a preparation holds no development capacity, worktree
  of a work item or merge authority.
- Approval keeps its rule: the roadmap is paused and no work on the map is live. A live
  preparation run no longer counts as work on the map. It only proposes; a proposal is checked
  against its exact binding when it is saved, and the operator reviews its text before approving.
  A preparation whose context predates another approval is at worst a stale recommendation,
  which that review catches.
- A roadmap may carry a standing preparation grant: enabled, a time limit per preparation and the
  number kept in flight at once (1 to 3), with who granted it and when. Like recovery delegation
  (ADR-057), it is changed only while scheduling is paused, it is audited, revoking it stops future
  preparations without cancelling started ones, and applying a planning amendment revokes it. It
  grants preparation only: never approval, merge, implementation or a start of work.
- Under an enabled grant, each pass of a running roadmap prepares the supported architecture
  decisions its selection still needs: selected, not yet accepted, with at least one unfinished
  selected slice waiting on it. Those that unblock the most slices go first, and no more than the
  granted number are in flight. A decision is prepared once per binding revision and digest; a
  failed preparation waits for the operator's explicit retry, as before. Each run uses its owning
  entry's investigation profile and acts as the grantor, and stops being launched once the grant
  is revoked or the grantor loses an editor role.
- Several saved proposals may be approved together in one pause: the operator marks each as
  reviewed, one rationale is recorded with each, and each is approved through the same command
  and checks as a single approval. Nothing is approved without the operator.
