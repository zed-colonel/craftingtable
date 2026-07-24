# CT-01 Accepted Implementation Plan — Scope, repository contract, and executable skeleton

**Status:** accepted by the operator on 2026-07-22. This is the plan of record for CT-01 execution; `work-items/CT-01.md` remains the binding acceptance contract.

## Context

CT-01 turns the seeded `craftingtable` repository (currently planning artifacts only) into a small, executable pnpm/TypeScript monorepo that proves the architectural boundaries: a Fastify server, a React/Vite dashboard shell, shared Zod-validated contracts, a fake `AgentBackend` and fake `GitService` behind narrow interfaces, and one normalized fake agent event flowing over SSE into the browser. `work-items/CT-01.md` is the binding contract; `AGENTS.md` sets architectural and quality boundaries; `docs/ui-principles.md` governs the shell's visual language.

**Explicit non-goal confirmation:** this plan implements **no** authentication, **no** SQLite or migrations, **no** real Git operations, **no** real agent integration (Codex/Claude Code/OpenCode), **no** diff viewing, **no** Planning Studio, **no** multi-user activation, **no** LAN/TLS/systemd deployment, and **no** Exo Stack runtime dependency (a forbidden-scope check enforces the last one).

## 1. Exact target file tree

```text
craftingtable/
├── package.json                  # root: private, scripts, engines, pnpm.onlyBuiltDependencies
├── pnpm-workspace.yaml           # apps/*, packages/*
├── pnpm-lock.yaml                # generated
├── .npmrc                        # engine-strict=true
├── .nvmrc                        # Node version pin (see risks)
├── tsconfig.base.json            # strict, shared compiler options
├── tsconfig.json                 # solution file: project references
├── biome.json                    # formatter + linter config
├── playwright.config.ts          # smoke test, chromium only, webServer entries
├── README.md                     # existing charter + dev quickstart (extended)
├── CONTRIBUTING.md               # new
├── docs/
│   ├── architecture.md           # new: package boundaries + dependency direction
│   ├── ui-principles.md          # existing, unchanged
│   └── decisions/
│       ├── README.md             # existing, unchanged
│       ├── ADR-001-server-and-web-framework.md    # accepted
│       ├── ADR-002-sqlite-and-migrations.md       # deferred
│       ├── ADR-003-sse-event-contract.md          # accepted
│       ├── ADR-004-diff-viewer.md                 # deferred
│       ├── ADR-005-codex-integration.md           # deferred
│       ├── ADR-006-local-tls.md                   # deferred
│       ├── ADR-007-agent-execution-boundary.md    # deferred
│       └── ADR-008-toolchain-and-quality-gates.md # accepted (companion tooling ADR allowed by CT-01)
├── scripts/
│   └── check-forbidden-scope.mjs # fails on ActionQueue/WorldInterface/Exoskeleton deps or imports
├── fixtures/
│   └── agent-events/
│       └── demo-run.json         # scripted fake run: ordered event templates
├── packages/
│   ├── domain/
│   │   ├── package.json          # @craftingtable/domain — zero runtime deps
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── ids.ts            # branded IDs + guarded factories
│   │       └── event-kinds.ts    # event-kind vocabulary (const)
│   ├── contracts/
│   │   ├── package.json          # @craftingtable/contracts — deps: zod, domain
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── health.ts         # HealthResponse schema
│   │       └── agent-event.ts    # AgentEventEnvelope schema + SSE wire notes
│   ├── agents/
│   │   ├── package.json          # @craftingtable/agents — deps: domain, contracts
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts          # AgentBackend interface, BackendDescriptor
│   ├── git/
│   │   ├── package.json          # @craftingtable/git — deps: domain
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts          # GitService interface, RepositorySnapshot
│   └── testing/
│       ├── package.json          # @craftingtable/testing — deps: domain, contracts, agents, git
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── fake-agent-backend.ts   # scripted stream from fixtures
│           ├── fake-git-service.ts     # canned repository snapshot
│           └── *.test.ts               # colocated unit tests
├── apps/
│   ├── server/
│   │   ├── package.json          # @craftingtable/server — deps: fastify + workspace pkgs; dev: tsx
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts          # bootstrap: listen 127.0.0.1:4600, SIGINT/SIGTERM shutdown
│   │       ├── server.ts         # buildServer(deps) — dependency-injected, testable
│   │       ├── config.ts
│   │       ├── routes/health.ts  # GET /api/health, contract-validated before send
│   │       ├── routes/events.ts  # GET /api/events, SSE
│   │       └── *.test.ts         # inject + SSE integration tests
│   └── web/
│       ├── package.json          # @craftingtable/web — deps: react, react-dom, contracts, domain
│       ├── tsconfig.json
│       ├── index.html
│       ├── vite.config.ts        # @vitejs/plugin-react; proxy /api -> 127.0.0.1:4600
│       └── src/
│           ├── main.tsx
│           ├── App.tsx           # shell layout: rail, header, regions, activity
│           ├── lib/useEventStream.ts   # EventSource hook: connecting/open/error + validated events
│           ├── components/
│           │   ├── ConnectionBadge.tsx
│           │   ├── SimulatedBadge.tsx
│           │   ├── StatusRegions.tsx   # Needs attention / Active / Ready / Blocked
│           │   └── ActivityPanel.tsx   # renders normalized fake events
│           └── styles/
│               ├── tokens.css    # design tokens per docs/ui-principles.md
│               └── global.css
└── e2e/
    └── dashboard.spec.ts         # Playwright smoke test
```

Existing files (`AGENTS.md`, `CLAUDE.md`, `init/*`, `work-items/CT-01.md`, `.gitignore`) are untouched except `README.md` (extended, charter preserved). After operator approval, this plan is recorded as `work-items/CT-01-accepted-implementation-plan.md`.

## 2. Package boundaries and dependency direction

Dependencies point strictly downward; no cycles:

```text
domain          (pure TS, zero runtime deps: branded IDs, event-kind vocabulary)
   ▲
contracts       (zod schemas: HealthResponse, AgentEventEnvelope; wire types inferred)
   ▲                    ▲
agents  git             │      (interfaces only: AgentBackend, GitService; no implementations)
   ▲     ▲              │
   testing              │      (FakeAgentBackend, FakeGitService — the test/dev boundary)
      ▲                 │
   apps/server ─────────┤      (Fastify; composes fakes; validates at the boundary)
   apps/web ────────────┘      (React/Vite; consumes contracts only; never trusts wire data)
```

- `domain` depends on nothing at runtime — no HTTP, React, process, Git, or vendor SDK types (AGENTS.md rule).
- `contracts` is the single source of runtime validation, reused verbatim by server and web.
- `agents` and `git` hold only the narrow CT-01 interfaces (dependency-inversion seams). Fakes live in `testing`, satisfying "place fake implementations in a test/development boundary."
- Apps depend on packages; packages never depend on apps.
- Workspace packages are consumed as built output (`dist/`) via TypeScript project references; `tsc -b` orders builds by the reference graph, which keeps the dependency direction machine-checked.

## 3. Root scripts (root `package.json`)

```text
pnpm dev           # tsc -b --watch (packages/server types) + server tsx watch + vite dev, via pnpm -r --parallel
pnpm build         # tsc -b (packages + server emit dist) then vite build for web
pnpm format        # biome format --write .
pnpm format:check  # biome format .
pnpm lint          # biome lint .
pnpm typecheck     # tsc -b --dry? no — tsc -b (composite; serves as typecheck) + tsc --noEmit for web
pnpm test          # vitest run (workspace projects)
pnpm test:e2e      # playwright test (chromium only; starts server + web via webServer config)
pnpm check:scope   # node scripts/check-forbidden-scope.mjs
pnpm check         # format:check && lint && typecheck && build && test && test:e2e && check:scope
```

`pnpm check` is the CI-equivalent local gate, mirroring the contract's required order (format, lint, type-check, build, unit test, smoke test, forbidden scope). Server binds `127.0.0.1:4600` (plan §2.4 convention); Vite dev serves the web app and proxies `/api` (including SSE) to the server.

## 4. Domain IDs and AgentEventEnvelope

**Branded IDs** (`packages/domain/src/ids.ts`) — non-interchangeable at compile time, guarded at runtime:

```typescript
type Brand<B extends string> = string & { readonly __brand: B };
export type UserId      = Brand<'UserId'>;
export type WorkspaceId = Brand<'WorkspaceId'>;
export type ProjectId   = Brand<'ProjectId'>;
export type WorkItemId  = Brand<'WorkItemId'>;
export type AgentRunId  = Brand<'AgentRunId'>;
export type EventId     = Brand<'EventId'>;
// each with a factory: asWorkspaceId(value: string): WorkspaceId (rejects empty/whitespace)
```

**Event kinds** — deliberately minimal, drawn from plan §8.2 vocabulary, only what the fake dashboard needs:

```text
run-started | status-changed | completion-proposed
```

**AgentEventEnvelope** (`packages/contracts/src/agent-event.ts`, Zod, discriminated on `kind`):

```typescript
{
  id: EventId,                    // z.string().min(1).brand<'EventId'>()
  sequence: number,               // int, >= 1, monotonic per stream
  occurredAt: string,             // ISO-8601 datetime
  workspaceId: WorkspaceId,
  projectId?: ProjectId,
  workItemId?: WorkItemId,
  runId?: AgentRunId,
  kind: 'run-started' | 'status-changed' | 'completion-proposed',
  payload:                        // per-kind shape:
    run-started:         { backend: string, title: string, branch: string }
    status-changed:      { status: string }        // e.g. "Editing 3 files"
    completion-proposed: { summary: string }
}
```

**HealthResponse** (`packages/contracts/src/health.ts`):

```typescript
{ status: 'ok', service: 'craftingtable-server', version: string, time: string /* ISO-8601 */ }
```

## 5. Server-to-browser fake SSE path

1. `apps/server` startup composes `FakeAgentBackend` (which itself consumes `FakeGitService` for the branch name in the `run-started` payload — demonstrating dependency inversion without extra endpoints).
2. `GET /api/events` (SSE, `text/event-stream`): on each connection the fake backend plays a deterministic scripted run loaded from `fixtures/agent-events/demo-run.json` — `run-started` immediately, `status-changed` after ~1s, `completion-proposed` after ~2s — then keep-alive comment lines (`:hb`) every 15s. Per-connection replay makes page refresh trivially correct (acceptance criterion 4 and "works after refresh").
3. Wire format per event: `event: agent-event`, `id: <sequence>`, `data: <JSON AgentEventEnvelope>`. Every envelope is schema-validated before write. `Last-Event-ID` replay is explicitly deferred to CT-02 (recorded in ADR-003).
4. `apps/web` `useEventStream` hook opens `new EventSource('/api/events')` (same-origin via Vite proxy), tracks `connecting → open → error` state, parses and re-validates each envelope with the shared contracts schema, and drops (and surfaces) invalid events.
5. Clean shutdown: SIGINT/SIGTERM close active SSE responses, clear fake-source timers, then `fastify.close()`.

## 6. Fake boundaries

**`AgentBackend`** (`packages/agents`) — narrow CT-01 subset, not the full plan-§8.1 interface (that stays deferred, noted in ADR-007):

```typescript
interface AgentBackend {
  describe(): BackendDescriptor;   // { id, label, version, simulated: true }
  streamEvents(signal: AbortSignal): AsyncIterable<AgentEventEnvelope>;
}
```

**`GitService`** (`packages/git`) — smallest interface that proves the seam without invoking real Git:

```typescript
interface GitService {
  describeRepository(): Promise<RepositorySnapshot>;  // { name, branch, headShaAbbrev, clean, simulated: true }
}
```

`FakeAgentBackend` and `FakeGitService` live in `packages/testing`. Both are clearly labeled simulated; the UI badge derives from `BackendDescriptor.simulated`.

## 7. Browser shell

Per `docs/ui-principles.md`: narrow left nav rail; concise workspace header; four visually suggested summary regions (`Needs attention`, `Active`, `Ready`, `Blocked` — labeled placeholders, no fake functionality); activity panel rendering the normalized fake events; persistent "Simulated data" badge; connection badge with distinct connected/connecting/disconnected states (text + icon, never color alone); minimal error/disconnected message. Plain CSS with custom-property design tokens (surfaces, text tiers, borders/focus, accent + semantic states, spacing/radius/type/shadow scales); no component library. Semantic landmarks, visible focus, `prefers-reduced-motion` respected. Desktop-first at a MacBook viewport (~1440×900).

## 8. Test layout and check sequence

- `packages/domain/src/*.test.ts` — ID factories accept/reject.
- `packages/contracts/src/*.test.ts` — envelope + health schemas: valid fixtures pass; wrong `kind`/`payload` mismatch, non-monotonic-safe fields, bad timestamps rejected. Also validates `fixtures/agent-events/demo-run.json` templates.
- `packages/testing/src/*.test.ts` — FakeAgentBackend emits schema-valid envelopes in order with monotonic `sequence`; abort stops the stream; FakeGitService snapshot is valid and `simulated: true`.
- `apps/server/src/*.test.ts` — `fastify.inject` on `/api/health` (200, schema-valid); SSE integration: real listen on an ephemeral port, read first `agent-event`, parse and validate.
- `e2e/dashboard.spec.ts` — Playwright (chromium): dashboard loads without console errors, simulated badge visible, connection state reaches connected, fake `run-started` event text appears in the activity panel.

Vitest runs all unit tests via workspace projects config. Playwright's `webServer` array starts the server and the web app itself.

**Exact `pnpm check` sequence:** `format:check → lint → typecheck → build → test → test:e2e → check:scope` — fail-fast, all runnable locally with no GitHub Actions.

**Forbidden-scope check** (`scripts/check-forbidden-scope.mjs`): scans every workspace `package.json` dependency field and all `src/` import specifiers for `actionqueue`, `worldinterface`/`world-interface`, `exoskeleton` (case-insensitive); exits non-zero with the offending file/line.

## 9. ADRs

**Accepted now:**
- **ADR-001 server and web framework** — Fastify; React + Vite. (Contract-fixed baseline; records rationale and alternatives.)
- **ADR-003 SSE event contract** — SSE over WebSockets; named `agent-event` events; `id` = sequence; JSON `AgentEventEnvelope` payload validated on both ends; heartbeat comments; reconnect/replay semantics deferred to CT-02.
- **ADR-008 toolchain and quality gates** (companion tooling ADR, allowed by CT-01) — pnpm workspaces without Nx/Turborepo; TypeScript strict + project references; Biome as single formatter+linter; Vitest; Playwright (chromium-only smoke); tsx for server dev; Node version policy; `pnpm check` as the CI-equivalent gate.

**Deferred (short files, status `deferred`, context only):** ADR-002 SQLite and migrations; ADR-004 diff viewer; ADR-005 Codex integration; ADR-006 local TLS; ADR-007 agent execution boundary.

## 10. Repository contract documents

- `README.md` — keep charter; add quickstart (Node/pnpm prerequisites, `pnpm install`, `pnpm dev`, `pnpm check`) and current-phase pointer.
- `CONTRIBUTING.md` — read order, scope rule, commands, quality expectations, no-commit-without-operator policy, ADR process.
- `docs/architecture.md` — the dependency diagram from §2, boundary rules, and what is deliberately fake in CT-01.

## 11. Environmental assumptions and risks

1. **Node version:** installed Node is v26.2.0 (Current line). The latest *maintained LTS* line is Node 24 (Node 26 is not scheduled to enter LTS until Oct 2026). Recommendation: document **Node ≥ 24 LTS as the supported floor** (`engines: ">=24"`, `.nvmrc` = `24`, noted in ADR-008), while acknowledging local development currently runs on 26. Operator may instead prefer installing Node 24 — flagged for the approval decision.
2. **pnpm 10 build scripts:** pnpm 10 blocks postinstall scripts by default; `esbuild` (via Vite/tsx) needs approval via `pnpm.onlyBuiltDependencies` in root `package.json`.
3. **Playwright browsers:** chromium revision 1161 is already cached. The pinned `@playwright/test` version must match, or `pnpm exec playwright install chromium` will download a browser (network required). The smoke test pins chromium only.
4. **Network:** `pnpm install` needs registry access for fastify, react, vite, zod, vitest, playwright, biome, tsx, typescript. No other network use.
5. **Ports:** assumes `127.0.0.1:4600` (server) and Vite's dev port are free; server tests use ephemeral ports.
6. **Git hygiene:** per AGENTS.md, no commits/branches unless the operator asks; worktree left cleanly reviewable with a final report (changed files, commands run, decisions, deferred decisions, unresolved risks — acceptance criterion 10).

## 12. Verification

1. `pnpm install` completes cleanly.
2. `pnpm dev` → `curl http://127.0.0.1:4600/api/health` returns the typed health JSON; browser at Vite URL shows shell, simulated badge, connected state, and the fake event; page refresh replays correctly.
3. `pnpm check` passes end-to-end (format:check, lint, typecheck, build, unit tests, Playwright smoke, forbidden-scope).
4. Negative check: temporarily adding a forbidden dependency name makes `pnpm check:scope` fail (verified manually, then reverted).
5. Produce the final CT-01 report per acceptance criterion 10.

## 13. Post-approval step

Once the operator approves, record the approved plan as `work-items/CT-01-accepted-implementation-plan.md` (per session instructions), then implement in the order: workspace scaffolding → domain → contracts → agents/git → testing fakes → server → web → e2e → scripts/ADRs/docs → full `pnpm check`.
