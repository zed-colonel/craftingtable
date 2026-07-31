# ADR-018 — Repository journal correlation

- **Status:** accepted
- **Date:** 2026-07-29

## Context

Schema 3 persists repository identity, immutable inspections, lifecycle state,
and project bindings, while the workspace journal represents only the four
CT-02/CT-03 kinds. Later lifecycle commands need one durable event boundary
that the existing snapshot/SSE/browser path can reconstruct without giving B1
Git, command, route, or service authority.

Repository events copy IDs into both structural columns and strict payloads.
The database can authoritatively prove the ownership graph through composite
foreign keys, but JSON-aware equality and retirement CHECKs would duplicate
contract semantics in SQLite and make future schema evolution brittle.

## Decision

Schema 4 registers exactly five kinds while retaining envelope version 1:

```text
repository-registered
repository-status-changed
repository-evidence-changed
project-repository-bound
project-repository-binding-retired
```

`workspace_events` gains nullable repository, inspection, and binding
correlation columns. Composite foreign keys tie them to the same workspace and,
for inspections and bindings, the same repository/project graph. Kind-scoped
CHECK arms require or forbid structural dimensions, and the default arm forces
all repository correlations to NULL for an unlisted future kind.

Migration 0004 preserves row count, order, IDs, exact payload bytes, and the
captured `sqlite_sequence` value. It restores the existing index and
append-only triggers and aborts atomically if its guards fail.

The database proves **ownership** and the contracts prove **semantics**. This
applies ADR-003's existing division to correlation as well as payload shape:

- strict Zod variants prove structural/payload ID agreement, version
  relationships, status/reason validity, and retirement/inspection coupling;
- append asserts ID agreement before inserting;
- the row mapper rechecks agreement and retirement coupling when reconstructing
  durable history;
- migration 0004 adds no payload-aware correlation or retirement CHECK.

The browser uses new events only as invalidation signals. Registration, status,
and evidence events stale the repository list and structural repository ID.
Binding events stale structural project and repository IDs. Pending repository
IDs retain stable unique order and are capped at 100. B1 adds no consumer for
those repository scopes.

## Consequences

Unknown kinds, contradictory structural shapes, payload ID disagreement, and
invalid retirement coupling fail closed before a read batch is returned. A
snapshot or SSE query never partially advances through a poisoned batch.

The journal is intentionally not complete inspection history. `verified`,
`environment-evidence-still-changed`, and `failure-recorded` inspection
outcomes produce no B1 event. CT-04E must fetch inspection history when a view
needs it.

Repository journal correlation and bounded browser invalidation vocabulary now
exist; no usable repository lifecycle command, service, route, notifier
producer, configuration, repository fetch, or repository UI exists. B2
lifecycle producers and CT-04E consumers remain absent.

## Alternatives considered

- Payload-aware equality and retirement CHECKs — rejected because they
  duplicate contract semantics in SQLite; structural ownership remains fully
  enforced.
- Infer structural IDs from payload JSON — rejected because callers must supply
  ownership correlations explicitly.
- Add a sixth inspection-history event — rejected because B1 owns only the five
  contracted lifecycle summaries.
- Add repository fetches or views now — deferred to CT-04E.

## Related decisions

- [ADR-003 — Durable workspace SSE event contract](ADR-003-sse-event-contract.md)
- [ADR-013 — Journal vocabulary catalogs](ADR-013-journal-vocabulary-catalogs.md)
- [ADR-017 — Repository evidence and persistence](ADR-017-repository-evidence-and-persistence.md)
