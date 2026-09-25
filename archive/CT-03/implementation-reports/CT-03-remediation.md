# CT-03 Remediation Report

**Work item:** CT-03 — Import plan bundles and render the project/work-item dashboard
**Review addressed:** `review-findings/CT-03/CT-03-initial-review.md`
**Reviewed head:** `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05`
**Findings:** 2 blocking, 2 high, 2 medium, 2 low — **all 8 resolved**

## 1. Disposition

Every finding was verified against the source before any change was made. All
eight reproduced. None required pushback; the reviewer's claims were accurate,
and two were broader than the finding text stated (noted below).

| ID | Severity | Disposition |
|---|---|---|
| CT03-R1 | blocking | Fixed — composite ownership keys close the whole chain |
| CT03-R2 | blocking | Fixed — imported work graph is now immutable by trigger |
| CT03-R3 | high | Fixed — full draft-document schema in contracts, casts removed |
| CT03-R6 | high | Fixed — projection and detail state keyed by workspace identity |
| CT03-R4 | medium | Fixed — role/format validation; a fatal analysis always explains itself |
| CT03-R5 | medium | Fixed — requested project resolved before analysis |
| CT03-R7 | low | Fixed — NUL byte removed; a guard now rejects any recurrence |
| CT03-R8 | low | Fixed — completion report bound to the real head |

## 2. Verification before remediation

Each finding was reproduced against the reviewed head before being changed.

**CT03-R1 and CT03-R2** were probed directly against a database built from the
committed migrations:

```text
project-a active version := version-b (other workspace)  => ALLOWED  <-- defect
work_item in wa: project-a but version of project-b      => ALLOWED  <-- defect
rewrite an imported work item title + source_fields      => ALLOWED  <-- defect
move a work item to another plan version                 => ALLOWED  <-- defect
delete an imported work item                             => ALLOWED  <-- defect
```

One imprecision in the review is worth recording: the same probe reported the
dependency-edge cases as *rejected*, but only as a side effect of an earlier
mutation in the probe itself, not because dependencies were protected. The
reviewer's claim that they were mutable stands, and they are now covered by
triggers.

**CT03-R7** was confirmed by a byte scan of every tracked file: exactly one NUL,
in `packages/planning/src/graph.ts` at offset 3538. `git diff --stat` reported
`Bin 0 -> 8998 bytes` and `file(1)` reported `data`.

**CT03-R3, R4, R5, R6, R8** were confirmed by reading the cited code paths.

## 3. What changed

### CT03-R1 — structural ownership chain (blocking)

`workspace_id` alone was never enough. The schema now keys each child by the
parent relationship that actually matters:

```text
projects.active_plan_version_id  ->  plan_versions(project_id, id)
plan_versions.bundle_id          ->  plan_bundles(project_id, id)
work_items.plan_version_id       ->  plan_versions(project_id, id)
work_contract_drafts.work_item_id -> work_items(plan_version_id, id)
work_contract_drafts.plan_version_id -> plan_versions(project_id, id)
plan_import_attempts.plan_version_id -> plan_versions(project_id, id)
workspace_events.project_id      ->  projects(workspace_id, id)
workspace_events.work_item_id    ->  work_items(workspace_id, id)
```

A project can no longer point its active version at another project's — or
another workspace's — plan, a work item cannot be reassigned to a project that
does not own its version, and an event cannot correlate to a foreign project.

The finding named `active_plan_version_id`, but the same gap existed in
`plan_versions.bundle_id`, `work_items.project_id`, the draft chain, the attempt
chain, and the event correlation columns. All were closed.

### CT03-R2 — historical work-graph immutability (blocking)

Immutable plan versions did not make the versioned graph immutable. Added:

- `work_items_source_immutable` — every imported field (workspace, project,
  version, source id, ordinal, title, risk, phase, areas, exit gate, source
  fields) is frozen. Uses `IS NOT` so NULL-to-value changes are caught.
- `work_items_admission_only` — scoped to `UPDATE OF status`, so only the
  proposed → admitted transition with a version bump is allowed, and a content
  rewrite is still reported by the trigger that names the real problem.
- `work_items_admission_final` — an admitted row is terminal; it cannot be
  un-admitted, re-admitted, or re-attributed.
- `work_items_no_delete`, and no-update/no-delete on `work_item_dependencies`,
  `plan_import_attempts`, and `plan_import_diagnostics`.

### CT03-R3 — strict draft contract (high)

`workContractDraftDocumentSchema` now defines the complete document with
`strictObject` at every level and literals on `status`, `completeness`, each
`unresolved` marker, and `merge.humanAuthorizationRequired`. The server parses
the projection through it **before persisting**, so a malformed draft never
reaches the database; the browser consumes the inferred type. Both `as never`
and the browser's separate local `DraftDocument` shape are gone.

This is what makes an added `approved`, `executable`, or `ready` field a parse
failure rather than a rendering surprise.

### CT03-R6 — browser workspace identity (high)

`snapshot-loaded` now retains events, the cursor, and diagnostic counters only
when the incoming snapshot is for the *same* workspace. A new
`workspace-changed` action clears the projection the moment the selection
changes, so nothing from the previous workspace renders while the new request is
in flight. `App` resets project, plan-version, work-item, artifact, import, and
audit state on workspace change, and each detail view renders only when its data
matches the current route identity.

### CT03-R4 — role/format validation (medium)

`REQUIRED_ROLE_SOURCE_CLASSES` pins `implementation-plan` to Markdown and
`work-breakdown` to YAML, producing a new stable
`artifact-role-format-mismatch` diagnostic. Parsing now dispatches on the
validated source class rather than re-deriving from the filename.

Separately, `analyzePlanBundle` now guarantees at least one error diagnostic
whenever it cannot produce a usable plan, and the service records the **real**
`errorCount` instead of `Math.max(errorCount, 1)`. The row's CHECK constraint
now fails loudly if that invariant is ever broken, rather than persisting an
unexplained failure.

### CT03-R5 — requested project resolution (medium)

Any supplied `projectId` is resolved in the authenticated workspace **before**
bundle analysis. A missing or foreign project is the same non-disclosing 404
whether the bundle is valid or not, and no half-written attempt is left behind.

### CT03-R7 — source integrity (low)

The literal NUL in `graph.ts` is now a named escaped constant. `check:scope`
rejects a NUL byte in any tracked source file or migration, and that guard was
verified to fail when deliberately violated.

Note: `git diff` will still label the *remediation* diff of `graph.ts` binary,
because its committed parent is binary. From this commit forward the blob is
text and diff, blame, and merge behave normally.

### CT03-R8 — report provenance (low)

The completion report now names `b226df5e…` as the reviewed head with correct
base-to-head statistics, records that it was written before the commit was
authorized, and points here for the remediated state.

## 4. Verification after remediation

| Command | Before | After |
|---|---|---|
| `pnpm test` | 315 passed (52 files) | **380 passed (53 files)** |
| `pnpm test:e2e` | 4 passed | 4 passed |
| `pnpm check` | exit 0 | **exit 0** under Node 24.18.0 |

65 tests were added, all of them negative cases the original gate did not
exercise:

- `planning-schema.test.ts` — cross-workspace and cross-project active version,
  bundle/project mismatch, item reassignment, foreign event correlation, plus
  nine field-by-field work-item rewrite cases and delete/edit cases for
  dependencies, attempts, and diagnostics.
- `packages/contracts/src/planning.test.ts` — every missing draft section, every
  authorization-looking field, optional human-merge, resolved-section, and empty
  `missing` list.
- `workspace-projection.test.ts` — two-workspace activity, cursor, and counter
  isolation; immediate clearing on switch; same-workspace retention preserved.
- `bundle.test.ts` — JSON work breakdown, YAML implementation plan, permitted
  spellings, optional-role freedom, and "never fatal with empty diagnostics".
- `server-plan-import.test.ts` — missing and cross-workspace project with both
  valid and invalid bundles; persisted diagnostics match the reported count.
- `check-forbidden-scope.test.mjs` — NUL detection and a repository-wide scan.

## 5. Operator action required

**Migration `0002` was edited rather than superseded by an `0003`.** CT-03 is
unmerged and unreleased, so no operator database legitimately holds the old
schema 2, and shipping a known-broken schema plus a corrective migration would
permanently record a defect in the history of a feature that never shipped.

The consequence: **any local database that ran the pre-remediation `0002` will
now fail checksum validation** with `schema invalid (checksum-mismatch)`. Reset
it using the documented procedure in `docs/operations.md` — stop the daemon,
move the data directory aside, migrate, and bootstrap again. Migration `0001`
is untouched, so a CT-02-era database is unaffected.

## 6. Unchanged from the completion report

The deferred decisions, the artifact retention gap, the 2 MiB artifact ceiling,
the split CT03-A50 evidence, and the two `biome-ignore` suppressions all stand
as recorded. No acceptance criterion was weakened, and no fixture, contract,
matrix, or source artifact was edited to make a test pass.
