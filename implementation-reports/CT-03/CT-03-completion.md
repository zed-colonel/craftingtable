# CT-03 Completion Report

**Work item:** CT-03 — Import plan bundles and render the project/work-item dashboard
**Binding contract:** `work-items/CT-03/CT-03.md`
**Accepted plan:** `work-items/CT-03/CT-03-accepted-implementation-plan.md`
**Reviewed head:** `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05`
**Status at that head:** the deterministic gate passed, but independent review
returned 2 blocking, 2 high, 2 medium, and 2 low findings and did **not** accept
the result. See `review-findings/CT-03/CT-03-initial-review.md` and the
remediation report for the resolved state.

## 1. Summary

CraftingTable can now ingest the real AQ-CONT-1 planning bundle over an
authenticated multipart request, preserve its exact source bytes, validate its
work graph in a pure package, commit the whole result as one atomic SQLite
transaction, project it into a browser dashboard, and let an operator admit a
proposed work item into a deliberately non-executable draft contract.

The path the contract asked for is now real and tested end to end:

```text
untrusted planning input
  → pure validation and diagnosis
  → one atomic durable import
  → authorized visual projection
  → explicit human admission
  → non-executable draft
```

CT-02's foundation was extended, not bypassed. Schema version 2 rebuilds both
journals exactly once so their vocabularies become migration-owned catalogs,
preserving every CT-02 row, both global sequences, and the append-only triggers.
The CT-02 review's one binding forward obligation — post-commit notifier use,
proven independently of the fallback poll — is satisfied and tested for both new
daemon commands.

## 2. Commits

| Role | SHA |
|---|---|
| Accepted source baseline | `c8e2396a65466bdde95bf740771af63b4fc2272e` |
| CT-03 base (Phase A inspection head) | `2173d6c9ebc0edf28ab4adfb1775e8a098341e01` |
| First implementation commit (reviewed head) | `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05` |

Base-to-head at the reviewed head: 1 commit, 132 files, 16,772 insertions,
195 deletions. HEAD descends from the accepted baseline and no CT-01 or CT-02
history was rewritten or discarded.

An earlier revision of this section named `2173d6c` as the implementation head
and stated the work was uncommitted, because it was written before the operator
authorized the commit and was not updated afterwards. That was corrected in
remediation (CT03-R8); see
`implementation-reports/CT-03/CT-03-remediation.md` for the remediated head and
its evidence.

## 3. Final file tree (added and materially changed)

### Added

```text
packages/planning/                          new pure package
  package.json · tsconfig.json
  src/{index,limits,diagnostics,exo-work-breakdown-schema,parse,normalize,
       graph,digest,bundle,work-contract-draft,test-support}.ts
  src/{parse,normalize,graph,digest,bundle,work-contract-draft,aq-fixture}.test.ts

packages/domain/src/{planning,work-contract}.ts
packages/contracts/src/planning.ts
packages/storage/migrations/0002-ct03-planning.sql
packages/storage/src/planning-types.ts
packages/storage/src/planning-test-support.ts
packages/storage/src/repositories/planning/{index,rows}.ts
packages/storage/src/{migration-0002,planning-schema,planning-repositories,
                      planning-transactions}.test.ts

apps/server/src/routes/{planning,multipart,request-security}.ts
apps/server/src/services/{plan-import-service,planning-query-service,
                          work-item-service}.ts
apps/server/src/multipart-test-support.ts
apps/server/src/{server-plan-import,server-planning-queries,
                 server-planning-events,route-inventory}.test.ts

apps/web/src/lib/{route,use-route,planning-api,planning-labels,plan-limits}.ts
apps/web/src/lib/route.test.ts
apps/web/src/features/planning/{ProjectPage,PlanVersionPage,WorkItemPage,
  ImportPlanPage,WorkContractDraftPanel,WorkItemTable,ProjectCards,
  DiagnosticList,SourceText}.tsx
apps/web/src/features/planning/planning-views.test.tsx

e2e/planning.spec.ts
fixtures/plan-bundles/invalid/ (16 small fixtures)
docs/decisions/ADR-011 … ADR-015
work-items/CT-03/CT-03-accepted-implementation-plan.md
implementation-reports/CT-03/CT-03-completion.md
```

### Materially changed

```text
packages/domain/src/{ids,audit,workspace-events,index}.ts
packages/contracts/src/{ids,snapshot,workspace-event,index}.ts
packages/storage/src/{types,storage}.ts, repositories/workspace-events.ts
apps/server/src/{composition,server,config,test-support}.ts, routes/auth.ts,
  services/workspace-service.ts
apps/web/src/App.tsx, components/{StatusRegions,ActivityPanel,WorkspaceShell}.tsx,
  lib/{api-client,workspace-projection}.ts, styles/global.css
scripts/check-forbidden-scope.mjs (+ its test)
tsconfig.json · vitest.config.ts · apps/{server,web}/package.json
docs/{architecture,security,operations,ui-principles}.md
docs/decisions/{ADR-002,ADR-003,ADR-008,README}.md · README.md · CLAUDE.md
work-items/CT-03/CT-03-acceptance-matrix.yaml (stale expectations path only)
Regression updates for schema 2: packages/storage/src/migrations.test.ts,
  apps/server/src/{restart,cli}.test.ts
```

Nothing was deleted. `migrations/0001-ct02-foundation.sql` is byte-identical, so
its recorded checksum and every existing database still validate.

## 4. Schema, migration, and journal vocabulary

Schema version **2**, migration `ct03-planning`.

Journal vocabularies became migration-owned catalogs (`audit_action_kinds`,
`workspace_event_kinds`) with journal foreign keys into them. Both catalogs
carry no-update and no-delete triggers while permitting `INSERT`, so a future
migration registers a kind with one statement and no further table rebuild.

Inspection found a constraint the CT-03 package did not anticipate:
`workspace_events.payload_json` also carried a CHECK hard-coded to the
`workspace-created` payload shape, so **no** new event kind was representable
without rebuilding that table. The rebuild was therefore mandatory, not merely
preferable. It now reads `json_valid AND json_type = 'object'`, with strict
per-kind payload validation remaining in Zod.

Each journal was rebuilt once: drop triggers → rename → create with catalog
foreign keys → copy every column including `sequence` → guard row whose
`CHECK (ok = 1)` aborts the migration on any count or maximum-sequence
mismatch → drop the old table → recreate indexes → recreate triggers.

Nine planning tables were added with structural workspace ownership: every table
carries `workspace_id`, and each child uses a composite foreign key into its
parent's `(workspace_id, id)`, so a row cannot attach to a parent in another
workspace. `plan_versions`, `plan_artifacts`, and `work_contract_drafts` are
immutable by trigger. Every foreign key is `RESTRICT`; there is no deletion path.

Vocabulary introduced:

```text
audit actions   plan.import.succeeded · plan.import.failed
                plan.import.duplicate · work-item.admitted
                work-contract-draft.created
event kinds     project-created · plan-version-imported · work-item-admitted
```

## 5. Accepted decisions

- **Import transport** is authenticated multipart; the multipart **field name is
  the artifact role**, so a role is never inferred from a filename or prose.
- **Canonical bundle digest v1** is a length-prefixed, byte-ordered encoding
  over role, filename, media type, and exact bytes under a domain separator. It
  excludes part order, timestamps, temporary names, and generated identifiers by
  construction. Canonical media type is derived from the validated extension, so
  a browser labelling `.yaml` as `application/octet-stream` still produces the
  same identity.
- **All three import outcomes return HTTP 200.** Each is a recorded, durable
  result of a valid request; 4xx stays reserved for transport and authorization
  faults, which record no attempt.
- **Repeated required edges are deduplicated with a warning** — the behaviour
  CT-03 §5.4 required Phase A to choose. This keeps `requiredDependencyCount`
  equal to the distinct-edge count the schema and the AQ expectations demand.
- **An unrecognised risk word never fails an import**: it normalises to
  `unspecified` with a warning and the raw value survives in `sourceFields`.
- **Any YAML parser error *or warning* is fatal**, because unresolved and
  unknown tags surface as warnings and a tag we do not understand is exactly
  where guessing would be unsafe.
- **`node:crypto` is permitted in the pure planning package**; hashing is
  computation, not I/O. Everything filesystem-, process-, socket-, database-,
  and UI-shaped is refused, and `check:scope` enforces it.
- **Validation is hand-written rather than Zod-based** inside the planning
  package, because CT-03 needs field-precise diagnostic codes. `contracts`
  remains the sole owner of Zod wire schemas.
- **No routing library.** Four static route shapes are handled by a pure
  `parseRoute`/`buildPath` pair plus a small `pushState` hook (ADR-015).
- **`statusSummary` keys renamed** `ready → planningReady`,
  `blocked → dependencyBlocked`, per operator-approved question Q3.
- **Explicit `projectId` import field** added, per operator-approved question Q4,
  because §5.13's route list otherwise could not target an existing project for
  a changed-version import.

## 6. Deliberately deferred

Plan version activation and comparison; Planning Studio editing and
model-assisted planning; a general content-addressed artifact store; dependency
graph visualisation; cross-project and cross-repository dependencies; repository
binding and base revisions; work-contract approval, editing, or execution;
diagnostic and artifact **retention policy** (failed-import artifacts persist
indefinitely today — recorded in `docs/security.md` and `docs/operations.md`);
external dependency references in `depends_on`; import-attempt cleanup; and a
browser YAML preview of the draft, which would require shipping a YAML
serialiser for cosmetic benefit where §5.12 says "may".

## 7. Introduced surface

**Routes** (the complete registered table is asserted by `route-inventory.test.ts`):

```text
POST /api/workspaces/:workspaceId/plan-imports                                     Owner|Editor
GET  /api/workspaces/:workspaceId/plan-imports                                     member
GET  /api/workspaces/:workspaceId/projects                                         member
GET  /api/workspaces/:workspaceId/projects/:projectId                              member
GET  /api/workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId  member
GET  /api/workspaces/:workspaceId/work-items/:workItemId                           member
POST /api/workspaces/:workspaceId/work-items/:workItemId/admit                     Owner|Editor
GET  /api/workspaces/:workspaceId/plan-artifacts/:artifactId                       member
```

**Domain:** `Project`, `PlanBundle`, `PlanVersion`, `PlanImportAttempt`,
`PlanArtifact`, `PlanImportDiagnostic`, `WorkItem`, `WorkItemDependency`,
`WorkContractDraft`, `WorkContractDraftDocument`, plus seven branded IDs and the
status/risk/role/outcome/severity vocabularies.

**Commands:** `pnpm check` is unchanged. `check:scope` now additionally fails on
real-Git, process-execution, or vendor-agent-SDK imports in production source; on
a production import of the `agents`/`git`/`testing` seams; and on any filesystem,
process, socket, database, or UI import inside `@craftingtable/planning`.

## 8. Exact AQ-CONT-1 fixture result

Verified independently before implementation and asserted at run time against
`work-items/CT-03/CT-03-aq-import-expectations.yaml` (loaded, never inlined):

```text
project                    ActionQueue — AQ-CONT-1
work items                 14   (AQ-01 … AQ-14, in source order)
required dependency edges  24
root / planning-ready      AQ-01 only; the other 13 are dependency-blocked
risk counts                medium 1 · high 7 · critical 6
maximum fan-in             8 (AQ-12)
fatal diagnostics          none
artifact bytes             unchanged; per-artifact SHA-256 identical
checksum manifest          verified against the submitted bytes
```

Every recognised top-level and work-item field is preserved, and uninterpreted
fields (`clean_break`, `release_order`, `forbidden_release_symbols`) survive
verbatim in the version's normalized source.

## 9. Commands run

| Command | Result |
|---|---|
| `git cat-file -t c8e2396…` / `git merge-base --is-ancestor` | baseline exists; HEAD descends from it |
| `pnpm install` | clean |
| `pnpm --filter @craftingtable/server add @fastify/multipart@10.1.0` | added |
| `pnpm --filter @craftingtable/web add -D jsdom @testing-library/react @testing-library/dom` | added |
| `pnpm format:check` | pass — 190 files |
| `pnpm lint` | pass — 191 files |
| `pnpm typecheck` | pass |
| `pnpm build` | pass |
| `pnpm test` | **315 passed (52 files)** at the reviewed head |
| `pnpm test:e2e` | **4 passed** |
| `pnpm check:scope` | pass |
| **`pnpm check`** | **exit 0**, under pnpm-managed Node **24.18.0** |

Baseline for comparison: CT-02 had 103 tests in 35 files and 1 E2E test.

## 10. Acceptance evidence

| ID | Evidence |
|---|---|
| A01 | `packages/storage/src/migration-0002.test.ts` — real schema-1 file seeded through CT-02 repositories; every row, ID, and sequence compared before/after |
| A02 | `migration-0002.test.ts` (checksum row, idempotent reopen) + `packages/storage/src/migrations.test.ts` |
| A03 | `migration-0002.test.ts` — catalogs compared exactly against `AUDIT_ACTIONS` / `WORKSPACE_EVENT_KINDS` |
| A04 | `migration-0002.test.ts` — unregistered action and kind both rejected by foreign key |
| A05 | `migration-0002.test.ts` — update/delete rejected on both journals after migration |
| A06 | `migration-0002.test.ts` — next event and audit rows receive greater sequences |
| A07 | `migration-0002.test.ts` — a new kind registered and used; journal DDL byte-identical afterwards |
| A08 | `packages/storage/src/planning-schema.test.ts` — introspection of all nine tables + negative FK cases |
| A09–A12 | `packages/planning/src/aq-fixture.test.ts` (9 cases, asserted against the expectation file) |
| A13 | `packages/planning/src/bundle.test.ts`; `apps/server/src/server-plan-import.test.ts` |
| A14, A24 | `packages/planning/src/parse.test.ts` (12 cases: malformed, unknown tag, alias bomb, `__proto__`, multi-doc, depth, node count) |
| A15, A16 | `packages/planning/src/normalize.test.ts` |
| A17–A20 | `packages/planning/src/graph.test.ts` (missing, self, 2-node and 4-node cycles, permutation determinism, recommended warning, duplicate-edge dedup) |
| A21, A22 | `packages/planning/src/digest.test.ts` (all 6 part-order permutations; role/filename/media-type/each-byte sensitivity; injectivity) |
| A23 | `bundle.test.ts` + `server-plan-import.test.ts` (filenames, media types, duplicates, oversize, counts, totals) |
| A25, A27 | `packages/storage/src/planning-transactions.test.ts` — success plus **12 table-driven fault-injection stages** |
| A26, A31 | `planning-repositories.test.ts`; `server-plan-import.test.ts` |
| A28 | `server-plan-import.test.ts` + `planning-transactions.test.ts` |
| A29, A30 | `server-plan-import.test.ts` (duplicate with reversed part order; changed bundle → v2, active unchanged) |
| A32 | `planning-repositories.test.ts`; `server-planning-queries.test.ts` |
| A33, A34 | `planning-schema.test.ts` |
| A35 | `planning-repositories.test.ts`; `server-planning-queries.test.ts` (two workspaces, identical 404s) |
| A36, A37 | `server-planning-queries.test.ts` (Viewer refused at the service layer; Editor permitted) |
| A38 | `server-plan-import.test.ts` + `server-planning-queries.test.ts` (missing/wrong CSRF, cross-origin, cross-site, unauthenticated, revoked) |
| A39, A40 | `server-planning-queries.test.ts` — parent-joined ownership; exact response headers |
| A41 | `server-plan-import.test.ts` + `route-inventory.test.ts` |
| A42 | `server-plan-import.test.ts` — audit metadata key allowlist, size bound, and log capture |
| A43, A44 | `server-plan-import.test.ts`; `server-planning-events.test.ts` |
| **A45** | `server-planning-events.test.ts` — real port, fallback poll **60 s**, import event observed in ≪ 6 s |
| **A46** | `server-planning-events.test.ts` — same for `work-item-admitted` |
| A47 | `server-planning-events.test.ts` — notifier suppressed; durable re-query still delivers |
| A48 | `server-planning-queries.test.ts` — snapshot counts and `asOfSequence` from one read transaction |
| A49 | `server-planning-events.test.ts` — both race orderings, no gap and no duplicate |
| A50 | **Split, per approved question Q2:** daemon restart by `apps/server/src/restart.test.ts` (real close/reopen carrying plan, admission, draft, audit, and event state); browser refresh by `e2e/planning.spec.ts` |
| A51, A52 | `server-planning-queries.test.ts`; `aq-fixture.test.ts`; `planning-repositories.test.ts` |
| A53, A54 | `server-planning-queries.test.ts`; `server-planning-events.test.ts`; `planning-repositories.test.ts` |
| A55 | `server-planning-queries.test.ts` (AQ-14 admitted while blocked, blockers still reported); `planning-views.test.tsx` |
| A56 | `planning-transactions.test.ts` (rollback) + `server-planning-queries.test.ts` (success) |
| A57, A58 | `packages/planning/src/work-contract-draft.test.ts`; `server-planning-queries.test.ts`; `planning-views.test.tsx` |
| A59 | `apps/server/src/route-inventory.test.ts` — exact allowlist + forbidden-fragment scan |
| A60, A62, A63, A64, A65 | `apps/web/src/features/planning/planning-views.test.tsx` (9 cases) + `e2e/planning.spec.ts` |
| A61 | `e2e/planning.spec.ts` — real AQ fixture: 14 items, risk counts, versions, artifacts, 1 ready / 13 blocked |
| A66, A67 | `apps/web/src/lib/workspace-projection.test.ts` |
| A68 | Full suite green, including every CT-01/CT-02 regression |
| A69 | `pnpm check` exit 0 under Node 24.18.0 |
| A70 | Extended `scripts/check-forbidden-scope.mjs` + 13 tests in its suite |
| A71 | This report + updated architecture, security, operations, UI principles, ADR-002/003/008, ADR-011–015, README, CLAUDE.md |

## 11. Changed files by purpose

- **Pure planning:** `packages/planning/**`, `packages/domain/src/{planning,work-contract}.ts`
- **Wire contracts:** `packages/contracts/src/{planning,snapshot,workspace-event,ids}.ts`
- **Persistence:** `migrations/0002-ct03-planning.sql`, `packages/storage/src/{planning-types,types,storage}.ts`, `repositories/planning/**`, `repositories/workspace-events.ts`
- **Daemon:** `apps/server/src/routes/{planning,multipart,request-security}.ts`, `services/{plan-import,planning-query,work-item,workspace}-service.ts`, `composition.ts`, `server.ts`
- **Browser:** `apps/web/src/features/planning/**`, `lib/{route,use-route,planning-api,planning-labels,plan-limits}.ts`, `App.tsx`, `components/**`, `styles/global.css`
- **Guards:** `scripts/check-forbidden-scope.mjs`, `apps/server/src/route-inventory.test.ts`
- **Fixtures:** `fixtures/plan-bundles/invalid/**`
- **Documentation:** `docs/**`, `README.md`, `CLAUDE.md`, `work-items/CT-03/**`, this report

## 12. Unresolved risks and operator actions

1. **Failed-import retention.** Bounded source bytes from failed validation
   attempts persist indefinitely; there is no retention or deletion feature.
   Recorded in `docs/security.md` and `docs/operations.md`. A future work item
   should decide a policy.
2. **Artifact size ceiling.** Planning artifacts are SQLite BLOBs capped at
   2 MiB each. A larger future bundle should force the general artifact-store
   decision rather than a quiet limit increase.
3. **A50 evidence is split**, exactly as approved in question Q2: daemon restart
   is proved by a real-file close/reopen at the runtime level, browser refresh by
   Playwright. No Playwright-driven daemon restart exists.
4. **Two `biome-ignore` suppressions** in `App.tsx` mark `refreshToken` as a
   deliberate refetch trigger rather than a read dependency. A reviewer should
   confirm the pattern is acceptable.
5. **Nothing is committed.** The operator must authorize a commit and any merge.
6. **The 1000 ms SSE fallback interval** remains a CT-02 scaling caveat,
   unchanged and still documented in ADR-003.

## 13. Criterion statement

*Superseded by review.* At the reviewed head the deterministic gate passed, but
the independent review demonstrated focused negative cases the gate did not
exercise, contradicting CT03-A08, A13/23/28, A35, A58, A67, and A71. The
statement below describes the exit gate as tested at that head; the remediated
position is recorded in `CT-03-remediation.md`.

**Every CT-03 exit-gate criterion passes.** The exact AQ-CONT-1 fixture imports
without losing source fields; AQ-01 through AQ-14 appear in one immutable plan
version with all 24 required edges; AQ-01 is the only initially planning-ready
item; risk, dependency, blocker, and status summaries are correct; an
authenticated operator can inspect project, plan, and work-item pages; AQ-01 can
be admitted; admission creates one clearly incomplete, non-executable draft;
import and admission reach connected SSE clients through post-commit
notification without waiting for fallback polling; refresh and daemon restart
preserve state; a duplicate import duplicates nothing; a changed import creates a
distinct immutable version without changing the active one; invalid IDs, missing
dependencies, self-dependencies, duplicate IDs, and cycles fail with actionable
persisted diagnostics; failed imports produce no partial state; all CT-01 and
CT-02 regressions remain green; and the literal root `pnpm check` passes under
the pinned runtime.

No criterion was weakened, and no fixture, contract, matrix, or source artifact
was edited to make a test pass. The only change to a CT-03 package file is a
stale path in the acceptance matrix's `expectations:` pointer.

## 14. Proposed independent review focus

1. **Migration 0002.** Does the rebuild preserve every CT-02 guarantee — rows,
   both global sequences, append-only triggers, indexes, foreign keys — and is
   the in-migration guard actually able to fail the migration?
2. **Digest determinism.** Can two distinct bundles collide, or one bundle
   produce two digests across clients?
3. **Failed-import atomicity.** Can any path leave a partial project, version,
   work item, edge, draft, or workspace event?
4. **Duplicate idempotency**, including under concurrent importers, given that
   `BEGIN IMMEDIATE` is the serialisation argument.
5. **YAML safety bounds** — alias, depth, node count, prototype keys, unresolved
   tags — and whether any hostile input escapes them.
6. **Workspace isolation** of artifacts, diagnostics, work items, and drafts,
   including the parent-join artifact lookup.
7. **Service-layer role checks**: is any mutation reachable without them?
8. **Post-commit notifier use** in both new commands, and whether the fast-path
   tests genuinely exclude the fallback poll.
9. **Draft non-executability**: can any field, route, or control be read as
   authorization?
10. **Scope**: did any CT-04+ capability enter by convenience, and are the
    route-inventory and `check:scope` guards actually load-bearing?
11. **Browser honesty**: are the planning-readiness labels accurate, and is all
    source text genuinely escaped?
12. **The two `biome-ignore` suppressions** and the split A50 evidence.
