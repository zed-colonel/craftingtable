# CT-04A2 source assessment

## 1. Assessment basis

This assessment uses the operator-provided source bundle:

```text
craftingtable-ct-04a-git-foundation.zip
SHA-256: ee0090898b7cedb1ecd0438f607b1e8ed60f0ec28a99f58b688400f025a2aeea
```

The accepted A1 runtime source is pinned by the final independent review to:

```text
7313e81a56c0188574c436322d7fedc16e08bb70
```

The bundle includes later review and record artifacts. The A1 package source itself is the accepted implementation at that head.

## 2. A1 completion evidence

A1's final review records:

- accepted implementation plan;
- independent design review and disposition;
- one initial implementation generation;
- two remediation generations;
- no unresolved blocking or high findings;
- 60 test files / 476 tests plus four Playwright tests in the final gate;
- one sole production `node:child_process` importer;
- no storage, route, journal, or browser integration.

The final review explicitly authorizes A2 planning and carries two limitations forward:

1. `riskScan`, device evidence, `canonicalGitDirectory`, and `observedAt` are validated but not covered by A1's core fingerprint; A2 owns full-record storage integrity.
2. normal top-level worktree activity can conservatively produce `observation-raced`; A2 registration requires a quiescent window and must not turn that error into identity loss.

The ownership-refusal and root-daemon cases remain covered through injected dependencies rather than a real second UID/root host. A2 should preserve the limitation rather than overstate end-to-end host coverage.

## 3. Accepted A1 API

The package root exports:

```ts
createRepositoryInspector
parseRecordedObservation
compareRepositoryObservations
```

and the public result/error/observation types.

A1 intentionally keeps the CT-01 simulated `GitService` export for existing fake-agent tests. A2 must not confuse that legacy fake seam with the trusted observer.

### Inspector creation

`createRepositoryInspector(options)`:

- accepts explicit source and reserved roots;
- accepts an explicit Git executable or explicit search path;
- validates non-root POSIX operation and Git >= 2.32;
- applies aggregate creation and per-command bounds;
- returns a result rather than throwing expected failures;
- may probe more than one search candidate within the aggregate deadline;
- creates no daemon startup dependency until A2 composes it.

### Inspection

`inspect({ requestedPath, signal })`:

- performs path admission and two fixed repository subprocesses;
- returns a branded parsed observation;
- detects ordinary metadata/layout races conservatively;
- returns bounded typed failure without raw process output;
- is observation-only.

### Stored parse

`parseRecordedObservation(unknown)`:

- is total and strict;
- rejects unknown fields and unsupported versions;
- validates full shape and core fingerprint;
- does not independently authenticate risk scan, device values, canonical Git directory, or timestamp.

### Comparison

`compareRepositoryObservations(recorded, current)` separates:

```text
coreDifferences
environmentalDifferences
riskScanDifferences
sameCoreIdentity
sameEnvironmentalEvidence
sameRiskScanEvidence
```

It rejects inspection-policy mismatch rather than guessing equivalence.

## 4. A1 error contract

A1 errors carry:

```text
category
code
subject
operation
retryability
fixed message
bounded evidence
```

The broad subject is useful for explanation but insufficient for durable state. A2 must map exact codes because `observation-raced` and `path-unavailable` share a broad subject but require different state consequences.

## 5. Current architecture below A1

A1 imports only domain types and Node primitives. Server composition does not import Git. Domain, contracts, storage, and web still reflect the accepted CT-03 planning model.

The current durable patterns are:

```text
state + audit + workspace event in one SQLite transaction
commit
post-commit notifier
snapshot-first browser reconstruction + durable cursor
exhaustive event contracts and switch statements
```

The A2 implementation must follow those patterns rather than creating repository-specific shortcuts.

## 6. Why A2 should fan out

Actual A1 source now provides a clean observational API. The remaining A2 objective still spans:

```text
new domain vocabulary
strict public contracts
major relational schema
append-only evidence
state machine and direct-SQL invariants
server feature configuration
A1 result translation
authorization and command transactions
workspace-events rebuild
event contract/storage/browser exhaustive switches
```

That is again a schema-heavy layer combined with a distinct authenticated service/journal layer. The anticipated `A2a → A2b` seam from the earlier operator disposition is now source-grounded and should be adopted.

## 7. Current persistence patterns relevant to A2a

Migration 0002 demonstrates:

- migration-owned audit and event catalogs;
- full journal table rebuilds when structural correlation changes;
- row-count and maximum-sequence guard checks;
- composite workspace/project/work-item ownership;
- direct triggers for immutability and one-way transitions;
- explicit handling of SQLite `MATCH SIMPLE` nullable dimensions.

A2a should match that standard for repository, inspection, baseline, and binding relationships.

## 8. Current event and browser patterns relevant to A2b

`WorkspaceEventEnvelope` is a strict discriminated union. Adding kinds requires changes to:

```text
packages/domain event vocabulary
packages/contracts workspace-event schemas
packages/storage workspace-event row mapper
apps/web workspace projection
apps/web activity description
associated exhaustive tests
```

This is not a repository UI. It is required compatibility with the accepted journal reconstruction contract.

## 9. Work-contract boundary

CT-03's admitted work-contract draft remains incomplete. A2 may expose a project repository binding and registered repository state, but it must not rewrite the immutable draft or claim that repository/base/scope/verification/backend/environment are all resolved.

Exact base revision belongs to CT-04B.

## 10. Source-to-target disposition

| Current source | A2a | A2b |
|---|---|---|
| `packages/git/src/index.ts` | no change | consume only public accepted API |
| `packages/domain/src/ids.ts` | add repository/inspection/binding IDs | no new authority |
| `packages/domain/src/audit.ts` | add audit action vocabulary | consume |
| `packages/domain/src/event-kinds.ts` | defer repository events | add events |
| `packages/domain/src/workspace-events.ts` | no event records | add repository event records |
| `packages/domain/src/work-contract.ts` | preserve immutable draft | optional read-only resolution projection only if source plan justifies |
| `packages/contracts` | add strict repository API records, excluding event kinds | add event payload schemas |
| `packages/storage/migrations` | schema 3 repository/evidence/binding model | schema 4 journal rebuild and event catalog |
| `packages/storage/src/repositories` | repository/inspection/binding primitives | authoritative command transactions and event mapper integration |
| `apps/server` | no change | config, composition, services, routes, tests |
| `apps/web` | no change | exhaustive event projection/activity compatibility only |

## 11. Source limitations to preserve honestly

- non-root POSIX and Git >= 2.32 only;
- source-root paths containing `:` rejected by A1 ceiling policy;
- cooperative filesystem deadlines;
- no hard-daemon-death orphan guarantee;
- risk scan covers declared names and hooks only;
- A1 fingerprint is core identity, not full-record integrity;
- registration should occur while the repository top level is quiescent;
- no real second-UID/root-host acceptance test in the supplied environment.
