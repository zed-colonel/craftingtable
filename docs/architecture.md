# Architecture

CraftingTable is one daemon and one browser app. The daemon owns all state and every
command; the browser is an authenticated projection reconstructed from a durable
snapshot plus an event cursor.

## Packages and dependency direction

```text
domain      pure TypeScript records, branded identifiers, closed vocabularies
contracts   strict Zod HTTP/SSE schemas (depends on domain)
planning    pure plan-bundle parsing, validation, graph, digest (depends on domain)
storage     SQLite, migrations, repositories (depends on domain)
git         worktree/diff operations and the read-only inspector (depends on domain)
agents      agent backend seam and the Claude Code adapter (depends on domain)
server      Fastify routes, services, composition (depends on all of the above)
web         React projection (depends on domain + contracts only)
```

Only `storage` owns SQL. Only three modules may spawn a process, and
`scripts/check-forbidden-scope.mjs` enforces that list: the Git inspector runner,
the Git operations module, and the Claude Code process supervisor. No package depends
on ActionQueue, WorldInterface, Exoskeleton, or any other supervised project.

## The execution model

```text
SourceRepository   a registered local checkout (path, default branch, head at registration)
Worktree           a linked worktree on a fresh branch, bound to one work item and repository
AgentRun           one supervised agent session in a worktree: backend, role, permission
                   posture, brief, status, cost, turns, optional parentRunId lineage
AgentRunEvent      the normalized per-run journal: session-started, user-message,
                   assistant-message, tool-call, tool-result, turn-completed, notice,
                   stderr, run-finished
```

Run status: `starting → running ⇄ waiting → finished | failed | cancelled | interrupted`.
Transitions are guarded by expected-status sets so a late process callback can never
regress a run the operator already cancelled. A daemon restart moves every live run to
`interrupted`.

Roles (`implement`, `review`, `design`) select a brief template. Together with
`parentRunId` they are the composition seam for orchestrated design/implement/review
cycles: an orchestrator chains runs by role and lineage without new vocabulary.

## Agent backend seam

`packages/agents` defines `AgentBackend` (`describe`, `launch`) and `AgentSession`
(`items`, `send`, `end`, `kill`). A backend owns the child process and translates the
vendor's native output into `NormalizedAgentEvent`s; the daemon owns run state, the
journal, audit, and workspace events. Raw vendor lines are retained, bounded, on each
event for diagnostics but are never the durable vocabulary.

The Claude Code adapter launches `claude -p --input-format stream-json
--output-format stream-json` with the brief as the first stdin message, keeps stdin
open for follow-ups, maps the vendor-neutral permission posture to a CLI permission
mode, and terminates the process group on cancel. Adding Codex means adding another
`AgentBackend`.

## Git boundary

`createGitOperations` covers exactly what the loop needs: inspect a top-level checkout,
create a worktree on a new branch from an exact base revision, remove a worktree, and
diff a worktree against its base (commits, per-file status and counts, bounded unified
patch including untracked files). Argument arrays only, bounded lifetime and output,
process-group termination, and paths reach Git only as `cwd` or after `--`.

The CT-04A1 read-only inspector and its repository-evidence persistence remain in the
tree, uncomposed. They are superseded for the working loop by the simpler source
repository model and are candidates for removal.

## Events

Two journals, one notifier:

- `workspace_events` is the coarse workspace journal the browser follows to invalidate
  its queries. Execution adds `source-repository-registered`, `worktree-created`,
  `worktree-removed`, `agent-run-started`, and `agent-run-status-changed`.
- `agent_run_events` is the high-volume per-run journal, streamed per run over
  `GET /api/workspaces/:id/runs/:runId/events`.

Every mutation writes state, audit rows, and events in one immediate SQLite transaction;
the in-process notifier fires after commit and carries no data. Streams re-authenticate
on every iteration and never touch the session's last-seen time.

## Browser

The app has no router library and no data-fetching library. Routes are parsed by a pure
function; the projection reducer marks scopes stale on events and the app refetches the
authoritative endpoints. The run page loads the committed events once and then follows
the live stream from the last sequence. No agent output is ever rendered as markup.
