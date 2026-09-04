# CT-04A2a design-review disposition

Status: **Accepted by Operator**
Adoption date: 2026-07-28
Slice: `CT-04A2a — Repository domain, evidence model, and persistence`
Parent slice: `CT-04A2 — Repository registry and project binding`
Parent milestone: `CT-04`

Reviewed proposed plan:
`work-items/CT-04/CT-04A2a-proposed-implementation-plan.md`
Reviewed plan SHA-256:
`67c6444ca23ba8d19902ad01a05ef4d31a5c990e4d8d02b1049cde458fcd2c81`
Independent design review:
`review-findings/CT-04/CT-04A2a-design-review.md`
Design review SHA-256:
`5b6e9f620eaec112386f19578b2111d52d12745b43b3de26bb0e67aad8dcfc94`

Source/planning checkout:
`599f3dedf406542cfda26bfecc25ffdc86e0c6d4`
Accepted A1 runtime head:
`7313e81a56c0188574c436322d7fedc16e08bb70`
Protected-package pin:
`06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Original protected acceptance SHA-256:
`ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`
A2 protected supplement SHA-256:
`1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c`

Primary implementer: Codex
Independent reviewer: source-specific read-only reviewer; model identity was not recorded
in the review artifact
Operator: Keith Sanders

## 1. Purpose and authorization boundary

This disposition records the operator's adjudication of all findings in the independent
CT-04A2a design review. It uses `templates/design-review-disposition.md` and the
planning-feedback protocol in
`init/craftingtable-planning-implementation-feedback-loop-addendum.md`.

It is read with:

1. the reviewed proposed plan;
2. the independent design review;
3. `work-items/CT-04/CT-04A2.md` and `work-items/CT-04/CT-04A2a.md`;
4. the original protected specification and the read-only A2 supplement.

This is not an implementation plan and authorizes no source change. It authorizes creation
of `work-items/CT-04/CT-04A2a-accepted-implementation-plan.md` only. Source implementation
remains unauthorized until the operator approves and commits that accepted plan and then
gives separate explicit implementation permission.

## 2. Overall disposition

The review verdict is accepted:

```text
REVISE — incorporate all findings before accepting the implementation plan
```

All 18 findings are accepted. The six explicit operator decisions are binding:

- F-01: add the A2a-owned `stored-evidence-integrity` failure axis;
- F-02: use a global `sequence INTEGER PRIMARY KEY AUTOINCREMENT`;
- F-07: permit equal timestamps and reject backwards timestamps;
- F-11: expose `canonicalTopLevel` to all authenticated readers and restrict both Git
  directory paths to Owner-only administrative responses;
- F-13: make all four latest-inspection fields required;
- F-18: retain `expectedVersion` and reject stale inspection requests before any A1 call.

The review states that the remaining findings are technical dispositions the implementer
can carry out once accepted. The operator's instruction to address the findings adopts
those recommendations. No finding is rejected, downgraded, or deferred to implementation
discretion.

| Decision | Count |
|---|---:|
| Accepted | 18 |
| Accepted with modification | 0 |
| Rejected | 0 |
| Escalated | 0 |

The review's affirmed conclusions remain binding: the A2a/A2b split is honest, SQLite can
express the model, the full-record byte/digest contract is correct, the candidate keys and
relationship matrices are structurally sound, and A2a should not fan out further.

## 3. Finding dispositions

### A2a-F-01 — High — unrepresentable stored-digest failure

**Operator decision:** Accepted as recommended.

**Required design changes:** Add `errorOrigin: 'a1' | 'storage-integrity'`. Add the
A2a-owned code `stored-evidence-digest-mismatch`, subject
`stored-evidence-integrity`, operation `verify-stored-record`, category `observation`, and
retryability `not-retryable`. Keep it outside the mirrored A1 sets. The SQL taxonomy
enforces two disjoint tables. Digest mismatch appends a durable failed verification and
transitions the repository to
`evidence-blocked`/`stored-evidence-digest-mismatch` in one outer transaction.

**Accepted-plan locations:** §§6.2, 6.3, 8.2, 10, 11.2, 20.

**Proof:** `A2A-INSP-013`, new `A2A-INSP-015`, direct-SQL cross-origin negatives.

**Residual limitation:** The digest is an application-integrity checksum, not proof
against a hostile database writer.

### A2a-F-02 — High — inspection history lacks a total order

**Operator decision:** Accepted as recommended; use the global sequence.

**Required design changes:** Restructure inspections to
`sequence INTEGER PRIMARY KEY AUTOINCREMENT` and `id TEXT NOT NULL UNIQUE`. Retain all
composite candidate keys. Define latest and latest-successful solely by greatest sequence;
timestamps never break ordering ties.

**Accepted-plan locations:** §§6.3, 8.2, 11.5, 13, 14, 20.

**Proof:** new `A2A-INSP-016`, including a fixed clock and opposite UUID orderings.

### A2a-F-03 — High — insert primitives expose raw constraint failures

**Operator decision:** Accepted as recommended.

**Required design changes:** Registration, inspection append, and binding insert return
closed discriminated results. Collision classification uses explicit reads inside the same
immediate transaction. Foreign identity conflicts have a payload-free
`identity-reserved-elsewhere` variant. Residual uniqueness failures are rolled back to a
savepoint, reclassified, and never parsed from SQLite error text.

**Accepted-plan locations:** §§9, 11.5, 13, 14.2, 20.

**Proof:** new `A2A-REP-015`, concurrency tests, and structural serialization assertions
that foreign variants contain no identifiers or paths.

### A2a-F-04 — High — reaffirm reducer carries no evidence

**Operator decision:** Accepted as recommended.

**Required design changes:** `reaffirm-environment` carries a complete
`RepositoryObservationAssessment`. Only environmental difference can reaffirm. Core
difference transitions to mismatch; same/risk-only reject as reaffirmation-not-required;
unavailable, invalid evidence, and no-state-change failure have explicit outcomes. No
branch falls through.

**Accepted-plan locations:** §§6.4, 11.3, 20.

**Proof:** new seven-assessment matrix `A2A-STATUS-015`.

### A2a-F-05 — Medium — server restart tests pin schema 2

**Operator decision:** Accepted as recommended.

**Required design changes:** Add `apps/server/src/restart.test.ts` to the target tree and
replace both literal schema-version assertions with the discovered supported version. Add
a repository-level scope regression preventing test code from pinning the supported
migration version to a literal. Describe the slice as having no server production change.

**Accepted-plan locations:** §§5, 14, 15, 19, 20.

**Proof:** `pnpm test`; new `A2-SCOPE-003`.

### A2a-F-06 — Medium — schema-2 audit catalog assertion becomes false

**Operator decision:** Accepted as recommended.

**Required design changes:** At schema 2, compare the catalog only with the
`introduced_in_schema <= 2` slice of `AUDIT_ACTIONS`. At schema 3, compare the complete
catalog with all 19 actions and prove old introduction versions unchanged.

**Accepted-plan locations:** §§8.5, 14.1, 15, 20.

**Proof:** extended `A2A-MIG-003`.

### A2a-F-07 — Medium — timestamp predicate rejects equal time and permits rewind

**Operator decision:** Accepted as recommended.

**Required design changes:** Require
`NEW.status_changed_at >= OLD.status_changed_at`. Version +1 and the exact transition
table prove progress. Equal millisecond timestamps are legal; backwards timestamps fail.
A self-update still fails because no exact old/new/reason transition admits it.

**Accepted-plan locations:** §§11.1, 14.2, 20.

**Proof:** new `A2A-REP-016`.

### A2a-F-08 — Medium — duplicated A1/SQL vocabulary has no parity proof

**Operator decision:** Accepted as recommended.

**Required design changes:** SQL bounds but does not pin the risk pattern's exact text.
Domain owns the exact accepted pattern. An A2a text-level test compares every migration
allowlist with domain constants. A2b must compare those domain constants with A1
package-root exports.

**Accepted-plan locations:** §§3, 6.2, 8.2, 15, 18, 20.

**Proof:** new `A2-SCOPE-004`; deferred A2b adapter parity case.

### A2a-F-09 — Medium — genuine A1 evidence can violate SQL key shape

**Operator decision:** Accepted as recommended.

**Required design changes:** A2a owns a total, deterministic evidence normalizer. It drops
unsafe keys/values, sorts keys, caps count and byte size, truncates strings on UTF-8
boundaries, and returns `{}` rather than failing. Failed-inspection write input accepts
only its branded normalized output. SQL retains the structural limits as a backstop.

**Accepted-plan locations:** §§6.3, 10, 13, 14.2, 20.

**Proof:** new `A2A-INSP-017` plus direct-SQL bypass negatives.

### A2a-F-10 — Medium — repository-side inspection FKs are unnecessarily deferred

**Operator decision:** Accepted as recommended.

**Required design changes:** Both repository-to-inspection FKs are immediate. Only the
inspection-to-repository parent FK remains deferred. Sibling/wrong-parent failures occur
at repository INSERT/UPDATE; an orphan inspection fails at the outermost COMMIT. A nested
primitive never claims to observe an outer deferred failure.

**Accepted-plan locations:** §§8.1, 8.2, 9, 11.5, 12, 20.

**Proof:** timing-explicit expansion of `A2A-REP-002` and existing
`A2A-REP-003/004`.

### A2a-F-11 — Medium — host-path disclosure is unstated

**Operator decision:** Expose canonical top level to all authenticated readers; expose
canonical Git directory and common Git directory only through an Owner-authorized
administrative response.

**Required design changes:** Split reader and administrative identity schemas. Common list,
detail, and mutation responses reject the two diagnostic Git paths. Add the administrative
detail response and document the boundary in `docs/security.md`.

**Accepted-plan locations:** §§7.3, 7.4, 16, 20.

**Proof:** new `A2A-CON-009`.

### A2a-F-12 — Medium — binding projection hides repository state

**Operator decision:** Accepted as recommended.

**Required design changes:** Existing bindings remain active and immutable when a
repository becomes non-active. Every project-scoped binding summary includes required
`repositoryStatus` and `repositoryStatusReason`. An active binding never implies an active
or usable repository.

**Accepted-plan locations:** §§7.3, 7.4, 11.4, 13, 20.

**Proof:** new `A2A-BIND-013`.

### A2a-F-13 — Low — impossible optional latest fields

**Operator decision:** Make all four fields required.

**Required design changes:** `latestInspectionId`, `latestInspectionAt`,
`latestSuccessfulInspectionId`, and `latestSuccessfulInspectionAt` are required in every
repository evidence summary.

**Accepted-plan locations:** §§7.3, 13, 20.

**Proof:** new `A2A-CON-010`.

### A2a-F-14 — Low — registration quiescence proof is not durable

**Operator decision:** Accepted as recommended.

**Required design changes:** State honestly that the registration inspection stores only
the second observation and has NULL comparison arrays. A2b must record a bounded audit
attestation containing both exact observation digests and the three true comparison
booleans. This attests the two-inspection decision but does not retain the first full
observation.

**Accepted-plan locations:** §§6.3, 8.2, 18, 20.

**Proof:** new `A2A-INSP-018`; deferred A2b registration-audit case.

### A2a-F-15 — Low — non-advancing reaffirmation kind is ambiguous

**Operator decision:** Accepted as recommended.

**Required design changes:** A2b writes successful `kind='reaffirmation'` only for the
fresh environmental-difference observation adopted as baseline in that transaction. Any
other reaffirm-command assessment is stored as `kind='verification'`. Read projections
carry `acceptedAsEnvironmentBaseline`, derived from the repository baseline link, so a
direct-SQL stray row cannot read as accepted merely from `kind`.

**Accepted-plan locations:** §§7.3, 11.2, 11.3, 13, 18, 20.

**Proof:** new `A2A-BASE-009`.

### A2a-F-16 — Low — scope checker exempts tests

**Operator decision:** Accepted as recommended.

**Required design changes:** The A2a-specific rule scans every file under
`packages/domain`, `packages/contracts`, and `packages/storage`, including tests, for Git
imports. `repository-test-support.ts` remains deliberately production-classified by the
general checker and contains no production capability or privileged import.

**Accepted-plan locations:** §§4.2, 5, 15, 20.

**Proof:** extended `scripts/check-forbidden-scope.test.mjs`.

### A2a-F-17 — Low — sqlite_sequence preservation is overbroad

**Operator decision:** Accepted as recommended.

**Required design changes:** Preserve every pre-existing `sqlite_sequence` row and counter
unchanged and never reset an existing counter; schema 3 may legitimately add a new
inspection sequence row after the first inspection insert.

**Accepted-plan locations:** §14.1 and §20.

**Proof:** `A2A-MIG-002` forward-migration fixture.

### A2a-F-18 — Low — inspect expected-version ordering is unstated

**Operator decision:** Keep `expectedVersion` and reject stale versions before A1.

**Required design changes:** A2a keeps the strict request field and storage conflict type.
A2b's mandatory ordering is authenticate, authorize, load, compare expected version, and
only then invoke the inspector. A later race is rechecked in the transaction.

**Accepted-plan locations:** §§7.2, 11.5, 18, 20.

**Proof:** deferred A2b pre-inspection zero-call and transaction-race cases.

## 4. Informational and coverage-gap dispositions

The review's informational corrections are accepted:

- `packages/storage/src/snapshot.test.ts` is added to the target tree as the named home for
  `A2A-MIG-007`;
- archived-workspace structural references remain legal in A2a, matching CT-03; A2b owns
  active-workspace policy;
- the A1 package-root export inventory is made explicitly complete;
- ADR-017 records that historical attribution FKs prevent deletion of referenced
  workspace-membership rows;
- all 13 original trigger behaviors, not merely trigger names, receive positive and
  negative direct-SQL tests.

The review-proposed cases are permanent implementation proof obligations but do not edit
or renumber the protected supplement:

```text
A2A-STATUS-015
A2A-REP-015
A2A-REP-016
A2A-INSP-015
A2A-INSP-016
A2A-INSP-017
A2A-INSP-018
A2A-BASE-009
A2A-BIND-013
A2A-CON-009
A2A-CON-010
A2-SCOPE-003
A2-SCOPE-004
```

`A2A-REP-002` additionally receives three timing-explicit subcases without changing its
protected ID.

## 5. Required amendments to the proposed plan

| Proposed-plan section | Required amendment |
|---|---|
| §3 | Complete the package-root export inventory and state domain/SQL/A1 parity ownership |
| §5/§19 | Add server restart and snapshot tests; revise to 35 files and no server production change |
| §6 | Add origin-qualified integrity failure, sequence-bearing records, normalized evidence, and evidence-bearing reaffirmation |
| §7 | Split reader/admin paths, require latest fields, expose repository state in binding projections |
| §8 | Use inspection sequence PK, immediate repository-side FKs, origin-qualified taxonomy, relaxed risk-pattern SQL bound |
| §9 | Add typed registration classification and exact outermost-commit attribution |
| §10 | Add the never-failing evidence normalizer |
| §11 | Use total ordering, monotonic non-decreasing time, exact reaffirm-kind and expected-version rules |
| §13 | Replace bare insert returns with discriminated outcomes |
| §14 | Fix migration catalog/version regressions, sequence wording, and name snapshot proof |
| §15 | Add all review-proposed cases and expand timing/parity/scope proofs |
| §16 | Record disclosure, archived-workspace, and membership-delete decisions |
| §18 | Add quiescence audit attestation, pre-A1 version ordering, and A1 parity obligations |
| §20 | Map every finding to its disposition, accepted section, and proof |

## 6. Unresolved matters

None. All findings and operator decisions have an accepted design disposition. The
implementation may still return to planning if a stop condition in the accepted plan is
encountered.

## 7. Implementation-plan authorization

The primary implementer may produce the accepted implementation plan incorporating the
decisions above. Source implementation remains unauthorized until the operator approves
and commits that plan.
