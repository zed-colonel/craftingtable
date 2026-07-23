# Architecture boundaries (CT-01)

This document records the package boundaries established in CT-01 and the rules that keep them honest. `AGENTS.md` states the governing principles; this file maps them to the actual workspace.

## Dependency direction

Dependencies point strictly downward. TypeScript project references (`tsc -b`) enforce the graph — a package cannot import something it does not reference.

```text
domain          pure TS, zero runtime deps: branded IDs, event-kind vocabulary
   ▲
contracts       Zod schemas: HealthResponse, AgentEventEnvelope; wire types inferred
   ▲                    ▲
agents  git             │      interfaces only: AgentBackend, GitService
   ▲     ▲              │
   testing              │      FakeAgentBackend, FakeGitService — the test/dev boundary
      ▲                 │
   apps/server ─────────┤      Fastify; composes fakes; validates at the boundary
   apps/web ────────────┘      React/Vite; consumes contracts; never trusts wire data
```

## Rules

- **The daemon is authoritative.** The browser renders projections of server state and will submit typed commands (CT-02+). It never invokes Git or processes.
- **`domain` stays pure.** No HTTP, React, process, Git, or vendor-SDK types. Branded IDs make `WorkspaceId`, `ProjectId`, etc. non-interchangeable at compile time.
- **`contracts` is the single validation point.** The server validates every payload before writing it to the wire; the browser re-validates before rendering. Neither side defines its own wire types.
- **`agents` and `git` are seams, not features.** They hold the narrowest interfaces that let the server depend on abstractions. The complete future contracts are deliberately not designed yet (ADR-005, ADR-007).
- **Fakes live in `testing`.** `FakeAgentBackend` replays a deterministic scripted run from `fixtures/agent-events/demo-run.json`; `FakeGitService` returns a canned snapshot. In CT-01 the server composes these fakes at its entry point (`apps/server/src/index.ts`) because no real implementations exist; that composition point is where real adapters plug in later.
- **Raw vendor events are not domain vocabulary.** Only normalized `AgentEventEnvelope` values cross package boundaries.
- **No Exo Stack runtime dependencies.** `pnpm check:scope` fails the build if ActionQueue, WorldInterface, or Exoskeleton appears in any dependency field or import specifier.

## What is deliberately fake or absent in CT-01

- The agent backend, Git service, and every event shown in the UI are simulated and labeled as such.
- No persistence: the event stream is regenerated per SSE connection.
- No authentication, users, workspaces-as-data, plan import, worktrees, diffs, verification runners, reviews, merges, or LAN exposure. See `work-items/CT-01.md` non-goals and the deferred ADRs.
