# CT-04A2a — Repository domain, evidence model, and persistence

**Status:** Proposed child contract for source-specific planning  
**Parent:** CT-04A2  
**Depends on:** accepted CT-04A1 source  
**Risk:** Critical  
**Primary areas:** domain records, strict contracts, pure state reducer, schema 3, immutable inspection evidence, structural ownership, storage repositories and direct-SQL tests

## 1. Objective

Create the complete durable repository model without composing Git, Fastify, routes, audit/event transactions, notifier behavior, or browser projections.

A2a must make invalid repository graphs and invalid transitions impossible or explicitly detectable at the database/domain boundary before A2b builds authenticated commands on top.

## 2. Required deliverables

- branded IDs for repository, inspection, and project binding;
- repository status/reason enums and pure transition reducer;
- strict repository request/response and stored-document contracts that contain no raw process authority;
- migration `0003-ct04a2a-repository-model.sql`;
- `registered_repositories`;
- append-only `repository_inspections` with success/failure null-coupling;
- deferred structural linkage between each repository and its registration inspection;
- accepted environmental-baseline linkage and reaffirmation transition support;
- immutable project repository bindings with explicit retirement;
- global active uniqueness for canonical top level, common Git directory, and core fingerprint;
- version and transition triggers;
- immutable observation bytes and full-record checksum fields;
- storage repositories and query projections;
- migration, schema, direct-SQL, concurrency, and repository tests;
- audit action catalog additions only; workspace event kinds remain A2b;
- ADR for repository evidence, state, and persistence.

## 3. Required schema concepts

### Registered repository

Must structurally preserve:

```text
workspace ownership
immutable display name
immutable core identity fields
registration inspection
accepted environmental-baseline inspection
current status/reason
registration actor/time
status actor/time
monotonic version
```

### Inspection attempt

Must support:

```text
registration | verification | reaffirmation
succeeded | failed
exact observation JSON and SHA-256 for success
A1 version/policy/fingerprint projections
bounded A1 failure classification for failure
comparison arrays where applicable
actor and timestamps
append-only history
```

Success and failure fields are mutually exclusive by checks/triggers. A successful observation must reference the same repository and workspace. Stored JSON is opaque to SQLite but must be digest-verified and A1-parsed by the A2b boundary before use.

### Environmental baseline

The accepted environmental inspection must belong to the same repository. Updating it requires a fresh successful inspection, Owner attribution, and an exact version increment. It never changes core identity.

### Project binding

One active binding per project; many projects may bind one repository. Retirement is one-way, versioned, immutable in ownership, and independent from repository retirement.

## 4. A2a forbidden scope

A2a must not:

- import `@craftingtable/git` in domain, contracts, or storage;
- import `node:child_process`;
- create or memoize an inspector;
- add Fastify routes or service composition;
- add repository workspace-event kinds or rebuild `workspace_events`;
- call the notifier;
- modify browser projection or activity rendering;
- perform filesystem or Git inspection;
- implement A2b command transactions;
- implement CT-04B+ behavior.

## 5. A2a exit gate

```text
A fresh and accepted schema-2 database migrates to schema 3 without loss.
Repository, inspection, baseline, and binding graphs reject cross-workspace and wrong-parent rows.
Every status transition and version rule is enforced by pure reducer and database triggers.
Every immutable record rejects update/delete.
A repository cannot commit without one coherent successful registration inspection and accepted environmental baseline.
Full observation bytes and checksums round-trip exactly.
Direct SQL cannot bypass retirement, reaffirmation coupling, status/version rules, or active uniqueness.
No production A2a module imports Git/process/server/browser authority.
All CT-01 through CT-04A1 tests remain green.
```
