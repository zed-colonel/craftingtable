# Architecture boundaries (CT-02)

CraftingTable is a loopback-only supervisory workbench. The daemon owns
authoritative state; the browser is an authenticated projection reconstructed
from a durable snapshot and event cursor.

## Dependency direction

```text
domain        pure TypeScript records and branded identifiers
   ▲
contracts     strict Zod HTTP/SSE contracts
   ▲
storage       SQLite adapter, migrations, SQL, repositories
   ▲
server        Fastify routes, security policy, application services, composition

domain + contracts
   ▲
web           React projection; no server/storage imports
```

The actual project-reference graph is:

```text
domain       → none
contracts    → domain
storage      → domain
server       → domain + contracts + storage
web          → domain + contracts
```

`packages/agents`, `packages/git`, and `packages/testing` remain future/test
seams inherited from CT-01. Production server composition imports none of them.
Only `@craftingtable/storage` imports `better-sqlite3` or owns SQL. No package
depends on ActionQueue, WorldInterface, Exoskeleton, or another application
runtime.

## Authoritative write and read paths

The first workspace-domain command is bootstrap:

```text
user + default workspace + Owner membership
  + allowlisted audit rows + workspace-created event
  └── one immediate SQLite transaction
        └── commit
              └── in-memory generation notifier
```

The notifier contains no event data and is never an event store. A browser
reconstructs state through:

```text
authenticated session
  → authorized workspace list
  → one-transaction snapshot + global asOfSequence
  → workspace-filtered SSE replay after that cursor
  → durable live tail
```

SSE re-queries SQLite after notifier changes and bounded timeouts. This makes
lost or process-local notifications harmless and makes replay survive daemon
restart. The global database sequence is strictly increasing; a workspace
stream can legitimately contain gaps caused by events in another workspace.

## Boundary rules

- Domain types do not depend on HTTP, React, SQLite, process control, Git, or
  vendor SDKs.
- Shared responses and SSE payloads are strict runtime-validated contracts.
  The server validates before sending and the browser validates again.
- Workspace membership is enforced in application services. UI filtering and
  route parameters are not authorization.
- The browser cannot submit shell commands, SQL, paths, or process-control
  requests.
- Audit events and workspace events are separate append-only vocabularies.
- CT-01's fake backend fixture is test/development data only. No normal-runtime
  fallback bypasses the workspace journal.

## Deliberately deferred

CT-02 has no projects, imported plans, executable work items, repository
registration, Git/worktrees/diffs, real coding agents, verification runners,
reviews, remediation/readiness/merge workflow, Planning Studio, LAN exposure,
TLS termination, service manager integration, or backup command. The schema has
user/workspace/membership seams but does not activate collaborative multi-user
product behavior.
