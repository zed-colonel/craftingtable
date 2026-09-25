# CT-03 second-remediation re-review

## Review identity

- Repository: `zed-colonel/craftingtable`
- CT-03 base: `2173d6c9ebc0edf28ab4adfb1775e8a098341e01`
- Initially reviewed head: `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05`
- First-remediation head: `b8aff843124846f679c183c3bb924e1ef3717090`
- Reviewed second-remediation head: `498f0b7d462b2780dbfce73d618116d6c01e1b58`
- Second-remediation merge-base with the first-remediation head:
  `b8aff843124846f679c183c3bb924e1ef3717090`
- Re-review disposition: **Not accepted — 2 high and 2 medium findings**
- Git disposition: **Not committed or merged**

The second remediation is one clean commit directly atop the first-remediation
head. It also commits the prior re-review record without changing its contents.
The worktree was clean before verification. The condition for committing this
review and merging into `main` was not met.

## Deterministic verification

| Verification | Result |
| --- | --- |
| `pnpm exec node --version` | `v24.18.0` |
| `pnpm check` | Passed: format 192 files, lint 193 files, typecheck/build passed, Vitest 54 files and 394 tests passed, Playwright 4 tests passed, forbidden-scope check passed |
| AQ fixture checksum manifest | Both fixture files verified |
| AQ fixture behavior | 14 items, 24 required edges, only initial planning-ready root `AQ-01` |
| Second-remediation diff check | `git diff --check` passed |
| Intended non-null artifact/version mismatch | Rejected by the database |
| Intended same-workspace project/item mismatch | Rejected by the database |
| Proposed work-item version-only update | Rejected; version remained 1 |
| Orphan artifact with NULL version and missing attempt | **Accepted by the database** |
| Orphan diagnostic with NULL version and missing attempt | **Accepted by the database** |
| Work-item event with NULL project correlation | **Accepted by the database** |

The quality gate remains green because its new tests cover valid NULL evidence,
but do not test whether that evidence still references an existing attempt.

## Prior residual finding dispositions

| Prior finding | Re-review result |
| --- | --- |
| CT03-RR1 evidence coherence | **Partially fixed** — non-null mismatched versions are rejected, but NULL-version evidence bypasses the only attempt foreign key |
| CT03-RR2 controller-version integrity | Fixed |
| CT03-RR3 event correlation | **Partially fixed** — two non-null mismatched correlations are rejected, but a work-item correlation may omit its project |
| CT03-RR4 browser workspace identity | **Partially fixed** — picker-driven projection clearing is fixed, but deep-link and in-flight action paths remain unkeyed |

## Findings

```yaml
id: CT03-R2R1
head_sha: 498f0b7d462b2780dbfce73d618116d6c01e1b58
severity: high
category: persistence-referential-integrity
path: packages/storage/migrations/0002-ct03-planning.sql
line_start: 227
line_end: 262
claim: >-
  Failed-import artifacts and diagnostics no longer have an enforced parent
  attempt. SQLite considers a composite foreign key satisfied when any child-key
  column is NULL; it does not match that NULL to the parent's NULL.
evidence: >-
  The remediation replaced the independent (workspace_id, import_attempt_id)
  foreign key with only the three-column
  (workspace_id, import_attempt_id, plan_version_id) key. Failed-import evidence
  necessarily has plan_version_id NULL, so SQLite skips the entire key. A focused
  probe successfully inserted an artifact and a diagnostic in a real workspace
  with import_attempt_id `missing-attempt` and plan_version_id NULL; both rows
  persisted. The remediation test proves only that valid failure evidence is
  accepted, not that an attempt is still required.
contract_reference: >-
  CT-03 sections 5.5, 5.6, and 5.8; CT03-A08; CT03-A28; CT03-I04; CT03-I14;
  CT03-RR1
suggested_verification: >-
  Retain a two-column foreign key from (workspace_id, import_attempt_id) to the
  attempt in addition to the three-column version-coherence key, or enforce the
  equivalent with a trigger. Add negative tests for a missing attempt, an
  attempt in another workspace, and a NULL-version row attached to a succeeded
  attempt; keep the positive failed-attempt evidence test.
confidence: high
```

```yaml
id: CT03-R2R2
head_sha: 498f0b7d462b2780dbfce73d618116d6c01e1b58
severity: medium
category: event-integrity
path: packages/storage/migrations/0002-ct03-planning.sql
line_start: 527
line_end: 535
claim: >-
  A workspace event can correlate a work item while omitting its project, which
  bypasses the new project-graph foreign key and leaves the durable envelope
  only partially correlated.
evidence: >-
  The three-column event foreign key is skipped whenever project_id is NULL, and
  the remediation removed the prior independent (workspace_id, work_item_id)
  key. A focused probe inserted a work-item-admitted row with a real work_item_id,
  project_id NULL, and a contract-valid work-item-admitted payload; the database
  accepted it. The positive no-work-item test is valid but does not prove the
  inverse rule that a correlated work item requires its project.
contract_reference: >-
  CT-03 section 5.9; accepted implementation plan section 9 (correlation columns
  populated where semantically correct); CT03-A08; CT03-I14; CT03-RR3
suggested_verification: >-
  Preserve an independent workspace/work-item foreign key and add
  `CHECK (work_item_id IS NULL OR project_id IS NOT NULL)` alongside the
  three-column same-project key. Test missing project, missing/foreign work item,
  same-workspace cross-project correlation, a correct work-item event, and every
  event kind that legitimately carries no work item.
confidence: high
```

```yaml
id: CT03-R2R3
head_sha: 498f0b7d462b2780dbfce73d618116d6c01e1b58
severity: high
category: browser-isolation
path: apps/web/src/App.tsx
line_start: 320
line_end: 363
claim: >-
  In-flight artifact, import, and admission requests from the previous workspace
  can repopulate unkeyed view state after selectWorkspace clears it, allowing old
  workspace content or outcomes to render after the new workspace loads.
evidence: >-
  selectWorkspace clears artifact, importResult/importError, and admitError, but
  the promises in handleImport, handleAdmit, and viewArtifact capture the old
  workspace and later call their state setters without checking a workspace
  generation or current identity. importBusy and admitting are not reset either.
  A deferred artifact response from workspace A can therefore resolve after
  switching to B and set artifact; once B's projection is ready, the render guard
  passes for B and renders A's artifact text. A deferred failed import or
  admission error can similarly appear in B. The new App tests leave all three
  planning API promises permanently pending and exercise none of these races,
  despite CT03-RR4's requested artifact/import/detail coverage.
contract_reference: CT03-A35; CT03-A67; CT03-I13; CT03-I14; CT03-RR4
suggested_verification: >-
  Key all asynchronous view results by workspace/resource identity or use a
  selection-generation token/abort signal before every state write and
  navigation. Add App tests that start artifact, failed-import, and admission
  requests in A, switch to and fully load B, then resolve/reject each A request
  and prove no A content, result, error, busy state, or navigation appears in B.
confidence: high
```

```yaml
id: CT03-R2R4
head_sha: 498f0b7d462b2780dbfce73d618116d6c01e1b58
severity: medium
category: browser-routing-isolation
path: apps/web/src/App.tsx
line_start: 134
line_end: 147
claim: >-
  Deep-link and browser-history workspace changes still rely on a post-render
  effect, while the render guard compares the projection only to the old selected
  workspace and not to the workspace named by the route.
evidence: >-
  When the route changes from workspace A to workspace B, the render preceding
  this useEffect still has selectedWorkspaceId A and projection.workspace A, so
  the guard at lines 425-429 passes and can commit A's dashboard/detail content
  under B's URL. selectWorkspace(B) runs only after that commit. The new App tests
  exercise the picker callback, which calls selectWorkspace synchronously, but
  do not exercise a deep link or popstate transition.
contract_reference: >-
  CT-03 section 5.14; CT03-A61; CT03-A67; CT03-I13; CT03-I14; ADR-015; CT03-RR4
suggested_verification: >-
  Include the route's workspace identity in the render guard, or make route and
  selected-workspace identity one atomic state transition. Add an App-level
  popstate/deep-link test that changes from populated A to B while B is pending
  or failed and observes every committed render for absence of A content under
  the B route.
confidence: high
```

## Area verdicts

### AQ fixture and dependency semantics

**Pass.** Checksums verified. The approved fixture evidence remains exactly 14
items, 24 required edges, and only `AQ-01` as the initial planning-ready root.

### Migration preservation

**Pass for CT-02 journal preservation.** Existing audit/event rows, sequences,
indexes, catalogs, and append-only triggers retain credible passing evidence.

**Fail for CT-03 evidence integrity.** CT03-R2R1 permits append-only orphan
evidence, and CT03-R2R2 permits a partially correlated append-only event.

### Security and isolation

Server authorization, CSRF/origin enforcement, bounded input parsing, source
rendering, strict draft validation, and workspace-scoped persistent reads pass
their evidence. Overall browser isolation remains **fail** because unkeyed
asynchronous results and route-driven switching can project old-workspace state
after the visible identity changes.

### Notification and recovery

**Pass.** Post-commit notification, fast delivery independent of fallback,
dropped-notifier recovery, authoritative refetch, and restart behavior were not
regressed.

### Acceptance evidence

Not every acceptance ID has credible passing evidence. CT03-A08, CT03-A28,
CT03-A35, CT03-A61, CT03-A67, and invariants CT03-I04/I13/I14 remain
contradicted or materially weakened by the findings above.

### CT-04 readiness

CT-04 should **not** build on this state. It would otherwise inherit orphanable
failure evidence and browser state that is not consistently bound to its
workspace/resource identity.

## Merge decision

The operator authorized commit and merge only if the second remediation passed
review. It did not. This review record is intentionally left uncommitted on
`ct-03-plan-dashboard`, and `main` remains unchanged.
