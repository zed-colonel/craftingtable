# CT-04A2a Initial-Review Remediation Report

**Work item:** CT-04A2a — Repository domain, evidence model, and persistence
**Review addressed:** `review-findings/CT-04/CT-04A2a-initial-review.md`
**Reviewed implementation head:** `e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c`
**Report-only commit at review time:** `ae883ed96dba528ca896d3e62365e7d90acde51a`
**Remediation implementation head:** `ccb9c7951f6143819e3c5ab30bd4d57157e8d658`
**Accepted-plan SHA-256:** `e3490f16333c9e80b9eab667cea10d57312bbbdbab9434ddb05bc7794e1da747`
**Status:** remediation complete; ready for independent final review

## 1. Summary

The remediation closes blocking finding `A2a-R-01` under the operator's binding
disposition: accepted-plan §15 remains a control, every original protected A2a ID remains
discoverable from a test title, and the reviewer's title-plus-check recommendation is
implemented. The check derives the original IDs from the untouched supplement rather
than maintaining a second copy.

All four advisory findings were also remediated deliberately:

- a missing verification parent has a truthful typed result;
- a bind racing retirement reports the retired non-active parent;
- production A2a source cannot import filesystem or socket authority;
- repository transitions retain their write lock through read-back.

At the first remediation head, no schema, migration, domain, public contract, route,
server production, workspace-event, notifier, Git, process, or browser behavior changed.

### Follow-up correction after remediation review

The independent remediation review found that ten title anchors named scenarios their
tests did not attempt. That finding was correct. The follow-up adds the missing direct-SQL
assertions and removes every surplus title claim.

It also supersedes this report's original statement that all 104 cases are test-title
anchors. There are now 101 behavioral title anchors and three documentary process
controls. `A2-PROC-001..003` are proved by artifact hashes and Git history, not by file
existence or by treating a document as a behavior test.

A schema change was attempted for `A2A-REP-013` and then reverted. See §2 below and
`review-findings/CT-04/CT-04A2a-remediation-2-review.md` finding `A2a-R-03`. Migration
0003 is byte-identical to its first-remediation form and no migration changed in this
follow-up.

## 2. Finding closure

### A2a-R-01 — protected acceptance title anchors

**Binding control.** The operator directed that the accepted-plan §15 statement be
treated as binding and that the reviewer's remediation recommendation be followed.

**Root cause.** The implementation used accurate descriptive test titles and family-level
report mappings, but it did not attach 66 original protected IDs or seven review-added
IDs to those titles. No gate compared the live title set with the protected and accepted
ID sets.

**Repair.**

1. Behavioral tests carry only the protected/review IDs they actually exercise. Existing
   compact `001..014` and `003/006` notation remains supported.
2. `check:protected` reads the 91 CT-04A2a cases directly from the operator-owned
   supplement.
3. It reads accepted-plan §15.2 and requires its exact 13 review-added IDs.
4. It scans only the twelve nominated proof files' `describe`/`it`/`test` titles,
   expands compact ranges and slash lists, and fails for any missing behavioral ID.
5. It rejects an A2b ID claimed in an A2a test title.
6. Its own negative test removes `A2A-REP-016` from a scratch proof package and proves
   the gate fails.
7. It separately validates `A2-PROC-001..003` through the artifact/Git lineage described
   below.

The resulting required set is exactly 101 title anchors plus three documentary lineage
controls. The initial completion report §9 gives an explicit row for every case instead
of implying per-case proof from family ranges.

**Scope.** The R-01 repair itself is confined to test titles, the protected checker and
its tests, and the report correction. It does not touch the schema, migration, domain,
public contracts, or storage production implementation.

### A2a-R-02 — truthful per-case proof

The schema tests now directly attempt and assert every relationship/lifecycle scenario
identified by the remediation reviewer:

- cross-workspace inspection parent and valid-user/non-member inspection actor;
- cross-workspace and missing binding project;
- partial binding retirement, retarget, unretire, and delete;
- revoked historical binding attribution plus membership delete restriction;
- post-retirement inspection mutation;
- repository status NULL/coupling failures and stale attribution-pair reuse.

The broad schema titles retain only the IDs their bodies actually exercise. The retired
history test first retires the repository before attempting inspection mutation,
unretire, and repository delete.

For `A2A-REP-013`, a trigger clause requiring the attribution pair to change was added to
migration 0003 and then **reverted** during review as `A2a-R-03`. It made every
same-actor, same-millisecond transition fail with a raw `SqliteError` out of
`applyTransition`, `reaffirmEnvironment`, and `retireWithBindings`, and it silently
narrowed accepted plan §11.1 and `A2A-REP-016` to different-actor transitions only. A
trigger sees only `OLD` and `NEW` values, so an `UPDATE` that omits the attribution
columns is indistinguishable from a genuine same-millisecond action by the same actor;
the check cannot be made precise at that layer.

`A2A-REP-013` is therefore discharged by what SQL does prove — `NOT NULL` on both
attribution columns and the status/reason coupling `CHECK` — with the direct-SQL
stale-pair case recorded as an accepted limitation in
`packages/storage/src/repository-schema.test.ts`. No storage API path can produce it:
all three mutators always write both attribution columns from their arguments.

### A2a-A-01 — fabricated retired status for a missing repository

**Decision.** Remediate now rather than carrying the downstream A2b warning.

**Repair.** `InspectionAppendResult` gains the internal storage result
`{ kind: 'repository-not-found' }`. `appendVerification` returns it when no parent row
exists and reserves `repository-not-inspectable` plus a status for an existing parent
whose real state disallows inspection.

**Proof.** A focused storage test appends against an identifier that was never registered
and asserts the exact status-free result.

**Justification for production change.** This is a closed internal storage-union
refinement, not a public wire-contract or A2b service change. It removes fabricated state
and makes accidental downstream existence claims impossible.

### A2a-A-02 — retirement race classification

**Decision.** Make the storage result match accepted-plan §11.5 directly.

**Repair.** Binding insertion checks the found repository's active state before comparing
its expected version. A pre-retirement version racing a completed retirement therefore
returns `{ kind: 'repository-not-active', status: 'retired' }`; active-parent version
conflicts remain unchanged.

**Proof.** A focused test retires a repository to version 2, submits a bind with expected
version 1, and asserts the exact retired non-active result. It is also the title anchor
for `A2A-BIND-004` and `A2A-RET-004`.

**Justification for production change.** The binding was already refused fail-closed.
This change makes the discriminant truthful and aligned with the accepted race outcome.

### A2a-A-03 — incomplete A2a authority gate

**Decision.** Close the prospective gate gap.

**Repair.** The A2a forbidden set now includes `node:fs` and subpaths, `node:net`,
`node:http`, and `node:https`. Production A2a files are rejected for these imports.
Structurally recognized tests may still read fixtures; in particular,
`repository-schema.test.ts` must read the migration SQL it verifies.

**Proof.** Unit assertions cover every new specifier. Workspace-fixture tests place each
specifier in production `packages/storage/src/repository.ts` and prove `runCheck` reports
the exact A2a authority violation.

### A2a-A-04 — transition read-back race

**Decision.** Give `applyTransition` the same transaction boundary as the other
repository mutators.

**Repair.** The read, guarded update, and read-back now execute in a nested-safe
`transaction(...).immediate()`.

**Proof.** A focused adversarial test intercepts the read-back point and attempts a valid
later transition from a second SQLite connection. The competing writer receives
`SQLITE_BUSY`, and the caller returns the exact version-2 row it produced. Without the
outer immediate transaction, that competing update can commit before the read-back.

**Justification for production change.** The accepted plan requires immediate mutator
transactions. This closes the residual return-value race without altering transition
vocabulary or SQL invariants.

### A2a-A-05 — broader host-module denylist

No current A2a source imports bare `fs`, DNS/datagram, worker-thread, or VM modules. The
follow-up does not extend the pattern denylist case by case: the reviewer correctly notes
that doing so still would not create a structural authority boundary. A2b must decide the
complete production-module policy when it composes the repository feature. The current
filesystem/socket cases accepted in the first remediation remain enforced.

### A2a-A-06 — valid competing transition

The read-back race probe now attempts the valid
`unavailable → active/evidence-matches` transition with a later attribution timestamp.
`SQLITE_BUSY` therefore proves lock holding without relying on an independently invalid
status reason.

### A2a-A-07 — documentary process controls

`A2-PROC-001..003` are no longer categorized as behavior title anchors.

- `A2-PROC-001` recomputes the proposed plan, design review, and disposition SHA-256
  values and requires the review → disposition → accepted-plan hash dependency chain.
- `A2-PROC-002` derives all 18 `A2a-F-*` findings from the design review and requires
  every one in accepted-plan §20's reconciliation appendix.
- `A2-PROC-003` resolves the report-named implementation commit with Git, requires it to
  be an ancestor of `HEAD`, locates the report's introduction commit, and requires the
  named implementation head to be that commit's parent.

The Git call is developer verification tooling using fixed argument arrays. It adds no
Git or process authority to domain, contracts, storage, server, or browser code.

## 3. Permanent proof

The complete per-case mapping is in
`implementation-reports/CT-04/CT-04A2a-initial-impl.md` §9. Its 101 behavioral title
anchors and three documentary controls are mechanically checked by:

```text
node scripts/check-ct04-protected-package.mjs
```

Finding-specific regression proof:

| Finding | Permanent proof |
| --- | --- |
| `A2a-R-01` | `scripts/check-ct04-protected-package.{mjs,test.mjs}` and title anchors in the twelve nominated proof files |
| `A2a-A-01` | `packages/storage/src/repository-repositories.test.ts` — nonexistent verification parent |
| `A2a-A-02` | `packages/storage/src/repository-repositories.test.ts` — bind racing retirement |
| `A2a-A-03` | `scripts/check-forbidden-scope.{mjs,test.mjs}` — production filesystem/socket fixtures |
| `A2a-A-04` | `packages/storage/src/repository-transitions.test.ts` — second-connection read-back race |
| `A2a-R-02` | schema/transition direct-SQL relationship, attribution, binding-lifecycle, and retired-history tests |
| `A2a-A-07` | content-hash dependency chain, 18-finding reconciliation, and Git commit ancestry checks |

## 4. Verification actually run

Focused A2a command:

```text
pnpm exec vitest run \
  packages/domain/src/repository.test.ts \
  packages/contracts/src/repository.test.ts \
  packages/storage/src/repository-schema.test.ts \
  packages/storage/src/repository-repositories.test.ts \
  packages/storage/src/repository-transitions.test.ts \
  packages/storage/src/migration-0003.test.ts \
  packages/storage/src/migration-0002.test.ts \
  packages/storage/src/migrations.test.ts \
  packages/storage/src/snapshot.test.ts \
  apps/server/src/restart.test.ts \
  scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs
```

Result: exit 0; 12 files and 97 tests passed.

Full deterministic gate:

```text
pnpm check
```

The sandboxed run reached Vitest and failed only because ten existing SSE tests could not
bind `127.0.0.1` (`listen EPERM`). The approved non-sandboxed rerun passed:

```text
format:check       passed, 220 files
lint               passed, 221 files
typecheck          passed
build              passed
unit/integration   66 files, 530 tests passed
Playwright         4 tests passed
check:scope        passed
check:protected    passed, exact package plus 104 A2a anchors
```

Other completed checks:

```text
pnpm typecheck
pnpm lint
git diff --check
node scripts/check-forbidden-scope.mjs
node scripts/check-ct04-protected-package.mjs
```

All passed.

## 5. Protected and migration preservation

Live SHA-256 values at the remediation implementation head:

```text
A2 protected supplement
1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c

original protected specification
ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64

migration 0001
42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273

migration 0002
6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247

migration 0003
526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
```

`git diff --exit-code e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c` is empty for
the protected package, protected supplement, and migrations 0001–0003. The
operator-owned supplement was not edited, renumbered, weakened, or reclassified.

These values still hold. The follow-up briefly amended migration 0003 to
`fa088c2a2dfbc102f03b9382f2720dd27ac6e0df17dc1eaef096bf6c2c72f9af` under the operator's
`A2A-REP-013` decision; that amendment was reverted during review as `A2a-R-03`, so all
three migrations, the protected package, and the supplement are unchanged from
`e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c`. No local database needs a reset.

## 6. Scope and remaining boundaries

Domain, contracts, storage production, server, and browser code do not import or compose:

```text
@craftingtable/git
node:child_process or child_process
Fastify or @fastify/*
server production composition or routes
workspace events or notifier code
React, @craftingtable/web, or browser code
```

It adds no dependency and no CT-04A2b behavior. The exact-byte digest remains corruption
detection, not hostile-database authenticity, and no stored status or binding conveys
readiness, executability, approval, review, or merge authority.

The first remediation review evaluated
`ccb9c7951f6143819e3c5ab30bd4d57157e8d658`. This follow-up invalidates that verdict.
Independent final review must evaluate the eventual committed follow-up head; this report
does not invent one before the operator requests a commit.
