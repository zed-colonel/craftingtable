# CT-03 Third Remediation Report

**Work item:** CT-03 — Import plan bundles and render the project/work-item dashboard
**Review addressed:** `review-findings/CT-03/CT-03-remediation-2-review.md`
**Re-reviewed head:** `498f0b7d462b2780dbfce73d618116d6c01e1b58`
**Residual findings:** 2 high, 2 medium — **all 4 resolved**

## 1. Disposition

| ID | Severity | Disposition |
|---|---|---|
| CT03-R2R1 | high | Fixed — failure evidence has an enforced parent attempt again |
| CT03-R2R2 | medium | Fixed — a correlated work item must carry its project |
| CT03-R2R3 | high | Fixed — every asynchronous result is keyed to the workspace that asked for it |
| CT03-R2R4 | medium | Fixed — the render guard is derived from the route, not corrected by an effect |

All four reproduced against the reviewed head before any change was made. None
required pushback: R2R1 and R2R2 were regressions I introduced in the second
remediation, and R2R3/R2R4 were real gaps the second remediation left open.

## 2. Root cause of the two schema findings

The second remediation replaced always-enforced two-column foreign keys with
three-column coherence keys. **SQLite applies MATCH SIMPLE semantics: when any
child column of a composite key is NULL, the entire key is treated as satisfied
and no parent row is looked up.** It does not match a child NULL to a parent
NULL.

Failure evidence always has a NULL `plan_version_id`, and an event legitimately
has a NULL `work_item_id`. So for exactly the rows the constraint existed to
protect, the new key enforced nothing at all. The reviewer's probe was right, and
my second-round tests could not see it because they only asserted that valid
NULL-bearing rows are *accepted*.

That rule is now written down in ADR-002 so the next composite key does not
repeat it.

### CT03-R2R1 — orphan evidence (high)

`plan_artifacts` and `plan_import_diagnostics` now declare **both** keys: the
plain `(workspace_id, import_attempt_id)` key that enforces the parent's
existence in every case, and the three-column key that enforces version
coherence when a version is present.

A foreign key still cannot express "NULL here only if NULL there" — the NULL-skip
rule disables that comparison in precisely that case — so a `BEFORE INSERT`
trigger on each table rejects versionless evidence whose attempt did resolve a
version.

### CT03-R2R2 — partially correlated events (medium)

`workspace_events` regains the independent
`(workspace_id, work_item_id)` key and gains
`CHECK (work_item_id IS NULL OR project_id IS NOT NULL)`. The CHECK is what makes
the three-column same-project key reachable at all: without it, naming a work
item and omitting the project skipped the key entirely.

**The independent work-item key is not falsifiable.** Given the CHECK, a present
`work_item_id` implies a present `project_id`, so the three-column key is always
enforced and is strictly stronger. Removing the two-column key causes no test to
fail — I verified this, rather than assuming otherwise. It is kept because the
reviewer asked for it and because it is the constraint that survives if the CHECK
is ever relaxed, and it is labelled as redundant in the migration so nobody reads
its passing tests as evidence for it.

## 3. Root cause of the two browser findings

### CT03-R2R3 — in-flight results crossing a workspace change (high)

`selectWorkspace` cleared view state, but a request already in flight wrote to
that state afterwards. `handleImport`, `handleAdmit`, and `viewArtifact` now each
capture the workspace they were issued for and check it before every state write
and every navigation; `importBusy` and `admitting` are also reset by the
selection itself.

The check reads `activeWorkspaceIdRef`, assigned **during render** rather than in
an effect, so it is already correct when a promise settles.

### CT03-R2R4 — route-driven switching (medium)

The render guard compared the projection to `selectedWorkspaceId`, which a
`useEffect` updated *after* the route changed. The guard therefore passed for the
previous workspace and committed its dashboard under the new workspace's URL.

The active workspace is now derived during render — the route's workspace when
the user can see it, the selection otherwise — and both the render guard and the
workspace picker read that value. The effect still exists to keep the selection
in sync, but nothing correct depends on when it runs.

## 4. Why the previous round's tests did not catch any of this

This is the third review in which `pnpm check` stayed green over a real defect.
The cause was the same each time and is worth stating plainly: **the new tests
asserted that valid cases are accepted, and treated that as evidence that invalid
cases are rejected.**

Two specific test-construction defects were found and fixed while doing this
round:

1. **`waitFor` cannot assert absence.** `await waitFor(() => expect(x).toBeNull())`
   succeeds on its first check — before the leaked update has been committed —
   so it passes whether or not the leak exists. The three isolation tests now
   flush all pending callbacks, updates, and effects through `act`, then assert
   absence synchronously.
2. **A leaked value needs somewhere to render.** The round's first attempt
   resolved workspace A's requests while standing on B's *dashboard*, where an
   admission error or import outcome has no render site at all. Each test now
   navigates to B's corresponding page first.

Every fix in this round was therefore verified by mutation: the fix is reverted,
and the test must fail.

| Reverted fix | Result |
|---|---|
| Artifact's independent attempt key | 2 tests fail |
| Diagnostic's independent attempt key | 2 tests fail |
| Artifact NULL-version coherence trigger | 1 test fails |
| Diagnostic NULL-version coherence trigger | 1 test fails |
| Event work-item/project CHECK | 1 test fails |
| Event independent work-item key | **no test fails — redundant by construction, see §2** |
| Artifact workspace guard | 1 test fails |
| Admission workspace guard | 1 test fails |
| Import workspace guard | 1 test fails |
| Busy-state reset in the selection | 2 tests fail |
| Render guard reads the selection, not the route | 1 test fails |

The route test needed an instrument that neither `waitFor` nor `act` provides,
because both only expose the settled state. It samples the URL and the committed
DOM once per microtask turn: React commits a state update within one turn but
schedules passive effects on a later macrotask, so per-turn sampling is what
separates "correct by construction" from "corrected by an effect". Measured, with
the fix in place and with it reverted:

```text
fixed    turn 0: url=b alpha=1   (read before React had any turn to respond)
         turn 1: url=b alpha=0 loading=1
mutated  turn 0: url=b alpha=1
         turn 1: url=b alpha=1
         ...
         turn 6: url=b alpha=1   (workspace A still rendered under B's URL)
```

Turn 0 is recorded but never asserted on: every implementation looks identical
there.

## 5. Verification after remediation

| Command | Re-reviewed head | Now |
|---|---|---|
| `pnpm test` | 394 passed (54 files) | **407 passed (54 files)** |
| `pnpm test:e2e` | 4 passed | 4 passed |
| `pnpm check` | exit 0 | **exit 0** under Node 24.18.0 |

13 tests added, every one of them a negative or ordering case:

- `planning-schema.test.ts` — seven cases under a new
  `referential integrity where a column is NULL` block: versionless artifact and
  diagnostic evidence with a nonexistent attempt; versionless evidence borrowed
  from another workspace's attempt; versionless evidence on an attempt that did
  resolve a version; an event naming a work item without its project; an event
  naming another workspace's work item; and an event correlating neither, which
  must still be accepted.
- `App.test.tsx` — the three in-flight isolation cases and the deep-link
  per-turn sampling case, plus the busy-state and navigation assertions.

No fixture, contract, matrix, or source artifact was edited to make a test pass.
No acceptance criterion was weakened.

## 6. Documentation

- **ADR-002** now states the MATCH SIMPLE NULL-skip rule and the two consequences
  CT-03 depends on, plus the requirement to label any constraint kept for defence
  in depth that is strictly weaker than another.
- **ADR-015** now records that the render guard is derived from the route rather
  than the selection, and that asynchronous results are keyed to the workspace
  that issued them.

## 7. Operator action unchanged

Migration `0002` is revised in place for the third time, for the same reason:
CT-03 is unmerged and unreleased. **Any local database that ran an earlier `0002`
must be reset** using the procedure in `docs/operations.md`. Migration `0001` is
untouched, so CT-02-era databases are unaffected.

## 8. Standing items

Unchanged: the artifact retention gap, the 2 MiB artifact ceiling, the split
CT03-A50 evidence, and the two `biome-ignore` suppressions in `App.tsx`.
