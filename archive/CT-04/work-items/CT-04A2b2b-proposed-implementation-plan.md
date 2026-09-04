# CT-04A2b2b proposed implementation plan

**Status:** Phase A proposal only; not accepted and not implementation authorization
**Slice:** CT-04A2b2b — Registration, inspection, and environmental reaffirmation lifecycle
**Risk:** Critical
**Prepared from live checkout:** `d1c7fcf5be88a579b4fb0693baf658e057b1d8b6`

This is the only Phase A deliverable. It does not authorize source edits. An independent design review, operator disposition, reconciled accepted plan, operator approval, and a separately committed planning package must precede implementation.

## 1. Checkout and source-pin attestation

The live branch is `ct-04a-git-foundation`. At planning time it is clean, is one local commit ahead of `origin/ct-04a-git-foundation`, and has this exact ancestry:

```text
d1c7fcf5be88a579b4fb0693baf658e057b1d8b6  CT-04A2b2b planning-package commit
└── 094c78382e4bd7f00e397cdfe3ec6284a9c9f04f  attached archive head
    └── ... includes 0c2e9ba68abecd904bae81a9faae5074b4e29fb6  accepted A2b2a runtime head
```

The planning-package commit is deliberately recorded separately from the accepted runtime head. `d1c7fcf...` contains the eight B2b planning-package changes relative to `094c783...`; it is not an implementation head and must never be reported as one.

### 1.1 Supplied source pins

| Pin | Exact value | Live disposition |
|---|---|---|
| Attached archive head | `094c78382e4bd7f00e397cdfe3ec6284a9c9f04f` | Commit exists and is the direct parent of the planning-package commit |
| Attached archive SHA-256 | `e44813b5d9f1d67573e83ec6848ff3811afa031dc68db73c44e60f5d3b53d128` | Recorded source-package pin; the archive blob itself is not a checkout file and therefore was not re-hashed as a working-tree artifact |
| Accepted A2b2a runtime head | `0c2e9ba68abecd904bae81a9faae5074b4e29fb6` | Commit exists and is an ancestor of both archive head and live HEAD |
| A2b2a accepted-plan SHA-256 | `451429f6acca20a1812c2cd18ad79fd3eaab912a8ebb5ded53334833dc3fe02b` | Matches live file |
| A2b2a final-review SHA-256 | `80f9f4cb36a6cdae638ab1a051de634c7a047cd42a3d2a0000b56e2fde494317` | Matches `CT-04A2b2a-remediation-1-review.md` |
| B2b protected supplement SHA-256 | `f4c6ed4efc96d282247d307967167781351abeb893205c98ad90f3c9ec555a5c` | Matches live file |
| B2b planning-package commit | `d1c7fcf5be88a579b4fb0693baf658e057b1d8b6` | Live HEAD at Phase A start; separate from runtime head |

The B2b package added the acceptance matrix, adversarial matrices, implementation guidance, protected supplement, source assessment, source handoff, source map, and the revised child contract. No runtime source differs between `094c783...` and `d1c7fcf...`.

### 1.2 Protected and implementation-source checks

The live hashes match the source handoff:

| Artifact | SHA-256 |
|---|---|
| Original CT-04 protected specification | `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64` |
| A2 protected supplement | `1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c` |
| A2b protected supplement | `255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad` |
| A2b2 protected supplement | `d5ec533cf3187511e6709c989b6c525a9297dd7cfd8795b04871a814006a8879` |
| A2b2b protected supplement | `f4c6ed4efc96d282247d307967167781351abeb893205c98ad90f3c9ec555a5c` |
| Migration 0003 | `526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4` |
| Migration 0004 | `409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e` |
| Observation port | `eaebc7ed288ad8ffda9babd601e851ddd96115d13e2e9cb901f65bb8779f9e36` |
| A1 adapter | `91bf174f2b386a8b7786fc376f906251d8fb0f6d34e5d420c42bcd8fe9fcdd8b` |
| Provider | `355c345b269fc4719f935d88fb1e12bccded8510812da8063d2159fc58f249ee` |
| Repository domain source | `ad1ca726dff9a11dab32e3181ef2ea0eeddb9855e2b01eb9580d3d9a943c2c4d` |
| Repository storage types | `21704153e53639d11dd451e1b160504f7337a8f7e58f69fc690213f5e5f1069c` |
| Repository registry adapter | `12e68b3c93139911216aa8f038bb5a90bf138bbc97c760915d117d4dc4dd019d` |

The handoff's `a2b2a_final_report` pin `20c03172...` resolves to `work-items/CT-04/CT-04A2b2a-remediation-1-commit-report.md`; the similarly named initial implementation report is a different artifact and is not substituted for it.

## 2. Required source-grounded answers

### How are two fresh observations compared without fabricating a repository baseline?

Add only `RepositoryObservationPort.compareFresh(first, second)`. The accepted adapter verifies both exact JSON digests, parses both JSON values through A1's `parseRecordedObservation`, checks every server-owned evidence projection against its parsed observation, and invokes A1's accepted `compareRepositoryObservations`. It then applies the existing server policy mapper. Different `observedAt` values do not constitute core, environment, or risk differences. No synthetic `RegisteredRepository`, `SuccessfulRepositoryInspection`, verified-stored brand, or accepted baseline is constructed.

Digest/projection corruption on freshly returned adapter evidence is an impossible adapter-boundary state: comparison stops before A1 comparison, returns the permanent adapter failure, and latches the provider through the accepted callback. A supported, well-formed pair with incompatible inspection policies uses the existing `comparison-policy-version-mismatch` integrity result. The focused tests distinguish those cases and prove a previously latched adapter returns the same permanent failure.

### Which failures create audit only, and which create inspection evidence?

Audit only is used when no truthful repository observation attempt can be attached to a registered parent: known-member role denial, provider disabled/cooldown/permanent failure, adapter invariant failure, registration's first/second A1 failure, registration fresh-comparison/non-quiescence failure, registration reservation conflict, and preflight not-found/version/status/latest-successful conflicts. A nonmember produces only the established `workspace.access.denied`, not a repository-action audit. An injected unexpected exception rolls its in-transaction audit back with everything else.

Inspection evidence is created for every existing-repository command outcome after a port has been obtained and the evidence boundary has been reached: successful A1 observations, normalized A1 operational/class failures, comparison integrity outcomes, and stored-baseline verification failures. Stored-baseline failure is evidence even though `port.inspect` is forbidden, because the accepted stored evidence itself was verified and found invalid. Adapter failures are never converted into inspections.

### How is a failed or non-advancing reaffirmation stored as reaffirmation rather than verification?

Storage gains `appendInspectionAttempt`, whose input type admits only `kind: 'verification' | 'reaffirmation'`. Reaffirmation uses that API for failed attempts, same/risk-only non-advancing successes, and successful or failed outcomes that take an ordinary governed transition. `appendVerification` remains a compatibility wrapper. The existing `reaffirmEnvironment` primitive remains the sole baseline-advancing write.

### How does the route represent a durably failed reaffirmation?

It returns HTTP 200 and the strict response:

```text
{
  repository: RegisteredRepositorySummary,
  inspection: { outcome: "failed", kind: "reaffirmation", error: bounded tuple, ... },
  changed: boolean,
  baselineAdvanced: false
}
```

`changed` reports whether repository version/state changed; it does not imply baseline advancement. `baselineAdvanced` is true only when `reaffirmEnvironment` commits the fresh inspection as the new accepted environment baseline.

### How does an outer transaction roll back nested repository writes?

Every state-producing command enters one `CraftingTableStorage.transaction`, which is an immediate better-sqlite3 transaction. Existing repository methods open nested better-sqlite3 transactions; inside the outer transaction those are savepoints. Any unexpected exception or deliberate rollback sentinel escapes the outer callback, causing the outer transaction to roll back nested inspection/repository writes plus audit and workspace-event inserts. Expected conflicts that occur before a write commit a bounded failed audit; a conflict detected after a nested write throws a sentinel to roll back first, then records only the conflict audit in a new transaction.

### When is notifier called, and when is it forbidden?

After a successful outer commit, call `WorkspaceEventNotifier.notify()` exactly once if that command appended one or more workspace events. It is forbidden inside a transaction and forbidden for unchanged success, no-state failure, denied/not-found/conflict commands, provider/adapter failures, duplicate registration, transaction rollback, and any command that appended no event. A transition plus risk disposition may append two accepted B1 events but still causes one notifier call. Durable polling/replay remains the recovery path for a missed post-commit notification.

### How are same-workspace idempotency and foreign reservation conflict distinguished without disclosure?

The accepted storage classifier makes the distinction inside the registration transaction. An exact active row in the caller workspace returns `existing` and the common projection with `created:false`. A caller-workspace non-active exact row or partial local identity collision returns generic 409 and directs the caller to lifecycle handling. A live reservation in another workspace also returns the same generic 409, but the response and caller-workspace audit contain no foreign workspace, repository, path, or fingerprint. Nothing is written in the foreign workspace. Retired rows do not reserve identity.

### How does feature-disabled mode preserve reads but reject host operations?

`RepositoryQueryService` depends only on storage and workspace authorization. It never receives the provider, so list/detail/admin/history work from stored summaries while disabled. Lifecycle commands authorize and perform all derivable preflight checks before `provider.get()`; an authorized host operation then receives the provider's feature-disabled result, writes bounded failed audit only, and returns generic 503. It creates no inspection, state change, event, or notification.

## 3. Fan-out decision and recalculated scope

**Decision: retain one CT-04A2b2b implementation slice.** The reconciled target is 35 files, below the approximately 45-file trigger. It introduces no migration, event kind, browser surface, retirement/binding behavior, process import, authority boundary, or persistence boundary. Query projection and lifecycle mutation remain separately testable services, while one route module and one composition seam keep their authorization and transaction behavior reviewable together.

Estimated change budget:

| Area | Files | Net changed-line ceiling |
|---|---:|---:|
| Contracts | 4 | 250 |
| Storage API/adapter | 4 | 450 |
| Server production | 11 | 1,900 |
| Server tests | 6 | 2,500 |
| Scope/protected gates | 4 | 700 |
| Documentation/ADR/README | 6 | 900 |
| **Total** | **35** | **6,700** |

The line ceiling is a review budget, not permission to add abstractions. Stop and return to planning before source work if the tree exceeds 45 files or any listed trigger appears. A contract defect, including inability to preserve exact reducer/event semantics without changing protected vocabulary, is also a stop condition.

## 4. Exact target file tree

`M` means modify; `A` means add. No file outside this list is authorized by this proposal.

```text
M README.md

packages/contracts/src/
M auth.ts
M auth.test.ts
M repository.ts
M repository.test.ts

packages/storage/src/
M repository-types.ts
M repository-repositories.test.ts
M repository-transitions.test.ts
M repositories/repository-registry/index.ts

apps/server/src/
M composition.ts
M composition.test.ts
M server.ts
M test-support.ts
M route-inventory.test.ts
M routes/http.ts
A routes/repositories.ts
A server-repositories.test.ts
M services/errors.ts
A services/repository-query-service.ts
A services/repository-query-service.test.ts
A services/repository-lifecycle-service.ts
A services/repository-lifecycle-service.test.ts
A services/repository-response-mapper.ts
M services/repository-observation-port.ts
M services/repository-observation-adapter.ts
M services/repository-observation-adapter.test.ts

scripts/
M check-forbidden-scope.mjs
M check-forbidden-scope.test.mjs
M check-ct04-protected-package.mjs
M check-ct04-protected-package.test.mjs

docs/
M architecture.md
M security.md
M operations.md
M decisions/README.md
A decisions/ADR-020-repository-registration-and-identity-lifecycle.md
```

Explicitly unchanged: `packages/domain/src/repository.ts`, all migration SQL, workspace-event domain/contracts/storage files, `packages/git/**`, `apps/server/src/config.ts`, `repository-inspector-provider.ts`, `apps/server/src/e2e-entry.ts`, all `apps/web/**`, and every protected specification/supplement.

## 5. Dependency and authority proof

```text
routes/repositories.ts
  ├── contracts (strict request/response validation)
  ├── AuthService + existing request-security chain
  ├── RepositoryQueryService
  │     ├── WorkspaceService
  │     └── CraftingTableStorage (stored reads only)
  └── RepositoryLifecycleService
        ├── WorkspaceService
        ├── CraftingTableStorage
        │     ├── repository registry
        │     ├── audit
        │     └── accepted workspace-event repository
        ├── RepositoryInspectorProvider
        │     └── RepositoryObservationPort
        │           └── repository-observation-adapter.ts
        │                 └── @craftingtable/git   ← sole production A1 import
        └── WorkspaceEventNotifier (post-commit signal only)
```

The route, query/lifecycle services, contracts, storage, and response mapper must not import `@craftingtable/git`, `node:child_process`, filesystem APIs, inspector implementations, or raw A1 result types. The exact accepted adapter remains the only production `@craftingtable/git` import. The scope gate retains the existing narrow testing-seam exceptions only.

## 6. Narrow source corrections

### 6.1 Fresh observation comparison

Add this exact port member:

```ts
compareFresh(
  first: RepositoryObservationEvidence,
  second: RepositoryObservationEvidence,
): RepositoryObservationComparisonResult;
```

The adapter will factor a private parse-and-projection verifier shared by `compare` and `compareFresh`, without widening exports. For each fresh operand it will:

1. verify `observationJson` against `observationSha256` over exact UTF-8 bytes;
2. parse JSON without accepting invalid JSON as an empty/missing value;
3. call A1 `parseRecordedObservation`;
4. validate all 16 projection fields, including ordered risk signals, with the existing `evidenceMatchesObservation` logic;
5. invoke A1 `compareRepositoryObservations` on the two parsed observations;
6. normalize comparison differences with `assessObservationDifferences`;
7. preserve A1's policy-version mismatch as the existing evidence-invalid comparison failure;
8. latch impossible digest/projection/vocabulary/shape faults through `invariantFault()`.

Focused adapter tests carry `B2B-FRESH-001` through `008`: equality despite different `observedAt`; one case each for core/environment/risk differences; corrupt first digest stopping before A1 comparison; second projection mismatch; policy mismatch; and already-latched behavior. Registration service tests additionally prove exactly two `inspect` calls, exactly one `compareFresh`, and storage of the second evidence only.

### 6.2 Standalone inspection-attempt storage

Add this exact input and member:

```ts
export interface AppendRepositoryInspectionAttemptInput {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly expectedVersion: number;
  readonly inspection: InspectionWrite & {
    readonly kind: 'verification' | 'reaffirmation';
  };
}

appendInspectionAttempt(input: AppendRepositoryInspectionAttemptInput): InspectionAppendResult;
```

`appendVerification` delegates to it and retains its accepted signature. The implementation keeps duplicate-ID, workspace/repository coherence, expected-version, missing repository, and inspectable-status checks. The type excludes registration; a defensive runtime check rejects it if an untyped caller bypasses TypeScript. Existing database checks continue to enforce success/failure column coupling.

Storage tests prove successful and failed reaffirmation append with their true kind, successful non-advancing reaffirmation, verification compatibility, registration rejection, terminal/missing/foreign/stale/duplicate results, and use inside an outer immediate transaction. No schema change is needed because migration 0003 already permits succeeded and failed reaffirmation rows.

### 6.3 Strict public contract corrections

Change only:

```ts
reaffirmRepositoryEnvironmentResponseSchema = z.strictObject({
  repository: registeredRepositorySummarySchema,
  inspection: repositoryInspectionSummarySchema,
  changed: z.boolean(),
  baselineAdvanced: z.boolean(),
});
```

Add the generic `service-unavailable` member to `apiErrorCodeSchema` and the matching `sendApiError` type. No provider reason becomes a public enum. Contract tests prove strict rejection of missing/extra `baselineAdvanced`, acceptance of successful and failed reaffirmation summaries, and the new generic error code.

## 7. Service boundaries

### 7.1 `RepositoryResponseMapper`

This server-owned mapper is the single storage-domain-to-HTTP projection boundary. It exposes functions for common repository summary, administrative summary, binding summary, inspection summary, and the four aggregate read/command responses. Every completed outbound object is parsed through the corresponding shared strict Zod schema before being returned to a route. It never returns `observationJson`, failure `errorEvidence`, actor IDs, inode/device values, or provider state.

### 7.2 `RepositoryQueryService`

Constructor dependencies: `CraftingTableStorage`, `WorkspaceService`. It has exactly four public methods:

```text
listRepositories(context, workspaceId, requestId?)
repositoryDetail(context, workspaceId, repositoryId, requestId?)
repositoryAdminDetail(context, workspaceId, repositoryId, requestId?)
inspectionHistory(context, workspaceId, repositoryId, requestId?)
```

Common methods require active membership; admin requires Owner. Each operation authorizes first and then runs one deferred read transaction. Detail reads the repository summary and at most 100 bindings from the same workspace, projecting only active bindings in the response. History reads the newest 100 inspection summaries ordered by descending immutable sequence. A missing/foreign repository returns the established 404. Mapping corruption throws an internal integrity failure before any response is sent; no partial list/detail/history is returned. The service has no provider field, making host access structurally impossible.

### 7.3 `RepositoryLifecycleService`

Constructor dependencies: storage, workspace service, inspector provider, notifier, clock, and optional test-only failure hooks. Its only public command methods are:

```text
register(context, workspaceId, parsedRequest, requestId?)
inspect(context, workspaceId, repositoryId, parsedRequest, requestId?)
reaffirm(context, workspaceId, repositoryId, parsedRequest, requestId?)
```

Private helpers own role-plus-denial-audit behavior, provider acquisition, stored-baseline verification, inspection construction, reducer/event mapping, bounded audit builders, and post-commit notification. Routes never compose a lifecycle transaction themselves.

The optional hooks are a server-test seam, not a public or HTTP surface. They receive no storage handle and can only throw at named points. Production composition passes no hooks.

## 8. Exact route and contract inventory

All responses, including errors, carry `Cache-Control: no-store`.

| # | Route | Role | Strict request | Success response/status |
|---:|---|---|---|---|
| 1 | `GET /api/workspaces/:workspaceId/repositories` | Owner/Editor/Viewer | branded workspace path; no body | `repositoryListResponseSchema`, 200 |
| 2 | `POST /api/workspaces/:workspaceId/repositories` | Owner | `registerRepositoryRequestSchema` | `registerRepositoryResponseSchema`; 201 when created, 200 when existing |
| 3 | `GET /api/workspaces/:workspaceId/repositories/:repositoryId` | Owner/Editor/Viewer | branded workspace/repository paths; no body | `repositoryDetailResponseSchema`, 200 |
| 4 | `GET /api/workspaces/:workspaceId/repositories/:repositoryId/admin` | Owner | branded paths; no body | `repositoryAdministrativeDetailResponseSchema`, 200 |
| 5 | `GET /api/workspaces/:workspaceId/repositories/:repositoryId/inspections` | Owner/Editor/Viewer | branded paths; no body | `repositoryInspectionListResponseSchema`, 200 |
| 6 | `POST /api/workspaces/:workspaceId/repositories/:repositoryId/inspect` | Owner/Editor | `inspectRepositoryRequestSchema` | `inspectRepositoryResponseSchema`, 200 for every durably recorded outcome |
| 7 | `POST /api/workspaces/:workspaceId/repositories/:repositoryId/reaffirm` | Owner | `reaffirmRepositoryEnvironmentRequestSchema` | revised reaffirmation response, 200 for every durably recorded outcome |

There is no pagination request because the contracts fix the list/history maxima at 100. There is no generic path-inspect, Git, argv, environment, command, retirement, binding, or unbinding route.

Route order for mutations is: authenticate session; constant-time CSRF and same-origin/fetch-metadata authorization through `authorizeMutation`; strict path/body parsing; lifecycle service membership/role/preflight; provider acquisition. Thus invalid CSRF/origin returns 403 before the lifecycle service or provider, while a known member's role denial is audited inside the service before provider access.

## 9. Disclosure map

| Data | Common list/detail | Owner admin detail | History | Never public |
|---|---:|---:|---:|---:|
| Repository ID, display name, status/reason/version/times | yes | yes | through parent route only | — |
| Canonical top level, object format, core fingerprint | yes | yes | no | — |
| Canonical Git directory/common Git directory | no | yes | no | — |
| Registration/accepted/latest inspection IDs and recency | yes | yes | individual summaries | — |
| Risk classification, bounded signal names, observation time | yes | yes | successful summaries | — |
| Difference-name arrays and accepted-baseline flag | no | no | yes | — |
| Bounded failed-inspection error tuple | no | no | yes | — |
| Active binding IDs/project/repository status/version/times | detail only | yes | no | — |
| Exact observation JSON/digest-bearing raw record | no | no | no | yes (history exposes digest only) |
| Error evidence map/raw A1 diagnostics/stdout/stderr | no | no | no | yes |
| Inodes/devices/actor IDs | no | no | no | yes |
| Configured roots, executable/search path, environment | no | no | no | yes |
| Cookies, CSRF/session tokens, operator reason text | no | no | no | yes |

The administrative route adds only the two Git-directory projections already admitted by the strict administrative contract. It is not a raw evidence endpoint.

## 10. Authorization-before-provider matrix

| Operation/outcome | Authorization and preflight before `provider.get()` | Provider/A1 permitted? | Audit/event |
|---|---|---:|---|
| Stored list/common detail/history | authenticated active member | never | none |
| Stored admin detail | authenticated Owner | never | none |
| Nonmember/missing workspace | `WorkspaceService` records indistinguishable workspace denial and returns 404 | no | no repository audit/event |
| Known member wrong role | membership established, bounded `repository.<action>` denied audit committed | no | denied audit only |
| Register Owner | request/display name valid | yes | later command outcome |
| Inspect Owner/Editor | local repository exists, expected version matches, status inspectable | yes | preflight conflict audit or later outcome |
| Reaffirm Owner | local repository exists, version and latest-successful ID match, status is `identity-evidence-changed` | yes | preflight conflict audit or later outcome |
| Invalid CSRF/origin/session | existing route-security chain rejects | no | existing authentication behavior only |

Provider acquisition is necessary to obtain the accepted port that implements `verifyStored`; lazy creation may perform the accepted fixed inspector creation/version probe. For an existing repository, no requested repository path is passed to `port.inspect` until the accepted baseline has passed `verifyStored` and `verifyRegisteredIdentity`. Therefore “no A1 call” in storage-integrity cases means no fresh repository observation/compare; this plan does not invent a second parser outside the sole adapter.

## 11. Provider, adapter, and stored-baseline failure behavior

Provider outcomes `feature-disabled`, temporary cooldown/creation failure, and permanent creation/vocabulary failure are collapsed to an internal allowlisted provider class. After authorization they produce a failed command audit and public 503 `service-unavailable`; they produce no inspection, state/version change, event, or notifier.

An `adapter-error` returned by `inspect`, `verifyStored`, identity verification, `compare`, or `compareFresh` follows the same audit-only 503 path. The accepted callback has already latched the provider permanently. It is never rewritten as A1 or storage-integrity evidence.

For existing repositories, baseline verification is:

```text
deferred preflight read:
  repository by (workspaceId, repositoryId)
  accepted inspection by acceptedEnvironmentInspectionId
  prove it is a successful inspection owned by that repository/workspace
provider.get()
port.verifyStored(accepted inspection)
port.verifyRegisteredIdentity(repository, verified stored observation)
only then port.inspect(repository.canonicalTopLevel)
```

Digest mismatch, JSON/A1 parse invalidity, unsupported version, projected-row mismatch, repository-identity mismatch, or comparison-policy incompatibility is converted to one failed inspection of the command's true kind with:

```text
origin: storage-integrity
code: stored-evidence-digest-mismatch | recorded-observation-invalid |
      unsupported-observation-version | inspection-policy-version-mismatch
subject: stored-evidence-integrity
category: observation
operation: verify-stored-record
retryability: not-retryable
errorEvidence: normalized allowlist of reason and optional projection field
```

The returned `evidence-invalid` assessment is passed to the accepted reducer. One outer transaction rechecks version/status, appends the failed inspection, applies the `evidence-blocked` transition, appends failed audit and `repository-status-changed`, and commits. `port.inspect` and observation comparison are forbidden. The HTTP result is 200 because the failed inspection is durable and expected.

## 12. Registration lifecycle

1. Require Owner, with denial semantics from Section 10.
2. Use the strict supplied display name, or derive POSIX basename from the request shape and re-parse it through `repositoryDisplayNameSchema`. Empty/unsafe basename is 400 before provider access.
3. Hash the exact requested-path UTF-8 bytes and record only SHA-256 plus byte length in audit metadata.
4. Acquire provider. On failure, commit failed audit and return 503.
5. Call `port.inspect({requestedPath})` twice sequentially. A normalized first/second A1 failure commits audit only and returns generic 409; an adapter failure returns 503. When the second fails, the audit may include the first digest.
6. Call `compareFresh(first.evidence, second.evidence)`. Require all three same booleans. Any difference is a generic non-quiescent 409 with audit only. A policy comparison failure is 409; adapter failure is 503.
7. Build a successful registration inspection from the second evidence only. Difference arrays remain absent.
8. In one outer immediate transaction call the accepted nested `register` primitive, append the exact audit outcome, and append `repository-registered` only for `created`.
9. After commit, notify once only for `created`.

Registration result handling:

| Storage result | HTTP/body | Durable caller effects | Event/notifier |
|---|---|---|---|
| `created` | 201, `created:true` | repository, second registration inspection, succeeded audit | one registered event; one post-commit notify |
| exact active `existing` in caller workspace | 200, `created:false` | succeeded idempotency audit; no new inspection | none |
| `conflicting-local-state` or `local-identity-conflict` | generic 409 | failed caller audit | none |
| `identity-reserved-elsewhere` | same generic 409 | failed caller-workspace audit with no foreign identifiers; no foreign write | none |
| retired prior row | classified as unreserved | a fresh ID may be created | as `created` |
| concurrent loser | existing or same generic conflict | never a second active row/history/event | none |

The registration transaction includes a failure hook immediately after nested `register` and before audit/event. Throwing there proves the circular registration inspection, repository row, audit, and event all remain absent.

## 13. Explicit inspection lifecycle

Preflight authorizes Owner/Editor, loads the local repository and accepted baseline, rejects stale version and terminal `identity-mismatch`, `evidence-blocked`, or `retired` status before provider access, then follows stored verification from Section 11.

After fresh observation:

- success: compare the verified baseline with current evidence, build a successful `verification`, and reduce `apply-assessment`;
- normalized A1 failure: build a failed `verification` and use its accepted assessment;
- adapter failure: audit only and return 503;
- comparison integrity failure: build failed storage-integrity `verification` and use `evidence-invalid`.

The outer immediate transaction re-reads the repository/version/status, appends exactly one verification via `appendInspectionAttempt`, applies a transition if the reducer requires it, appends bounded audit, and appends accepted events. If a conflict appears after observation, no orphan evidence is committed. `changed` is true exactly when repository version increments.

Exact assessment consequences:

| Assessment | Inspection | State/baseline | Events |
|---|---|---|---|
| same | successful verification | unchanged | none |
| risk only | successful verification | unchanged version | one `repository-evidence-changed` |
| environment changed | successful verification | `identity-evidence-changed`, version +1 | one status event |
| core changed | successful verification | terminal `identity-mismatch/core-identity-changed` | one status event |
| repository class changed | failed verification | terminal `identity-mismatch/repository-class-changed` | one status event |
| unavailable | failed verification | transition to unavailable only if status changes | zero or one status event |
| no-state operational failure | failed verification | unchanged | none |
| evidence invalid | failed storage-integrity verification | `evidence-blocked` | one status event |
| accepted evidence returns from unavailable/evidence-changed | successful verification | active/evidence-matches | one status event; a risk disposition may add one evidence event |

At most one status event is emitted for a single version transition. When the accepted `apply-assessment` reduction carries both a transition and `risk-evidence-changed`, append the status event and evidence event in that order, then notify once after commit. Inspection history remains authoritative for unchanged/no-state outcomes with no event.

## 14. Environmental reaffirmation lifecycle

Preflight requires Owner, a local `identity-evidence-changed` repository, exact expected version, and exact current latest-successful inspection ID. All four checks precede provider access and repeat inside the outer transaction. Baseline verification then precedes `port.inspect`.

Every reached-port result is constructed with `kind:'reaffirmation'`. The accepted `reaffirm-environment` reducer decides baseline eligibility; the command never infers eligibility from the route name.

| Outcome | Storage/state action | `changed` | `baselineAdvanced` | Event |
|---|---|---:|---:|---|
| environment still differs, same core | accepted nested `reaffirmEnvironment`: insert attempt, advance accepted baseline, active/version +1 | true | true | status |
| same | standalone successful reaffirmation append; accepted reducer says not required | false | false | none |
| risk-only | standalone successful reaffirmation append; baseline/status/version unchanged | false | false | evidence only |
| core difference | standalone successful reaffirmation + ordinary governed transition to identity mismatch | true | false | status |
| repository-class failure | standalone failed reaffirmation + mismatch transition | true | false | status |
| unavailable failure | standalone failed reaffirmation + transition where required | reducer result | false | status only if changed |
| no-state operational failure | standalone failed reaffirmation, baseline preserved | false | false | none |
| stored evidence invalid | standalone failed storage-integrity reaffirmation + evidence-blocked | true | false | status; no fresh A1 inspection |
| provider/adapter failure | no inspection or state write | false | false | none; public 503 |

The risk-only evidence event is the contract's explicit reaffirmation consequence even though the accepted reaffirm reducer returns `reaffirmation-not-required`; it uses the accepted comparison's risk assessment, changes no version/baseline, and does not invent a combined event. Same evidence emits nothing. No non-advancing result calls `reaffirmEnvironment`.

For the advancing branch, any `reaffirmEnvironment` conflict after its nested inspection insert is converted to an outer rollback sentinel before a 409 conflict audit is recorded separately. This closes the accepted primitive's otherwise composable savepoint behavior and proves no orphan reaffirmation can survive. Repository ID and all existing bindings are untouched in every reaffirmation; only the accepted environment inspection link changes on the true advancing branch.

## 15. Bounded audit metadata schemas

All records use existing action/outcome vocabulary and existing top-level audit columns for actor, session, workspace, request ID, target, and prior/result versions. Metadata is constructed only by typed allowlist builders; no request-body spread, exception message, raw `errorEvidence`, or provider object is accepted. Strings are closed literals, digests are 64 lowercase hex, counts are bounded integers, and raw path/operator reason text is replaced by SHA-256 plus UTF-8 byte length.

### 15.1 Common fields

```text
stage: authorization | validation | provider | first-observation |
       second-observation | fresh-comparison | preflight |
       stored-verification | observation | transaction
providerFailureClass: feature-disabled | temporarily-unavailable |
                      permanently-unavailable | adapter-invariant
```

`requestId` stays in its dedicated audit column. `repositoryId`/`inspectionId` use target columns or metadata only after local visibility is proven. Missing/foreign or pre-role inputs are omitted.

The closed `disposition` literals are action-specific:

```text
register: role-denied | invalid-display-name | feature-unavailable |
          first-observation-failed | second-observation-failed |
          non-quiescent | comparison-incompatible | created | existing |
          lifecycle-conflict | identity-reserved | transaction-conflict

inspect: role-denied | not-found | version-conflict | terminal-status |
         feature-unavailable | adapter-fault | recorded-succeeded |
         recorded-failed | transaction-conflict

reaffirm: role-denied | not-found | version-conflict |
          latest-successful-conflict | reaffirmation-not-required |
          feature-unavailable | adapter-fault | recorded-succeeded |
          recorded-failed | baseline-advanced | transaction-conflict
```

### 15.2 Exact action/outcome metadata

| Action/outcome | Allowed metadata keys |
|---|---|
| `repository.register` denied | `stage`, `disposition:'role-denied'`, `requiredRole:'owner'` |
| register validation/provider failure | `stage`, `disposition`, `requestedPathSha256`, `requestedPathUtf8Bytes`, optional `providerFailureClass` |
| register first/second A1 failure | prior keys plus `failureClass:'a1'`, `errorCode`, optional `firstObservationSha256` |
| register comparison/conflict | `stage`, `disposition`, both observation digests, three same booleans, three difference counts, path hash/length |
| register created/existing | comparison fields plus `disposition:'created'|'existing'` |
| `repository.inspect` denied/preflight/provider | `stage`, `disposition`, `expectedVersion`, optional `providerFailureClass`; local target only after proven |
| inspect recorded outcome | `stage:'transaction'`, `disposition:'recorded'`, `inspectionId`, `inspectionKind:'verification'`, `inspectionOutcome`, `assessmentKind`, optional `errorCode`, `changed`, `eventDisposition:'none'|'status'|'evidence'|'status-and-evidence'` |
| `repository.reaffirm` denied | `stage`, `disposition:'role-denied'`, `requiredRole:'owner'`; no reason or unproven target |
| reaffirm preflight/provider | inspect preflight fields plus `reasonSha256`, `reasonUtf8Bytes`; expected latest ID only when locally proven |
| reaffirm recorded outcome | inspect recorded fields with `inspectionKind:'reaffirmation'`, `baselineAdvanced`, reason hash/length |

Audit outcome is `succeeded` for a successfully processed command whose inspection may itself be a successful or expected failed observation; it is `failed` for provider/adapter failure, validation/conflict, or a durably recorded failed inspection. Known-role denial uses `denied`. Tests assert the exact key set and serialized byte bounds for every builder, not merely absence of selected secrets.

## 16. Event, transaction, and notifier design

Only accepted B1 events are used:

- creation: one `repository-registered`, structurally correlated to repository and registration inspection, payload fixed to active/registration/version 1;
- a reducer transition: one `repository-status-changed` with repository/inspection structural correlation, from/to status, reason, and prior/result versions;
- a risk disposition: one `repository-evidence-changed` correlated to the attempt, with `evidenceClass:'risk-scan'` and the repository version in effect after the transaction.

No event exists for unchanged verification, no-state failure, non-advancing same reaffirmation, provider failure, denial, conflict, or duplicate registration. Audit and inspection history carry those facts. No new event kind is added.

Named failure-injection points in `RepositoryLifecycleService` tests are:

```text
afterRegistrationWrite
afterInspectionAppend
afterRepositoryTransition
afterBaselineAdvance
afterAuditAppend
afterEventAppend
```

For registration, inspection standalone append, transition, and baseline-advance paths, tests snapshot repository/inspection/audit/event counts and rows, throw at the relevant hook, and then prove byte-for-byte logical state is unchanged and notifier count is zero. The most important nested proofs are `afterRegistrationWrite`, `afterInspectionAppend`, and `afterBaselineAdvance`; the later hooks prove audit/event also participate in the same outer transaction. Hooks never intercept after commit.

## 17. Public error/status mapping

Add `InvalidRequestError`, `ConflictError`, and `ServiceUnavailableError` to the existing server error module. The central handler maps only their generic class, never internal details:

| Condition | HTTP/API code | Public message class |
|---|---|---|
| Strict path/body or derived basename invalid | 400 `invalid-request` | invalid repository request |
| Unauthenticated | 401 `unauthenticated` | existing generic message |
| Known member insufficient role or request-security denial | 403 `forbidden` | existing generic message |
| Missing/foreign workspace/repository | 404 `not-found` | existing indistinguishable message |
| Stale version/latest successful, terminal/not-required state, duplicate/local/foreign reservation, non-quiescent registration | 409 `conflict` | generic repository conflict |
| Feature disabled/cooldown/permanent provider failure or adapter invariant | 503 `service-unavailable` | repository service unavailable |
| Expected recorded success/failure inspection | 200 | strict command body |
| Created registration | 201 | strict registration body |
| Existing idempotent registration | 200 | strict registration body |
| Unexpected invariant/storage/mapping exception | 500 `internal-error` | no internal detail; log error name only |

All route-level Zod failures use `sendApiError` directly. Lifecycle errors are thrown only after any required audit-only transaction has committed.

## 18. Acceptance and protected-ID mapping

Every one of the 211 required/protected IDs is covered below. Range notation is inclusive and is also the exact notation the protected checker will expand from test titles.

| IDs | Primary proof files and focus |
|---|---|
| `B2-AUTH-001..010` | `server-repositories.test.ts`, lifecycle tests: complete role matrix, 401/403/404, audit, zero provider calls |
| `B2-REG-001..012` | lifecycle/server tests plus transition/storage tests: creation, failures, idempotency, reservations, race, rollback, replay, bounded audit |
| `B2-INSP-001..014` | lifecycle/server/storage tests: every reducer assessment, history, conflict serialization, full rollback |
| `B2-REAFF-001..008` | lifecycle/storage/server tests: authorization, preflight, advance/no-advance, mismatch/failure, rollback |
| `A2B-AUTH-001..010` | same authorization cases with explicit inspector-call counters and denial audit assertions |
| `A2B-REG-001..014` | registration lifecycle tests including basename validation, double observation, notification and SSE recovery |
| `A2B-INSP-001..016` | inspection lifecycle tests plus accepted reducer/storage assertions for all evidence/failure classes |
| `A2B-REAFF-001..008` | reaffirmation lifecycle/storage tests, including exact single status event and identity/binding preservation |
| `B2-CSRF-001` | `server-repositories.test.ts`: every POST passes the existing session/CSRF/origin chain before service/provider |
| `B2-DISCLOSURE-001`, `B2B-DISC-001` | contract, mapper, query, and HTTP tests for common/admin separation and raw-evidence exclusion |
| `B2-AUDIT-001`, `B2B-REG-DOUBLE-001` | lifecycle exact-key audit tests for bounded metadata, two digests/booleans, and no raw diagnostic/path/token data |
| `B2B-REAFF-EVID-001..003` | storage/lifecycle tests for successful non-advance, failed attempt, and ordinary governed reaffirmation kind |
| `B2B-TX-001..002` | storage transition and lifecycle hook tests proving nested append/transition rollback and zero notifier |
| `B2B-HISTORY-001` | query/server history with unchanged, still-changed, failed, and reaffirmation rows but no workspace event |
| `B2B-READ-001` | composition/query/server tests: disabled stored reads 200, host mutations audited 503 |
| `B2B-CLASS-001` | lifecycle test: accepted class failure maps to terminal `repository-class-changed` |
| `B2B-NOTIFY-001` | lifecycle/query tests: no event/notify for unchanged/no-state, durable history visible |
| `B2B-FRESH-001..008` | adapter tests for the exact fresh-comparison matrix |
| `B2B-PROV-001..006` | composition/lifecycle/query/server tests for disabled, cooldown, permanent, latched, concurrent creation, and reads |
| `B2B-QUERY-001..008` | query/mapper/server tests for roles, bounds, disclosure, disabled mode, ordering, and fail-closed mapping |
| `B2B-REGX-001..016` | lifecycle/server tests; `REGX-014` uses `afterRegistrationWrite`, `REGX-015` SSE replay |
| `B2B-INSPX-001..016` | lifecycle/server tests; `INSPX-014` uses `afterInspectionAppend`; notifier/history cases explicit |
| `B2B-REAFFX-001..016` | lifecycle/server tests; true-kind outcomes, stored-integrity, advance, conflicts, rollback, identity/binding preservation |
| `B2B-JRNX-001..012` | lifecycle/server tests for exact B1 correlation/payload, audit-only/evidence-only cases, rollback, replay, boundedness, one notify |
| `B2B-ROUTE-001..010` | contract, `server-repositories.test.ts`, and route inventory: exact routes, strict parsing, status mapping, response truth, no leakage |
| `B2B-SCOPEX-001..008` | both scope/protected checker tests: sole adapter import, process boundary, frozen migrations/events/web/protected files, process order |
| `B2B-PROCESS-001` | this proposal plus required independent design-review artifact |
| `B2B-PROCESS-002` | later disposition and accepted plan reconciliation appendix; cannot be claimed in Phase A |
| `B2B-PROCESS-003` | later post-commit implementation report; cannot be claimed before an actual implementation commit |
| `B2B-PROCESS-004` | protected checker hashes B2b and all inherited protected files |
| `B2B-FANOUT-001` | Section 3's explicit one-slice decision and recalculated 35-file tree |

The protected checker will add the B2b supplement parser, all ID prefixes/ranges, exact proof-file inventory, the accepted implementation path allowlist, and dynamic governance/report patterns. It will fail for missing/duplicate IDs, unproved required IDs, changed protected hashes, source work before the accepted-plan sequence, a fifth migration, new event kinds, web repository files/fetches, retire/bind routes, or paths outside the accepted tree. The forbidden-scope checker will admit only the seven exact lifecycle routes while continuing to reject generic Git/process and all deferred capabilities.

## 19. Documentation and ADR changes

- `README.md`: identify CT-04A2b2b as the implemented server lifecycle only after acceptance/implementation and retain explicit browser/retirement/binding deferrals.
- `docs/architecture.md`: document providerless stored reads, the sole adapter import, query/lifecycle boundaries, outer transaction/savepoints, and commit-then-notify.
- `docs/security.md`: document exact role matrix, common/admin disclosure split, authorization-before-provider, stored-evidence verification, and bounded audit metadata.
- `docs/operations.md`: document disabled-mode 200 reads versus audited 503 host operations, recorded-outcome 200 responses, history versus activity, and durable replay after lost notification.
- `ADR-020`: accept double observation, fresh A1 comparison, truthful reaffirmation attempts, stored-baseline verification before fresh path inspection, single outer transaction, and event/notifier policy; explicitly reject synthetic baselines, fictional inspections, new event kinds, and browser/process expansion.
- `docs/decisions/README.md`: index ADR-020.

No documentation may imply that risk evidence authorizes mutation or that CraftingTable can retire/bind repositories, create branches/worktrees, run agents/checks, or merge.

## 20. Deterministic verification commands

Run focused gates first from repository root, in this exact order:

```bash
pnpm exec vitest run packages/contracts/src/auth.test.ts packages/contracts/src/repository.test.ts
pnpm exec vitest run packages/storage/src/repository-repositories.test.ts packages/storage/src/repository-transitions.test.ts
pnpm exec vitest run apps/server/src/services/repository-observation-adapter.test.ts
pnpm exec vitest run apps/server/src/services/repository-query-service.test.ts apps/server/src/services/repository-lifecycle-service.test.ts
pnpm exec vitest run apps/server/src/composition.test.ts apps/server/src/server-repositories.test.ts apps/server/src/route-inventory.test.ts
pnpm exec vitest run scripts/check-forbidden-scope.test.mjs scripts/check-ct04-protected-package.test.mjs
pnpm check:scope
pnpm check:protected
git diff --check
```

Then run the complete deterministic gate:

```bash
pnpm check
```

Before implementation review, also record:

```bash
git status --short --branch
git diff --name-status <accepted-implementation-base>...HEAD
sha256sum protected/CT-04-protected-acceptance-spec.yaml \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml \
  work-items/CT-04/CT-04A2b-protected-acceptance-supplement.yaml \
  work-items/CT-04/CT-04A2b2-protected-acceptance-supplement.yaml \
  work-items/CT-04/CT-04A2b2b-protected-acceptance-supplement.yaml \
  packages/storage/migrations/0003-ct04a2a-repository-model.sql \
  packages/storage/migrations/0004-ct04a2b-repository-journal.sql
```

`<accepted-implementation-base>` must be replaced by the exact operator-committed planning-package head after design-review disposition and accepted plan are committed. The completion report may record an implementation head only after the implementation itself is committed.

## 21. Scope locks and deferrals

This plan explicitly confirms:

- **no migration** and no modification to migrations 0001–0004;
- **no new workspace-event kind** and no change to accepted B1 event schemas;
- **no browser repository page, route, model, API wrapper, fetch, or UI change**;
- **no retirement, binding, or unbinding route or service command**;
- **no new Git, filesystem, shell, argv, environment, or process authority**;
- **no `@craftingtable/git` import outside the accepted adapter**;
- **no CT-04B+ behavior**: no target ref, exact-base validation, branch/worktree/diff/artifact/change request, coding agent, checks, review, remediation, readiness, approval, commit, or merge.

CT-04A2b2c retains retirement, project binding/unbinding, A2 parent fan-in, and any browser repository workflow assigned there. CT-04B and later retain repository mutation/worktrees, agent execution, verification, review, remediation, and merge authority. Discovery of a need for any of those behaviors stops implementation and returns the slice to planning.

## 22. Phase boundary

The next authorized action after this proposal is independent design review only. After accepted findings are returned, the primary source-specific agent must create the design-review disposition and reconciled accepted implementation plan, then stop for operator approval and commit. No source implementation may begin from this proposed plan.
