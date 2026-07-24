# ADR-014 — Work-item admission and non-executable draft contracts

- **Status:** accepted
- **Date:** 2026-07-24
- **Amended:** 2026-07-24 after independent review (CT03-R2, CT03-R3)

## Context

An imported plan proposes an agenda. CT-03 must let an operator accept one item
into that agenda without implying that anything is authorized to run. CT-03 has
no repository, worktree, agent, verification, review, or merge capability, so
the artifact admission produces must be unmistakably incomplete.

## Decision

### Transition

CT-03 exposes exactly one transition:

```text
Proposed → Admitted
```

`Active`, `Completed`, `Canceled`, and `Superseded` are deliberately absent from
the status vocabulary rather than reserved-but-unreachable, so no unsupported
transition can be represented at all.

Only an authenticated `Owner` or `Editor` may admit, through the same
session-bound CSRF and origin policy as every other mutation. Admission is
idempotent: a repeat returns the existing draft and writes no audit row, no
event, and no second draft.

A dependency-blocked item **may** be admitted through explicit user action. The
UI shows the blockers next to the control and states that admission means
"accepted into the agenda", not "run this now". Blockers remain visible
afterwards. Admission is not execution readiness and does not satisfy any
dependency.

### Atomicity

One transaction commits the status change with actor and time, one
`WorkContractDraft`, `work-item.admitted` and `work-contract-draft.created`
audit rows, and one `work-item-admitted` workspace event. The composed daemon
notifier is called after the transaction returns, never inside it.

`work_contract_drafts.work_item_id` is `UNIQUE`, so one draft per admitted item
is a database guarantee rather than a service convention.

### Draft document

```text
schemaVersion 1 · status draft · completeness incomplete

inherited   title, exit gate, risk, primary areas, required and recommended
            dependency references, project and plan-version references,
            source work-item ID
defaults    review perspectives [specification, correctness]
            maxRemediationGenerations 3
            merge.humanAuthorizationRequired true
unresolved  registered-repository · exact-base-revision · path-scope
            verification-policy · protected-acceptance-criteria
            agent-backend · execution-environment
```

Unresolved fields are **enumerated in a `missing` list**, not left blank. A blank
field reads as "nothing required"; an enumerated one reads as "not yet decided".

The document deliberately has no `approved`, `executable`, `ready`,
`authorized`, or `active` field.

That is enforced by the shared contract, not only by a test.
`workContractDraftDocumentSchema` is `strictObject` at every level, with
literals pinning `status`, `completeness`, each `unresolved` marker, and
`merge.humanAuthorizationRequired`. The admission service parses its projection
through that schema *before persisting*, so a draft that could not satisfy the
wire contract never reaches the database, and the browser consumes the inferred
type with no local re-declaration and no cast. An added authorization-looking
field is a parse failure rather than a rendering surprise.

Admission is also terminal at the database level: an admitted work item rejects
every further update, so its actor and time attribution cannot be rewritten.

Drafts are immutable in CT-03: `work_contract_drafts` carries no-update and
no-delete triggers, so the draft cannot transition even at the database level.
Editing belongs to later work.

The browser renders a structured summary, the missing-field list, an explicit
"Not executable" banner, and a read-only JSON preview. There is no edit, save,
or approve control.

## Consequences

An operator can build a real agenda from an imported plan and see exactly what
CraftingTable still does not know. Nothing in CT-03 can approve a contract,
create a change request, create a worktree, start an agent, execute a command,
or merge — enforced by a route-inventory test and the forbidden-scope script,
not only by review.

Because drafts are immutable, correcting one in CT-03 is impossible; the item
would have to be re-admitted, which idempotency prevents. This is accepted: the
draft is a projection of an immutable plan version, so it has no independent
content to correct until editing exists.

A YAML preview of the draft is deferred. It would require shipping a YAML
serialiser to the browser for cosmetic benefit, and the contract says "may", not
"must".

## Alternatives considered

- **Automatic admission on import** — would silently activate work, which the
  contract's governing statement forbids.
- **Blocking admission of dependency-blocked items** — would make the operator's
  agenda hostage to a plan graph that describes ordering, not permission.
- **A mutable draft with an edit form** — CT-04+ scope; adding it now would
  create an approval surface with nothing to approve against.
- **Leaving unresolved fields absent** — indistinguishable from "not required".
- **A `status: pending-approval` field** — invites a reader to believe approval
  is a state this system can reach.
