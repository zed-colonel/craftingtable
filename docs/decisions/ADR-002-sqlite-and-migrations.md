# ADR-002 — SQLite library and migration tool

- **Status:** deferred
- **Date:** 2026-07-23

## Context

The implementation plan fixes SQLite in WAL mode as the authoritative workflow store, arriving in CT-02. CT-01 explicitly forbids adding a database.

## Decision

Deferred until CT-02. Nothing in CT-01 persists state; the fake event stream is generated per connection.

## Notes for the future decision

Candidates to evaluate in CT-02: `better-sqlite3` (synchronous, simple) versus `node:sqlite` (built-in, still maturing), plus a migration approach (hand-rolled ordered SQL files versus a small library). The decision must preserve the rule that large artifacts live on the filesystem, not in database rows.
