# CT-03 remediation re-review

## Review identity

- Repository: `zed-colonel/craftingtable`
- CT-03 base: `2173d6c9ebc0edf28ab4adfb1775e8a098341e01`
- Initially reviewed head: `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05`
- Reviewed remediation head: `b8aff843124846f679c183c3bb924e1ef3717090`
- Remediation merge-base with the initially reviewed head:
  `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05`
- Re-review disposition: **Not accepted — 3 high and 1 medium residual findings**
- Git disposition: **Not committed or merged**

The remediation is one commit directly atop the initially reviewed CT-03 head.
The worktree was clean before verification. The condition for merging into
`main` was not met.

## Deterministic verification

| Verification | Result |
| --- | --- |
| `pnpm exec node --version` | `v24.18.0` |
| `pnpm check` | Passed: format 191 files, lint 192 files, typecheck/build passed, Vitest 53 files and 380 tests passed, Playwright 4 tests passed, forbidden-scope check passed |
| AQ fixture checksum manifest | Both files verified |
| AQ fixture behavior | 14 items, 24 required edges, only initial planning-ready root `AQ-01` |
| Remediation diff check | `git diff --check` passed |
| `packages/planning/src/graph.ts` | Classified as UTF-8 JavaScript source; repository NUL-byte guard passed |
| Focused database probe | Four invalid states below were accepted |

The green deterministic gate does not cover the residual negative cases found
by the focused probe.

## Original finding dispositions

| Original finding | Re-review result |
| --- | --- |
| CT03-R1 structural ownership | **Partially fixed** — cross-workspace active-plan and direct parent ownership checks are fixed, but artifact/diagnostic attempt-version coherence and project/work-item event coherence remain unenforced |
| CT03-R2 historical immutability | **Partially fixed** — source fields, edges, and deletes are protected, but a proposed work item's controller version remains freely mutable |
| CT03-R3 strict draft contract | Fixed |
| CT03-R4 role/format diagnostics | Fixed |
| CT03-R5 requested-project failure path | Fixed |
| CT03-R6 browser workspace identity | **Partially fixed** — reducer identity is fixed, but `App` clears the previous workspace only in a post-render effect |
| CT03-R7 source NUL byte | Fixed |
| CT03-R8 completion-report provenance | Fixed |

## Residual findings

```yaml
id: CT03-RR1
head_sha: b8aff843124846f679c183c3bb924e1ef3717090
severity: high
category: persistence-referential-integrity
path: packages/storage/migrations/0002-ct03-planning.sql
line_start: 204
line_end: 256
claim: >-
  An artifact or diagnostic can name one import attempt while naming a different
  plan version from the same workspace. The remediation therefore does not close
  the attempt-to-version relationship chain claimed in its report.
evidence: >-
  plan_artifacts and plan_import_diagnostics each have one foreign key for
  (workspace_id, import_attempt_id) and an independent foreign key for
  (workspace_id, plan_version_id). Neither requires plan_version_id to equal the
  referenced attempt's plan_version_id. A focused probe created two projects and
  versions in one workspace, inserted a succeeded attempt for version A, then
  successfully inserted both an artifact and a diagnostic for that attempt with
  version B. listForVersion subsequently treats such rows as version B evidence,
  while listForAttempt treats them as attempt A evidence.
contract_reference: >-
  CT-03 sections 5.5, 5.6, and 5.8; CT03-A08; CT03-I14; CT03-R1 suggested
  verification requiring artifact/diagnostic relationship tests
suggested_verification: >-
  Give plan_import_attempts a candidate key including workspace_id, id, and
  plan_version_id, then reference that exact tuple from artifacts and
  diagnostics (nullable plan_version_id continues to support failed attempts).
  Add negative tests for same-workspace cross-project/cross-version rows and for
  attaching a non-null version to a failed attempt.
confidence: high
```

```yaml
id: CT03-RR2
head_sha: b8aff843124846f679c183c3bb924e1ef3717090
severity: high
category: persistence-immutability
path: packages/storage/migrations/0002-ct03-planning.sql
line_start: 316
line_end: 354
claim: >-
  A proposed work item's version can be changed without admission, so the
  remediation still permits work-item mutation outside the single atomic
  proposed-to-admitted transition.
evidence: >-
  work_items_source_immutable omits version. work_items_admission_only runs only
  on UPDATE OF status, and work_items_admission_final runs only when the old row
  is admitted. A focused probe executed
  `UPDATE work_items SET version = version + 40` on a proposed item; the database
  accepted it and changed version from 1 to 41. A later legitimate admission
  would consequently report and persist fabricated prior/resulting versions.
contract_reference: >-
  CT-03 section 5.6; CT03-A33; CT03-A54; CT03-I10; CT03-R2 suggested
  verification permitting only the atomic admission fields/version change
suggested_verification: >-
  Enforce that any version change is part of the one valid proposed-to-admitted
  transition, and otherwise reject it. Add raw-SQL negative tests for version-only
  changes and for every admission attribution field outside that transition.
confidence: high
```

```yaml
id: CT03-RR3
head_sha: b8aff843124846f679c183c3bb924e1ef3717090
severity: medium
category: event-integrity
path: packages/storage/migrations/0002-ct03-planning.sql
line_start: 510
line_end: 530
claim: >-
  A workspace event can correlate a project from one project graph with a work
  item from another project graph in the same workspace.
evidence: >-
  workspace_events independently references (workspace_id, project_id) and
  (workspace_id, work_item_id); no relationship proves that the work item belongs
  to the correlated project. A focused probe inserted a work-item-admitted event
  with project A and a work item from project B in the same workspace, and the
  database accepted it. The new test covers only a project from another
  workspace, not this same-workspace mismatch.
contract_reference: >-
  CT-03 section 5.9; CT03-A08; CT03-I14; CT03-R1 suggested verification requiring
  event-correlation relationship tests
suggested_verification: >-
  Add a candidate work-item key containing workspace_id, project_id, and id and
  reference it from the event correlation tuple when both project_id and
  work_item_id are present. Add a negative same-workspace cross-project event
  test and a positive test for event kinds without a work item.
confidence: high
```

```yaml
id: CT03-RR4
head_sha: b8aff843124846f679c183c3bb924e1ef3717090
severity: high
category: browser-isolation
path: apps/web/src/App.tsx
line_start: 81
line_end: 100
claim: >-
  Workspace switching still commits a render with the newly selected workspace
  and the previous workspace's projection because clearing occurs in useEffect
  after rendering rather than in the selection transition.
evidence: >-
  onSelectWorkspace changes selectedWorkspaceId and navigates to the new
  workspace dashboard at lines 382-385 without dispatching workspace-changed.
  The only projection/detail/audit reset is the useEffect at lines 85-100. React
  effects run after the render has committed, so that render can show workspace
  A summaries, projects, activity, and audit while WorkspaceShell already marks
  workspace B selected. Reducer tests prove the reset action itself but no App
  component test exercises the actual two-workspace selection path requested by
  CT03-R6.
contract_reference: >-
  CT03-A35; CT03-A67; CT03-I14; CT03-R6 suggested two-workspace component test
suggested_verification: >-
  Clear or key the projection and all workspace-owned view state synchronously
  in the workspace-selection transition before changing the rendered workspace
  identity. Add an App-level test that loads populated workspace A, selects B,
  holds B's requests pending or failed, and proves no A project, activity, audit,
  artifact, import, or detail content is ever rendered under B.
confidence: high
```

## Area verdicts

### AQ fixture and dependency semantics

**Pass.** Checksums verified and the approved tests observed exactly 14 items,
24 required edges, and only `AQ-01` as the initial planning-ready root.

### Migration preservation

**Pass for CT-02 journal preservation.** Existing audit/event rows, sequences,
catalog extensibility, indexes, and append-only behavior retain credible passing
evidence.

**Fail for the remediated CT-03 planning schema.** CT03-RR1, CT03-RR2, and
CT03-RR3 leave relationship integrity and the promised admission-only mutation
rule incomplete.

### Security and isolation

Server authorization, CSRF/origin enforcement, multipart/YAML controls, source
rendering, workspace-scoped reads, and the new strict draft contract pass their
focused evidence. The overall isolation verdict remains **fail** because
CT03-RR4 can render one workspace's projection under another workspace's
selected identity.

### Notification and recovery

**Pass.** The remediation did not regress post-commit notification, fast
delivery independent of the fallback, dropped-notifier recovery, snapshot
sequence behavior, or authoritative refetch.

### Acceptance evidence

Not every acceptance ID has credible passing evidence. CT03-A08, CT03-A33,
CT03-A35, CT03-A54, CT03-A67, and invariants CT03-I10/I14 remain contradicted or
materially weakened by the residual findings.

### CT-04 readiness

CT-04 should **not** build on or bypass this state. The remaining high findings
affect structural evidence attribution, controller-version integrity, and
workspace projection isolation—the exact CT-03 boundaries CT-04 must be able to
trust.

## Merge decision

The operator authorized a commit and merge only if the remediation checked out.
It did not. This review record is intentionally left uncommitted on
`ct-03-plan-dashboard`, and `main` remains unchanged.
