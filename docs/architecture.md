# Architecture boundaries (CT-03)

CraftingTable is a loopback-only supervisory workbench. The daemon owns
authoritative state; the browser is an authenticated projection reconstructed
from a durable snapshot and event cursor.

## Dependency direction

```text
domain        pure TypeScript records and branded identifiers
   ▲
contracts     strict Zod HTTP/SSE contracts
planning      pure plan parsing, validation, graph, digest, draft projection
storage       SQLite adapter, migrations, SQL, repositories
   ▲
server        Fastify routes, security policy, application services, composition

domain + contracts
   ▲
web           React projection; no server/storage/planning imports
```

The actual project-reference graph is:

```text
domain       → none
contracts    → domain
planning     → domain
storage      → domain
server       → domain + planning + contracts + storage
web          → domain + contracts
```

`@craftingtable/planning` is the whole interpretation boundary for untrusted
planning input. It accepts bytes plus logical metadata and returns data: it
opens no file, issues no SQL, spawns no process, and never throws for hostile
input. `node:crypto`'s `createHash` is permitted because hashing is
computation, not I/O. `check:scope` enforces this boundary mechanically.

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

CT-03 introduces the first in-daemon workspace-event producers. Plan import and
work-item admission both call the composed notifier immediately after their
transaction commits, and never inside it. Acceptance proves this independently
of the fallback poll: the stream's re-query interval is configured far longer
than the test, so any event that arrives must have arrived through same-process
notification. A separate case suppresses the notification entirely and confirms
CT-02's durable timeout still recovers it.

Bootstrap still runs in the separate CLI process, so its daemon visibility
correctly relies on the durable re-query.

Planning ownership and history are database guarantees. Composite foreign keys
close the workspace/project/version/item chain, and triggers freeze every
imported field, so neither a defect in a service nor a direct SQL statement can
rewrite a committed plan version or move a record between workspaces.

A successful plan import is one atomic transition:

```text
project + bundle + immutable version + attempt + exact artifact bytes
  + diagnostics + work items + dependency edges + audit + summary events
  └── one immediate SQLite transaction
        └── commit
              └── notifier
```

Parsing, digesting, and graph analysis all happen before that transaction opens.
A failed validation commits an attempt, bounded artifacts, diagnostics, and an
audit row — and no project, version, work item, draft, or workspace event.

The fallback re-query interval is currently 1000 ms. It deliberately guarantees
session/membership invalidation and dropped-notification recovery, at the cost
of one authentication and empty journal query per idle connection per second.
That is appropriate for CT-02's single-user loopback boundary and must be
revisited before activated multi-user or CT-08 deployment.

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

CT-03 has projects, imported plans, and an operator-admitted agenda, but no
executable work. It adds no repository registration, Git, worktrees, diffs,
change requests, real coding agents, process execution, verification runners,
reviews, remediation, readiness, or merge workflow; no Planning Studio, plan
version activation, or model-assisted planning; no interactive graph editing;
no ZIP, host-path, or external-URL import; no general artifact store; and no
LAN exposure, TLS termination, service manager integration, or backup command.
The schema has user/workspace/membership seams but does not activate
collaborative multi-user product behavior.

A work item can be Proposed or Admitted, and nothing else. Admission pairs the
item with a deliberately incomplete, non-executable work-contract draft; it is
not execution readiness and satisfies no dependency. A route-inventory test and
`check:scope` fail the build if any CT-04+ capability appears.
