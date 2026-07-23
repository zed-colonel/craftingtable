# ADR-005 — Codex integration path

- **Status:** deferred
- **Date:** 2026-07-23

## Context

The first real agent backend is Codex (CT-05), targeting its app-server interface with `codex exec --json` as fallback (assumption CT-A-01 in `init/craftingtable-adapter-assumption-ledger.yaml`).

## Decision

Deferred until the CT-05 adapter spike. CT-01 ships only the narrow `AgentBackend` seam (see ADR-007) and a fake implementation, keeping vendor event shapes out of the domain vocabulary.

## Notes for the future decision

The spike must prove: session start in a worktree, streamed events, file/command visibility, approvals, follow-up directives, interruption, restart recovery, and separate implementation/review profiles.
