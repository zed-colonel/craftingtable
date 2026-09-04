# ADR-020 — Execution model and the Claude Code backend

- **Status:** accepted
- **Date:** 2026-09-04

## Context

Six weeks of slice-by-slice contract work had produced a daemon that could import plans
but not delegate anything. The operator asked for the first usable loop in one vertical
slice: pick a work item, register a repository, create a worktree, launch an agent with
the work item as its brief, watch it live from another machine, and read the diff, with
Claude Code as the first backend and the security posture kept.

## Decision

1. **A new, small execution model** (`source_repositories`, `worktrees`, `agent_runs`,
   `agent_run_events`, migration 0005) rather than extending the CT-04A2 repository
   registry. Registration verifies a Git top level and records the head; it does not
   require a quiescent tree, allowed-root configuration, or evidence fingerprints. The
   A1/A2 inspector and evidence tables stay in the tree uncomposed.
2. **A separate per-run event journal** with its own SSE stream. Run output is orders of
   magnitude more voluminous than workspace events; mixing them would make the workspace
   cursor useless. The workspace journal receives only coarse `agent-run-*` and
   `worktree-*` events for invalidation.
3. **Claude Code first, through its headless CLI**, not the Agent SDK or the Messages
   API. The CLI is what the operator already runs and is signed into; stream-json in and
   out gives a multi-turn session with follow-up messages; spawning it keeps the daemon
   free of vendor SDKs. The adapter is the only module that knows the vendor format.
4. **Vendor-neutral run vocabulary.** Roles, permission postures, statuses, and event
   kinds are CraftingTable's own. Codex or another agent is a second `AgentBackend`.
5. **Roles and lineage as the orchestration seam.** `implement`, `review`, and `design`
   briefs plus `parentRunId` are enough for a later orchestrator to chain cycles; no
   workflow engine is introduced now.
6. **LAN with TLS.** The daemon may bind a non-loopback host only with a certificate or
   an HTTPS origin behind a proxy, serves the built UI itself, and keeps cookie, CSRF,
   and origin policy unchanged. This closes ADR-006.

## Consequences

- Process authority is now three modules, listed and enforced by the scope check.
- The slice-contract process, its route denylist, and its per-slice allowlists are
  retired (`archive/CT-04`).
- Approvals, automated review cycles, merge from the UI, and Codex remain future work
  on top of this model rather than prerequisites for using it.
