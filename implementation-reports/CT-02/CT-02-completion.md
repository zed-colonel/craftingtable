# CT-02 Completion Report

**Date:** 2026-07-24
**Work contract:** `work-items/CT-02.md`
**Accepted plan:** `work-items/CT-02-accepted-implementation-plan.md`
**Accepted CT-01 baseline:** `693445257d61222959c2efa9fc82c621fa8c6653`
**Implementation starting head:** `ac760499b87f0c128228ce9e84323bfff553c5fc`
**Implementation commit:** `466649bbfa9f99d777ed899c9dae00fe4b7713ec`
(`CT-02: add persistent authenticated daemon`), created after the operator
explicitly authorized a clean review commit. The accepted plan itself granted
no commit authority.

## Outcome

CT-02 is complete. CraftingTable now has one loopback-only persistent daemon
with schema-checked SQLite storage, interactive administrator bootstrap,
Argon2id authentication, digest-backed revocable sessions, session-bound CSRF,
service-layer workspace authorization, append-only audit and workspace-event
journals, consistent snapshots, durable SSE replay/live tail, and browser
reconstruction after refresh, outage, or daemon restart.

The operator-approved CT02-A07 amendment is implemented exactly: a refused
second bootstrap appends one safe `admin.bootstrap.denied` audit row and no
user, workspace, membership, session, or workspace-event row.

## Final implementation tree

Added or materially changed areas are:

```text
.
├── .gitignore
├── CLAUDE.md
├── CONTRIBUTING.md
├── README.md
├── package.json
├── playwright.config.ts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── vitest.config.ts
├── apps
│   ├── server
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src
│   │       ├── cli.test.ts
│   │       ├── cli.ts
│   │       ├── composition.ts
│   │       ├── config.test.ts
│   │       ├── config.ts
│   │       ├── e2e-entry.ts
│   │       ├── index.ts
│   │       ├── restart.test.ts
│   │       ├── server-auth.test.ts
│   │       ├── server-events.test.ts
│   │       ├── server-workspaces.test.ts
│   │       ├── server.test.ts
│   │       ├── server.ts
│   │       ├── test-support.ts
│   │       ├── routes
│   │       │   ├── auth.ts
│   │       │   ├── http.ts
│   │       │   ├── workspace-events.ts
│   │       │   └── workspaces.ts
│   │       ├── security
│   │       │   ├── csrf.test.ts
│   │       │   ├── csrf.ts
│   │       │   ├── origin-policy.test.ts
│   │       │   ├── origin-policy.ts
│   │       │   ├── password-hasher.test.ts
│   │       │   ├── password-hasher.ts
│   │       │   ├── session-tokens.test.ts
│   │       │   └── session-tokens.ts
│   │       └── services
│   │           ├── auth-service.ts
│   │           ├── bootstrap-service.test.ts
│   │           ├── bootstrap-service.ts
│   │           ├── errors.ts
│   │           ├── workspace-event-notifier.ts
│   │           ├── workspace-event-stream-service.test.ts
│   │           ├── workspace-event-stream-service.ts
│   │           └── workspace-service.ts
│   └── web
│       └── src
│           ├── App.tsx
│           ├── styles/global.css
│           ├── components
│           │   ├── ActivityPanel.tsx
│           │   ├── AuditPanel.tsx
│           │   ├── ConnectionBadge.tsx
│           │   ├── LoginPage.tsx
│           │   ├── SessionPanel.tsx
│           │   ├── StatusRegions.tsx
│           │   └── WorkspaceShell.tsx
│           └── lib
│               ├── api-client.ts
│               ├── auth-state.test.ts
│               ├── auth-state.ts
│               ├── use-workspace-event-stream.ts
│               ├── workspace-projection.test.ts
│               └── workspace-projection.ts
├── packages
│   ├── domain/src
│   │   ├── audit.ts
│   │   ├── auth.test.ts
│   │   ├── auth.ts
│   │   ├── ids.test.ts
│   │   ├── ids.ts
│   │   ├── index.ts
│   │   ├── workspace-events.test.ts
│   │   ├── workspace-events.ts
│   │   ├── workspace.test.ts
│   │   └── workspace.ts
│   ├── contracts/src
│   │   ├── audit.test.ts
│   │   ├── audit.ts
│   │   ├── auth.test.ts
│   │   ├── auth.ts
│   │   ├── ids.ts
│   │   ├── index.ts
│   │   ├── snapshot.test.ts
│   │   ├── snapshot.ts
│   │   ├── workspace-event.test.ts
│   │   ├── workspace-event.ts
│   │   ├── workspace.test.ts
│   │   └── workspace.ts
│   └── storage
│       ├── package.json
│       ├── tsconfig.json
│       ├── migrations/0001-ct02-foundation.sql
│       └── src
│           ├── database.test.ts
│           ├── database.ts
│           ├── index.ts
│           ├── migrations.test.ts
│           ├── migrations.ts
│           ├── repositories.test.ts
│           ├── snapshot.test.ts
│           ├── storage.ts
│           ├── test-support.ts
│           ├── transactions.test.ts
│           ├── types.ts
│           └── repositories
│               ├── audit.ts
│               ├── sessions.ts
│               ├── users.ts
│               ├── workspace-events.ts
│               └── workspaces.ts
├── e2e/dashboard.spec.ts
├── docs
│   ├── architecture.md
│   ├── operations.md
│   ├── security.md
│   └── decisions
│       ├── ADR-002-sqlite-and-migrations.md
│       ├── ADR-003-sse-event-contract.md
│       ├── ADR-006-local-tls.md
│       ├── ADR-008-toolchain-and-quality-gates.md
│       ├── ADR-009-authentication-sessions-and-csrf.md
│       ├── ADR-010-atomic-audit-and-workspace-events.md
│       └── README.md
├── implementation-reports/CT-02/CT-02-completion.md
└── work-items/CT-02-accepted-implementation-plan.md
```

Replaced/deleted CT-01 runtime files:

```text
apps/server/src/routes/events.ts
apps/web/src/components/SimulatedBadge.tsx
apps/web/src/lib/streamState.ts
apps/web/src/lib/streamState.test.ts
apps/web/src/lib/useEventStream.ts
```

The fake agent fixture and the `agents`, `git`, and `testing` packages are
retained only as future/test seams. Production composition has no dependency on
them and no fallback to the CT-01 ephemeral stream.

## Accepted decisions

- `better-sqlite3` 13.0.1 and `@types/better-sqlite3` 7.6.13; only storage owns
  SQLite/SQL.
- Ordered package-owned SQL with SHA-256 checksums, per-migration
  transactions, unknown/newer-version rejection, WAL, FULL synchronous mode,
  foreign keys, and 5000 ms busy timeout.
- `argon2` 0.45.1 with Argon2id; 12–1024 byte password input bounds.
- Opaque 32-byte session tokens; only SHA-256 digests persist; 30-day absolute
  expiry; explicit revocation and logout.
- Strict session cookie, session-bound synchronizer CSRF token, timing-safe
  comparison, JSON-only login, and origin/fetch-metadata checks.
- Service-layer membership authorization with indistinguishable missing and
  unauthorized workspace responses.
- Separate immutable audit and workspace-event journals. State, audit, and
  related events commit atomically; notifier runs only after commit.
- Global workspace-event cursor with permitted cross-workspace gaps,
  transactionally consistent snapshot `asOfSequence`, durable ordered replay,
  `Last-Event-ID`, timeout re-query, and post-commit notifier.
- Loopback-only networking remains enforced.

ADRs 002 and 003 are accepted/amended; ADRs 006 and 008 are reviewed/amended;
ADRs 009 and 010 record security and atomicity.

## Deliberately deferred

Plan import, projects/work items, repositories, real Git/worktrees/diffs, real
agent backends, arbitrary execution, verification runners, review/remediation/
readiness/merge workflows, Planning Studio, LAN/TLS/systemd deployment, backup
CLI, activated collaboration, and all generic ORM/event-sourcing/command-bus/
workflow-engine abstractions remain deferred. There is no ActionQueue,
WorldInterface, or Exoskeleton dependency.

## Installed schema

Migration `0001-ct02-foundation.sql` installs schema version **1**:

- `schema_migrations`
- `users`
- `workspaces`
- `workspace_memberships`
- `sessions`
- `audit_events`
- `workspace_events`
- membership/session/audit/event indexes
- database-level no-update/no-delete triggers for both journals

Foreign-key deletion is restrictive. No CT-02 deletion or retention route is
exposed.

## Commands, routes, and configuration

Commands:

```text
pnpm craftingtable admin bootstrap --username <name>
pnpm db:migrate
pnpm db:status
```

HTTP:

```text
GET  /api/health
POST /api/auth/login
GET  /api/auth/session
GET  /api/auth/sessions
POST /api/auth/logout
POST /api/auth/sessions/:sessionId/revoke
GET  /api/workspaces
GET  /api/workspaces/:workspaceId/snapshot
GET  /api/workspaces/:workspaceId/audit
GET  /api/workspaces/:workspaceId/events?after=<sequence>
```

Configuration:

```text
CRAFTINGTABLE_DATA_DIR
CRAFTINGTABLE_HOST
CRAFTINGTABLE_PORT
CRAFTINGTABLE_PUBLIC_ORIGIN
CRAFTINGTABLE_SESSION_LIFETIME_SECONDS
CRAFTINGTABLE_LOG_LEVEL
```

## Acceptance evidence

| ID | Result | Evidence |
|---|---|---|
| CT02-A01 | Pass | `packages/storage/src/migrations.test.ts` clean real-file migration and ledger checksum |
| CT02-A02 | Pass | `packages/storage/src/migrations.test.ts` close/reopen idempotence |
| CT02-A03 | Pass | `packages/storage/src/migrations.test.ts` changed-checksum rejection |
| CT02-A04 | Pass | `packages/storage/src/migrations.test.ts` newer-schema rejection |
| CT02-A05 | Pass | `packages/storage/src/database.test.ts` pragma verification |
| CT02-A06 | Pass | `apps/server/src/services/bootstrap-service.test.ts` exact atomic rows/audits/event |
| CT02-A07 | Pass, amended | Same test proves exactly one safe denial audit and no other mutation |
| CT02-A08 | Pass | `apps/server/src/server-auth.test.ts`; `e2e/dashboard.spec.ts` |
| CT02-A09 | Pass | `security/password-hasher.test.ts`; captured-log and database assertions in `server-auth.test.ts` |
| CT02-A10 | Pass | `security/session-tokens.test.ts`; raw-token absence assertion in `server-auth.test.ts` |
| CT02-A11 | Pass | HTTP/HTTPS cookie assertions in `server-auth.test.ts` |
| CT02-A12 | Pass | expired/revoked API tests and revoked live stream in `server-auth.test.ts`/`server-events.test.ts` |
| CT02-A13 | Pass | logout API test and Playwright logout/protected-API check |
| CT02-A14 | Pass | own-session list/revoke and cross-user negative in `server-auth.test.ts` |
| CT02-A15 | Pass | missing/invalid CSRF cases in `server-auth.test.ts` |
| CT02-A16 | Pass | positive logout/revoke requests in `server-auth.test.ts` |
| CT02-A17 | Pass | content-type/origin/fetch policy tests |
| CT02-A18 | Pass | non-member snapshot/audit/service/stream coverage in `server-workspaces.test.ts` and `server-events.test.ts` |
| CT02-A19 | Pass | identical missing/non-member response assertion |
| CT02-A20 | Pass | two-user/two-workspace isolation fixture and schema constraints |
| CT02-A21 | Pass | bootstrap/login/logout/revoke/denial audit assertions |
| CT02-A22 | Pass | exact denial metadata allowlist and captured-log secret exclusions |
| CT02-A23 | Pass | update/delete trigger failures in `packages/storage/src/repositories.test.ts` |
| CT02-A24 | Pass | global sequence/filter/uniqueness/immutability repository tests |
| CT02-A25 | Pass | bootstrap success row assertions and one storage transaction |
| CT02-A26 | Pass | injected rollback in `packages/storage/src/transactions.test.ts` |
| CT02-A27 | Pass | strict shared `WorkspaceEventEnvelope`; journal-backed SSE source; old route deleted |
| CT02-A28 | Pass | concurrent WAL snapshot test and snapshot service/route test |
| CT02-A29 | Pass | real-port ordered replay in `server-events.test.ts` |
| CT02-A30 | Pass | real-port native `Last-Event-ID` resume test |
| CT02-A31 | Pass | deterministic query/commit/wait race in `workspace-event-stream-service.test.ts` |
| CT02-A32 | Pass | real-port post-connect commit delivery |
| CT02-A33 | Pass | dropped-notifier timeout/re-query recovery test |
| CT02-A34 | Pass | snapshot-first reducer and Playwright flow |
| CT02-A35 | Pass | projection-preservation reducer test |
| CT02-A36 | Pass | reducer duplicate test and one-event refresh assertion in Playwright |
| CT02-A37 | Pass | sustained outage/recovery reducer and browser route-abort recovery |
| CT02-A38 | Pass | `apps/server/src/restart.test.ts` close/reopen reconstruction |
| CT02-A39 | Pass | retained/expanded non-loopback rejection in `config.test.ts` |
| CT02-A40 | Pass | unique temporary storage fixtures and non-reusing Playwright/e2e entry |
| CT02-A41 | Pass | native install and literal `pnpm check` under `v24.18.0` |
| CT02-A42 | Pass | `pnpm check:scope` and changed-path/source review |
| CT02-A43 | Pass | accepted/amended ADRs, architecture/security/operations docs, accepted plan, this report |

## Verification command record

Meaningful implementation and verification commands, including repaired
diagnostics:

| Command | Result |
|---|---|
| `git cat-file -e 693445…^{commit}` / `git merge-base --is-ancestor 693445… HEAD` | Pass; baseline exists and starting HEAD descends from it |
| `pnpm install` (initial sandbox attempt) | Failed: restricted DNS; no repository mutation from the failed fetch |
| `pnpm install` (approved network execution) | Pass; `better-sqlite3` native build completed under Node 24.18.0 |
| `pnpm install` after Argon2/cookie additions | Pass; `argon2` native install completed |
| focused domain/contracts/storage compile and tests | Pass: 16 files, 41 tests at that generation |
| focused server compile/tests (initial sandbox attempt) | Failed only because real SSE test could not bind loopback (`EPERM`) |
| focused server compile/tests (approved loopback execution) | Pass: 12 files, 30 tests at that generation |
| `pnpm --filter @craftingtable/web typecheck` | No-op diagnostic: package has no local `typecheck` script |
| `pnpm exec tsc --noEmit -p apps/web` | Failed once on direct Zod typing and branded test IDs; repaired |
| `pnpm exec tsc --noEmit -p apps/web` | Pass |
| `pnpm typecheck` | Failed once on a renamed storage test helper; repaired |
| `pnpm typecheck` | Pass |
| `pnpm exec vitest run packages/storage/src apps/server/src apps/web/src` | Pass: 20 files, 54 tests |
| `pnpm test` | Pass: 35 files, 95 tests |
| `pnpm test:e2e` | Pass: 1 Chromium authenticated/replay/outage/logout test |
| isolated `pnpm db:migrate` (sandbox attempt) | Failed because tsx IPC sockets are restricted; also exposed argument forwarding, which was repaired |
| isolated `pnpm db:migrate` (approved IPC execution) | Pass: migrated to schema 1 |
| isolated `pnpm db:status` | Pass: `schema 1/1; pending: none` |
| `pnpm lint && pnpm typecheck` | Lint failed once on one implicit-any diagnostic; all reported warnings were repaired |
| `pnpm format && pnpm lint && pnpm typecheck` | Pass |
| `git diff --check` | Pass |
| `pnpm check:scope` | Pass |
| `pnpm exec node --version` | Pass: `v24.18.0` |
| `pnpm check` | Pass: formatting, lint, strict typecheck, production build, 96 unit/integration tests, Playwright, scope |

## Risks, limitations, and operator actions

- Operator action: run `pnpm db:migrate`, then interactive
  `pnpm craftingtable admin bootstrap --username <name>` against the intended
  absolute/default data directory before normal use.
- `better-sqlite3` and `argon2` are native modules; a fresh platform must allow
  the pinned pnpm builds.
- CT-02 has schema/event version 1 and only `workspace-created`; the status
  regions honestly remain zero until later domain work lands.
- HTTP loopback cookies are intentionally not `Secure`; `Secure` is enabled for
  an HTTPS public origin, while actual TLS/LAN deployment remains CT-08.
- There is no online backup command. Stop the daemon and treat the SQLite,
  WAL, and SHM files as one unit for any manual offline copy.
- The operator explicitly authorized committing the completed implementation
  after this report was first prepared; implementation commit `466649b`
  provided the clean independent-review baseline.

No unresolved CT-02 acceptance failure remains. Every CT-02 acceptance
criterion passes under the operator-approved A07 amendment.

## Independent Claude Code review focus

Review migration/checksum failure behavior, SQLite transaction boundaries,
Argon2/token/CSRF secrecy, session ownership, indistinguishable workspace
authorization failures, append-only triggers, snapshot/WAL consistency,
SSE cursor selection and lost-wakeup proof, shutdown/revocation behavior,
browser duplicate/outage handling, temporary-data isolation, and confirmation
that production server composition has no CT-01 fake fallback or CT-03 scope.
