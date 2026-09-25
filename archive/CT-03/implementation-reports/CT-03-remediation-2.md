# CT-03 Second Remediation Report

**Work item:** CT-03 — Import plan bundles and render the project/work-item dashboard
**Review addressed:** `review-findings/CT-03/CT-03-remediation-review.md`
**Re-reviewed head:** `b8aff843124846f679c183c3bb924e1ef3717090`
**Residual findings:** 3 high, 1 medium — **all 4 resolved**

## 1. Disposition

All four residual findings reproduced against the re-reviewed head before any
change was made. None required pushback.

| ID | Severity | Disposition |
|---|---|---|
| CT03-RR1 | high | Fixed — evidence is keyed to the version its attempt resolved to |
| CT03-RR2 | high | Fixed — one guard now covers the controller version too |
| CT03-RR3 | medium | Fixed — event correlation must describe one project graph |
| CT03-RR4 | high | Fixed — clearing moved into the selection transition, plus a render guard |

The re-review's characterisation of the first remediation as *partially* fixed
was accurate in each case. The first pass closed direct parent ownership and the
obvious mutation paths but stopped short of the relationships and the render
timing that actually carry the guarantee.

## 2. Verification before remediation

A focused probe against a database built from the committed migrations
reproduced all three schema findings:

```text
artifact on attempt(version A) claiming version B   => ACCEPTED  <-- defect
diagnostic on attempt(version A) claiming version B => ACCEPTED  <-- defect
bump a proposed work item version by 40             => ACCEPTED  <-- defect (1 -> 41)
event: project A correlated with project B's item   => ACCEPTED  <-- defect
```

CT03-RR4 was confirmed by reading the selection path: `onSelectWorkspace` called
`setSelectedWorkspaceId` and navigated without dispatching `workspace-changed`,
leaving the reset to a `useEffect` that runs after the render commits.

## 3. What changed

### CT03-RR1 — evidence coherence (high)

`plan_artifacts` and `plan_import_diagnostics` each had two independent foreign
keys — one for the attempt, one for the version — with nothing requiring the
version to be the one the attempt resolved to. `listForVersion` and
`listForAttempt` could therefore disagree about the same row.

`plan_import_attempts` gains the candidate key
`UNIQUE (workspace_id, id, plan_version_id)`, and both children now reference
that exact tuple through a single composite key instead of two independent ones.
A NULL version matches a failed attempt's NULL, which is how retained failure
evidence stays legal; attaching a non-null version to a failed attempt is now
rejected.

### CT03-RR2 — controller version integrity (high)

`work_items_admission_only` was scoped to `UPDATE OF status`, so a bare
`SET version = version + 40` on a proposed item was accepted. A later legitimate
admission would then have recorded a fabricated prior and resulting version in
its audit row.

The three overlapping work-item triggers are now **one** guard stating the whole
rule: an update is accepted only when every imported field is unchanged, the
status moves proposed → admitted, the version increments by exactly one, and
actor attribution is present.

Collapsing them was not cosmetic. Splitting the rule across several
`BEFORE UPDATE` triggers made the reported reason depend on SQLite's firing
order — a real problem the first remediation had worked around by scoping one
trigger to `UPDATE OF status`, which is exactly what opened this hole. One rule,
one message, no ordering dependency, and no duplicated field list.

### CT03-RR3 — event correlation coherence (medium)

`workspace_events` referenced `(workspace_id, project_id)` and
`(workspace_id, work_item_id)` independently, so an event could pair a project
with a sibling project's work item in the same workspace.

`work_items` gains `UNIQUE (workspace_id, project_id, id)` and the event table
references `(workspace_id, project_id, work_item_id)` against it. A NULL
`work_item_id` leaves this trivially satisfied, so `workspace-created`,
`project-created`, and `plan-version-imported` remain legal — verified by
positive tests, not just by reasoning.

### CT03-RR4 — workspace selection isolation (high)

Clearing in a `useEffect` runs after the render commits, so one frame could show
workspace B selected while rendering workspace A's summaries, projects,
activity, and audit.

Two changes, deliberately belt-and-braces:

1. A `selectWorkspace` helper batches the `workspace-changed` dispatch and every
   view-state reset with the selection itself. Every path that changes the
   selected workspace — the picker, a deep link, logout — now goes through it.
2. A **render guard**: planning content renders only when
   `projection.workspace?.id === selectedWorkspaceId`.

The guard is the load-bearing part. Clearing correctly depends on remembering
every call site; the guard makes rendering one workspace's projection under
another's identity impossible regardless of update ordering or a future missed
call site.

## 4. Verification after remediation

| Command | Re-reviewed head | Now |
|---|---|---|
| `pnpm test` | 380 passed (53 files) | **394 passed (54 files)** |
| `pnpm test:e2e` | 4 passed | 4 passed |
| `pnpm check` | exit 0 | **exit 0** under Node 24.18.0 |

14 tests added, all negative or ordering cases the previous gate did not
exercise:

- `planning-schema.test.ts` — artifact and diagnostic naming a mismatched
  version; a version attached to a failed attempt; retained failure evidence
  with no version still accepted; same-workspace cross-project event
  correlation; correct correlation and no-work-item kinds still accepted; four
  version and attribution mutation cases; and a real admission reporting true
  prior and resulting versions.
- `apps/web/src/App.test.tsx` — a new App-level suite that loads a populated
  workspace A, selects B through the real picker, and holds B's snapshot pending
  or failed.

**The App-level tests were verified to fail against the reviewed defect.**
Reverting `onSelectWorkspace` to the bare `setSelectedWorkspaceId` and removing
the render guard makes all three fail; restoring the fix makes all three pass.
A test for a timing defect that was never observed failing would not be evidence
of anything.

## 5. Operator action unchanged

Migration `0002` is revised again in place, for the same reason as the first
remediation: CT-03 is unmerged and unreleased. **Any local database that ran an
earlier `0002` must be reset** using the procedure in `docs/operations.md`.
Migration `0001` remains untouched, so CT-02-era databases are unaffected.

## 6. Standing items

Unchanged from the previous reports: the artifact retention gap, the 2 MiB
artifact ceiling, the split CT03-A50 evidence, and the two `biome-ignore`
suppressions in `App.tsx`. No acceptance criterion was weakened, and no fixture,
contract, matrix, or source artifact was edited to make a test pass.

## 7. Note on the review record

`review-findings/CT-03/CT-03-remediation-review.md` states the re-review was
left uncommitted. It is committed here alongside this report so the finding
record and its resolution live together in the branch history. Nothing in the
review text was altered.
