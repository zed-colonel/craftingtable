# CT-03 Source Assessment

**Repository:** `zed-colonel/craftingtable`  
**Accepted source baseline:** `c8e2396a65466bdde95bf740771af63b4fc2272e`  
**Assessment method:** Static review of the public repository at the pinned commit, its committed CT-02 completion/review records, and the retained planning inputs.  
**Purpose:** Explain how the binding CT-03 contract maps to the actual accepted source rather than to the original planning document alone.

## 1. Baseline status

The current accepted history is:

```text
c8e2396  docs: fix typo in CT-02 remediation review filename
4685e5b  CT-02: record remediation review and completion
1c43dc2  CT-02: remediate independent review findings
466649b  CT-02: add persistent authenticated daemon
ac76049  CT-02: add source-grounded work contract
6934452  CT-01: record remediation review and completion
```

The final CT-02 review and completion artifacts are committed. CT-02 reports a green full quality gate, durable restart recovery, and no unresolved acceptance failure. The current README still identifies CT-02 as the active phase; CT-03 should update that only after its contract and implementation are accepted.

The CT-02 source is a suitable foundation. CT-03 should extend it directly rather than invent a parallel project/store/event path.

## 2. Current package boundaries

The accepted project-reference direction is:

```text
@craftingtable/domain
    pure TypeScript records and branded identifiers

@craftingtable/contracts
    strict Zod HTTP/SSE payload contracts
    depends on domain

@craftingtable/storage
    SQLite adapter, migrations, repositories, transactions
    depends on domain

@craftingtable/server
    Fastify routes, security, application services, composition
    depends on domain + contracts + storage

@craftingtable/web
    React projection
    depends on domain + contracts
```

Retained future/test seams:

```text
@craftingtable/agents
@craftingtable/git
@craftingtable/testing
```

Production composition does not depend on those seams.

CT-03 should add a pure `@craftingtable/planning` package rather than placing YAML interpretation in the server, storage, or browser.

Recommended direction:

```text
planning → domain + YAML/Zod libraries

contracts → domain
storage   → domain
server    → domain + planning + contracts + storage
web       → domain + contracts
```

The contracts package may import domain planning records when they are pure. It should not import the planning parser.

## 3. Current domain vocabulary

`packages/domain/src/ids.ts` already defines several future-oriented IDs, including:

```text
ProjectId
WorkItemId
AgentRunId
```

CT-03 should retain `ProjectId` and `WorkItemId` if their representation and construction rules remain suitable.

It still needs explicit IDs for:

```text
PlanBundleId
PlanVersionId
PlanImportAttemptId
PlanArtifactId
PlanImportDiagnosticId
WorkContractDraftId
```

Current event and audit vocabularies were intentionally minimal for CT-02. CT-03 is the first feature that exercises their extensibility.

## 4. Current persistence model

Migration `0001-ct02-foundation.sql` creates:

```text
schema_migrations
users
workspaces
workspace_memberships
sessions
audit_events
workspace_events
```

Important accepted properties:

- ordered migration files with SHA-256 checksums;
- rejection of changed, unknown, or newer applied migrations;
- one migration transaction;
- WAL;
- `synchronous=FULL`;
- foreign keys;
- bounded busy timeout;
- append-only no-update/no-delete triggers;
- restrictive foreign-key deletion;
- real-file migration and restart tests.

The storage package exposes one transaction boundary suitable for committing state + audit + workspace events.

### 4.1 Journal vocabulary pressure

Migration 0001 hard-codes the initial audit action and workspace-event kind vocabulary through SQL constraints. That was correct for a tightly bounded CT-02, but CT-03 must add multiple event producers.

Simply rebuilding both journal tables in every feature migration would create repeated risk around:

- global event sequence preservation;
- trigger preservation;
- index preservation;
- append-only history;
- old vocabulary compatibility.

The contract therefore recommends migration-owned kind catalogs:

```text
audit_action_kinds
workspace_event_kinds
```

and journal foreign keys into those catalogs.

Migration 0002 should rebuild the CT-02 journal tables once, preserve all data and sequences, re-establish immutable triggers, seed CT-02 and CT-03 kinds, and allow later migrations to add kinds without another table rebuild.

The application still owns strict payload schemas. A registered string does not make an arbitrary JSON payload valid.

### 4.2 Planning persistence

The existing one-database/one-transaction architecture is well suited to CT-03.

A successful import can atomically create:

```text
import attempt
project
plan bundle
plan version
source artifacts
diagnostics
work items
dependencies
audit
workspace events
```

Small planning artifacts can be stored in SQLite BLOBs without introducing the general artifact filesystem prematurely.

The existing append-only audit and event repositories provide patterns to follow, but plan/version/artifact repositories should not be forced into those journals. They are authoritative current/history state with their own immutability rules.

## 5. Current application-service boundary

The server is built through dependency-injected composition.

Current relevant seams include:

```text
apps/server/src/composition.ts
apps/server/src/server.ts
apps/server/src/routes/http.ts
apps/server/src/routes/workspaces.ts
apps/server/src/routes/workspace-events.ts
apps/server/src/services/workspace-service.ts
apps/server/src/services/workspace-event-notifier.ts
apps/server/src/services/workspace-event-stream-service.ts
```

Workspace membership is enforced in services, not in React or route filtering.

CT-03 should add services such as:

```text
plan-import-service
project-query-service
work-item-service
```

or an equivalent cohesive split.

Routes should:

- authenticate;
- parse strict wire input;
- pass actor/workspace identity into a service;
- map service errors to stable responses;
- serialize strict contracts.

They should not:

- parse YAML;
- issue SQL;
- decide dependency semantics;
- perform authorization through browser-supplied role claims.

## 6. The CT-02 notification handoff

CT-02 has a generation notifier and a durable timeout re-query.

The accepted architecture notes a specific current condition:

- bootstrap is performed by a separate CLI process;
- therefore the live daemon has no same-process post-commit workspace event producer in CT-02;
- the current one-second fallback poll recovers bootstrap changes;
- CT-03 introduces the first normal daemon-side event producers.

The initial CT-02 review made the forward requirement explicit:

> New daemon commands that append workspace events must call the composed notifier immediately after commit.

This is not an optimization-only concern. Without the call, CT-03 would appear to work but would silently degrade to one-second polling latency for every import and admission.

Required proof:

```text
configure fallback poll to a duration longer than the test
connect an authenticated SSE client
perform plan import or admission
observe the event before the fallback can occur
```

A second test should deliberately suppress notification and retain CT-02's durable fallback proof.

## 7. Current wire and snapshot contracts

CT-02 currently exposes strict contracts for:

```text
session
workspace
audit
workspace event
workspace snapshot
```

The `WorkspaceEventEnvelope` already carries future correlation fields such as optional project/work-item/run IDs. CT-03 should use those fields where semantically correct rather than creating a competing event envelope.

The current snapshot contains:

- workspace identity;
- `asOfSequence`;
- zero-valued status regions;
- recent activity.

CT-03 should expand the snapshot with lightweight project/work-item summaries. It should not embed every plan, dependency, artifact, and diagnostic into the workspace bootstrap response.

Detailed project and work-item pages should use separate authorized query contracts.

## 8. Current browser shape

The browser currently has:

```text
apps/web/src/App.tsx
apps/web/src/components/WorkspaceShell.tsx
apps/web/src/components/StatusRegions.tsx
apps/web/src/components/ActivityPanel.tsx
apps/web/src/components/AuditPanel.tsx
apps/web/src/components/SessionPanel.tsx
apps/web/src/components/ConnectionBadge.tsx
apps/web/src/lib/api-client.ts
apps/web/src/lib/workspace-projection.ts
apps/web/src/lib/use-workspace-event-stream.ts
apps/web/src/styles/global.css
```

Accepted UI properties:

- warm-neutral, calm, editorial visual language;
- authenticated snapshot-first loading;
- durable event cursor;
- visible connection state;
- browser payload revalidation;
- no local browser authority.

Current status regions are honest placeholders because CT-02 has no projects or work items. CT-03 is the correct point to replace those zeros with server-derived counts.

`App.tsx` currently coordinates authentication, workspace choice, snapshots, audit, sessions, and SSE. CT-03 adds enough navigation and detail views that continuing to place all state and rendering in one component would likely become brittle. A lightweight routing and feature-module split is reasonable, but CT-03 should not become a full frontend architecture rewrite.

## 9. Current activity semantics

The only durable workspace event kind is currently `workspace-created`.

CT-03 should add summary events:

```text
project-created
plan-version-imported
work-item-admitted
```

It should not emit fourteen separate “work item imported” activity entries for AQ-CONT-1. The authoritative work-item table provides detail; the activity journal should capture the meaningful transition.

Suggested event payloads:

```text
project-created
    projectId
    name

plan-version-imported
    projectId
    planVersionId
    document
    itemCount
    requiredDependencyCount
    warningCount

work-item-admitted
    projectId
    planVersionId
    workItemId
    sourceWorkItemId
    workContractDraftId
```

Exact payloads remain contract decisions. They must be strict and versioned.

## 10. Current audit semantics

Audit records and workspace events are deliberately separate.

CT-03 should audit:

```text
successful import
failed validation import
idempotent duplicate import
work-item admission
work-contract-draft creation
```

A failed import should be auditable without creating a workspace activity event that implies accepted project state.

Audit metadata should remain bounded and should not contain full source files.

## 11. The actual AQ-CONT-1 fixture

The included AQ work breakdown contains:

```text
work items:                14
required dependency edges: 24
root item:                 AQ-01
risk distribution:
  medium:                  1
  high:                    7
  critical:                6
```

The exact dependency count is **24**, calculated from the committed fixture. Earlier conversational summaries used a lower number; the fixture and the generated expectation file are authoritative.

The required graph is acyclic and has one root.

The fixture therefore provides useful acceptance pressure for:

- a nontrivial DAG;
- multiple risk classes;
- one ready root and many blockers;
- one item with eight direct predecessors;
- preserved top-level metadata;
- immutable source artifacts.

## 12. Source-to-target disposition

| Current source | CT-03 disposition |
|---|---|
| `packages/domain/src/ids.ts` | Extend with planning IDs |
| `packages/domain/src/event-kinds.ts` | Extend registered domain vocabulary |
| `packages/domain/src/workspace-events.ts` | Add strict CT-03 event payload types |
| `packages/domain/src/index.ts` | Export planning domain records |
| `packages/contracts/src/workspace-event.ts` | Extend discriminated event contract |
| `packages/contracts/src/snapshot.ts` | Add project/work-item summaries |
| `packages/contracts/src/index.ts` | Export CT-03 HTTP contracts |
| `packages/storage/migrations/0001-*` | Preserve unchanged |
| `packages/storage/migrations/0002-*` | Add journal catalogs + planning schema |
| `packages/storage/src/storage.ts` | Extend composed repositories/transactions |
| `packages/storage/src/types.ts` | Extend storage transaction interfaces |
| `packages/storage/src/repositories/audit.ts` | Adapt to kind catalog |
| `packages/storage/src/repositories/workspace-events.ts` | Adapt to kind catalog; preserve sequence semantics |
| new `packages/storage/src/repositories/planning/*` | Own projects, plans, artifacts, diagnostics, items, dependencies, drafts |
| new `packages/planning` | Own pure parse/normalize/validate/draft logic |
| `apps/server/src/composition.ts` | Compose planning services and notifier |
| `apps/server/src/services/workspace-service.ts` | Extend snapshot summaries or delegate to planning query service |
| new server planning services/routes | Import/query/admit |
| `apps/web/src/App.tsx` | Split navigation/data responsibilities carefully |
| `StatusRegions.tsx` | Render real server-derived planning counts |
| `ActivityPanel.tsx` | Describe CT-03 event kinds |
| `workspace-projection.ts` | Invalidate/refetch on CT-03 events without treating event payload as full state |
| `global.css` | Extend current design tokens and responsive layout |
| E2E dashboard flow | Add real AQ import/admission/restart path |

## 13. Risks to pressure-test in Phase A

### 13.1 Migration preservation

Migration 0002 is the highest-risk part of this medium-risk work item because it touches immutable journals and the global event cursor.

The plan must specify the exact table-rebuild order, trigger/index recreation, foreign-key behavior, and tests that prove CT-02 rows and sequences survive.

### 13.2 Duplicate import identity

If canonical digest construction is underspecified, multipart ordering or renamed temporary fields can create accidental duplicate versions. The digest format must be deterministic and versioned.

### 13.3 Plan-version identity

Work items must be version-scoped. Reusing one mutable work-item row across plan versions would erase the history that later Planning Studio needs.

### 13.4 Readiness language

The UI must distinguish:

```text
planning-ready
admitted
dependency-blocked
executable
merge-ready
```

CT-03 only owns the first three. Calling AQ-01 simply “Ready” without context would create semantic debt.

### 13.5 Failed import partial state

Persisting diagnostics is useful, but the failure path must not leak partial projects or workspace events. The transaction shape and tests should make this unmistakable.

### 13.6 Browser size and routing

Project and work-item pages justify navigation. Do not let that trigger an unrelated frontend rewrite or state-management framework.

## 14. Review focus for the eventual independent reviewer

The independent reviewer should concentrate on:

- migration 0002 data and global-sequence preservation;
- append-only trigger preservation;
- YAML safety and resource bounds;
- content-digest determinism;
- failed-import atomicity;
- duplicate-import idempotency;
- immutable changed versions;
- workspace isolation of artifacts and diagnostics;
- service-layer role checks;
- post-commit notifier use;
- snapshot/event race behavior;
- exact AQ fixture counts and graph;
- honest planning-ready/admitted/blocked language;
- visibly incomplete, non-executable draft contracts;
- absence of CT-04+ Git, worktree, agent, execution, or review behavior.

## 15. Assessment conclusion

CT-02 established the right foundation.

CT-03 should not redesign persistence, authentication, authorization, or event delivery. It should add the first substantial user-facing domain on top of them and prove that:

```text
untrusted planning input
    → pure validation and diagnosis
    → one atomic durable import
    → authorized visual projection
    → explicit human admission
    → non-executable draft
```

The source supports that path cleanly, provided journal vocabulary extensibility and notifier use are handled deliberately.
