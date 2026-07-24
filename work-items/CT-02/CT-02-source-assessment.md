# CT-02 source assessment

**Repository:** `zed-colonel/craftingtable`  
**Accepted baseline:** `693445257d61222959c2efa9fc82c621fa8c6653`  
**Assessment date:** 2026-07-23  
**Purpose:** reconcile the original CT-02 planning assumptions with the actual accepted CT-01 implementation

## 1. Executive assessment

CT-01 produced a good foundation for CT-02. The repository is small, the package graph is explicit, the server is dependency-injected, the browser validates wire data, the daemon remains loopback-only, and the review/remediation cycle closed every known CT-01 acceptance defect.

CT-02 does **not** need to undo the established architecture. It needs to replace one deliberately temporary runtime path:

```text
FakeAgentBackend
    → per-connection AgentEventEnvelope sequence
    → /api/events
    → browser clears and rebuilds from fake replay
```

with:

```text
SQLite state + audit + workspace event transaction
    → transactionally consistent workspace snapshot
    → durable cursor
    → authenticated workspace SSE replay
    → live tail
    → idempotent browser projection
```

Authentication and workspace membership then wrap every persistent query, command, and stream.

The key implementation risk is not UI complexity. It is establishing one unambiguous durability and authorization boundary that later project, Git, agent, verification, review, and merge features can reuse.

## 2. Accepted baseline and review status

The accepted commit records the CT-01 remediation review as approved. The final review confirms:

- all five initial findings are closed;
- `pnpm check` passes end to end;
- 43 unit tests across 10 files pass;
- one fresh-server Playwright smoke test passes;
- no CT-02-or-later scope was introduced;
- the current domain/contracts/package layering remains suitable for CT-02.

The closed findings remain useful design constraints:

| Finding | CT-02 consequence |
| --- | --- |
| Non-loopback daemon binding | Authentication does not authorize LAN exposure yet. Keep the loopback restriction until CT-08 supplies TLS and deployment hardening. |
| E2E could reuse stale servers | Every CT-02 acceptance test must own its data directory and daemon process. No test may silently connect to an unrelated instance. |
| SSE outage lacked visible state | The durable stream must preserve the tested reconnect/disconnected/recovery behavior. |
| Scope checker missed valid imports | New storage/auth packages remain covered by the existing Exo Stack dependency guard. |
| Literal `pnpm check` was not reproducible | Native SQLite/password dependencies must install and execute under pnpm-managed Node `24.18.0`. |

## 3. Current repository shape

The accepted workspace is:

```text
apps/
├── server
└── web

packages/
├── agents
├── contracts
├── domain
├── git
└── testing
```

Supporting areas include:

```text
docs/decisions
fixtures/agent-events
implementation-reports
review-findings
scripts
e2e
work-items
init
```

The root quality gate is:

```text
format:check
→ lint
→ typecheck
→ build
→ unit/integration tests
→ Playwright
→ forbidden-scope check
```

The workspace uses pnpm-managed Node `24.18.0`, strict TypeScript project references, Fastify 5, React 19/Vite 8, Zod 4, Vitest, Playwright, Biome, and tsx.

## 4. Current strengths to retain

### 4.1 Dependency direction is explicit

`packages/domain` is pure TypeScript. `packages/contracts` owns Zod wire schemas. The application packages depend downward, and TypeScript project references enforce the graph.

CT-02 should add one meaningful infrastructure boundary:

```text
@craftingtable/storage
```

The SQLite driver, migrations, transaction helpers, and repository implementations belong there. Fastify, React, and HTTP types do not.

### 4.2 Server construction is testable

`apps/server/src/server.ts` exports `buildServer(deps, options)` and registers routes through injected dependencies. This is a strong seam for CT-02.

The dependency object should evolve from:

```text
backend
Git service
```

into services such as:

```text
auth service
workspace service
snapshot service
event journal / stream service
audit query service
```

The composition root in `apps/server/src/index.ts` should open storage, apply migrations, construct services, start Fastify, and close dependencies in the correct shutdown order.

### 4.3 The browser already treats wire data as untrusted

`useEventStream` parses JSON and validates the envelope through the shared Zod schema before dispatch. This is the correct habit.

CT-02 should preserve shared validation for:

- login requests and responses;
- authenticated-session snapshots;
- workspace lists;
- workspace snapshots;
- audit pages;
- durable workspace events.

### 4.4 SSE is already the accepted transport

ADR-003 correctly separates server-to-browser live events from authenticated HTTP commands. The endpoint already emits event IDs and heartbeat comments.

CT-02 therefore needs to change semantics, not transport:

```text
per-connection fake cursor
    → durable database cursor

unscoped stream
    → authenticated workspace stream

clear on every open
    → hydrate snapshot, then apply only unseen events
```

### 4.5 UI language is established

The warm-neutral shell, workspace header, status regions, connection badge, and activity panel form a useful visual foundation. CT-02 can introduce login and persistent workspace identity without redesigning the application.

### 4.6 Review artifacts are already part of the repository culture

CT-01 retained:

- accepted work contract;
- accepted implementation plan;
- completion report;
- initial review findings;
- remediation report;
- remediation review.

CT-02 should follow the same pattern. This is particularly important because CraftingTable is itself intended to automate that workflow later.

## 5. Temporary CT-01 mechanics that must be replaced

### 5.1 Direct backend-to-SSE streaming

Current route:

```text
GET /api/events
    → AgentBackend.streamEvents()
    → validate AgentEventEnvelope
    → write SSE frame
```

This makes the backend invocation, event source, and browser delivery one in-memory lifecycle. It cannot survive daemon restart, cannot authenticate a workspace, and cannot replay an authoritative history.

Target:

```text
backend or domain operation
    → validate normalized event proposal
    → commit to SQLite journal
    → SSE reads committed journal
```

A future agent backend may propose events, but it must never write directly to browser connections.

### 5.2 Per-connection fake sequence

`FakeAgentBackend` begins `sequence` at zero for every connection and generates new UUIDs. The same conceptual scripted run therefore becomes a different event history on every refresh.

That is correct for CT-01 demonstration and wrong for CT-02 persistence.

Database insertion must assign durable identity and sequence once. Reconnection re-delivers the same immutable records.

### 5.3 Browser clears state on every open

`reduceStreamState` currently clears all events when EventSource reaches `open`, because CT-01 intentionally replays the fake script per connection.

CT-02 must remove that behavior. The browser needs explicit actions such as:

```text
snapshot-loaded
stream-opened
event-received
stream-error
authentication-expired
```

`stream-opened` changes connection state only. It must not erase the hydrated snapshot.

### 5.4 Agent-specific envelope as the root live type

`AgentEventEnvelope` was intentionally minimal for the fake dashboard. CT-02 introduces durable events caused by system bootstrap and future user commands as well as later agent activity.

The live journal should therefore become workspace-oriented rather than agent-oriented. Agent-run identifiers remain optional correlation fields.

### 5.5 Simulated normal runtime

The current composition root always loads the demo fixture, fake Git service, and fake agent backend. The dashboard is correctly marked simulated.

CT-02 should stop using that path as the normal runtime. A durable bootstrapped workspace and its immutable creation event are enough to prove persistence. Fakes remain valuable in tests and may support an explicit developer fixture, but they must not compete with SQLite as the authoritative event source.

## 6. Source-to-target disposition

| Current area | Current responsibility | CT-02 disposition |
| --- | --- | --- |
| `packages/domain/src/ids.ts` | Branded seed IDs | Retain and add session, membership, and audit IDs plus role/status vocabulary. |
| `packages/domain/src/event-kinds.ts` | Three fake agent kinds | Replace or generalize for a minimal durable workspace-event vocabulary. Avoid designing CT-03+ kinds. |
| `packages/contracts/src/agent-event.ts` | CT-01 SSE envelope | Replace as primary live contract with workspace event envelope; retain agent correlation fields as optional. |
| `packages/contracts/src/health.ts` | Health response | Retain. Add optional storage readiness details only if they do not expose sensitive paths. |
| `packages/agents` | Narrow fake backend seam | Retain deferred seam. Do not expand to real execution in CT-02. |
| `packages/git` | Narrow fake Git seam | Retain deferred seam. Do not invoke real Git in CT-02. |
| `packages/testing/FakeAgentBackend` | Per-connection scripted stream | Remove from production composition; keep or reshape for tests only. |
| `apps/server/src/index.ts` | Compose fakes and listen | Become composition root for config, storage, migrations, services, Fastify, and shutdown. |
| `apps/server/src/server.ts` | Register health/events | Register auth, workspace, snapshot, audit, and durable event routes through service dependencies. |
| `apps/server/src/routes/events.ts` | Stream backend iterator | Rewrite as authenticated journal replay/live-tail adapter. |
| `apps/server/src/config.ts` | Loopback host/port | Retain restrictions; add validated data-directory, origin, cookie, and session settings. |
| `apps/web/src/lib/useEventStream.ts` | Connect to unscoped fake stream | Require authorized workspace URL and initial cursor; preserve state across reconnect. |
| `apps/web/src/lib/streamState.ts` | Clear on open; append events | Add snapshot hydration and event dedup/order handling; never clear solely because a stream opened. |
| `apps/web/src/App.tsx` | Static demo workspace | Add unauthenticated login and authenticated workspace shell; no router required. |
| `fixtures/agent-events/demo-run.json` | CT-01 demonstration | Keep as archived/test fixture or remove from normal runtime. Do not seed it automatically as authoritative history. |
| `ADR-002` | Deferred SQLite decision | Resolve and mark accepted. |
| `ADR-003` | Accepted SSE transport, replay deferred | Amend with durable cursor, snapshot, replay, and workspace authorization semantics. |
| `ADR-006` | Loopback until later TLS | Retain unchanged in principle. Auth does not activate LAN use. |
| `ADR-008` | Toolchain and quality gate | Amend native dependency build permissions and new test commands if needed. |

## 7. Recommended new source areas

The likely target additions are:

```text
packages/storage/
├── package.json
├── tsconfig.json
├── migrations/
│   └── 0001-ct02-foundation.sql
└── src/
    ├── database.ts
    ├── migrations.ts
    ├── transaction.ts
    ├── users.ts
    ├── sessions.ts
    ├── workspaces.ts
    ├── audit.ts
    ├── workspace-events.ts
    └── index.ts

apps/server/src/
├── cli.ts
├── bootstrap.ts
├── services/
│   ├── auth-service.ts
│   ├── workspace-service.ts
│   ├── snapshot-service.ts
│   ├── audit-service.ts
│   └── event-stream-service.ts
├── security/
│   ├── password.ts
│   ├── session-token.ts
│   ├── csrf.ts
│   └── request-auth.ts
└── routes/
    ├── auth.ts
    ├── workspaces.ts
    ├── audit.ts
    └── events.ts

apps/web/src/
├── lib/api.ts
├── lib/authState.ts
├── lib/workspaceProjection.ts
├── lib/useWorkspaceEvents.ts
├── components/LoginPage.tsx
├── components/SessionMenu.tsx
└── components/WorkspaceShell.tsx
```

Names may change during Phase A. The separation of responsibilities should not.

## 8. Storage decision assessment

### 8.1 Why `better-sqlite3` fits this repository

The current daemon is one Node process serving one or a few trusted users. State transitions are small and transactional. `better-sqlite3` provides a direct synchronous transaction API and full SQLite functionality, with prebuilt binaries on major platforms.

This reduces the risk that CT-02 invents an asynchronous repository abstraction around an engine that serializes writes anyway.

The principal costs are:

- a native dependency;
- pnpm build-script approval;
- binding compatibility with the pinned Node runtime;
- the need to include database-driver installation in `pnpm check` evidence.

Those costs are acceptable for the Linux-hosted application and must be proven in CT-02.

### 8.2 Why not `node:sqlite` yet

The project pins Node `24.18.0`. The built-in SQLite module is available and has reached release-candidate status, but it is not yet stability level 2. CraftingTable's authoritative store is the wrong place to gain marginal dependency simplicity by using a still-maturing API.

This can be revisited later behind the storage package without changing domain or HTTP contracts.

### 8.3 Why hand-owned migrations

CT-02 needs one initial schema and strong startup behavior, not an ORM ecosystem. Ordered SQL plus checksums provides:

- inspectable schema history;
- deterministic tests;
- no model layer imposed on the domain;
- direct control of triggers, constraints, and SQLite pragmas;
- a small dependency footprint.

The migration runner must remain deliberately narrow.

## 9. Authentication and authorization assessment

### 9.1 Server-side sessions fit the trust model

CraftingTable will eventually control agents, Git, checks, and merges. A revocable server-side session is a better fit than a self-contained browser token because the daemon can invalidate access immediately and audit session lifecycle.

The raw session token should be treated as authentication-equivalent material. Only its digest belongs in SQLite.

### 9.2 Multi-user readiness is a data-model property in CT-02

The user asked to avoid barriers to later household use. CT-02 can satisfy that without implementing invitations or multi-user execution:

- users are separate from workspaces;
- membership is an explicit join record;
- roles are explicit;
- workspace routes authorize membership;
- event streams are workspace-filtered;
- sessions belong to users;
- audit events identify user and session;
- no global singleton project or workspace state is introduced.

This does not pretend the daemon can safely execute mutually untrusted users' agents. That later execution-isolation problem remains CT-14.

### 9.3 CSRF is part of the foundation, not a CT-08 patch

Even while loopback-only, CT-02 establishes cookie authentication. Mutating requests must therefore have a tested CSRF rule before future LAN access is enabled.

A session-bound synchronizer token plus strict cookies and origin/fetch-metadata checks is proportionate. The browser should never send arbitrary command strings, so the protected command surface remains typed and small.

## 10. Event and snapshot assessment

### 10.1 Do not turn CT-02 into full event sourcing

The plan requires append-only audit records and monotonic domain events. It does not require every current-state query to replay an event log.

Recommended model:

```text
normalized current-state tables
+ append-only audit log
+ append-only workspace event journal
```

A command transaction updates current state and appends the records needed for accountability and browser replay.

This is simpler to query and supports later CT-03–CT-08 work without committing to a generic event-sourcing framework.

### 10.2 Snapshot plus cursor is the critical invariant

The browser must never perform:

```text
query state
    [uncovered time gap]
connect to live events
```

Instead, a snapshot transaction returns state and the highest journal sequence visible in that same read. The event stream begins strictly after that sequence.

### 10.3 In-process notification is an optimization

SQLite is authoritative. An in-memory notifier may wake connected streams after a commit, but a stream must re-query the database and must also use a bounded timeout/poll fallback.

That makes restart, missed notification, and future process-boundary behavior honest:

```text
notification says “check the journal”
not “this transient message is the event”
```

## 11. Likely high-risk implementation mistakes

Review CT-02 specifically for these failures:

1. **Raw session token stored in SQLite.**
2. **Password or token included in structured logs.**
3. **Workspace filtering implemented only in routes or UI.**
4. **Snapshot cursor queried separately from state without one consistent read.**
5. **Event committed between query and waiter registration is lost until reconnect.**
6. **SSE reconnect duplicates visible activity because reducer lacks sequence deduplication.**
7. **SSE route remains directly connected to `AgentBackend`.**
8. **Audit record written after the state transaction and lost on crash.**
9. **Audit or event rows can be updated/deleted through ordinary repositories.**
10. **Migrations mutate previously applied files without checksum detection.**
11. **Tests use the operator's real data directory.**
12. **Vite/Playwright reuses a stale daemon or persistent test database.**
13. **Authentication is used as justification to relax loopback binding.**
14. **A generic command bus, ORM, or event framework appears before there is a real need.**
15. **The current fake stream is retained as a second authoritative runtime path.**

## 12. Decisions intentionally left to the accepted implementation plan

The Phase A implementer should propose and justify:

- exact SQL table and index names;
- exact session expiration interval;
- whether session last-seen writes are throttled or omitted initially;
- exact CLI package/script shape;
- exact Fastify decoration/plugin layout;
- exact origin-check implementation;
- whether CSRF uses a small custom service or a Fastify utility plugin;
- exact workspace snapshot response shape;
- the minimal durable workspace-event kinds;
- exact audit query pagination shape;
- whether the app displays audit history in CT-02 or exposes only the typed query endpoint;
- exact in-process event notifier implementation;
- whether one additional ADR or two are clearer for auth and transaction semantics.

These are implementation decisions, not permission to change the work item's authority, persistence, or scope boundaries.

## 13. Readiness conclusion

The accepted CT-01 source is ready for CT-02.

No preparatory refactor is required before the work item begins. The implementation should proceed from a fresh CT-02 branch or clean worktree rooted at the accepted baseline, with one authoritative implementation path and no compatibility mode for the fake stream.

The first action should be a read-only Codex inspection that produces an accepted implementation plan grounded in the actual source tree. Only then should code changes begin.
