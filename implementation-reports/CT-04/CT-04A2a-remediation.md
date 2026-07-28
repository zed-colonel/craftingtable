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

No schema, migration, domain, public contract, route, server production, workspace-event,
notifier, Git, process, or browser behavior changed.

## 2. Finding closure

### A2a-R-01 — protected acceptance title anchors

**Binding control.** The operator directed that the accepted-plan §15 statement be
treated as binding and that the reviewer's remediation recommendation be followed.

**Root cause.** The implementation used accurate descriptive test titles and family-level
report mappings, but it did not attach 66 original protected IDs or seven review-added
IDs to those titles. No gate compared the live title set with the protected and accepted
ID sets.

**Repair.**

1. Existing behavioral tests now carry the applicable protected/review IDs. Existing
   compact `001..014` and `003/006` notation remains supported.
2. `check:protected` reads the 91 CT-04A2a cases directly from the operator-owned
   supplement.
3. It reads accepted-plan §15.2 and requires its exact 13 review-added IDs.
4. It scans only the twelve nominated proof files' `describe`/`it`/`test` titles,
   expands compact ranges and slash lists, and fails for any missing ID.
5. It rejects an A2b ID claimed in an A2a test title.
6. Its own negative test removes `A2A-REP-016` from a scratch proof package and proves
   the gate fails.

The resulting required set is exactly 104 title anchors: 91 protected plus 13
review-added. The initial completion report §9 now gives an explicit row for every case
instead of implying per-case proof from family ranges.

**Scope.** The R-01 repair itself is confined to test titles, the protected checker and
its tests, and the report correction. It does not touch the schema, migration, domain,
public contracts, or storage production implementation.

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

## 3. Permanent proof

The complete per-case mapping is in
`implementation-reports/CT-04/CT-04A2a-initial-impl.md` §9. Its 104 explicit rows are
mechanically checked by:

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

## 6. Scope and remaining boundaries

The remediation does not import or compose:

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

The review verdict is invalidated by the new implementation head. Independent final
review must evaluate exact commit
`ccb9c7951f6143819e3c5ab30bd4d57157e8d658`.
