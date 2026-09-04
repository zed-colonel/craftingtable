# CT-04A2b2 source assessment

## 1. Assessment basis

This assessment is pinned to the attached GitHub archive bundle:

```text
Archive head: dd9c9699f0d86cae00fc1bf0d054224880c8dbed
Archive SHA-256: 104f780533687b3eee19c76995256567b2bea5a1145158e3f4f36199ca18971f
Files: 390
Tracked TypeScript/TSX/MJS source-like files: 196
```

The bundle contains accepted A1, accepted A2a, accepted B1, B1 implementation/remediation records, and the B1 independent review chain. It is treated as the source authority for this package.

Relevant accepted pins:

```text
B1 reviewed code head: b8a5493b9e33a82c3e4d6b43e39d6e4422d05576
B1 report head: e2be367d443294e83f7b7d5d9584dad60256abf3
B1 accepted-plan SHA-256: 9df50c1da04fd7a4b2351245724105a5c3a11e02bcd5d66c09f10886cb43d658
B1 final-review SHA-256: cd0a77f5383d5936a229c3ad10311b522e9fbf1f45ec78acd32d3b946c3492a3
Migration 0003 SHA-256: 526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
Migration 0004 SHA-256: 409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e
Original CT-04 protected SHA-256: ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
A2 protected supplement SHA-256: 1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c
A2b protected supplement SHA-256: 255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad
```

This is a static source assessment. The implementation agent must reconcile every statement with the live checkout before proposing A2b2a code.

## 2. Accepted B1 state

B1 is accepted. Its substantive runtime source establishes:

- nine exhaustive workspace-event variants;
- five repository event kinds;
- schema-4 repository, inspection, and binding correlations;
- kind-specific structural nullability and composite ownership;
- fail-closed event mapping;
- repository stale scopes in the browser projection;
- safe activity text;
- durable replay through existing snapshot/SSE behavior.

The final B1 review found no blocking runtime defect. Its remaining advisories concern Git-package test scratch placement and a deliberately constructed import-scanner edge. They do not belong in B2 lifecycle implementation.

## 3. Current source boundaries

### 3.1 A1 observation package

`@craftingtable/git` exports only its package-root public surface. The relevant accepted calls are:

```text
createRepositoryInspector(options)
parseRecordedObservation(value)
compareRepositoryObservations(recorded, current)
```

Its observation separates core identity, environmental device evidence, and risk-scan evidence. It returns typed failures with subject, code, operation, retryability, and bounded evidence.

No production server file imports this package today.

### 3.2 A2a domain and contracts

The repository domain has:

```text
six statuses
thirteen status reasons
registration / verification / reaffirmation inspection kinds
successful and failed immutable evidence
project binding state
pure repository reducer
strict request and response schemas
```

The public contracts already include requests and responses for registration, inspection, reaffirmation, retirement, bind, and unbind. B2 should use them rather than inventing alternate wire shapes without a reviewed source reason.

### 3.3 A2a storage

The accepted storage APIs already implement:

```text
register repository + registration inspection
append verification inspection
apply state transition
baseline-advancing reaffirmation
retire repository with active bindings
insert / query / retire project binding
repository and inspection summaries
```

They intentionally do not write audit or events.

`CraftingTableStorage.transaction()` provides one outer `BEGIN IMMEDIATE`. The repository primitives create nested better-sqlite3 transactions/savepoints. B2 may compose them, but it must test failure after a nested primitive returns and before outer commit.

### 3.4 B1 journal/projection

B1 added:

```text
repository-registered
repository-status-changed
repository-evidence-changed
project-repository-bound
project-repository-binding-retired
```

`repository-status-changed` allows an optional inspection correlation for retirement. Other repository events have exact structural correlations. The browser already invalidates repository list/detail scopes and project scopes; it has no repository page or fetch API yet.

### 3.5 Server

The server currently composes only auth, workspaces, planning, and SSE. It has:

- no repository feature configuration;
- no A1 adapter/provider;
- no repository service;
- no repository route;
- no production Git import;
- no owner administrative repository response path.

This is the first slice to activate A1 in production composition.

## 4. Source-grounded gaps

### 4.1 Missing repository-class assessment

The domain includes reason `repository-class-changed`, and A1 classifies several failures under subject `repository-class-changed`, but `RepositoryObservationAssessment` has no matching variant. The reducer can currently express only core mismatch, environment difference, risk difference, unavailable, evidence invalid, same, and no-state-change failure.

Mapping class failures to `core-identity-changed` would erase the accepted distinction. A2b2a must correct the domain before lifecycle commands exist.

### 4.2 Standalone reaffirmation evidence is impossible

`RepositoryInspection` permits failed and successful `reaffirmation` records. Storage can append:

- a standalone `verification`;
- a successful baseline-advancing `reaffirmation` through `reaffirmEnvironment()`.

It cannot append:

- failed reaffirmation evidence;
- successful reaffirmation evidence when the environment no longer differs;
- a reaffirmation that discovers core/class/unavailable state and is governed without baseline advance.

B2b must add a narrow storage capability so every explicit reaffirmation attempt remains truthful durable history.

### 4.3 Retirement result lacks event data

`retireWithBindings()` returns only `retiredBindingIds`. B1's `project-repository-binding-retired` payload requires:

```text
projectId
bindingId
repositoryId
priorVersion
resultingVersion
repositoryDisplayName
```

B2c must obtain these facts inside the retirement transaction. The clean source-grounded correction is to return full retired binding transition evidence or expose an equivalent transaction-local result; querying after commit would weaken atomic explanation.

### 4.4 Stored observation integrity has no server implementation

A2a stores exact observation JSON and SHA-256 and exposes `sha256ExactUtf8`. The accepted runtime has no composed read path that:

```text
recomputes digest
parses JSON
calls A1 parseRecordedObservation
compares parsed fields to projected columns
```

This belongs in A2b2a before any verification command trusts stored evidence.

### 4.5 Feature configuration is absent

`ServerConfig` contains only host, port, data/database path, origin, cookies, session lifetime, and logging. The accepted policy requires repository support to be optional when no variables are present and strict when explicitly configured.

### 4.6 Inspection history is not an event feed

B1 intentionally emits no event for unchanged verification, environment-still-changed verification, or bounded failed evidence. B2 must expose ordered inspection-history reads and must not teach CT-04E to infer freshness solely from workspace activity.

### 4.7 Browser projection is prepared but no view exists

B1 extended stale scopes and activity descriptions. B2 lifecycle services require no repository browser UI. CT-04E still owns actual repository/change-request views and temporal request identity.

## 5. Why three child slices

The remaining 188 inherited B2 acceptance obligations cover three independent failure domains:

```text
feature/evidence boundary:
    configuration, A1 parity, exact stored evidence, assessment mapping

identity lifecycle:
    authorization, registration, verification, reaffirmation,
    query/disclosure, audit/event/notifier

administrative relationships:
    binding, unbind, retirement, project event reconstruction,
    complete parent fan-in
```

A two-way split would leave registration, inspection, reaffirmation, retirement, binding, routes, and parent fan-in in one final child. The accepted source makes a three-way split more coherent.

## 6. Source-to-target disposition

| Current source | Target child | Disposition |
|---|---|---|
| `apps/server/src/config.ts` | A2b2a | Add explicit optional repository-feature config group |
| `apps/server/src/composition.ts` | A2b2a then B2b | Compose provider internally; expose lifecycle services only in B2b |
| `packages/git/src/index.ts` | A2b2a | Consume package-root API only; no A1 source changes expected |
| `packages/domain/src/repository.ts` | A2b2a | Add repository-class assessment and reducer coverage |
| `packages/storage/src/repository-types.ts` | B2b/B2c | Add standalone reaffirmation evidence and richer retirement transition result |
| `repository-registry/index.ts` | B2b/B2c | Implement only source-required API extensions; preserve accepted constraints |
| `workspace-events` domain/contracts/storage | B2b/B2c | Consume accepted B1 variants without widening event vocabulary |
| `apps/server/src/services` | B2a/B2b/B2c | Add evidence boundary, lifecycle service, and administrative service in sequence |
| `apps/server/src/routes` | B2b/B2c | Add only accepted typed repository endpoints |
| `apps/server/src/server.ts` | B2b/B2c | Register routes and closed errors |
| `route-inventory.test.ts` | B2b/B2c | Expand exact allowlist per child |
| `apps/web` | none in B2 | No repository views; B1 projection remains sufficient |

## 7. Carried-forward advisories outside this slice

- Moving A1 test scratch directories to the system temp directory is a separate A1 maintenance item.
- The B1 import-scanner regex-class advisory is unrelated to repository lifecycle.
- Neither advisory should expand B2 scope or be silently fixed here.
