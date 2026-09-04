# CT-04A2b2b source assessment

## 1. Assessment basis

The assessment is grounded in the attached source archive:

```text
archive head comment: 094c78382e4bd7f00e397cdfe3ec6284a9c9f04f
archive SHA-256: e44813b5d9f1d67573e83ec6848ff3811afa031dc68db73c44e60f5d3b53d128
accepted A2b2a runtime head: 0c2e9ba68abecd904bae81a9faae5074b4e29fb6
```

The archive contains the accepted A2b2a implementation, its accepted plan, initial code review, remediation, final approval, and later merge/record artifacts.

## 2. Accepted A2b2a result

The final independent review approved A2b2a after one remediation generation. It records:

- one sole production import of `@craftingtable/git` in `repository-observation-adapter.ts`;
- optional strict repository-feature configuration;
- lazy provider creation, cooldown, and permanent invariant-fault latching;
- exact stored digest verification before JSON parsing;
- A1 parse and projection verification;
- explicit repository-class assessment mapping;
- exhaustive A1 code/operation/subject/category/retryability parity;
- no routes, authorization, audit, event, notifier, binding, retirement, or storage mutation;
- 72 test files / 646 Vitest tests plus four Playwright tests in the final gate.

A2b2b must preserve this boundary rather than broadening it informally.

## 3. Current source shape

### 3.1 Repository feature configuration

`apps/server/src/config.ts` already supports:

```text
feature disabled when all repository variables are absent
strict failure when configuration is partial or malformed
explicit allowed roots and reserved roots
explicit Git executable or search path
creation / inspection / command deadlines
stdout / stderr / termination bounds
provider retry delay
```

The daemon can therefore remain useful for planning with the repository feature disabled.

### 3.2 Provider

`RepositoryInspectorProvider` has:

```text
disabled
idle
creating
available
cooldown
permanently-unavailable
```

Concurrent `get()` calls share one creation promise. Temporary creation failure enters cooldown. Adapter vocabulary/invariant faults latch permanently.

Provider failure occurs before repository observation and cannot truthfully become an inspection row under the accepted schema.

### 3.3 Observation port

The accepted port exposes:

```ts
inspect(requestedPath)
verifyStored(successfulInspection)
verifyRegisteredIdentity(repository, verifiedObservation)
compare(verifiedBaseline, currentEvidence)
```

Registration has no existing `RegisteredRepository` or stored baseline, so it cannot use `compare` without fabricating one. The correct source-grounded change is one narrow fresh-evidence comparison method in the same adapter.

### 3.4 Domain reducer

The accepted reducer handles:

```text
same
risk-evidence-changed
environment-evidence-changed
core-identity-changed
repository-class-changed
unavailable
evidence-invalid
no-state-change-failure
```

and explicit `apply-assessment`, `reaffirm-environment`, and `retire` commands.

For reaffirmation:

- only `identity-evidence-changed` may proceed;
- an environment-different, same-core observation advances the baseline and activates;
- same/risk-only is `reaffirmation-not-required`;
- core/class/unavailable/evidence-invalid/no-state failures use ordinary governed results.

B2b must follow this accepted behavior rather than silently changing reaffirmation semantics.

### 3.5 Storage

A2a storage currently supports:

```text
register
appendVerification
applyTransition
reaffirmEnvironment
retireWithBindings
binding insert/retire
repository/inspection/binding queries
```

The source gap is narrow:

- `appendVerification` requires `kind:'verification'`;
- `reaffirmEnvironment` inserts only a successful baseline-advancing reaffirmation;
- failed and non-advancing reaffirmation attempts cannot be appended with their true kind.

The schema already permits successful and failed reaffirmation records. No migration is needed.

### 3.6 Public contracts

Strict repository contracts already exist for all intended B2b routes. Common detail and administrative detail are separate. Inspection history exposes bounded summary evidence and never exact observation JSON.

The one contract mismatch is the reaffirmation response, which currently requires a successful inspection and cannot represent a failed but durably recorded reaffirmation attempt.

### 3.7 Journal

B1 has already established all B2b event kinds and structural correlations. B2b needs no migration or event vocabulary expansion.

### 3.8 Browser

B1 already made event storage, browser invalidation, and activity descriptions exhaustive. B2b adds no repository page or new browser fetch. CT-04E remains the visual repository workflow.

## 4. Source-grounded process decision

Unlike A2a and earlier B2 subdivisions, B2b now forms one coherent implementation slice:

```text
no schema migration
no event schema change
no browser UI
one route module
one accepted observation boundary
one accepted persistence boundary
one accepted journal boundary
```

A further split now would mostly separate route/service wiring from the transaction semantics they must prove together. Phase A should retain one slice unless actual target-tree reconciliation crosses the explicit fan-out triggers.

## 5. Source gaps that must not be improvised during coding

### 5.1 Fresh comparison

Lifecycle code must not duplicate A1 comparison logic. Add a narrow adapter/port method and review it.

### 5.2 Reaffirmation evidence

Do not write a failed or non-advancing reaffirmation as `verification`. Add a narrow storage capability that preserves the operator action.

### 5.3 Provider failures

Do not invent inspection rows for feature-disabled/provider-creation failures. They are command audit outcomes before observation.

### 5.4 Response semantics

Do not force all reaffirmation results through a successful-inspection response. The strict response must represent the recorded inspection truthfully and state whether the baseline advanced.

## 6. Existing patterns to reuse

- `WorkspaceService.requireRole` and non-disclosing 404 behavior;
- `authorizeMutation` for session, CSRF, and origin;
- `WorkItemService.admit` for read-before-write, re-read inside immediate transaction, state/audit/event atomicity, commit-then-notify, and idempotent no-op;
- strict Zod parsing in routes and services;
- `CraftingTableStorage.transaction` as the outer immediate transaction;
- B1 event append and structural correlation;
- route inventory and forbidden-scope checks.

## 7. Source-to-target disposition

| Current source | B2b disposition |
|---|---|
| `repository-observation-port.ts` | add narrow fresh-observation comparison |
| `repository-observation-adapter.ts` | implement comparison through exact verification and A1 comparator |
| `repository-inspector-provider.ts` | consume unchanged |
| `repository-observation-policy.ts` | consume unchanged |
| `packages/domain/src/repository.ts` | consume accepted reducer; no new state semantics expected |
| `packages/contracts/src/repository.ts` | broaden reaffirmation result to truthful inspection union and baseline flag |
| `packages/contracts/src/auth.ts` | add generic `service-unavailable` error code |
| `packages/storage/src/repository-types.ts` | add narrow standalone verification/reaffirmation append API |
| `repository-registry/index.ts` | implement append generalization; preserve A2a constraints |
| migrations 0003/0004 | frozen; no new migration |
| `apps/server/src/services` | add query and lifecycle services plus mappers/errors |
| `apps/server/src/routes` | add strict repository routes only |
| `apps/server/src/server.ts` | inject services, register routes, map typed errors |
| `apps/server/src/composition.ts` | compose lifecycle services from provider/storage/notifier |
| `apps/server/src/test-support.ts` | inject provider/port and failure controls |
| `apps/server/src/route-inventory.test.ts` | add exactly seven routes |
| `apps/web` | no change expected |

## 8. Honest limitations after B2b

- no startup/background repository reconciliation;
- read status may be older than the current host state, but responses expose evidence recency;
- no real second-UID or root-host acceptance environment beyond A1's injected boundary tests;
- no mutation-risk decision from registration-time risk evidence;
- no repository retirement or binding yet;
- no repository UI yet;
- no hard-daemon-death process-lifetime guarantee beyond accepted A1 limitations.
