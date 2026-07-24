# ADR-003 — Durable workspace SSE event contract

- **Status:** accepted
- **Date:** 2026-07-23
- **Amended:** 2026-07-24 for CT-02 durable replay

## Context

The browser needs one-way live updates and restart-safe reconstruction.
Commands remain ordinary authenticated HTTP requests. CT-01's direct fake
backend stream and per-connection sequence were only executable scaffolding.

## Decision

Live updates use authenticated, workspace-scoped SSE:

```text
GET /api/workspaces/:workspaceId/events?after=<global-sequence>

event: workspace-event
id: <global-database-sequence>
data: <JSON WorkspaceEventEnvelope>
```

The strict version-1 envelope contains `id`, `sequence`, `occurredAt`,
`workspaceId`, `kind`, `payload`, optional `actorUserId`, `projectId`,
`workItemId`, and `runId`, plus `schemaVersion`. CT-02 defines only the honest
`workspace-created` kind.

SQLite assigns one global monotonically increasing sequence. Queries filter by
authorized workspace, so cross-workspace gaps are valid. Events are immutable
and unique by both sequence and event ID. The endpoint uses the greater valid
cursor from `after` and `Last-Event-ID`, replays ascending committed rows, then
tails through SQLite re-query. Heartbeat comments remain every 15 seconds.

A snapshot and `asOfSequence` are read in one transaction. The browser hydrates
that snapshot before connecting after the cursor, revalidates every payload,
and ignores duplicates by sequence. Opening or reconnecting never clears the
projection.

The in-memory notifier is only a wakeup optimization: generation is sampled
before querying, registration rechecks generation, and a bounded timeout
forces another durable query. Session and membership are periodically
revalidated while streaming. Revocation emits the typed
`authentication-expired` control event and closes the stream.

## Consequences

Refresh, disconnect, missed notification, and daemon restart reconstruct from
SQLite. At-least-once network behavior is harmless to the idempotent browser.
No normal-runtime path streams `AgentBackend` events directly.

## Alternatives considered

- WebSockets — unnecessary bidirectional capability.
- Polling — less responsive and still needs cursor semantics.
- Process-memory replay — loses authoritative history on restart.
