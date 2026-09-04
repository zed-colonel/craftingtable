# CT-04A2b1 implementation report

**Status:** Source implementation complete and validated; implementation commit
not created
**Accepted source head:** `e3b69c612a51b0b2a8d436ae3ea5355abd40745e`
**Accepted planning/review commit:** `37d621a2e974d2f44cc2ff68122a8922a9970e7d`
**Implementation head:** intentionally absent — the operator has not authorized
an implementation commit
**Schema checkpoint:** approved by the operator before slices 3–5
**Date:** 2026-07-29

## Delivered boundary

The uncommitted implementation adds:

- the exact five schema-4 repository event kinds and introduced-schema map;
- nine strict event variants with structural/payload ID agreement, version,
  status/reason, and retirement refinements;
- migration 0004 with composite ownership foreign keys, kind-scoped structural
  CHECK arms, the all-NULL future-kind default, guarded byte/row/sequence
  preservation, and restored append-only artifacts;
- typed append inputs, pre-insert agreement assertions, explicit row mapping,
  typed fail-closed read errors, and complete-batch mapping;
- mixed legacy/repository snapshot and SSE cursor coverage;
- bounded repository invalidation scopes using structural IDs and exact
  parameterized consumption;
- safe, exhaustive activity descriptions;
- exact-path dependency allowlists, protected proof anchors, changed-path
  inventory, ADR-018, and foundation-only documentation.

Migration 0004 SHA-256:

```text
ae3786b86982735a57490d9b291c6c4335511736b4a1480c3110d5a5de5b9454
```

Migrations 0001–0003 remain at their accepted hashes:

```text
42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273
6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247
526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
```

## Source reconciliation

Implementation follows the accepted plan and design disposition. Migration 0004
contains no new payload-aware ID-equality or retirement CHECK. SQLite proves
ownership through structural correlations; Zod, append, and the mapper prove
semantics.

One necessary test-only target was discovered by the complete gate:
`apps/server/src/cli.test.ts` had hard-coded schema version 4 as the unsupported
future version. It now derives `supportedVersion + 1`, preventing the same drift
on later migrations. No production server file changed.

The schema-1/2 preservation fixtures also exposed that their repository seam
appends legacy events before schema 4 exists. The mapper retains a narrow legacy
append compatibility branch that names only pre-schema-4 columns; all
repository-correlated appends continue through the schema-4 path.

No further B1 fan-out was required.

## Validation

Focused implementation gate:

```text
15 test files passed
154 tests passed
```

Final elevated-loopback `pnpm check`:

```text
format:check passed
lint passed
typecheck passed
build passed
68 Vitest files passed
601 Vitest tests passed
4 Playwright tests passed
check:scope passed
check:protected passed
```

The first sandboxed complete run reached the real-port SSE suites and failed
with the expected `listen EPERM 127.0.0.1`; it also identified the stale
CLI future-version fixture. After correcting that fixture, the complete gate
passed with loopback socket permission.

## Scope proof

- No package manifest or lockfile changed.
- No production server service, route, or composition file changed.
- Route inventory remains unchanged.
- No repository configuration or feature toggle was added.
- No A1 or `@craftingtable/git` import was added.
- No child-process authority was added.
- No A2a repository state primitive or migration 0003 was changed.
- No repository-specific notifier producer was added.
- No repository fetch, model projection, page, or view was added.
- Protected specifications remain byte-identical.

Repository journal correlation and bounded browser invalidation vocabulary now
exist. **B2 lifecycle commands remain absent.**

## Commit boundary

The worktree contains the reviewed implementation and this immutable report but
no implementation commit. Record an exact implementation head only after the
operator explicitly authorizes and creates that commit; do not amend this
report to invent one.
