# ADR-049 — Reviewed amendments and cross-project finalization

- Status: accepted
- Date: 2026-09-16

Schema 22 records immutable planning proposals and one attributed apply/reject decision per
proposal, with an exact impact digest and the previous roadmap/attempt snapshot. Proposing
holds the workspace delegation and pauses its cycles without cancelling sessions. Apply
waits for affected sessions, phase reservations and Git operations to finish. New bindings
and selected scope become a new revision of the same roadmap; Resume remains explicit.

Preview compares requirements, queued activities, exact plan/branch bindings, attempt
dispositions and evidence applicability. A revised plan may be imported inactive and bound
before review; applying explicitly activates that version. Historical completion and admitted
work are not rewritten. Retired worktrees and branches remain inspectable but lose execution
authority and capacity claims. Compatible attempts on the same binding retain their frozen
settings. Changed bindings retire the old authority, including historical worktree ownership.

Integrated code may be reused only through explicit selection of unchanged source-bound
scopes in the same repository/integration branch, with Git ancestry verified before adoption.
This records code provenance, never approval. New definitions require new map adoption,
dependency environments and verification/acceptance. Repinning on the same binding can retire
stale completed reviews and schedule fresh ones without rerunning integrated development.
Parent completion under an older definition is not acceptance of revised obligations.

Full original parent acceptance, current binding/adoption and a pinned runtime unlock the
existing staged finalization. Finalization freezes map, binding, runtime and integration SHA;
its runs use the same enforcing dependency adapter as slice runs. Recheck before launch and
promotion. A changed runtime requires reconciliation and a new finalization. The existing
integration hold and operator-only exact-commit promotion remain authoritative. After promotion,
the recorded destination becomes the provider reference; consumers explicitly repin and review
evidence. Promotion does not supply publication or downstream compatibility evidence.

ZIP handling delegates semantic validation to `analyzeConcurrencyDefinition`, a bounded,
source-snapshot-checked normalization seam usable by a future Planning Studio. Authoring has
no adoption or execution authority: both transports produce the same immutable definition and
use the same exact binding, proposal and adoption services. Agents must surface scope changes
as open questions; an operator may attribute a planning proposal to the originating run.
This increment provides that seam, not a Planning Studio editor or remote qualification runner.
