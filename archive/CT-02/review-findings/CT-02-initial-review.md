# CT-02 Initial Independent Review

**Reviewer role:** independent implementation review (read-only; no files edited except this record)
**Review date:** 2026-07-24

## Commits under review

| Role | SHA | Subject |
| --- | --- | --- |
| CT-01 accepted source baseline | `693445257d61222959c2efa9fc82c621fa8c6653` | CT-01: record remediation review and completion |
| Base of the reviewed change (plan + contract commit, `main`) | `ac760499b87f0c128228ce9e84323bfff553c5fc` | CT-02: add source-grounded work contract |
| **Reviewed head** | `466649bbfa9f99d777ed899c9dae00fe4b7713ec` | CT-02: add persistent authenticated daemon |

The diff `ac76049..466649b` is **120 files, +7150 / −611**. All findings below are anchored to
head `466649b`.

## Reviewed against

- `work-items/CT-02.md` (binding contract)
- `work-items/CT-02-acceptance-matrix.yaml` (CT02-A01 … CT02-A43)
- `work-items/CT-02-accepted-implementation-plan.md` (accepted Phase A plan, incl. A07 amendment)
- `AGENTS.md` / `CLAUDE.md` scope guardrails

## Deterministic verification (run by the reviewer at head `466649b`)

| Gate component | Command | Result |
| --- | --- | --- |
| Runtime pin | `pnpm exec node --version` | `v24.18.0` (matches `useNodeVersion: 24.18.0`) — CT01-R5 held |
| Format | `pnpm format:check` | pass (exit 0) |
| Lint | `pnpm lint` | pass (exit 0) |
| Strict typecheck | `pnpm typecheck` | pass (exit 0) |
| Build | `pnpm build` (part of gate) | pass |
| Unit/integration | `pnpm test` | **96 passed / 35 files** |
| E2E | `pnpm test:e2e` | **1 passed** — `authenticated snapshot, replay, outage recovery, and logout` |
| Forbidden scope | `pnpm check:scope` | pass — "no Exo Stack runtime dependencies found" |

The full `pnpm check` gate is green under the pinned runtime (CT02-A41 satisfied).

## Overall assessment

**The implementation is strong and matches the contract and accepted plan closely.** The durable
control-plane model is correct: writes commit state + append-only audit + append-only,
DB-sequenced workspace events in one `IMMEDIATE` transaction; the browser reconstructs from a
transactionally consistent snapshot cursor plus authenticated, workspace-filtered SSE replay and
live tail. The two hardest correctness cases — the lost-wakeup window and dropped in-memory
notifications — are handled with a generation-guarded waiter and a bounded requery, and both are
covered by deterministic tests. No CT-03+ functionality was introduced, and the CT-01 fake runtime
path is fully removed.

No high- or medium-severity defects were confirmed. Findings are Low / Informational plus
forward-looking risks for CT-03/CT-08.

---

## Area-by-area verdict

### Authentication & session security — solid
- Argon2id via `argon2` with a per-startup `dummyPasswordHash` verified even for unknown users, so
  login is timing-equalized and returns a single generic `AuthenticationError` (`auth-service.ts:36-57`).
  DB `CHECK (password_hash LIKE '$argon2id$%')` enforces the algorithm at rest.
- Session tokens are 256-bit `randomBytes(32)` base64url; only the SHA-256 digest is persisted
  (`sessions.token_digest UNIQUE CHECK length = 64`), and the raw token appears only in the cookie
  (`session-tokens.ts`, `auth-service.ts:59-90`). Confirmed by `server-auth.test.ts` ("stores only a digest").
- `authenticate()` rejects unknown/revoked/expired sessions and disabled users, and re-checks on
  every SSE loop iteration (≤1 s), so revocation/expiry tears the stream down promptly
  (`auth-service.ts:93-118`, `workspace-event-stream-service.ts:33-42`).
- Cookie flags: `HttpOnly`, `SameSite=Strict`, `Path=/`, explicit `expires`/`maxAge`, `Secure` bound
  to `publicOrigin` protocol (`http.ts:58-67`, `config.ts:97`). Generic cookie name upgradable to
  `__Host-` in CT-08.

### CSRF — solid
- Session-bound synchronizer token compared with `timingSafeEqual` after a length guard
  (`csrf.ts`), required on every mutation (`authorizeMutation` in `auth.ts:38-53`), plus an
  origin/`Sec-Fetch-Site` check as defense in depth.
- Login accepts JSON only and rejects cross-site browser requests via content-type +
  `isAllowedBrowserRequest` (`auth.ts:60-66`). Covered by `server-auth.test.ts` (CSRF accept/reject,
  cross-site login).

### Workspace isolation & authorization — solid
- Every workspace query/stream authorizes membership in the service layer through
  `findAuthorized(userId, workspaceId)` (a `memberships JOIN workspaces`, both `status='active'`) —
  UI never authorizes (`workspace-service.ts`, `repositories/workspaces.ts:54-74`).
- Missing-vs-unauthorized are indistinguishable: both return `NotFoundError` → 404, and denial audit
  omits `workspace_id` when the workspace does not exist to avoid a FK-shaped existence oracle
  (`workspace-service.ts:97-115`). Non-disclosure verified in `server-workspaces.test.ts`.
- Every CT-02 workspace-owned row carries `workspace_id` (schema), and the schema assumes no
  singleton user/workspace (roles `owner|editor|viewer`, `UNIQUE(workspace_id,user_id)`).

### Transaction atomicity — solid
- One `storage.transaction()` (`BEGIN IMMEDIATE`) wraps state + audit + event for bootstrap, login,
  logout, revoke, and denial (`storage.ts:43-45`; services). Rollback-on-throw leaves no partial
  rows; covered by `transactions.test.ts` and the migration failure-rollback test.
- Notifiers fire only **after** commit and carry no payload (`bootstrap-service.ts:126`), matching
  ADR-010 / plan.

### Migration safety — solid
- Ordered SQL with SHA-256 checksums; ledger + migration applied atomically per file with
  `.immediate()`; `validateApplied` rejects checksum drift, unknown/newer applied versions, and
  name mismatch *before* applying anything; `discoverMigrations` enforces contiguous versions from 1
  (`migrations.ts`). Negative paths covered: changed checksum, newer schema, first-migration
  rollback, independently-opened unsupported ledger (`migrations.test.ts:59-118`).
- Pragmas set **and verified** (`journal_mode=wal`, `foreign_keys=1`, `synchronous=2/FULL`,
  `busy_timeout=5000`) with a hard throw on mismatch (`database.ts:12-33`). Owner-only dir (`0700`)
  and DB (`0600`).

### Snapshot / event boundary — correct
- `snapshot()` reads authorization, `maxSequence()` (global), and recent activity inside one
  `readTransaction` (`BEGIN DEFERRED`); combined with better-sqlite3's single synchronous
  connection this yields one consistent view and `asOfSequence` (`workspace-service.ts:25-48`).
- Snapshot delivers events `≤ asOfSequence` (recent-activity, workspace-filtered); SSE `listAfter`
  delivers `sequence > cursor` — no gap, no overlap. Browser dedups by sequence, so refresh shows no
  duplicate/lost event.

### Lost-wakeup & reconnect races — correct and well-tested
- The generation is captured **before** the journal read; `waitForChangeOrTimeout` resolves
  immediately if the generation advanced during the read/`afterEmptyQuery` window, closing the
  classic lost-wakeup gap (`workspace-event-notifier.ts`, `workspace-event-stream-service.ts:44-66`).
  Deterministic test: "does not lose a commit between an empty journal query and waiter
  registration" (CT02-A31).
- In-memory notification is non-authoritative: a bounded timeout requery recovers a dropped
  notification — test "recovers a dropped in-memory notification by timeout and requery" (CT02-A33).
- `Last-Event-ID` is honored via `selectEventCursor(max(after, lastEventId))`; the `id:` line carries
  the global sequence, so native EventSource reconnect resumes exactly after the last delivered event
  (`workspace-events.ts:46,103`). Duplicates on reconnect are additionally idempotent in the reducer.

### Restart recovery — correct
- WAL + `synchronous=FULL`; reopening the same data dir re-validates the schema idempotently and
  preserves user, session (cookie still authenticates to the same session id), audit (count 3),
  workspace event (count 1), and snapshot (`asOfSequence=1`) — `restart.test.ts`. Because replay comes
  from SQLite, streams are correct across restart.

### CT-01 regressions — held
- R1 non-loopback rejected (`config.ts:44-71`; `config.test.ts` "rejects every non-loopback host…
  (CT01-R1)"). R2 fresh managed E2E server (playwright config). R3 sustained-failure visibly
  represented (reducer `disconnected` after `sourceClosed`/≥2 errors → `ConnectionBadge`; e2e outage
  recovery). R4 forbidden-scope import forms (`check-forbidden-scope.test.mjs`). R5 literal
  `pnpm check` under Node 24.18.0.

### Scope discipline — held
- Scope gate passes; no `@craftingtable/agents`/`git` imports in production server/web source; no
  worktree/merge/git/agent/planning-studio/Exo terms in new production source. Fake artifacts
  deleted: `routes/events.ts`, `SimulatedBadge.tsx`, `useEventStream.ts`, `streamState.ts`.

### CT-03 buildability — clean, with one explicit hand-off (see F3)
- The durable model is the sole source of truth; CT-03 producers append workspace events inside the
  same transaction helper and get replay/live-tail for free. One forward contract must be honored
  (F3) so live latency does not silently degrade.

---

## Findings

### CT02-F1 — Low — CLI `db status` / `db migrate` surface a raw error on an unsupported/tampered schema
`apps/server/src/cli.ts:82-105` calls `migrationStatus` / `openCraftingTableStorage`, which **throw**
on a newer-version or checksum-mismatch ledger (`migrations.ts:81-99`). The CLI has no branch to turn
that into a structured status line + distinct exit code — it falls through to the top-level catch and
prints a bare message with exit `1`. Additionally `db status` opens through `openDatabase`, whose
`configureDatabase` sets `journal_mode=WAL`; handing it a non-WAL database mutates it (and creates
`-wal`/`-shm`) as a side effect of a nominally read-only status check.
**Impact:** operator ergonomics only; safety is preserved (it refuses rather than corrupts).
**Recommendation:** catch validation errors in the CLI and emit a clean "schema unsupported / checksum
mismatch" status with a dedicated nonzero exit; consider a read-only open for `db status`.

### CT02-F2 — Low (hardening) — SSE stream relies solely on `SameSite=Strict` for cross-site protection
`GET /api/workspaces/:id/events` (`routes/workspace-events.ts`) authenticates by cookie but performs
**no** Origin / `Sec-Fetch-Site` check, unlike login and all mutations. Today this is adequate:
`EventSource` cannot attach a cross-site `SameSite=Strict` cookie and cannot add custom headers, so a
cross-origin page gets an unauthenticated `401`. The risk is coupling: if the cookie policy is ever
relaxed (e.g. `SameSite=Lax`/`__Host-` transition in CT-08) the stream loses its only cross-site
guard.
**Recommendation:** add an explicit same-origin assertion on the SSE route (mirroring
`isAllowedBrowserRequest`) or document the `SameSite=Strict` dependency as load-bearing so CT-08 does
not weaken it inadvertently.

### CT02-F3 — Informational (CT-03 hand-off contract) — daemon in-process `notify()` is never exercised at runtime in CT-02
The only workspace-event producer in CT-02 is `BootstrapService`, which runs in the **CLI** process
holding a *separate* `WorkspaceEventNotifier` instance from the daemon (`cli.ts:117`,
`composition.ts:38`). No runtime daemon path appends a workspace event, so the daemon's fast-path
`notifier.notify()` is dead at runtime; live delivery is carried entirely by the ≤1 s bounded requery
(the A33 recovery path). This is correct and by design for CT-02 (only `workspace-created` exists).
**Forward risk:** CT-03 must call the **daemon's** `notifier.notify()` after each post-commit
workspace-event append, or live latency will silently degrade to the poll interval with no test
failure.
**Recommendation:** record this as an explicit CT-03 acceptance obligation (append + same-process
notify) so it is not lost.

### CT02-F4 — Low (efficiency / scaling caveat) — each idle SSE connection re-auths and requeries every 1 s
With production `waitTimeoutMs=1000`, every open stream re-runs `authenticate()` (session + user
reads) and an empty `listAfter` query once per second even when nothing changed
(`workspace-event-stream-service.ts:32-66`). Negligible for a single-user loopback daemon and it
doubles as the dropped-notification safety net, but it is O(connections/second) DB work that should be
revisited before multi-user/CT-08.
**Recommendation:** none required for CT-02; note the interval as a knob for later.

### CT02-F5 — Low (consistency) — `/snapshot` and `/audit` validate `workspaceId` before authenticating
`routes/workspaces.ts:50-54,67-81` return `404` for a malformed `workspaceId` *before* calling
`authenticate()`, so an unauthenticated request with a malformed id gets `404` while the SSE route
(which authenticates first) would return the generic `401`. No data is disclosed either way, but the
`401` vs `404` ordering is inconsistent across routes.
**Recommendation:** authenticate first (or normalize the order) so unauthenticated requests uniformly
receive `401`.

### CT02-F6 — Low (documentation / process) — completion report says "uncommitted" but the reviewed head is the commit
`implementation-reports/CT-02/CT-02-completion.md` states **"Commit status: uncommitted, as
required,"** yet the entire implementation is committed as the reviewed head `466649b` on branch
`ct-02-persistent-daemon` (and the accepted plan states "No commits or merges are authorized by this
plan"). The durable record therefore contradicts the repository state.
**Recommendation:** reconcile the report — either confirm the operator authorized the commit and
update the status line, or clarify the intended committed/uncommitted posture.

### CT02-F7 — Informational — reducer conflates cross-workspace and schema-invalid events
`apps/web/src/lib/workspace-projection.ts:69-86` increments a single `invalidEventCount` for both a
schema-invalid event and a (server-impossible) cross-workspace event. Since the server already filters
by workspace, the cross-workspace branch is effectively unreachable; the counter is really
"schema-invalid." Cosmetic observability nit only.

---

## Acceptance matrix (reviewer confirmation)

Every acceptance ID CT02-A01 … CT02-A43 has corresponding, passing evidence in the green gate and the
tests read during this review (migration negatives, pragma verification, Argon2id + digest-only
storage, cookie attributes, CSRF accept/reject, cross-site login, session ownership, expiry, workspace
non-disclosure, both snapshot/SSE race orderings, lost-wakeup, dropped-notifier recovery,
`Last-Event-ID`, refresh dedup, outage recovery, restart reconstruction, loopback rejection,
forbidden-scope, docs/ADRs). The operator-approved **A07** amendment (exactly one
`admin.bootstrap.denied` audit row, no other mutation) is implemented in `bootstrap-service.ts:41-44`.

No acceptance criterion was found unmet. The findings above are non-blocking; F1, F5, and F6 are the
most worth addressing, and F3 should be carried forward as a written CT-03 obligation.
