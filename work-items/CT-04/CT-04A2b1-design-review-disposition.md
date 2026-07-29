# CT-04A2b1 Design Review Disposition

## Review context

- Source baseline: `e3b69c612a51b0b2a8d436ae3ea5355abd40745e`
- Planning checkout: `6aed9bda58fac0824f707691106aff0abbf35cdb`
- Proposed implementation plan:
  `work-items/CT-04/CT-04A2b1-proposed-implementation-plan.md`
- Proposed-plan revision/hash:
  `79aa4580ebd5f5bd1fa3efe16ba1047f54a5d8b4aa4cf6366f93b9cc31cbb3a1`
- Independent review:
  `review-findings/CT-04/CT-04A2b1-design-review.md`
- Review revision/hash:
  revision 2,
  `9dc99acd43499305420d8233269195ae7e2c4073fd879c7f293099e873774d8a`
- Reviewer: independent third-party reviewer; identity not recorded in the review
- Primary implementer: Codex
- Operator: Keith Sanders
- Date: 2026-07-29

## Summary

| Decision | Count |
|---|---:|
| Accepted | 14 |
| Accepted with modification | 0 |
| Rejected | 0 |
| Escalated | 0 |

Overall disposition:

```text
REVISE — accept all fourteen findings and incorporate them into the accepted plan
```

The operator expressly selects option (b) for B1-F-01 and B1-F-02:

- migration 0004 contains no new payload-aware equality or retirement CHECK;
- every structural composite FK remains;
- every kind-scoped structural presence/absence CHECK remains;
- the correlation CHECK receives B1-F-08's all-NULL default arm;
- Zod proves payload shape, ID agreement, version relationships, and retirement coupling;
- append asserts structural/payload ID agreement before writing;
- the mapper enforces agreement and retirement coupling when reading;
- ADR-018 records that the database proves **ownership** and the contracts prove
  **semantics**, extending ADR-003's existing division to structural correlations.

The inherited generic `payload_json` valid-object CHECK remains unchanged. “No
payload-aware CHECK” means no new `json_extract` or kind-specific payload semantic
constraint in migration 0004.

## Finding dispositions

### B1-F-01 — High — payload/structural equality CHECK is vacuous on absent IDs

**Reviewer claim**

An ordinary SQLite equality CHECK accepts an absent, misspelled, or JSON-null payload ID
because a NULL CHECK result passes.

**Operator decision**

Accepted. Use option (b).

**Rationale**

The database must enforce parent ownership with structural columns. Payload meaning is
already owned by strict contracts under ADR-003 and is cheaper to validate at append and
read boundaries.

**Required design changes**

1. Add no payload/structural equality CHECK to migration 0004.
2. Refine every relevant Zod envelope so structural and payload IDs agree.
3. Assert agreement in `appendEvent` before executing INSERT.
4. Reject missing, null, misspelled, or disagreeing payload IDs when mapping a row.
5. Test each correlation dimension for every applicable kind.

**Accepted-plan locations**

- §§5, 7, 8, 10, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-CON-012`
- `B1-STO-009`
- `B1-STO-011`
- existing `B1-CON-006`, `B1-COR-009`, `B1-COR-010`

**Residual limitations**

Direct SQL can insert a semantically malformed payload when its structural ownership is
valid. The row is durable but unreadable through the application mapper and cannot be
projected silently.

**Status**

Resolved in accepted-plan design.

### B1-F-02 — Medium — payload semantics belong in contracts, not immutable DDL

**Reviewer claim**

Kind-specific payload semantics in DDL duplicate Zod and freeze payload paths without a
parity mechanism.

**Operator decision**

Accepted. Use option (b) jointly with B1-F-01.

**Rationale**

ADR-003 already places strict per-kind payload semantics in contracts. B1 does not need
to disturb ADR-013 by introducing JSON-path semantics into schema 4.

**Required design changes**

1. Migration 0004 retains only the inherited valid-object payload CHECK.
2. It contains no `json_extract` and no kind-specific `json_type` expression.
3. Add a schema-text test proving the absence of unapproved payload-aware expressions.
4. ADR-018 records the ownership/semantics division.
5. Do not amend ADR-013.

**Accepted-plan locations**

- §§7, 9, 14, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-MIG-004`
- `B1-MIG-009`

**Residual limitations**

Payload semantics are enforced when application code appends or reads, not against an
untrusted direct SQL writer at insertion time.

**Status**

Resolved in accepted-plan design.

### B1-F-03 — High — optional base correlations make legacy variants wire-valid

**Reviewer claim**

Adding optional correlations to a shared strict base allows legacy envelopes carrying
those correlations to parse.

**Operator decision**

Accepted.

**Rationale**

All nine variants need their own exact structural-correlation shape. Base strictness alone
does not provide it.

**Required design changes**

1. Export a named domain base/correlation shape.
2. In contracts, explicitly require or forbid all three repository correlations on all
   nine variants.
3. Add a table-driven 9 × 3 illegal-correlation matrix.

**Accepted-plan locations**

- §§4, 5, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-COR-008`
- `B1-CON-011`

**Residual limitations**

None within the nine-kind envelope.

**Status**

Resolved in accepted-plan design.

### B1-F-04 — High — union-derived `EventBase` drops new correlations

**Reviewer claim**

`Omit<WorkspaceEvent, 'kind' | 'payload'>` retains only keys common to the union and
cannot represent variant-specific repository correlations.

**Operator decision**

Accepted.

**Rationale**

Storage must map against an explicit base type rather than derive it from a discriminated
union.

**Required design changes**

1. Export an explicit `WorkspaceEventBase` and correlation types from domain.
2. Make storage's base mapper return that explicit type.
3. Add compile-time assertions and round trips that inspect structural IDs separately
   from payload IDs.

**Accepted-plan locations**

- §§4, 10, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-STO-001`
- `B1-STO-005`

**Residual limitations**

None.

**Status**

Resolved in accepted-plan design.

### B1-F-05 — High — mapper exhaustiveness is compile-time only

**Reviewer claim**

The current mapper trusts a cast `WorkspaceEventKind` and can return `undefined` at runtime
for an unknown kind.

**Operator decision**

Accepted.

**Rationale**

Rows are an untrusted persistence boundary. Exhaustive TypeScript switches must be paired
with a runtime default rejection and correlation checks.

**Required design changes**

1. Type raw `row.kind` as `string`.
2. Reject an unregistered runtime kind before narrowing.
3. Add an explicit unreachable/default throw after the exhaustive switch.
4. Introduce a typed mapping error with closed reason codes.
5. Reject structural-kind contradictions, malformed correlation payload IDs,
   structural/payload disagreement, and invalid retirement coupling.
6. Map complete result arrays before snapshot/SSE code can observe a partial batch.
7. State existing catch behavior: snapshot fails as one request; SSE logs and closes
   without advancing the cursor past the poisoned batch.

**Accepted-plan locations**

- §§10, 12, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-STO-004`
- `B1-STO-005`
- `B1-STO-009`
- `B1-REGRESS-002`

**Residual limitations**

A poisoned durable row makes its workspace's affected journal query unavailable until the
data is repaired; it is never skipped or partially projected.

**Status**

Resolved in accepted-plan design.

### B1-F-06 — Medium — compound transition leaves `repositoryVersion` ambiguous

**Reviewer claim**

A risk-evidence change can occur in the same transaction as a status transition, so
“unchanged repository version” is not a total definition.

**Operator decision**

Accepted.

**Rationale**

The wire contract must define the quantity before B2 emits it.

**Required design changes**

1. Define `repositoryVersion` as the repository version in effect after the committing
   transaction.
2. Specify that B2's compound case emits the status event first and the evidence event
   second.
3. Both events use the same inspection correlation.
4. The evidence event's `repositoryVersion` equals the status event's
   `resultingVersion`.

**Accepted-plan locations**

- §§5, 16, Appendix A

**Required acceptance/adversarial cases**

- B1 contract fixtures freeze the value's meaning.
- B2 owns the reducer-driven unavailable and identity-evidence-changed emission cases.

**Residual limitations**

B1 defines and round-trips the contract but has no lifecycle producer.

**Status**

Resolved in accepted-plan design.

### B1-F-07 — Medium — repository stale scopes are write-only and unbounded

**Reviewer claim**

Repository IDs survive all current consumption and can grow without bound; `App.tsx` is
the dispatcher but was omitted from the target tree.

**Operator decision**

Accepted.

**Rationale**

The reducer needs a bounded pending-invalidation vocabulary and a parameterized
consumption action before CT-04E adds a consumer.

**Required design changes**

1. Add `apps/web/src/App.tsx` to the target tree.
2. Cap `repositoryIds` at 100, retaining stable order among the newest unique IDs.
3. Parameterize `stale-consumed` with the exact scope classes and IDs the dispatcher is
   scheduling for authoritative refetch.
4. Current App consumption names only current planning scopes; it never consumes
   repository scopes.
5. Same-workspace snapshots preserve repository scopes, while workspace switches clear
   them.

**Accepted-plan locations**

- §§3, 11, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-UI-006`
- `B1-UI-007`
- `B1-UI-011`

**Residual limitations**

Repository scopes remain pending, bounded vocabulary until CT-04E supplies repository
queries.

**Status**

Resolved in accepted-plan design.

### B1-F-08 — Medium — unspecified default correlation arm

**Reviewer claim**

An unlisted future kind may bypass structural correlation policy, particularly because
nullable composite FKs are skipped.

**Operator decision**

Accepted.

**Rationale**

Schema 4 must fail closed for repository correlations that no known kind owns.

**Required design changes**

1. Use an explicit CASE-based kind/correlation CHECK.
2. Its ELSE arm forces `repository_id`, `repository_inspection_id`, and
   `repository_binding_id` all NULL.
3. Direct-SQL test a synthetic future catalog kind with a repository correlation.
4. Add one nine-kind parity fixture spanning catalog, domain map, mapper, invalidation,
   and activity description coverage.

**Accepted-plan locations**

- §§7, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-COR-014`
- `B1-STO-010`

**Residual limitations**

A future kind without a schema-5 correlation rule may still be inserted when all three
repository correlations are NULL; it remains unreadable until application vocabulary is
updated.

**Status**

Resolved in accepted-plan design.

### B1-F-09 — Medium — durable unchanged inspections have no workspace event

**Reviewer claim**

Several durable inspection outcomes intentionally emit no workspace event, so inspection
history freshness cannot be derived from this five-kind journal.

**Operator decision**

Accepted.

**Rationale**

B1 must document the limitation rather than invent a sixth kind or overclaim
`JRN-REP-004`.

**Required design changes**

1. Keep exactly five new event kinds.
2. Record in ADR-018 that unchanged verification, unchanged environmental evidence, and
   recorded failure do not invalidate browser repository scopes.
3. Narrow the B1 contribution to `JRN-REP-004` to replay of emitted lifecycle events.
4. Assign inspection-history fetch-on-view/freshness to CT-04E and exact zero-event
   lifecycle proofs to B2.

**Accepted-plan locations**

- §§4, 13, 14, 16, Appendix A

**Required acceptance/adversarial cases**

- B2 retains `A2B-JRN-008` and inspection no-event cases.
- B1's event-kind parity proves no sixth kind was introduced.

**Residual limitations**

The workspace event journal is not a complete change feed for
`repository_inspections`.

**Status**

Resolved and explicitly deferred to its owning later slices.

### B1-F-10 — Medium — rollback test copy and missing amendment policy

**Reviewer claim**

A hand-maintained failing copy of migration 0004 can drift from the shipped migration.

**Operator decision**

Accepted.

**Rationale**

The failure fixture must be mechanically derived from the exact production bytes.

**Required design changes**

1. Put one unique guard marker in real migration 0004.
2. At test time, read the real bytes and replace that marker exactly once.
3. Assert one match and changed bytes.
4. After forced failure, prove schema-3 queries, triggers, indexes, and four-row catalog.
5. During B1 implementation/remediation before accepted release, amend 0004 in place and
   update immutable report hashes. After B1 acceptance, later schema changes require a
   new migration.
6. Add an operator checkpoint immediately after the migration slice.

**Accepted-plan locations**

- §§8, 15, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-MIG-006`
- `B1-MIG-008`

**Residual limitations**

Migration 0004 is not immutable until the B1 implementation is accepted.

**Status**

Resolved in accepted-plan design.

### B1-F-14 — Medium — browser invalidation reads unverified payload IDs

**Reviewer claim**

Current invalidation reads payload IDs even though structural IDs carry database
ownership.

**Operator decision**

Accepted.

**Rationale**

New repository invalidation should use the authoritative structural copy. Existing legacy
behavior remains outside B1.

**Required design changes**

1. New five-kind invalidation reads structural correlations.
2. Zod proves those IDs agree with payload IDs.
3. Record that the four legacy kinds continue to use payload IDs.
4. Test mismatch at the reducer helper boundary so the structural project/repository is
   selected, while contract parsing rejects that envelope at the wire boundary.

**Accepted-plan locations**

- §§5, 11, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-UI-003`
- `B1-UI-013`
- `B1-CON-012`

**Residual limitations**

Legacy invalidation retains its accepted payload-ID convention.

**Status**

Resolved in accepted-plan design.

### B1-F-11 — Low — foreign keys omit explicit delete actions

**Reviewer claim**

The proposed FK text omitted `ON DELETE RESTRICT`.

**Operator decision**

Accepted.

**Rationale**

The journal must match existing explicit ownership policy.

**Required design changes**

Add `ON DELETE RESTRICT` to all three new composite FKs and assert exact
`pragma_foreign_key_list` rows.

**Accepted-plan locations**

- §§7, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-MIG-010`

**Residual limitations**

None.

**Status**

Resolved in accepted-plan design.

### B1-F-12 — Low — scope checker mixes imports with behavior

**Reviewer claim**

Import scanning cannot prove lifecycle behavior and may false-positive on the accepted
`types.ts → repository-types.js` edge.

**Operator decision**

Accepted.

**Rationale**

Static import allowlists and behavioral inventory proofs must remain distinct.

**Required design changes**

1. Scope checker uses exact-path allowed-specifier lists only.
2. Add negative fixtures for forbidden specifiers.
3. Add a positive fixture for `types.ts → repository-types.js`.
4. Pin the permitted `workspace-event.ts → repository.js` contract direction and reject
   the reverse A2a-to-event direction.
5. Prove no service, route, notifier producer, or lifecycle behavior using changed-path,
   production-file, and route-inventory assertions outside the import scanner.

**Accepted-plan locations**

- §§13, 16, Appendix A

**Required acceptance/adversarial cases**

- `B1-SCOPE-001`
- `B1-SCOPE-003`
- `B1-SCOPE-005`

**Residual limitations**

An import checker does not prove arbitrary runtime semantics; the accepted plan no longer
claims that it does.

**Status**

Resolved in accepted-plan design.

### B1-F-13 — Info — smaller corrections

**Reviewer claim**

The target tree, empty-journal sequence wording, structural round-trip wording,
`JRN-REP-004` claim, and plan's fan-out conclusion need precise corrections.

**Operator decision**

Accepted.

**Rationale**

Each correction removes ambiguity without expanding B1.

**Required design changes**

1. Add `App.tsx`.
2. Expect a new sequence row with `seq = 0` after rebuilding an empty journal, while
   preserving the old high-water exactly when one existed.
3. Require `B1-STO-001` to inspect structural correlations separately.
4. Narrow `JRN-REP-004`.
5. Retain the no-further-fan-out conclusion.

**Accepted-plan locations**

- §§3, 8, 11, 16, 17, Appendix A

**Required acceptance/adversarial cases**

- `B1-MIG-002`
- `B1-STO-001`
- `B1-UI-011`

**Residual limitations**

None beyond the explicitly documented inspection-history gap.

**Status**

Resolved in accepted-plan design.

## Coverage-gap dispositions

The review proposes twelve new identifiers. They are accepted as implementation
traceability labels without modifying the protected supplement:

```text
B1-COR-013
B1-COR-014
B1-CON-011
B1-CON-012
B1-STO-009
B1-STO-010
B1-STO-011
B1-MIG-009
B1-MIG-010
B1-UI-011
B1-UI-012
B1-UI-013
```

`B1-UI-012` is documentary in B1 and executable in B2 because B1 has no lifecycle
producer. Its B1 proof is the exact five-kind vocabulary and ADR limitation; B2 supplies
the zero-event/zero-notifier behavior.

`B1-COR-013` is proved at contract, append, and read boundaries under option (b), not by
direct-SQL insertion rejection. Direct SQL with structurally valid ownership may insert
the row; every application read must reject it.

The existing `B1-COR-011` test title is split into separately named positive and negative
subcases without altering the protected identifier.

## Operator decisions

1. Option (b) is binding for B1-F-01 and B1-F-02.
2. Migration 0004 contains no new payload-aware semantic CHECK.
3. All three structural FKs and all kind-scoped structural presence/absence rules remain.
4. B1-F-08's all-NULL default arm is mandatory.
5. ID agreement and retirement coupling are strict Zod refinements.
6. Append asserts ID agreement before INSERT.
7. Mapper read rejects ID disagreement and invalid retirement coupling.
8. ADR-018 states: the database proves **ownership**; contracts prove **semantics**.
9. No ADR-013 amendment is made.
10. No further fan-out is required.

## Required amendments to the proposed plan

| Proposed-plan section | Required amendment |
|---|---|
| §§3.2, 10 | Add `App.tsx`; bound repository IDs; parameterize scope consumption |
| §§4–5 | Use explicit base types; exact all-nine correlation schemas; define post-commit repository version |
| §§6–7 | Remove new payload-aware CHECKs; add all-NULL default arm and explicit `ON DELETE RESTRICT` |
| §7 | Correct empty-journal sequence behavior |
| §9 | Add append assertion, typed mapper validation, and runtime default |
| §§10–11 | Use structural IDs for new invalidation; retain safe exhaustive rendering |
| §12 | Add review cases and narrow later-slice claims |
| §13 | Limit scope checker claims to exact import edges |
| §14 | Add ADR-018 only; do not amend ADR-013 |
| §15 | Derive guard failure from real 0004 and insert migration checkpoint |
| §16 | Separate import proof from route/service/behavior inventory |

## Unresolved matters

None for accepted-plan production. B1-PROC-002, B1-SCOPE-004, implementation report
lineage, and the actual implementation head necessarily remain open until implementation
is authorized and a real commit exists.

The inspection-history freshness limitation is assigned to CT-04E, with B2 retaining its
protected zero-event lifecycle cases.

## Implementation-plan authorization

The primary implementer may produce the accepted implementation plan incorporating the
decisions above. Source implementation remains unauthorized until the operator approves
and commits that plan and then gives separate explicit implementation permission.
