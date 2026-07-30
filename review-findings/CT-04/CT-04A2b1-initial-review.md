# CT-04A2b1 independent code review

Reviewed implementation head: `0c3d53a00cc004c99248abb227110293f829b722`
Report-only commit at review time: `ea102b77f944dcd6951b2cb1bf1fc7b4dd301012`
Accepted source head / base: `e3b69c612a51b0b2a8d436ae3ea5355abd40745e`
Planning/review commit: `37d621a2e974d2f44cc2ff68122a8922a9970e7d`
Accepted implementation plan: `work-items/CT-04/CT-04A2b1-accepted-implementation-plan.md`
Completion report: `work-items/CT-04/CT-04A2b1-implementation-commit-report.md`
Migration 0004 SHA-256: `ae3786b86982735a57490d9b291c6c4335511736b4a1480c3110d5a5de5b9454`

Review checkout: `ea102b7`, branch `ct=04a2b1-repository-journal`, working tree clean
before and after. `git diff 0c3d53a ea102b7` touches only the 61-line commit report, so
the reviewed code head is `0c3d53a`. Local environment: Node `v26.2.0`, Vitest `4.1.10`,
Zod `4.4.3`, POSIX, non-root UID `1000`. Every probe ran from a scratch directory outside
the repository against temporary SQLite databases and a `git archive` copy of the head.
Nothing in the repository was modified by this review.

**This document is introduced after `ea102b7`.** The verdict below binds to that exact
head. Any remediation invalidates it and requires re-review at a new head.

## Verdict

**CHANGES REQUIRED**

Two blocking findings, `B1-R-01` and `B1-R-02`. Neither is a defect in the schema-4
journal, the event contracts, the storage mapper, or the browser projection — the
substantive slice is sound and holds under independent adversarial probing. Both blockers
are failures of the deterministic gates that the slice relies on to prove its own
containment:

- `B1-R-01`: `pnpm check:scope` no longer detects multi-line import statements, so a
  production file can import `node:child_process` or `@craftingtable/git` and pass the
  gate. Proven end-to-end.
- `B1-R-02`: `pnpm check` is nondeterministic at this head, failing 3 of 8 clean-tree
  runs. The completion report's green-gate claim does not reproduce.

The ownership/semantics division that ADR-018 records is the strongest part of the slice.
I could not construct a poisoned row — by direct SQL, bypassing every application
defence — that reaches a caller. Migration preservation, the AUTOINCREMENT high-water
policy, composite ownership, the fail-closed mapper, bounded browser invalidation, and
activity-text safety all hold. No CT-04A2b2 behaviour leaked in.

## Review basis — verified pins

| Item | Claimed | Result |
|---|---|---|
| Accepted source head | `e3b69c61…` | ancestor of HEAD |
| Planning/review commit | `37d621a2…` | first parent of implementation head |
| Implementation head | `0c3d53a0…` | confirmed; delta to `ea102b7` is report-only |
| Migration 0001 | `42ade0fe…483273` | byte-identical |
| Migration 0002 | `6d2789c5…64464247` | byte-identical |
| Migration 0003 | `526df194…72123bc4` | byte-identical |
| Migration 0004 | `ae3786b8…5de5b9454` | matches disk and the report |
| CT-04 protected specification | `ce7a101c…f090f64` | byte-identical |
| A2 protected supplement | `1000d564…5e55b656429c` | byte-identical |
| A2b protected supplement | `255fe8b6…c7b14278ebad` | byte-identical |
| A2a + A1 production source | unchanged | zero diff |
| Manifests, lockfile | unchanged | zero diff |
| Server production files, routes, services | unchanged | zero diff |

## Independent probes

45 probes written outside the repository without reference to the implementer's tests, run
against temporary databases and a `git archive` copy of the head. **All 45 pass.**

**Migration (probe group A, H).** Legacy rows, IDs, exact `hex(CAST(payload_json AS BLOB))`
bytes, order, count and maximum preserved across 3→4. Forced a real deletion gap by
dropping the append-only delete trigger, deleting rows, and restoring it: the captured
`sqlite_sequence` high-water (5) survived while `MAX(sequence)` fell to 3, and the next
append issued 6 — high-water + 1, never a reused sequence. Empty schema-3 journal
normalises to a `seq = 0` row and appends at 1. No `migration_0004_*` or
`workspace_events_schema3` scaffolding survives. Nine-row kind catalog with exact
introduction values. Table DDL contains no `json_extract`, exactly one `json_type`
(the inherited generic valid-object CHECK), and none of `repositoryId`, `inspectionId`,
`bindingId`, `toStatus`, `statusReason`. Flipping the single `B1_GUARD_TEST_SENTINEL`
occurrence in the real bytes aborts the migration and rolls back completely to schema 3 —
legacy rows and payload bytes intact, four-row catalog, named index, working update/delete
rejection triggers, no scaffolding, and a successful subsequent legacy append at
sequence 4. Applied-0004 checksum drift is rejected.

**Structural containment (probe group B).** Thirteen illegal kind × correlation
combinations rejected by direct SQL, covering legacy kinds carrying a repository,
inspection or binding; registration without an inspection or with a binding or project;
status change without a repository or with a binding; evidence without an inspection;
binding without a binding ID or project, or carrying an inspection or run. A synthetic
unlisted kind inserted into `workspace_event_kinds` is forced to all-NULL repository
correlations by the ELSE arm, and is insertable only without them. Composite ownership
rejects a foreign-workspace repository, a sibling inspection belonging to a different
repository **including one inside the same workspace**, and a binding from a different
project graph; the fully-owned correlation is accepted.

**Read-time containment (probe group C).** Payload/structural disagreement fails both
`listAfter` and `listRecentAtOrBefore` with `WorkspaceEventMappingError` /
`payload-correlation-mismatch`. Missing, `null`, and misspelled payload correlation keys
each fail closed. `invalid-retirement-correlation` fires both for an operator retirement
carrying an inspection and for a non-retirement status change lacking one — the case SQL
deliberately permits. An unregistered runtime kind fails with `unknown-kind`. A poisoned
batch yields nothing: a window containing only good rows succeeds, and any window
containing the poison throws on both surfaces rather than returning a short result. A
foreign workspace reads an empty list.

**Append and sequencing (probe group D).** A disagreeing append throws
`WorkspaceEventAppendError` with row count and `sqlite_sequence` unchanged. Mixed legacy
and repository appends share one strictly increasing global sequence, and structural
correlations round-trip as exact variant fields. Append-only triggers still reject UPDATE
and DELETE at schema 4.

**Wire strictness (probe group E).** All nine canonical envelopes valid. The full 9 × 3
repository-correlation matrix rejects every illegal pair. Legacy correlations rejected on
repository kinds and inspection on binding kinds. Payload/structural disagreement rejected
per kind and per dimension. Version arithmetic, no-op transitions, reason-outside-the-
`toStatus`-set, and zero versions rejected. Retirement/inspection coupling exact in both
directions. All 25 forbidden payload field names rejected across all five new kinds.
Display names with leading whitespace, control characters, or 121 characters rejected. The
refinements are present on the exported per-kind schemas, not only the union.

**Browser projection (probe group F).** Repository lifecycle events set `repositoryList`
and the structural repository ID only, leaving `workspaceSummary`, `projectIds` and
`workItemIds` untouched. Binding events set structural project and repository but *not*
`repositoryList`, matching plan §11.1. Legacy events preserve pending repository scopes.
The 100-ID cap holds with stable order (`repository-31` … `repository-130` after 130
events); repeating a pending ID neither moves nor duplicates it. Parameterized consumption
clears only named scopes — consuming planning scopes leaves repository scopes pending, and
vice versa. Duplicate and lower-sequence events alter nothing. Foreign-workspace events
increment the counter and alter no stale scope. A same-workspace snapshot preserves the
live tail and pending repository scopes; a workspace switch clears events, scopes and
counters.

**Activity safety (probe group G).** Every kind yields a nonempty description. No
repository description discloses a path, `.git`, inode, fingerprint, digest, or any
ready/verified/reviewed/approved/executable/mergeable claim. All five new kinds stay within
256 characters at the maximum 120-character display name (worst case 176). A hostile
display name (`<img src=x onerror=…>`) renders as literal text: no `<img>` element in the
DOM or in `.activity-list` innerHTML, and no handler executes. All nine kinds render. An
invented runtime kind throws rather than rendering an unlabelled row.

**Scope absence.** No Git, `node:child_process`, Fastify, server-service, or A1 import in
any changed production file. No production server file, route, service, repository
configuration, notifier producer, repository fetch, repository view, sixth event kind, or
second migration. `apps/server` changes are test-only. The SSE route's existing catch logs
`error.name` and closes the stream; the cursor cannot advance past a failed batch because
`listAfter` throws before the batch is yielded. Documentation across README, CLAUDE.md,
architecture, security, operations and ADR-018 states the foundation-only claim accurately,
including the incomplete-inspection-history limitation. **B2 lifecycle commands remain
absent** — verified structurally, not by assertion alone.

Because of `B1-R-01`, the scope-absence conclusion above rests on direct file inspection
and the changed-path inventory, **not** on `pnpm check:scope`.

## Blocking findings

### B1-R-01 — `check:scope` no longer detects multi-line imports

**Severity: high. Blocking.**

`scripts/check-forbidden-scope.mjs:152` replaced the shared `IMPORT_PATTERN`. The new
alternation requires the import clause to match `[^'"\n;]+?`, which cannot span a newline,
and the previous standalone `\bfrom\s+` branch was removed. Multi-specifier import
statements — the form Biome produces for this codebase — are now invisible to the scanner.

Measured on real B1 files (old pattern vs new):

| File | Specifiers found, old | new | Missed by new |
|---|---:|---:|---|
| `packages/storage/src/repositories/workspace-events.ts` | 3 | 1 | `@craftingtable/domain`, `../types.js` |
| `packages/contracts/src/workspace-event.ts` | 4 | 2 | `@craftingtable/domain`, `./ids.js` |
| `packages/domain/src/workspace-events.ts` | 2 | 1 | `./ids.js` |
| `apps/web/src/lib/workspace-projection.ts` | 2 | 1 | `@craftingtable/contracts` |

End-to-end proof on a clean `git archive` of the head, injecting into
`packages/storage/src/repositories/workspace-events.ts` and running `runCheck`:

```text
baseline (unmodified head)                    -> []
multi-line node:child_process + git imports   -> []            <- gate passes
the same two imports written single-line       -> 4 violations
```

The four violations the single-line control produces —
`CT-04A2b1 exact-path source imports unapproved module "node:child_process"`,
the same for `@craftingtable/git`, `imports CT-04+ capability module`, and
`production source imports non-production seam` — are exactly the ones silently lost.

Every guard in `runCheck` consumes `findImports` (call sites at lines 399, 449, 465, 475),
so the weakening is repository-wide, not confined to B1: the new
`b1DisallowedImports` allowlist (B1-SCOPE-001), the forbidden-capability denylist, the
non-production seam check, planning-package purity, the CT-04A2a authority-free check, and
the development-tooling separation check all lose multi-line detection.

This contradicts accepted plan §15.1, the AGENTS.md boundary that "Agent backends and Git
operations sit behind explicit interfaces", and the structural-containment principle
established by CT-04A1 F-07.

The new negative fixtures at `scripts/check-forbidden-scope.test.mjs:359-390` all use
single-line `import value from 'y';`, which is why a green suite coexists with a
bypassable gate. **Any fix must add multi-line negative fixtures**, or the repair is
asserted rather than proven.

### B1-R-02 — `pnpm check` is nondeterministic at this head

**Severity: medium-high. Blocking.**

`verifyCt04A2b1Inventory` (`scripts/check-ct04-protected-package.mjs:560`) collects
changed paths from `git diff --name-only e3b69c61…` **plus**
`git ls-files --others --exclude-standard` against the live working tree.
`packages/git/test/test-support.ts:89` creates
`realpathSync(mkdtempSync(join(process.cwd(), '.ct04a-git-test-')))` — an untracked
directory at the repository root, matched by no `.gitignore` rule — and Vitest executes
both files in parallel workers.

Observed at this exact head on a clean tree: **3 failures in 8 full-suite runs.** Example:

```text
FAIL scripts/check-ct04-protected-package.test.mjs
  > B1-SCOPE-005 rejects manifests, routes, services, configuration, and A2a state paths
  + "B1-SCOPE-005 changed path is outside the accepted B1 tree: .ct04a-git-test-f9NlNr/budget-spawn-count"
  + "B1-SCOPE-005 changed path is outside the accepted B1 tree: .ct04a-git-test-f9NlNr/counting-git"
  + "B1-SCOPE-005 changed path is outside the accepted B1 tree: .ct04a-git-test-f9NlNr/sources/repository/"
```

The file passes in isolation; only the parallel race fails it. `B1-REGRESS-001` requires a
full green `pnpm check`, and the completion report records "68 Vitest files / 601 tests
passed". That result does not reproduce at this head. A crashed or interrupted
`packages/git` run also leaves the directory behind, which would then fail standalone
`pnpm check:protected` deterministically until it is removed by hand.

## Advisory findings

Recorded for operator disposition; none blocks acceptance on its own.

### A-01 — exact-tree deviation, and the gate was widened rather than the contract amended

`apps/server/src/cli.test.ts` is changed at this head but is not in the accepted plan's §3
exact implementation tree (30 files; the head changes 31). The change itself is correct and
necessary — the fixture hard-coded schema version 4 as the unsupported future version and
now derives `supportedVersion + 1` — and the implementation report discloses it plainly
under "Source reconciliation". The CT-04A2a review accepted the analogous fixture repair as
disclosed.

The finding is narrower: the path was added to `CT04A2B1_ALLOWED_CHANGED_PATHS`
(`scripts/check-ct04-protected-package.mjs:129`) without a corresponding amendment to the
accepted plan's §3 tree. B1-SCOPE-005 therefore now proves the implementation matches the
checker rather than matching the contract. In a slice whose methodology is the audit chain,
that inversion matters more than the file itself. Closing it means amending §3, or
recording the deviation in a remediation report for explicit disposition.

### A-02 — migration 0004 omits the composite FK-catalog guard that §8.2 enumerates

Accepted plan §8.2 lists "exact composite FK catalog" among the pre-drop preservation
guards. Migration 0004 has row-count, maximum-sequence, bilateral legacy-column,
payload-byte, all-NULL-correlation, catalog, index/trigger, `pragma_foreign_key_check` and
`pragma_integrity_check` guards, but no FK-definition guard. The assertion exists only in
the test suite (`B1-MIG-010`).

Practical exposure is small, and I want to be precise about why rather than overstate it:
`pragma_foreign_key_check` validates rows against whatever foreign keys exist but not that
the definitions exist, so a dropped FK definition would pass the in-migration guards —
however the test suite catches exactly that, and the checksum ledger detects byte drift in
0004. My probe confirms the FK catalog at this head is correct, with exact composite column
order and `ON DELETE RESTRICT` on all six keys.

The reason to close it now rather than later is the amendment window: plan §8.4 permits
amending 0004 in place only until B1 is accepted, because no operator database is at
schema 4. After acceptance, satisfying §8.2 literally requires a migration 0005.

### A-03 — the 256-character description bound is not universal

Plan §12 and `B1-UI-009` state that activity descriptions are "no longer than 256
characters". This holds for all five new kinds at the maximum 120-character display name.
It does not hold for legacy `plan-version-imported`: `document` is capped at 300
characters, and a 300-character document yields roughly 360. Verified by probe. Pre-existing
behaviour, unchanged by B1, but the criterion as written is broader than what is proven and
will be inherited by later slices as though it were universal. Narrowing the wording to the
five new kinds is sufficient.

### A-04 — schema sniff in the production append path

`SqliteWorkspaceEventRepository.hasRepositoryCorrelationColumns()`
(`packages/storage/src/repositories/workspace-events.ts:403`) runs a `pragma_table_info`
query on every `appendEvent` call and gates a legacy-column INSERT branch that is
unreachable at schema 4. Its only live purpose is the schema-1/2 preservation fixtures. Not
described in the accepted plan, though the implementation report discloses it.

No action recommended. It is correct, commented, cheap (a prepared statement against an
in-memory catalog), and removing it means reworking the preservation fixtures. Worth
revisiting only if CT-04A2b2 makes `appendEvent` hot.

### A-05 — size overrun against the plan's prediction

Plan §3 predicts 30 files and 2,700–3,700 changed lines. The head changes 31 files with
4,616 insertions and 158 deletions. The overrun is test volume — `migration-0004.test.ts`
alone is 889 lines, `repositories.test.ts` +403, `workspace-event.test.ts` +362. Not
actionable; recorded for prediction calibration only.

### A-06 — the inventory gate has no provision for this review artifact

`CT04A2B1_ALLOWED_CHANGED_PATHS` admits `review-findings/CT-04/CT-04A2b1-design-review.md`
via `CT04A2B1_PROCESS_FILES`, and admits implementation and remediation reports under
`work-items/` via the report regex, but has no entry or pattern for the independent
implementation review that the CT-04 process protocol requires. Committing this document
therefore fails `pnpm check:protected` at B1-SCOPE-005 until the path is admitted. See the
note at the end of this report.

## Remediation sequencing

The verdict binds to `ea102b7` and any remediation invalidates it. `B1-R-01`, `B1-R-02`,
and whichever advisories the operator disposes for action should therefore land in **one**
remediation turn against one new head; splitting them costs a second full independent
re-review for no benefit. Each remediation must record new bytes and checksums for any
amended migration in a new immutable report, per plan §8.4.
