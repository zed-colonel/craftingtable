# CT-02 Accepted Implementation Plan

**Status:** accepted by the operator on 2026-07-24
**Binding contract:** `work-items/CT-02.md`
**Accepted source baseline:** `693445257d61222959c2efa9fc82c621fa8c6653`
**Implementation head at inspection:** `ac760499b87f0c128228ce9e84323bfff553c5fc`

This is the accepted Phase A plan of record for CT-02. The work contract and
acceptance matrix remain authoritative except for the explicit A07 amendment
recorded below.

## Baseline

The accepted CT-01 commit exists, and the inspected head is descended from it.
The only intervening commit reorganizes CT-01 records and adds the CT-02
planning package; it does not rewrite or replace the accepted implementation.
The worktree was clean at Phase A completion.

The implementation replaces the temporary production path:

```text
FakeAgentBackend → /api/events → per-connection sequence → clearing browser reducer
```

with one authoritative path:

```text
SQLite state + audit + workspace-event transaction
    → transactionally consistent snapshot and global cursor
    → authenticated workspace-filtered replay
    → durable SSE live tail
    → idempotent browser projection
```

## Operator-approved A07 amendment

The operator resolved the contradiction between CT-02 §10 and CT02-A07 as
follows:

> A refused second bootstrap appends exactly one safe
> `admin.bootstrap.denied` audit row. It appends no user, workspace,
> membership, session, or workspace-event row and performs no other mutation.

Tests and completion evidence will apply this accepted interpretation.

## Package direction

```text
domain       → none
contracts    → domain + Zod
storage      → domain + better-sqlite3
server       → domain + contracts + storage
web          → domain + contracts
```

The existing `agents`, `git`, and `testing` packages remain deferred/test seams,
but production server composition no longer imports them. Only
`@craftingtable/storage` may import the SQLite driver or own SQL. The browser
cannot import storage or server internals.

## Target files and replacement policy

The accepted target is:

```text
root
├── package.json, pnpm-lock.yaml, pnpm-workspace.yaml
├── tsconfig.json, vitest.config.ts, playwright.config.ts
├── apps/server
│   ├── package.json, tsconfig.json
│   └── src
│       ├── config, composition, index, cli, e2e-entry, test-support
│       ├── routes/{auth,http,workspaces,workspace-events}
│       ├── security/{password-hasher,session-tokens,csrf,origin-policy}
│       ├── services/{errors,auth-service,bootstrap-service,
│       │             workspace-service,workspace-event-notifier,
│       │             workspace-event-stream-service}
│       └── focused HTTP/service/restart tests
├── apps/web/src
│   ├── App.tsx, styles/global.css
│   ├── components/{LoginPage,WorkspaceShell,ActivityPanel,AuditPanel,
│   │              SessionPanel,ConnectionBadge,StatusRegions}
│   └── lib/{api-client,auth-state,workspace-projection,
│            use-workspace-event-stream} plus reducer/state tests
├── packages/domain/src/{ids,auth,workspace,audit,workspace-events}
├── packages/contracts/src/{ids,auth,workspace,audit,snapshot,workspace-event}
├── packages/storage
│   ├── migrations/0001-ct02-foundation.sql
│   └── src/{database,migrations,storage,types,repositories/*} plus
│       real-file migration/repository/transaction/snapshot tests
├── e2e/dashboard.spec.ts
├── docs/{architecture,security,operations}.md
├── docs/decisions/{ADR-002,ADR-003,ADR-006,ADR-008,ADR-009,ADR-010}
├── work-items/CT-02-accepted-implementation-plan.md
└── implementation-reports/CT-02/CT-02-completion.md
```

Retain health routing, shared CT-01 foundations, agent/Git interface packages,
test fakes, and the fake fixture as non-production seams. Replace and delete
the normal-runtime `/api/events` route, `SimulatedBadge`, the CT-01
`useEventStream`, and its clearing/per-connection reducer. Do not delete or
rewrite any accepted CT-01 plan, report, finding, remediation, or review.

## Persistence and migrations

- Pin `better-sqlite3` 13.0.1 and `@types/better-sqlite3` 7.6.13.
- Approve native builds for `better-sqlite3` and `argon2` alongside `esbuild`.
- Use package-owned ordered SQL files with SHA-256 checksums.
- Record version, name, checksum, and application time in
  `schema_migrations`.
- Reject changed checksums, unknown applied migrations, and newer schemas.
- Apply each migration and its ledger row atomically.
- Configure and verify WAL, foreign keys, FULL synchronous mode, and a
  5000-millisecond busy timeout.
- Use XDG storage by default with an absolute `CRAFTINGTABLE_DATA_DIR`
  override and owner-only directory/database permissions.

Schema version 1 contains users, sessions, workspaces, memberships,
append-only audit events, and append-only workspace events. All foreign-key
deletion behavior is restrictive; CT-02 exposes no deletion or retention path.

Application services use one explicit storage transaction callback for current
state, audit, and workspace-event writes. Notifiers run only after commit and
carry no event payload.

## Authentication and authorization

- Pin `argon2` 0.45.1 and use Argon2id.
- Bootstrap through an interactive no-echo CLI; passwords never appear in
  arguments.
- Generate 256-bit opaque session tokens, store only SHA-256 digests, and use a
  30-day absolute lifetime.
- Use `HttpOnly`, `SameSite=Strict`, `Path=/`, explicit expiry, and
  origin-correct `Secure` cookies.
- Bind synchronizer CSRF tokens to server-side sessions and compare them with a
  timing-safe operation.
- Require JSON and reject cross-site origin/fetch metadata on login.
- Enforce workspace membership in services, returning indistinguishable
  responses for missing and unauthorized workspaces.
- Redact cookies, authorization headers, set-cookie values, passwords, raw
  session tokens, and CSRF tokens from logs and audit metadata.
- Remain loopback-only through CT-02.

## Events, snapshots, and browser reconstruction

The primary live contract is a strict version-1
`WorkspaceEventEnvelope` containing event ID, global database sequence,
timestamp, workspace, kind/payload, optional actor and future correlation IDs,
and schema version. CT-02 adds only `workspace-created`.

Snapshots authorize membership and read workspace state, recent workspace
activity, and the global maximum workspace-event sequence in one read
transaction. SSE starts after that cursor, honors a greater valid
`Last-Event-ID`, replays ascending workspace-filtered rows, and then tails by
re-querying SQLite after notifier generation changes or bounded timeout.

The browser loads session, workspace list, and snapshot before opening SSE. It
revalidates every event, accepts strictly increasing global cursors with
permitted cross-workspace gaps, ignores duplicates, preserves state across
stream opens/errors, exposes reconnect/disconnected/auth-expired states, and
supports logout and same-user session revocation.

The CT-01 fake fixture remains test-only. It is not seeded into the durable
journal and no direct backend-to-browser fallback remains.

## Verification

All storage tests use real temporary files. Coverage includes migration
integrity, pragmas, permissions, foreign keys, rollback, append-only triggers,
Argon2id, session secrecy, cookie/CSRF/origin behavior, session ownership,
workspace authorization and non-disclosure, snapshot consistency, both
snapshot/SSE race orderings, `Last-Event-ID`, lost wakeups, dropped
notifications, stream invalidation, refresh deduplication, outage recovery,
and close/reopen reconstruction.

The five accepted CT-01 findings remain regression-tested. The final gate is
the literal `pnpm check` under pnpm-managed Node 24.18.0.

Acceptance evidence is planned as follows:

- A01–A05: real-file migration, reopen, checksum/newer-version, pragma, and
  permission tests.
- A06–A07 and A21–A26: bootstrap, audit allowlist/append-only, global event,
  atomic success, and injected rollback tests.
- A08–A17: Argon2id, token, login, cookie, expiry/revocation, logout/session
  ownership, CSRF, origin, and log capture tests plus Playwright login/logout.
- A18–A20: non-member non-disclosure and two-user/two-workspace fixtures for
  every workspace service/query/stream.
- A27–A33: strict workspace event contracts, consistent snapshot concurrency,
  real-port replay/`Last-Event-ID`/live-tail, deterministic lost-wakeup, and
  dropped-notifier recovery.
- A34–A37: snapshot-first projection, open-state preservation, duplicate
  suppression, visible sustained outage, and recovery in reducer/Playwright.
- A38–A43: close/reopen reconstruction, loopback regression, temporary E2E
  data/fresh servers, pinned runtime/full gate, forbidden-scope, and docs.

## Implementation generations

1. Record this plan and accept/amend the persistence, SSE, authentication, and
   atomicity decisions.
2. Add pure domain records and strict contracts.
3. Add storage, migration 0001, repositories, transactions, and real-file
   tests.
4. Add bootstrap/auth/session/CSRF/workspace services and thin typed routes.
   This is the first vertical CLI → SQLite → login → authorized snapshot path.
5. Replace the fake event route with journal-backed replay/live tail and prove
   the cursor/lost-wakeup cases deterministically.
6. Replace the browser startup path with login → workspace → snapshot → SSE
   and add the fresh temporary-database Playwright flow.
7. Complete restart/security/scope regressions, documentation, the completion
   evidence matrix, then run the literal root quality gate.

Review should focus after each generation on, respectively: scope/decisions,
dependency purity, migration integrity/atomicity, password-token-CSRF and
authorization boundaries, replay correctness, browser state preservation, and
final isolation/scope/documentation.

## Scope

CT-02 adds no projects, plan import, work items, repositories, real Git,
worktrees, diffs, real agents, arbitrary process execution, verification
runners, reviews, remediation, readiness, merge, LAN/TLS/systemd deployment,
backup CLI, Planning Studio, activated collaboration, Exo Stack dependency,
ORM, command bus, event-sourcing framework, or workflow engine.

No commits or merges are authorized by this plan.
