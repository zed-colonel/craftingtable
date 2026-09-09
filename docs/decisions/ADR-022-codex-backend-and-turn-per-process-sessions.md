# ADR-022 — Codex backend and turn-per-process sessions

- **Status:** accepted
- **Date:** 2026-09-09
- **Supersedes:** ADR-005

## Context

CraftingTable needs implementation, review, follow-ups and remediation on either
Claude Code or Codex without introducing vendor events into the daemon's durable
vocabulary. Codex CLI 0.153.4 runs one turn per `exec` process.

## Decision

Use `codex exec --json`, with prompts on stdin and subsequent turns sent through
`codex exec resume <thread-id>`. `CodexSession` keeps the existing `AgentSession`
open between processes, serializes queued messages, drains accepted messages on
end, and terminates the active process group on cancellation. Unexpected exits,
missing completion events and failed turns close the session as failed. Both
adapters share the existing process-authority module and bounded text helpers.
Tool IDs include the turn number because Codex restarts item IDs on resume.

The daemon selects from a registry in the fixed order Claude Code, then Codex,
unless the operator explicitly chooses a backend. Status lists both, including
unavailable tools. Remediation uses the latest finished implementer's backend and
model in the same worktree, falling back to the review. The browser reloads this
history before starting remediation. The merge gate requires a successfully
finished review; a failed or cancelled session cannot authorize a merge.

For both initial and resumed turns, `auto` and `edit-only` set
`-c sandbox_mode="workspace-write" -c approval_policy="never"`. This adapter does
not enable Codex automatic approval review. `unrestricted` uses the explicit
approval-and-sandbox bypass flag. External brief reads work without `--add-dir`,
which would grant additional write access. Credentials remain owned by the CLI.

The observed JSONL reports token usage but no dollar cost, resolved model or
credential source. Cost remains absent; the model field records the requested
model or `default`. Billing is `api-key` when a key environment variable is
present, otherwise `unknown`; this is an environment inference, not a provider
billing report. The UI describes these limitations.

Migration 0007 rebuilds only `agent_runs` to widen its backend constraint. A
migration explicitly marked `requires: foreign_keys=off` runs outside any caller
transaction, disables enforcement before its transaction, checks all foreign keys
before commit, and restores enforcement on success or failure. Existing runs,
lineage, events, indexes and append-only journal protections are retained.

## Consequences and alternatives

The browser and durable events remain vendor-neutral. The daemon recognizes
activity from queued turns after a preceding result moved the run to waiting.
Interrupted sessions remain interrupted after restart; durable thread resumption,
interactive approvals and cycle orchestration are deferred.

The app-server protocol could support richer supervision later, but is not needed
for this slice. The adapter can adopt it without changing the daemon's run model.
Protocol evidence is the captured two-turn fixture and the linked sources in the
implementation plan; deterministic process and browser tests cover the full loop.
