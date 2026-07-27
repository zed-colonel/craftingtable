# Architecture boundaries (accepted CT-03 plus CT-04A1)

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
git          → domain + Node filesystem/process/crypto primitives
```

`@craftingtable/planning` is the whole interpretation boundary for untrusted
planning input. It accepts bytes plus logical metadata and returns data: it
opens no file, issues no SQL, spawns no process, and never throws for hostile
input. `node:crypto`'s `createHash` is permitted because hashing is
computation, not I/O. `check:scope` enforces this boundary mechanically.

`packages/agents` and `packages/testing` remain future/test seams inherited
from CT-01. `@craftingtable/git` now owns one real but uncomposed authority:
bounded observation through three closed command variants. Production server
composition imports none of these packages. Only `@craftingtable/storage`
imports `better-sqlite3` or owns SQL. No package depends on ActionQueue,
WorldInterface, Exoskeleton, or another application runtime.

## Trusted Git observation boundary

CT-04A1 accepts an untrusted absolute path only through an explicit,
programmatically configured inspector. It validates canonical source/reserved
root topology and exact primary-checkout structure before running Git. The
private runner can select only a version probe, identity probe, or local
risk-signal-name scan. It spawns an absolute revalidated executable without a
shell, closes stdin, constructs the entire environment, independently bounds
stdout/stderr, and terminates the detached process group on deadline, overflow,
or abort.

The result is a runtime-validated, versioned observation. Core identity,
environmental device evidence, and self-describing risk-scan evidence remain
separate. Serialized observations must pass `parseRecordedObservation` before
comparison; policy-version mismatch is not equality.

No server or browser imports the inspector in A1. Repository IDs, durable
state, authorization, registration, project binding, audit/events, routes, and
notification ordering remain CT-04A2.

The A2 boundary must preserve three A1 constraints. Registration runs against
a clean, quiescent working tree because top-level directory entry changes can
produce `observation-raced`. Coherent root configuration discharges reserved
overlap during inspector creation, so A2 must not expect an inspect-time
`reserved-root-overlap`; it will instead receive `invalid-root-policy` or
`outside-allowed-root` for reachable cases. Finally, the A1 SHA-256 fingerprint
authenticates core identity only. A2 storage must protect the integrity of
`riskScan`, environmental device evidence, `canonicalGitDirectory`, and
`observedAt` independently unless a later reviewed inspection-policy version
widens the fingerprint.

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
close the workspace/project/version/item chain — including evidence to the
version its attempt resolved to, and event correlation to a single project graph
— and one trigger per table freezes imported content. Neither a defect in a
service nor a direct SQL statement can rewrite a committed plan version, move a
record between workspaces or projects, or change a work item outside the single
atomic admission transition.

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

The composed CT-03 product has projects, imported plans, and an
operator-admitted agenda, but no executable work. CT-04A1 adds only an
uncomposed local Git observation library. There is still no repository
registration, worktree, diff, change request, real coding agent, verification
runner, review, remediation, readiness, or merge workflow; no Planning Studio, plan
version activation, or model-assisted planning; no interactive graph editing;
no ZIP, host-path, or external-URL import; no general artifact store; and no
LAN exposure, TLS termination, service manager integration, or backup command.
The schema has user/workspace/membership seams but does not activate
collaborative multi-user product behavior.

A work item can be Proposed or Admitted, and nothing else. Admission pairs the
item with a deliberately incomplete, non-executable work-contract draft; it is
not execution readiness and satisfies no dependency. A route-inventory test and
`check:scope` fail the build if any CT-04+ capability appears.
