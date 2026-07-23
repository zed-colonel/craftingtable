# ADR-003 — SSE event contract

- **Status:** accepted
- **Date:** 2026-07-23

## Context

The browser needs live, reconnectable, server-to-client updates. Commands will remain ordinary authenticated POST requests (CT-02+), so bidirectional transport is unnecessary.

## Decision

- Live updates use **server-sent events** at `GET /api/events`.
- Each normalized event is one SSE frame:

  ```text
  event: agent-event
  id: <sequence>
  data: <JSON AgentEventEnvelope>
  ```

- `AgentEventEnvelope` is defined once in `@craftingtable/contracts` (Zod) with fields `id`, `sequence`, `occurredAt`, `workspaceId`, optional `projectId`/`workItemId`/`runId`, `kind`, and a per-kind `payload` (discriminated union). The server validates before writing; the browser validates before rendering and never displays an invalid event.
- The CT-01 kind vocabulary is deliberately minimal: `run-started`, `status-changed`, `completion-proposed`. It extends toward the implementation plan's §8.2 list only when a work item needs it.
- Comment lines (`:connected`, `:hb` every 15 s) keep intermediaries from timing out the stream.
- The CT-01 fake source replays a deterministic scripted run per connection and then holds the stream open, so a page refresh reproduces the demonstration without a reconnect-replay loop.

## Consequences

- Native browser `EventSource` reconnection works without client libraries.
- `sequence` is per-stream and monotonic. **Deferred to CT-02:** durable global event sequencing, `Last-Event-ID` resume/replay, and snapshot queries; the `id:` field is already emitted so replay can be added without changing the wire shape.

## Alternatives considered

- **WebSockets** — bidirectional capability CraftingTable does not need; commands stay HTTP so they remain auditable, authenticated requests.
- **Polling** — simpler but loses liveness and costs more once runs stream many events.
