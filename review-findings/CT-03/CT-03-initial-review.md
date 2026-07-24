# CT-03 independent review

## Review identity

- Repository: `zed-colonel/craftingtable`
- Accepted CT-02 source baseline: `c8e2396a65466bdde95bf740771af63b4fc2272e`
- Reviewed CT-03 base: `2173d6c9ebc0edf28ab4adfb1775e8a098341e01`
- Reviewed CT-03 head: `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05`
- Base/head merge-base: `2173d6c9ebc0edf28ab4adfb1775e8a098341e01`
- Base-to-head commits: 1
- Base-to-head diff: 132 files, 16,772 insertions, 195 deletions
- Review disposition: **Not accepted — 2 blocking, 2 high, 2 medium, and 2 low findings**

The CT-02 baseline-to-CT-03-base delta contains only staging of the CT-03 work
package and acceptance fixture, including relocation of the completed CT-02
contract material. The implementation review was bound to the exact head above.

## Deterministic verification

| Verification | Result |
| --- | --- |
| `pnpm exec node --version` | `v24.18.0` |
| `pnpm check` | Passed with loopback access: formatting 190 files, lint 191 files, typecheck/build passed, Vitest 52 files and 315 tests passed, Playwright 4 tests passed, forbidden-scope check passed |
| Initial sandbox-only `pnpm check` | 50/52 Vitest files and 305/315 tests passed; all 10 failures were caused by the sandbox denying test loopback listeners with `listen EPERM 127.0.0.1`. The literal gate was rerun with loopback access and passed. |
| `git diff --check 2173d6c9ebc0edf28ab4adfb1775e8a098341e01..b226df5e1fe7931e69a3c9f8306dcf7b8900ba05` | Passed |
| CT-03 AQ fixture checksum manifest | Both fixture files verified |
| Independent AQ YAML count | 14 items, 24 required edges, no missing dependencies, no self-dependencies |
| Independent graph check | Acyclic; 14 of 14 nodes visited; only initial required-edge root is `AQ-01` |

## Findings

```yaml
id: CT03-R1
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: blocking
category: workspace-isolation
path: packages/storage/src/migrations/0002_ct03_planning.sql
line_start: 81
line_end: 94
claim: >-
  The database does not structurally require a project's active plan version to
  belong to that project or even to the same workspace. The
  active_plan_version_id foreign key references only plan_versions(id), allowing
  a cross-workspace active-plan pointer and defeating the accepted structural
  ownership boundary.
evidence: >-
  The projects table declares workspace ownership and a separate foreign key
  from active_plan_version_id to plan_versions(id), but no composite relationship
  joins workspace_id and project_id. A focused database probe successfully
  updated workspace-a/project-a to version-b owned by workspace-b/project-b; the
  normal active-version join then returned Plan b in project-a's row. Similar
  independent foreign keys in work_items, work_contract_drafts, artifacts,
  diagnostics, and event correlations do not prove the related records share the
  expected workspace/project/version chain.
contract_reference: >-
  CT-03 sections 5.5 and 5.6; CT03-A08; CT03-I14; accepted implementation plan
  section 6.4 (structural workspace ownership)
suggested_verification: >-
  Add negative migration/storage tests that attempt cross-workspace and
  cross-project active-plan, work-item, draft, artifact/diagnostic, and event
  relationships. Enforce composite foreign keys or equivalent triggers, including
  a project active-version relationship to (workspace_id, project_id, id).
confidence: high
```

```yaml
id: CT03-R2
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: blocking
category: persistence-immutability
path: packages/storage/src/migrations/0002_ct03_planning.sql
line_start: 234
line_end: 285
claim: >-
  Historical plan contents are mutable because work-item source fields and
  dependency rows have no immutability enforcement. Making plan_versions
  immutable does not make the versioned work graph immutable.
evidence: >-
  work_items and work_item_dependencies are created without update/delete
  protection. A focused probe imported a plan and successfully executed a raw SQL
  update changing an imported work item's title and source_fields_json. Dependency
  rows and isolated work items can likewise be deleted subject only to ordinary
  referential constraints. These changes rewrite the meaning of an already
  imported historical plan version without creating a new version.
contract_reference: >-
  CT-03 section 5.6 (old plan versions and work items remain queryable and
  immutable); CT03-I07; CT03-I08; CT03-A30; CT03-A32; CT03-A33
suggested_verification: >-
  Add database triggers and negative tests that reject source-field updates and
  deletion of historical work items and dependency rows. Permit only the
  narrowly defined atomic Proposed-to-Admitted transition fields on work_items,
  and prove imported source, ownership, version, and graph fields cannot change.
confidence: high
```

```yaml
id: CT03-R3
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: high
category: contract-validation
path: packages/contracts/src/planning.ts
line_start: 192
line_end: 200
claim: >-
  The shared work-contract draft wire schema validates document as z.unknown(),
  so the server/browser boundary does not runtime-validate the incomplete,
  non-executable draft contract it claims to expose.
evidence: >-
  WorkContractDraftSchema accepts any value for document. The server casts its
  stored document through `as never`, while WorkContractDraftPanel defines and
  casts to a separate optional frontend shape. Consequently missing or altered
  schemaVersion, status, completeness, source, objective, dependency,
  missing-field, unresolved-question, and human-merge fields—or arbitrary
  approval/execution-looking fields—can pass the shared contract parser.
contract_reference: >-
  CT-03 sections 5.12 and 5.13; CT03-A58; CT03-I11; accepted strict,
  runtime-validated shared wire-contract boundary
suggested_verification: >-
  Define the complete draft-document Zod schema in @craftingtable/contracts,
  consume its inferred type in server and browser code without casts, and add
  contract tests rejecting missing, mistyped, extra authorization-like, or
  otherwise malformed draft fields.
confidence: high
```

```yaml
id: CT03-R4
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: medium
category: input-validation
path: packages/planning/src/bundle.ts
line_start: 384
line_end: 423
claim: >-
  Required artifact roles are not checked against their required source classes,
  and one such rejection can be reported as failed-validation with no diagnostic.
  The implementation-plan role can contain JSON/YAML, and a JSON work-breakdown
  is parsed as generic JSON rather than rejected as not being the required YAML
  plan source.
evidence: >-
  Bundle parsing dispatches only on the submitted filename extension rather than
  validating role-to-format compatibility. In a focused authenticated HTTP probe,
  an implementation-plan Markdown file plus a work-breakdown JSON file returned
  200 with status failed-validation, an empty diagnostics array, a persisted
  errorCount of 1, and zero persisted diagnostic rows. commitFailure fabricates
  the count with Math.max(errorCount, 1) instead of adding an actionable
  diagnostic.
contract_reference: >-
  CT-03 section 5.1 (one implementation-plan Markdown and one work-breakdown
  YAML); CT03-A13; CT03-A23; CT03-A28
suggested_verification: >-
  Validate each required role's permitted source type before role-specific
  parsing. Add HTTP and persistence tests for swapped/wrong extensions and assert
  that every failed-validation attempt returns and persists at least one bounded,
  actionable error diagnostic.
confidence: high
```

```yaml
id: CT03-R5
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: medium
category: import-attempt-integrity
path: apps/server/src/services/plan-import-service.ts
line_start: 137
line_end: 157
claim: >-
  A syntactically valid but missing or foreign requested project ID causes an
  invalid bundle's failure transaction to violate a foreign key, producing a 500
  and preserving no import attempt. The same requested project is handled as a
  not-found error only when bundle validation succeeds.
evidence: >-
  commitFailure writes requestedProjectId directly into plan_import_attempts
  without resolving it in the authenticated workspace, while the column has a
  project foreign key. A focused authenticated HTTP probe submitted a missing
  work-breakdown with projectId `missing-project`; it returned 500
  `internal-error` and left the import-attempt count at zero. Thus durable failure
  evidence depends on unrelated bundle validity.
contract_reference: >-
  CT-03 section 5.8 (durable import attempts and failure evidence); CT03-A28;
  CT03-A35
suggested_verification: >-
  Resolve any supplied project through the workspace-scoped repository before
  bundle analysis and return the same non-disclosing not-found result regardless
  of bundle validity, or persist the unresolved requested identity in a bounded
  non-FK field if the contract requires an attempt. Test missing and
  cross-workspace project IDs with both valid and invalid bundles.
confidence: high
```

```yaml
id: CT03-R6
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: high
category: browser-isolation
path: apps/web/src/state/workspace-projection.ts
line_start: 118
line_end: 131
claim: >-
  Switching workspaces can retain and then merge the previous workspace's audit
  activity into the newly selected workspace projection. The reducer has no
  workspace identity and preserves events from every ready snapshot.
evidence: >-
  snapshot-received keeps state.events whenever the prior snapshot status is
  ready and advances lastSequence with Math.max, without checking that the old
  and new snapshots belong to the same workspace. App dispatches
  snapshot-requested only from the idle state, so a workspace switch does not
  clear the prior summaries or activity while the new request is pending.
  Project, plan, item, and artifact detail state is also not keyed/reset on route
  workspace identity. Existing reducer coverage proves same-workspace retention
  but has no two-workspace transition test.
contract_reference: >-
  CT03-I14; CT03-A35; CT03-A67; architecture requirement that the browser remain
  an authorized projection rather than a source of cross-workspace state
suggested_verification: >-
  Key projection and detail state by workspace/resource identity and reset it
  before a different workspace or resource is rendered. Preserve last-known-good
  state only within the same identity. Add reducer and component tests switching
  between two populated workspaces and exercising detail-fetch failure.
confidence: high
```

```yaml
id: CT03-R7
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: low
category: source-integrity
path: packages/planning/src/graph.ts
line_start: 98
line_end: 98
claim: >-
  The TypeScript source contains a literal NUL byte in the cycle-deduplication
  key, causing Git and file inspection tools to classify the source as binary and
  omit its textual base-to-head diff.
evidence: >-
  The file has one NUL byte at the cycle.join delimiter on line 98. `file`
  classifies it as data, and Git reports the newly added source as a binary
  0-to-8998-byte change. Compilation and tests pass, but ordinary diff review,
  blame, merge, and text-policy tooling cannot inspect this security-relevant
  graph implementation normally.
contract_reference: >-
  CT03-A38; CT03-A69; repository requirement for cleanly reviewable source and
  exact-diff review
suggested_verification: >-
  Replace the literal byte in source with an escaped delimiter such as `\0` (or a
  printable length-safe key encoding), verify Git emits a textual diff, and add a
  source-integrity check that rejects NUL bytes in tracked text source.
confidence: high
```

```yaml
id: CT03-R8
head_sha: b226df5e1fe7931e69a3c9f8306dcf7b8900ba05
severity: low
category: documentation-integrity
path: implementation-reports/CT-03/CT-03-completion.md
line_start: 34
line_end: 45
claim: >-
  The completion report records the CT-03 base as the implementation head and
  says the work was uncommitted, so its provenance and changed-path count do not
  describe the implementation being reviewed.
evidence: >-
  The report identifies 2173d6c9... as the implementation head, states that
  nothing was committed, and reports 87 changed paths. The supplied and verified
  implementation head is b226df5e..., one commit after that base, with 132
  base-to-head paths.
contract_reference: CT03-A71; CT-03 review handoff and exact-head evidence requirements
suggested_verification: >-
  Update the completion report to identify the exact implementation commit and
  base-to-head statistics, then bind its claimed gate and acceptance evidence to
  that immutable head.
confidence: high
```

## Area verdicts

### AQ fixture and dependency semantics

The accepted fixture checksums verified. Independent parsing observed exactly 14
items and 24 required edges, with no missing dependencies, self-dependencies, or
cycle. `AQ-01` is the only initial required-edge root. Recommended dependencies
are represented separately and do not block planning readiness.

### Migration preservation

Migration `0002` and its tests credibly preserve CT-02 audit/event row identities,
sequences, original indexes, trigger behavior, and invariant constraints while
moving extensible kind registration into catalog tables. The migration
preservation verdict for existing CT-02 audit/event history is **pass**.

The CT-03 planning persistence verdict is nevertheless **fail** because
structural relationship integrity and historical work-graph immutability are not
enforced (CT03-R1 and CT03-R2).

### Security and isolation

Authentication, CSRF/origin checks, workspace-role authorization, bounded
multipart buffering, logical-filename normalization, bounded safe YAML parsing,
non-executable source delivery, React Markdown display, and bounded
audit/diagnostic metadata have credible focused coverage. The overall
security/isolation verdict is **fail** because the storage schema permits
cross-workspace ownership corruption and the browser can mix projections across
workspace switches (CT03-R1 and CT03-R6).

### Notification, snapshots, and recovery

The reviewed daemon event producers notify after transaction commit. Fast-path
SSE tests passed with a 60-second fallback, so their delivery proof does not
depend on the one-second recovery poll. Dropped-notifier fallback, reconnect,
snapshot sequence, and authoritative browser-refetch behavior all have credible
passing coverage. This area’s verdict is **pass**, subject to the browser
workspace-identity defect in CT03-R6.

### Acceptance evidence

Not every acceptance ID has credible passing evidence at the reviewed head.
CT03-A08, CT03-A13/23/28, CT03-A35, CT03-A58, CT03-A67, and CT03-A71 are
contradicted or materially weakened by the findings above. The deterministic
quality gate passing does not exercise the focused negative cases demonstrated
during this review.

### CT-04 readiness

CT-04 should **not** build on this result without first resolving CT03-R1 and
CT03-R2 and revalidating the high-severity contract/browser findings. Proceeding
would require CT-04 to bypass or compensate for CT-03’s promised structural
ownership and immutable-history boundaries rather than safely building on them.
