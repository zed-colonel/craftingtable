# CT-04A2b1 remediation 1 report

**Status:** Remediation complete and validated; remediation commit not created
**Review-record base:**
`7c8bcd34c0c4822e1b37cf2f2ea05acc7d9c4056`
**Reviewed implementation head:**
`0c3d53a00cc004c99248abb227110293f829b722`
**Independent review:**
`review-findings/CT-04/CT-04A2b1-initial-review.md`
**Independent review SHA-256:**
`b8a70cb1793775d93b72b8923d01242e55751eb25d1621b1213a3eb07e1d2f66`
**Remediation head:** intentionally absent — no remediation commit has been
authorized or created
**Date:** 2026-07-29

## Operator disposition

The operator required `B1-R-01` and `B1-R-02`, and directed closure of
`B1-A-01`, `B1-A-02`, `B1-A-03`, and `B1-A-06` in this turn. `B1-A-04` and
`B1-A-05` were deliberately left unchanged.

The disposition is recorded in
`work-items/CT-04/CT-04A2b1-initial-review-disposition.md`. The accepted plan
was amended without editing any protected specification.

## Finding closure

### B1-R-01 — multi-line import detection

The shared import pattern now permits newlines inside static import/export
clauses while retaining side-effect imports, dynamic imports, and `require`.
Against the real B1 sources it reconstructs every exact specifier reported
missing by the review.

Permanent tests cover Biome-formatted multi-line value imports, type imports,
and re-exports. An end-to-end workspace fixture injects multi-line
`node:child_process` and `@craftingtable/git` imports and proves all four
expected B1/capability/seam violations.

### B1-R-02 — nondeterministic protected inventory

Changed-path inventory now excludes only paths below the exact root namespace:

```text
.ct04a-git-test-<mkdtemp suffix>/
```

That namespace is created by existing CT-04A Git tests in concurrent Vitest
workers and contains no repository source. Near-miss filenames and nested
lookalikes remain violations. The former race combination — all five Git test
files plus the protected-package tests — passed 12 consecutive runs:

```text
12 × (6 files / 77 tests) = 924 passing test executions
```

### B1-A-01 — accepted-tree amendment

Accepted-plan §3 now includes `apps/server/src/cli.test.ts` and records the
31-file exact tree. The original line-count estimate remains historical, as
required by the operator's no-change disposition for `B1-A-05`.

### B1-A-02 — composite FK-catalog guards

Migration 0004 now compares the exact six composite foreign keys before and
after dropping `workspace_events_schema3`. The bilateral catalog comparison
proves parent table, part count, ordered child/parent columns, and
`ON DELETE RESTRICT`.

A mutation test removes the repository ownership FK from the real migration.
Legacy rows still need no repository parent, but the catalog guard aborts and
rolls the whole migration back to complete schema 3.

Amended migration 0004 SHA-256:

```text
409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e
```

The superseded implementation-review hash was:

```text
ae3786b86982735a57490d9b291c6c4335511736b4a1480c3110d5a5de5b9454
```

### B1-A-03 — activity-description bound

Accepted-plan §12 and the B1-UI-009 evidence now scope the 256-character bound
to the five new repository descriptions. Tests use maximum 120-character
repository display names. All nine kinds remain nonempty and exhaustively
described. A separate regression proves the pre-existing 300-character legacy
plan document is outside the repository-specific bound.

### B1-A-06 — independent-review artifacts

The inventory admits the exact B1 initial-review path and numbered/unnumbered
B1 remediation-review paths required by the process protocol. A near-miss B2
review path remains rejected.

## Validation

Focused remediation validation:

```text
typecheck passed
4 focused files / 72 tests passed
check:scope passed
check:protected passed
git diff --check passed
```

Race reproduction:

```text
12 consecutive combined Git/protected runs passed
924 total repeated test executions passed
```

Complete elevated-loopback gate:

```text
pnpm check passed
format:check passed
lint passed
typecheck passed
build passed
68 Vitest files / 607 tests passed
4 Playwright tests passed
check:scope passed
check:protected passed
```

Accepted immutable hashes remain:

```text
migration 0001  42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273
migration 0002  6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247
migration 0003  526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
CT-04 protected  ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
A2 supplement     1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c
A2b supplement    255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad
```

## Scope and next boundary

No A1 production source, A2a state primitive, package manifest, lockfile,
production server file, route, service, repository configuration, notifier
producer, repository fetch, or repository view changed.

The worktree is ready for a separately authorized remediation commit. A new
exact-head report must be created only after that commit exists, followed by a
fresh independent remediation review.

**B2 lifecycle commands remain absent.**
