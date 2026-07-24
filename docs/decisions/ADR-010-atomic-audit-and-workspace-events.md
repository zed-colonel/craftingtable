# ADR-010 — Atomic audit and workspace-event writes

- **Status:** accepted
- **Date:** 2026-07-24

## Context

The browser must not observe an event for state that failed to commit, and
security/state changes need durable attributable audit history.

## Decision

Application services use a small storage transaction callback. A successful
workspace-domain mutation writes state, allowlisted audit records, and zero or
more workspace events in one immediate SQLite transaction. The notifier fires
only after commit and carries no data.

Audit events and workspace events use separate global database sequences and
separate vocabularies. Database triggers reject update and delete operations
for both journals. Foreign keys use restrictive deletion.

Bootstrap is CT-02's first complete domain transaction. A refused later
bootstrap is the operator-approved exception to the original CT02-A07 wording:
it writes exactly one safe `admin.bootstrap.denied` audit row and makes no
other mutation.

## Consequences

No event can advertise uncommitted state. Rollback leaves no partial state,
audit, or workspace event. The design is intentionally not a command bus,
event-sourcing framework, workflow engine, or generic unit-of-work layer.

## Alternatives considered

- Writing events after the state transaction — creates observable gaps.
- Treating the notifier as history — loses data on restart.
- Generic event-sourcing/command frameworks — premature and outside CT-02.
