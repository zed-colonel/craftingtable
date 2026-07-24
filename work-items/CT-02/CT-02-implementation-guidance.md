# CT-02 implementation guidance

**Status:** Recommended source-grounded design  
**Binding authority:** `work-items/CT-02.md`  
**Baseline:** `693445257d61222959c2efa9fc82c621fa8c6653`

This document is implementation guidance rather than a substitute for the binding work contract. The Phase A implementer should challenge any detail that conflicts with the real source or creates needless complexity, but must preserve the stated invariants.

## 1. Target architecture

```text
Browser
    │
    │ typed JSON commands and queries
    │ authenticated workspace SSE
    ▼
Fastify HTTP adapters
    │
    ├── authentication extraction
    ├── CSRF enforcement
    ├── shared schema validation
    └── thin route mapping
    │
    ▼
Application services
    ├── AuthService
    ├── WorkspaceService
    ├── SnapshotService
    ├── AuditService
    └── WorkspaceEventStreamService
    │
    ▼
Storage transaction boundary
    ├── current-state repositories
    ├── append-only audit journal
    ├── append-only workspace-event journal
    └── migration/schema manager
    │
    ▼
SQLite in WAL mode
```

The browser receives projections. Fastify adapts HTTP. Services authorize and coordinate. Storage owns SQL and atomicity. SQLite is authoritative.

## 2. Recommended package graph

```text
@craftingtable/domain
    pure identifiers, roles, statuses, records
       ▲       ▲
       │       │
contracts   storage
Zod wire    SQLite, migrations, repositories, transactions
       ▲       ▲
       └───┬───┘
           │
@craftingtable/server
    services, security, Fastify routes, CLI, composition

@craftingtable/web
    depends on contracts/domain; never storage/server internals

@craftingtable/testing
    test fixtures and temporary storage helpers; test-only consumers
```

Recommended TypeScript reference direction:

```text
domain        → none
contracts     → domain
agents        → domain + contracts     # unchanged/deferred
Git           → domain                 # unchanged/deferred
storage       → domain
Testing       → domain + contracts + storage + deferred seams as needed
server        → domain + contracts + storage + agents + git + testing only in dev/test composition
web           → domain + contracts
```

Production server composition should not depend on `@craftingtable/testing`. If a development seed is retained, expose it through an explicit development-only composition path rather than importing testing fakes into the normal daemon entry point.

## 3. Recommended source tree changes

```text
packages/
├── domain/
│   └── src/
│       ├── ids.ts
│       ├── auth.ts
│       ├── workspace.ts
│       ├── audit.ts
│       ├── workspace-events.ts
│       └── index.ts
│
├── contracts/
│   └── src/
│       ├── auth.ts
│       ├── workspace.ts
│       ├── snapshot.ts
│       ├── audit.ts
│       ├── workspace-event.ts
│       ├── health.ts
│       └── index.ts
│
├── storage/
│   ├── package.json
│   ├── tsconfig.json
│   ├── migrations/
│   │   └── 0001-ct02-foundation.sql
│   └── src/
│       ├── database.ts
│       ├── config.ts
│       ├── migrations.ts
│       ├── transaction.ts
│       ├── row-mapping.ts
│       ├── repositories/
│       │   ├── users.ts
│       │   ├── sessions.ts
│       │   ├── workspaces.ts
│       │   ├── audit.ts
│       │   └── workspace-events.ts
│       └── index.ts
│
└── testing/
    └── src/
        ├── temporary-database.ts
        ├── deterministic-clock.ts          # only if useful
        └── ...

apps/server/src/
├── index.ts
├── server.ts
├── config.ts
├── cli.ts
├── composition.ts
├── security/
│   ├── password-hasher.ts
│   ├── session-token.ts
│   ├── csrf.ts
│   ├── origin-policy.ts
│   └── auth-context.ts
├── services/
│   ├── bootstrap-service.ts
│   ├── auth-service.ts
│   ├── workspace-service.ts
│   ├── snapshot-service.ts
│   ├── audit-service.ts
│   └── workspace-event-stream-service.ts
├── routes/
│   ├── health.ts
│   ├── auth.ts
│   ├── workspaces.ts
│   ├── audit.ts
│   └── events.ts
└── plugins/
    ├── cookies.ts
    ├── request-context.ts
    └── authentication.ts

apps/web/src/
├── App.tsx
├── lib/
│   ├── api-client.ts
│   ├── auth-state.ts
│   ├── workspace-projection.ts
│   ├── workspace-stream-state.ts
│   └── useWorkspaceEventStream.ts
├── components/
│   ├── LoginPage.tsx
│   ├── WorkspaceShell.tsx
│   ├── AccountMenu.tsx
│   ├── SessionList.tsx
│   ├── ConnectionBadge.tsx
│   ├── StatusRegions.tsx
│   └── ActivityPanel.tsx
└── styles/...
```

Do not treat this file tree as a requirement to maximize file count. Consolidation is acceptable when it preserves dependency direction and testability.

## 4. Storage schema

The following schema is illustrative but intentionally concrete enough to pressure-test the design.

### 4.1 Schema migrations

```sql
CREATE TABLE schema_migrations (
    version       INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    checksum      TEXT NOT NULL,
    applied_at    TEXT NOT NULL
) STRICT;
```

Migration files should be immutable after merge. A changed checksum is a startup error, not a reason to update the stored checksum.

### 4.2 Users

```sql
CREATE TABLE users (
    id                    TEXT PRIMARY KEY,
    username              TEXT NOT NULL,
    username_normalized   TEXT NOT NULL UNIQUE,
    password_hash         TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;
```

Notes:

- Keep the first model direct. A separate generic auth-identity table is not required until a second authentication mechanism exists.
- Normalize username consistently, for example trim plus Unicode-safe lowercasing under a documented rule.
- Display casing can remain in `username`; uniqueness uses `username_normalized`.

### 4.3 Workspaces

```sql
CREATE TABLE workspaces (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    slug                  TEXT NOT NULL UNIQUE,
    status                TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_by_user_id    TEXT NOT NULL REFERENCES users(id),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;
```

CT-02 creates one default workspace through bootstrap. No HTTP creation route is required.

### 4.4 Workspace memberships

```sql
CREATE TABLE workspace_memberships (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role           TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    status         TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at     TEXT NOT NULL,
    revoked_at     TEXT,
    version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (workspace_id, user_id)
) STRICT;

CREATE INDEX idx_workspace_memberships_user
    ON workspace_memberships(user_id, status);
```

Only `owner` is created in CT-02, but route and service code should not assume the enum has one value.

### 4.5 Sessions

```sql
CREATE TABLE sessions (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash            TEXT NOT NULL UNIQUE,
    csrf_token            TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    expires_at            TEXT NOT NULL,
    last_seen_at          TEXT NOT NULL,
    revoked_at            TEXT,
    revocation_reason     TEXT,
    user_agent            TEXT,
    remote_address        TEXT,
    version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE INDEX idx_sessions_user_active
    ON sessions(user_id, revoked_at, expires_at);
```

The raw session token never enters this table. `csrf_token` may be stored because it is readable by same-origin authenticated JavaScript and does not independently authenticate a user. If preferred, store a hash and rotate/return a token through a dedicated operation; that is more complexity than CT-02 needs.

`last_seen_at` can be updated at most once per configured interval to avoid a write on every request. Omitting sliding expiration and using only absolute expiry is also acceptable if documented.

### 4.6 Audit events

```sql
CREATE TABLE audit_events (
    sequence               INTEGER PRIMARY KEY AUTOINCREMENT,
    id                     TEXT NOT NULL UNIQUE,
    occurred_at            TEXT NOT NULL,
    actor_kind             TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
    actor_user_id          TEXT REFERENCES users(id),
    session_id             TEXT REFERENCES sessions(id),
    workspace_id           TEXT REFERENCES workspaces(id),
    request_id             TEXT,
    action                 TEXT NOT NULL,
    target_type            TEXT,
    target_id              TEXT,
    outcome                TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
    prior_version          INTEGER,
    resulting_version      INTEGER,
    metadata_json          TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX idx_audit_workspace_sequence
    ON audit_events(workspace_id, sequence DESC);
CREATE INDEX idx_audit_user_sequence
    ON audit_events(actor_user_id, sequence DESC);
```

Add triggers that `RAISE(ABORT, ...)` on update and delete. Keep metadata small and explicitly allowlisted. Never dump request bodies or headers into audit JSON.

### 4.7 Workspace events

```sql
CREATE TABLE workspace_events (
    sequence               INTEGER PRIMARY KEY AUTOINCREMENT,
    id                     TEXT NOT NULL UNIQUE,
    schema_version         INTEGER NOT NULL,
    occurred_at            TEXT NOT NULL,
    workspace_id           TEXT NOT NULL REFERENCES workspaces(id),
    actor_user_id          TEXT REFERENCES users(id),
    project_id             TEXT,
    work_item_id           TEXT,
    run_id                 TEXT,
    kind                   TEXT NOT NULL,
    payload_json           TEXT NOT NULL
) STRICT;

CREATE INDEX idx_workspace_events_workspace_sequence
    ON workspace_events(workspace_id, sequence);
```

Add append-only triggers here as well.

A global sequence simplifies `Last-Event-ID`, audit correlation, and one-daemon ordering. Gaps observed within one workspace are harmless. If later household use treats those gaps as sensitive metadata, the external cursor can be changed without changing the database primary key.

### 4.8 Optional metadata

A small `application_metadata` table may retain:

```text
instance ID
created time
schema contract
```

Do not build a general configuration database in CT-02.

## 5. Database opening and migration

Recommended opening sequence:

```text
resolve canonical data directory
    ↓
create directory with owner-only permissions
    ↓
open database
    ↓
set busy timeout and foreign keys
    ↓
set/verify WAL mode
    ↓
set and verify `PRAGMA synchronous = FULL`
    ↓
apply and verify migrations
    ↓
construct repositories and services
```

Illustrative API:

```ts
export interface StorageOptions {
  readonly databasePath: string;
  readonly readonly?: boolean;
}

export interface CraftingTableStorage {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly workspaces: WorkspaceRepository;
  readonly audit: AuditRepository;
  readonly workspaceEvents: WorkspaceEventRepository;

  transaction<T>(operation: (tx: StorageTransaction) => T): T;
  close(): void;
}
```

Avoid exposing the raw SQLite connection outside `@craftingtable/storage`.

The server should not begin listening until migration and schema verification succeed.

## 6. Command transaction pattern

Do not introduce event sourcing or a generic command bus. Use explicit service methods and a small transaction context.

Illustrative bootstrap:

```ts
storage.transaction((tx) => {
  assertNoExistingUsers(tx);

  const user = tx.users.insert(...);
  const workspace = tx.workspaces.insert(...);
  const membership = tx.workspaces.insertMembership(...);

  const event = tx.workspaceEvents.append({
    workspaceId: workspace.id,
    actorUserId: user.id,
    kind: 'workspace-created',
    payload: { name: workspace.name },
  });

  tx.audit.append({
    actorKind: 'system',
    actorUserId: user.id,
    workspaceId: workspace.id,
    action: 'admin.bootstrap',
    targetType: 'workspace',
    targetId: workspace.id,
    outcome: 'succeeded',
  });

  return { user, workspace, membership, event };
});
```

After commit, signal the in-process journal notifier. Never notify before commit.

For failures that occur before a transaction, write a safe audit record in a separate transaction only when it is useful and does not create an enumeration or denial-of-service problem.

## 7. Authentication design

### 7.1 Password service

Illustrative interface:

```ts
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encodedHash: string, password: string): Promise<boolean>;
}
```

Use `argon2id`. Enforce a reasonable maximum password byte length before hashing to prevent pathological resource consumption. Do not enforce arbitrary composition rules; permit passphrases.

### 7.2 Session token service

```ts
export interface NewSessionToken {
  readonly raw: string;
  readonly digest: string;
}

export interface SessionTokenService {
  generate(): NewSessionToken;
  digest(raw: string): string;
}
```

Recommended generation:

```text
randomBytes(32)
→ base64url raw token
→ SHA-256 hex digest for lookup
```

The digest does not need a salt because the input has high entropy.

### 7.3 Login flow

```text
validate JSON request
    ↓
validate origin/fetch metadata
    ↓
normalize username
    ↓
load user by normalized username
    ↓
verify Argon2id hash
    ↓
generate session and CSRF token
    ↓
commit session + login audit
    ↓
set HttpOnly session cookie
    ↓
return AuthenticatedSessionResponse including CSRF token
```

Use a generic authentication error. Apply a minimum response duration or a lightweight rate limit if practical without adding a platform-sized subsystem.

### 7.4 Request authentication

```text
read cookie
    ↓
hash raw token
    ↓
load session
    ↓
check not revoked and not expired
    ↓
load active user
    ↓
attach immutable AuthContext
```

```ts
export interface AuthContext {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly username: string;
  readonly expiresAt: string;
}
```

Do not attach the raw session token.

### 7.5 CSRF flow

Authenticated session response includes a CSRF token. The web client holds it in memory and sends:

```text
X-CraftingTable-CSRF: <token>
```

for authenticated POST/PUT/PATCH/DELETE operations.

On a page reload, `GET /api/auth/session` returns the same session-bound token. The response is same-origin and `Cache-Control: no-store`.

The server:

- requires an authenticated session;
- validates the custom header against the session token using `timingSafeEqual`;
- validates request origin/fetch metadata;
- rejects invalid tokens before service invocation.

Login has no authenticated session yet. Require `Content-Type: application/json`, reject cross-site fetch metadata/origins, and do not support form encoding.

### 7.6 Logout and revocation

Logout transaction:

```text
mark current session revoked
append principal audit event
commit
clear cookie
close or invalidate active SSE connections for that session
```

Revoking another session requires the owning user and a valid CSRF token. Revoking the current session behaves like logout.

## 8. Workspace authorization

Recommended service boundary:

```ts
export interface WorkspaceAuthorizer {
  requireMembership(input: {
    userId: UserId;
    workspaceId: WorkspaceId;
    minimumRole?: WorkspaceRole;
  }): WorkspaceMembership;
}
```

For CT-02, role ordering need not become a general policy engine. Explicit checks are clearer:

```text
read workspace snapshot: active Owner/Editor/Viewer
read workspace stream: active Owner/Editor/Viewer
read workspace audit: active Owner initially
```

Return a generic not-found or forbidden response according to one consistent policy. Do not reveal workspace names or membership facts before authorization.

Every service method that reads workspace-owned data should accept `userId` and `workspaceId` or an already verified membership object. Avoid a hidden global “current workspace.”

## 9. Durable event envelope

Recommended schema shape:

```ts
const workspaceEventBaseSchema = z.object({
  id: eventIdSchema,
  sequence: z.number().int().positive(),
  schemaVersion: z.literal(1),
  occurredAt: z.iso.datetime(),
  workspaceId: workspaceIdSchema,
  actorUserId: userIdSchema.optional(),
  projectId: projectIdSchema.optional(),
  workItemId: workItemIdSchema.optional(),
  runId: agentRunIdSchema.optional(),
});
```

Minimal CT-02 event kinds might be:

```text
workspace-created
workspace-profile-updated       # only if a mutation route exists
```

If no workspace mutation route exists, `workspace-created` alone is sufficient. Authentication/session events belong in the audit journal, not necessarily the workspace activity stream.

Future CT-03+ kinds are added by the work item that owns them. Do not define speculative review, Git, or agent-run payloads now.

SSE frame:

```text
event: workspace-event
id: <sequence>
data: <WorkspaceEventEnvelope JSON>
```

## 10. Snapshot contract

Recommended response:

```ts
interface WorkspaceSnapshotResponse {
  workspace: {
    id: WorkspaceId;
    name: string;
    slug: string;
    role: WorkspaceRole;
  };
  asOfSequence: number;
  statusSummary: {
    needsAttention: number;
    active: number;
    ready: number;
    blocked: number;
  };
  recentActivity: WorkspaceEventEnvelope[];
}
```

The four status counts remain zero until CT-03/CT-05 create real records. This is honest and preserves the shell.

Read snapshot in one SQLite read transaction:

```text
verify membership
read workspace and membership
read current highest workspace-event sequence visible in transaction
read recent events with sequence <= cursor
return snapshot + cursor
```

Use the global maximum `workspace_events.sequence` visible inside that same read transaction as `asOfSequence`, or `0` when the journal is empty. Subsequent workspace-filtered replay naturally skips global-sequence gaps created by other workspaces. This fixes one cursor meaning across snapshot, query replay, `Last-Event-ID`, and future multi-workspace use.

## 11. SSE replay and live-tail algorithm

### 11.1 Cursor selection

On initial browser connection:

```text
/api/workspaces/<id>/events?after=<snapshot.asOfSequence>
```

On automatic native reconnect, the browser sends `Last-Event-ID`. Choose the greater valid cursor from:

```text
query `after`
Last-Event-ID header
```

Reject malformed, negative, unsafe-integer, or absurd cursors with a typed `400` before hijacking the response.

### 11.2 Race-free loop

Use a notifier as an optimization, never as the event source. The notifier is not the event store; SQLite remains authoritative.

```ts
while (!signal.aborted) {
  await ensureSessionStillActive();

  const observedGeneration = notifier.generation;
  const batch = journal.listAfter({ workspaceId, cursor, limit: 100 });

  if (batch.length > 0) {
    for (const event of batch) {
      writeSse(event);
      cursor = event.sequence;
    }
    continue;
  }

  await notifier.waitForChangeOrTimeout(observedGeneration, 1000, signal);
}
```

Why this avoids a lost wakeup:

1. record notifier generation;
2. query durable journal;
3. if an event commits after the query but before waiting, notifier generation changes;
4. `waitForChangeOrTimeout` returns immediately rather than sleeping;
5. timeout polling recovers even if an in-process notification is missed.

The notifier payload should be only “journal changed.” The stream always reloads authoritative rows from SQLite.

### 11.3 Connection lifecycle

Retain:

- heartbeat comments;
- active stream abortion during Fastify shutdown;
- visible reconnect/disconnected policy in web state.

Add:

- authenticated session and membership at connect;
- periodic session revalidation;
- workspace filtering;
- maximum batch size;
- backpressure handling or explicit connection termination if writes fail;
- safe logging with no cookie/token content.

## 12. Browser reconstruction

Recommended state machine:

```text
Booting
    ↓
CheckingSession
    ├── unauthenticated → Login
    └── authenticated
            ↓
       LoadingWorkspaces
            ↓
       LoadingSnapshot
            ↓
       ConnectingStream
            ↓
       Ready
```

Failure substates:

```text
AuthenticationExpired
TemporarilyDisconnected
FatalSnapshotError
```

### 12.1 Projection reducer

```ts
interface WorkspaceProjectionState {
  snapshotStatus: 'idle' | 'loading' | 'ready' | 'error';
  streamStatus: ConnectionState;
  workspace?: WorkspaceSummary;
  role?: WorkspaceRole;
  lastSequence: number;
  events: WorkspaceEventEnvelope[];
  invalidEventCount: number;
}
```

Actions:

```text
snapshot-requested
snapshot-loaded
snapshot-failed
stream-opened
stream-error
event-received
event-invalid
authentication-expired
```

Rules:

- `snapshot-loaded` replaces the projection and establishes `lastSequence`;
- `stream-opened` does not clear anything;
- an event with sequence `<= lastSequence` is ignored as duplicate;
- an event with sequence `lastSequence + 1` or any later valid global sequence is applied;
- out-of-order regression is surfaced, not silently sorted into history;
- keep only a bounded recent activity list in browser memory if needed;
- SQLite retains the full CT-02 history.

Because global sequences can contain gaps for other workspaces, do not require exact `+1` continuity unless sequences are defined per workspace. Require strictly increasing order.

### 12.2 Authentication UI

Keep the UI small:

- username;
- password;
- submit and generic failure;
- no registration link;
- no password reset;
- no “remember me” toggle;
- no OAuth.

Do not store the session token in browser storage; the cookie owns it. Do not persist the CSRF token to `localStorage`; reload it from the authenticated session endpoint.

### 12.3 Workspace selection

Even with one default workspace, render a small selector or structurally handle an array of workspaces. Do not hardcode the first workspace ID into the stream URL or application source.

## 13. API contracts

Illustrative request/response types:

### 13.1 Login

```ts
LoginRequest = {
  username: string;
  password: string;
}

AuthenticatedSessionResponse = {
  user: {
    id: UserId;
    username: string;
  };
  session: {
    id: SessionId;
    createdAt: string;
    expiresAt: string;
    current: true;
  };
  csrfToken: string;
}
```

Do not include password-hash parameters, token digest, remote address, or raw cookie.

### 13.2 Session list

```ts
SessionSummary = {
  id: SessionId;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
  userAgent?: string;
}
```

Avoid returning full IP addresses by default if they are not needed. A local display can use a safe description.

### 13.3 Workspace list

```ts
WorkspaceListResponse = {
  workspaces: Array<{
    id: WorkspaceId;
    name: string;
    slug: string;
    role: WorkspaceRole;
  }>;
}
```

### 13.4 Audit page

```ts
WorkspaceAuditPageResponse = {
  records: AuditRecordSummary[];
  nextBefore?: number;
}
```

Return allowlisted metadata only. Do not return session token digests, password hashes, CSRF tokens, raw cookies, or request headers.

## 14. Configuration

Extend `apps/server/src/config.ts` with runtime validation.

Recommended fields:

```ts
interface ServerConfig {
  host: LoopbackHost;
  port: number;
  dataDir: string;
  databasePath: string;
  publicOrigin: string;
  sessionCookieName: string;
  sessionLifetimeSeconds: number;
  secureCookies: boolean;
  logLevel: string;
}
```

Defaults:

```text
host: 127.0.0.1
port: 4600
dataDir: XDG data path
publicOrigin: http://127.0.0.1:5173 in dev or configured same origin
secureCookies: true only for HTTPS
```

Reject:

- non-loopback host;
- invalid public origins;
- relative or unsafe data-directory values after canonicalization rules;
- malformed durations;
- a production/LAN mode without secure-cookie/TLS requirements later.

Do not log the complete environment or secrets.

## 15. CLI design

Recommended command shape:

```text
pnpm craftingtable admin bootstrap --username keith
pnpm craftingtable db status
pnpm craftingtable db migrate
```

Internally:

```text
parse structural options
resolve config
open storage and migrate
call BootstrapService
close storage
return deterministic exit code
```

Password input:

- interactive no-echo prompt;
- confirmation prompt;
- no command-line password;
- core service accepts password as an in-memory argument for tests;
- test harness invokes the service directly or provides a dedicated test input adapter.

The CLI should emit concise human output and structured errors, not database internals.

## 16. Dependency recommendations

Likely new production dependencies:

```text
better-sqlite3
argon2
@fastify/cookie
```

Possible:

```text
@fastify/csrf-protection
```

Only use the CSRF plugin if it integrates cleanly with the custom session repository. A small custom synchronizer-token check is acceptable and may be easier to audit.

Likely development dependency:

```text
@types/better-sqlite3
```

Do not add:

```text
Prisma
TypeORM
Drizzle ORM
Knex
Passport
Auth.js
Redis
React Router
Redux
React Query
```

unless the Phase A proposal demonstrates an immediate CT-02 requirement that cannot be met proportionately.

Update pnpm build approval for native dependencies. Verify both prebuilt binary installation and full `pnpm check` under Node `24.18.0`.

## 17. Migration runner details

Recommended migration manifest generation:

```ts
interface MigrationDefinition {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}
```

At startup:

1. create `schema_migrations` if absent;
2. load applied rows;
3. compare every applied version and checksum;
4. reject unknown applied versions;
5. apply remaining migrations;
6. insert migration row within the same transaction;
7. verify final version.

Do not silently repair checksum mismatches.

Tests should modify an in-memory migration definition or temporary SQL file and prove rejection. Production code should not walk arbitrary user-controlled directories.

## 18. Audit semantics

Define an allowlisted action vocabulary, for example:

```text
admin.bootstrap
admin.bootstrap-denied
auth.login
auth.login-failed
auth.logout
auth.session-revoked
workspace.created
workspace.access-denied
```

Do not create one event per HTTP request. Audits represent security-relevant or state-changing actions.

Actor distinctions:

```text
system
user
```

Later CT-05 will add agent actor provenance, but CT-02 should not invent it now.

Failed login audit should avoid storing the submitted password or uncontrolled request body. It may retain a normalized username or a one-way identifier according to the accepted security decision.

## 19. Server composition and shutdown

Recommended composition:

```ts
const config = configFromEnv();
const storage = openCraftingTableStorage(config.storage);
runMigrations(storage);

const passwordHasher = createArgon2PasswordHasher();
const sessionTokens = createSessionTokenService();
const notifier = new WorkspaceEventNotifier();

const services = buildServices({
  storage,
  passwordHasher,
  sessionTokens,
  notifier,
  clock,
});

const app = buildServer({ services }, { logger: true });
```

Shutdown order:

```text
stop accepting requests
    ↓
abort active SSE streams
    ↓
await Fastify close hooks
    ↓
close SQLite connection
    ↓
exit
```

Do not close SQLite while stream loops or service calls can still query it.

## 20. Testing plan

### 20.1 Pure tests

- ID factories and role vocabularies.
- Contract validation.
- username normalization.
- session token digest determinism.
- CSRF comparison.
- projection reducer.
- cursor parsing and selection.

### 20.2 Storage integration tests

Use real temporary files rather than only `:memory:` so WAL/reopen semantics are exercised.

Each test or suite:

```text
mkdtemp
→ open database
→ migrate
→ operate
→ close
→ optionally reopen
→ assert
→ delete directory
```

High-value tests:

- migration and checksum behavior;
- WAL and foreign-key pragmas;
- transaction atomicity;
- append-only triggers;
- global sequence across reopen;
- concurrent snapshot/read while a write commits;
- clean and abrupt reopen after committed data.

### 20.3 Server integration tests

Use `buildServer` with real storage and test services.

- bootstrap service then login route;
- cookie extraction;
- session query;
- CSRF-protected logout/revoke;
- workspace list/snapshot/audit authorization;
- SSE replay against a real ephemeral port;
- session expiration/revocation.

Avoid mocking the exact boundary being tested.

### 20.4 Replay boundary tests

Create deterministic hooks around:

```text
journal query completed
notifier wait begins
event transaction commits
```

Prove the event is delivered in both race orderings.

A notifier with observable generation counters is easier to test than ad hoc promises.

### 20.5 Restart tests

At least one test should:

1. open storage A;
2. bootstrap and create session;
3. obtain snapshot and cursor;
4. close server/storage A;
5. open storage B on the same file;
6. authenticate with the retained cookie according to policy;
7. obtain the same workspace and event history;
8. continue the sequence with a later committed record.

A process-level child test is preferable if proportionate. An in-process close/reopen test is the minimum.

### 20.6 E2E

The Playwright flow should use a fresh temporary data directory and deterministic test credentials created through the real bootstrap service.

Suggested flow:

```text
visit app
→ see login
→ log in
→ see real workspace name and persistent badge/state
→ see workspace-created activity
→ refresh
→ activity remains exactly once
→ simulate temporary SSE outage and recovery
→ log out
→ return to login
```

Do not use the operator's actual CraftingTable database.

## 21. Phased implementation sequence

### Phase 1 — Accept the plan and ADR decisions

- inspect actual source;
- finalize target tree;
- accept ADR-002;
- amend ADR-003;
- add auth/session/CSRF ADR;
- add transaction/event/audit ADR if needed.

No code until operator approves the Phase A plan.

### Phase 2 — Domain, contracts, and storage skeleton

- add IDs and vocabularies;
- add wire schemas;
- add storage package;
- add migration runner and first migration;
- test opening, migration, and pragmas.

### Phase 3 — Bootstrap and authentication

- password/session/CSRF utilities;
- bootstrap service and CLI;
- session repository;
- login/session/logout/revoke routes;
- focused security tests.

### Phase 4 — Workspaces, authorization, audit

- membership repositories;
- workspace list and authorization service;
- append-only audit records;
- audit query;
- cross-workspace negative tests.

### Phase 5 — Workspace events and snapshots

- durable envelope;
- event journal;
- state + audit + event transaction helper;
- snapshot query and cursor;
- append-only/sequence tests.

### Phase 6 — SSE replay and live tail

- authenticated workspace route;
- cursor parsing;
- replay batches;
- notifier/poll loop;
- session revalidation;
- replay-race tests.

### Phase 7 — Browser authentication and reconstruction

- login shell;
- auth state;
- workspace list/selection;
- snapshot hydration;
- stream reducer;
- logout/session UI;
- remove normal fake-data path.

### Phase 8 — Restart/E2E/docs/full gate

- process or reopen tests;
- Playwright flow;
- README/CONTRIBUTING/architecture;
- completion report;
- `pnpm check`;
- source diff review.

This sequence keeps persistence and security semantics ahead of UI polish.

## 22. Review plan

Use Claude Code as the independent CT-02 reviewer after Codex produces a generation commit.

Reviewer inputs:

- this contract;
- accepted CT-02 implementation plan;
- baseline and head SHAs;
- full diff;
- `pnpm check` evidence;
- migration SQL;
- schema and API inventory.

Reviewer focus:

```text
transaction atomicity
migration safety
password/session secrecy
CSRF correctness
workspace authorization
snapshot consistency
SSE lost-wakeup and dedup behavior
restart recovery
test isolation
scope discipline
```

Do not give the reviewer the implementer's full conversation by default.

A second focused review after remediation must use the new exact head SHA and explicitly close or retain each finding.

## 23. Known tradeoffs accepted for CT-02

- One SQLite connection and one Node daemon are enough.
- Synchronous database calls are acceptable for small local transactions.
- Global event sequence can contain workspace gaps.
- Event retention is unlimited for this stage.
- Session auth is password-based only.
- `Secure` cookies are conditional until CT-08 provides HTTPS.
- The application remains loopback-only despite authentication.
- Logical workspace authorization does not provide hostile-user process isolation.
- Snapshot responses can remain small because projects and runs do not exist yet.
- No backup UI or operational packaging is required.

## 24. Definition of a strong CT-02 result

A strong result is not merely “SQLite added” or “login works.” It demonstrates one reusable pattern that later work can trust:

```text
user issues typed command
    ↓
server authenticates session
    ↓
service authorizes workspace
    ↓
transaction mutates state and appends audit/event records
    ↓
commit succeeds
    ↓
SSE clients are nudged
    ↓
clients reload durable events
    ↓
browser projection updates
    ↓
restart reproduces the same truth
```

Once this is correct, CT-03 can safely add plans and work items without reopening the foundation.
