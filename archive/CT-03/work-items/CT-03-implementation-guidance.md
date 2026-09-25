# CT-03 Implementation Guidance

**Binding contract:** `work-items/CT-03.md`  
**Source assessment:** `work-items/CT-03-source-assessment.md`  
**Pinned baseline:** `c8e2396a65466bdde95bf740771af63b4fc2272e`  
**Status:** Strong recommendation for Phase A reconciliation; the binding contract remains authoritative.

## 1. Recommended target architecture

The minimal target is:

```text
multipart plan submission
    ↓
strict HTTP contract and bounded upload handling
    ↓
PlanImportService
    ├── authorize workspace role
    ├── classify artifact roles
    ├── invoke pure planning parser/validator
    ├── compute canonical bundle digest
    └── build one durable import command
            ↓
CraftingTableStorage.transaction()
    ├── import attempt
    ├── project / bundle / immutable version
    ├── exact artifact bytes
    ├── diagnostics
    ├── work items
    ├── dependency edges
    ├── audit records
    └── workspace events
            ↓
commit
    ↓
WorkspaceEventNotifier.notify()
    ↓
authorized snapshot/detail queries + SSE invalidation
    ↓
React project / plan / work-item views
```

Admission is a second command:

```text
authenticated admit request
    ↓
WorkItemService
    ├── authorize role
    ├── load item and blockers
    ├── create pure draft projection
    └── transaction
          ├── Proposed → Admitted
          ├── WorkContractDraft
          ├── audit
          └── workspace event
    ↓
commit
    ↓
notify
```

## 2. Proposed package and module shape

This is a recommended logical tree, not permission to add unrelated abstraction.

```text
packages/
├── domain/src/
│   ├── ids.ts
│   ├── planning.ts
│   ├── work-contract.ts
│   ├── event-kinds.ts
│   ├── workspace-events.ts
│   └── index.ts
│
├── contracts/src/
│   ├── planning.ts
│   ├── work-contract.ts
│   ├── snapshot.ts
│   ├── workspace-event.ts
│   └── index.ts
│
├── planning/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── bundle.ts
│       ├── digest.ts
│       ├── diagnostics.ts
│       ├── exo-work-breakdown-schema.ts
│       ├── graph.ts
│       ├── normalize.ts
│       ├── parse.ts
│       ├── work-contract-draft.ts
│       └── *.test.ts
│
└── storage/
    ├── migrations/
    │   └── 0002-ct03-planning.sql
    └── src/
        ├── storage.ts
        ├── types.ts
        ├── repositories/
        │   ├── audit.ts
        │   ├── workspace-events.ts
        │   └── planning/
        │       ├── projects.ts
        │       ├── plan-imports.ts
        │       ├── plan-versions.ts
        │       ├── plan-artifacts.ts
        │       ├── diagnostics.ts
        │       ├── work-items.ts
        │       ├── dependencies.ts
        │       └── work-contract-drafts.ts
        └── ct03-*.test.ts

apps/server/src/
├── composition.ts
├── routes/
│   └── planning.ts
├── services/
│   ├── plan-import-service.ts
│   ├── project-query-service.ts
│   └── work-item-service.ts
└── server-planning*.test.ts

apps/web/src/
├── App.tsx
├── features/planning/
│   ├── ProjectListPage.tsx
│   ├── ProjectPage.tsx
│   ├── PlanVersionPage.tsx
│   ├── WorkItemPage.tsx
│   ├── ImportPlanDialog.tsx
│   ├── WorkContractDraftPanel.tsx
│   ├── planning-api.ts
│   └── *.test.tsx
├── components/
│   ├── StatusRegions.tsx
│   └── ActivityPanel.tsx
├── lib/
│   ├── api-client.ts
│   ├── workspace-projection.ts
│   └── route-state.ts or router integration
└── styles/global.css

e2e/
└── planning.spec.ts
```

A flatter repository split is acceptable if ownership remains clear.

## 3. Domain model guidance

### 3.1 Project

Suggested fields:

```typescript
interface Project {
  id: ProjectId;
  workspaceId: WorkspaceId;
  name: string;
  slug: string;
  description?: string;
  activePlanVersionId: PlanVersionId;
  createdAt: Instant;
  createdBy: UserId;
}
```

A project name should come from explicit plan metadata or an operator-supplied import field. Do not semantically infer it from prose.

For the AQ fixture, a reasonable operator-visible name is:

```text
ActionQueue — AQ-CONT-1
```

The exact display name can be an import form field while the source `document` remains separately preserved.

### 3.2 Plan bundle and version

```typescript
interface PlanBundle {
  id: PlanBundleId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  logicalName: string;
  createdAt: Instant;
}

interface PlanVersion {
  id: PlanVersionId;
  bundleId: PlanBundleId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  versionNumber: number;
  contentDigest: string;
  digestFormatVersion: 1;
  document: string;
  sourceProfile: "exo-work-breakdown-v1";
  normalizedSource: JsonValue;
  createdAt: Instant;
  createdBy: UserId;
}
```

A plan version is immutable. Do not update it after import.

### 3.3 Import attempt

```typescript
type PlanImportOutcome =
  | "succeeded"
  | "failed-validation"
  | "duplicate";

interface PlanImportAttempt {
  id: PlanImportAttemptId;
  workspaceId: WorkspaceId;
  actorUserId: UserId;
  outcome: PlanImportOutcome;
  requestedProjectName: string;
  bundleDigest?: string;
  projectId?: ProjectId;
  planVersionId?: PlanVersionId;
  createdAt: Instant;
}
```

The exact model may distinguish request and completion time if useful. Do not add a generic background-job state machine; CT-03 imports are bounded synchronous requests.

### 3.4 Artifacts

```typescript
type PlanArtifactRole =
  | "implementation-plan"
  | "work-breakdown"
  | "assumption-ledger"
  | "validation-manifest"
  | "decision-log"
  | "supporting";

interface PlanArtifact {
  id: PlanArtifactId;
  importAttemptId: PlanImportAttemptId;
  planVersionId?: PlanVersionId;
  logicalFilename: string;
  role: PlanArtifactRole;
  mediaType: string;
  byteLength: number;
  sha256: string;
  createdAt: Instant;
}
```

The bytes remain in storage. Normal API responses expose metadata unless the user requests one artifact.

### 3.5 Diagnostics

```typescript
type DiagnosticSeverity = "error" | "warning" | "info";

interface PlanImportDiagnostic {
  id: PlanImportDiagnosticId;
  importAttemptId: PlanImportAttemptId;
  severity: DiagnosticSeverity;
  code: string;
  artifactName?: string;
  path?: string;
  workItemSourceId?: string;
  message: string;
}
```

Diagnostic codes should be stable enough for UI grouping and tests:

```text
required-artifact-missing
duplicate-logical-filename
artifact-too-large
invalid-yaml
invalid-work-breakdown
duplicate-work-item-id
invalid-work-item-id
missing-required-dependency
self-dependency
required-dependency-cycle
unknown-recommended-dependency
unsupported-media-type
```

### 3.6 Work items

```typescript
type WorkItemStatus = "proposed" | "admitted";

interface WorkItem {
  id: WorkItemId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  planVersionId: PlanVersionId;
  sourceId: string;
  title: string;
  status: WorkItemStatus;
  risk: string;
  phase?: string;
  primaryAreas: readonly string[];
  exitGate: string;
  sourceFields: JsonValue;
  admittedAt?: Instant;
  admittedBy?: UserId;
}
```

Do not use `sourceId` as the database primary key. It is unique only within a plan version.

### 3.7 Dependencies

```typescript
type DependencyKind = "required" | "recommended";

interface WorkItemDependency {
  planVersionId: PlanVersionId;
  predecessorWorkItemId: WorkItemId;
  successorWorkItemId: WorkItemId;
  kind: DependencyKind;
}
```

Suggested uniqueness:

```text
(plan_version_id, predecessor_work_item_id, successor_work_item_id, kind)
```

Ensure both items belong to the same plan version.

### 3.8 Draft contract

The draft is durable and immutable by CT-03 unless an idempotent admission retrieves it. Editing belongs to later work.

Suggested projection:

```yaml
schemaVersion: 1
status: draft
completeness: incomplete

source:
  projectId: ...
  planVersionId: ...
  workItemId: ...
  sourceWorkItemId: AQ-01

objective:
  title: Freeze evidence and establish the development contract
  exitGate: Baseline green; contract, archive, and boundary checks installed.

classification:
  risk: medium
  primaryAreas:
    - contract
    - conformance
    - archive

dependencies:
  required: []
  recommended: []

repository:
  status: unresolved

baseRevision:
  status: unresolved

scope:
  status: unresolved
  writable: []
  forbidden: []

verification:
  status: unresolved
  checkIds: []

review:
  requiredPerspectives:
    - specification
    - correctness
  maxRemediationGenerations: 3

merge:
  humanAuthorizationRequired: true

missing:
  - registered-repository
  - exact-base-revision
  - path-scope
  - verification-policy
  - protected-acceptance-criteria
  - agent-backend
  - execution-environment
```

The draft should not carry an `approved` or `executable` field that can be misunderstood.

## 4. Canonical bundle digest

Use a deterministic byte encoding.

Recommended algorithm:

1. Assign each accepted file one explicit artifact role.
2. Normalize the logical filename to NFC Unicode and validate it.
3. Sort by `(role, logicalFilename)`.
4. For each file, append length-prefixed UTF-8 role, length-prefixed UTF-8 filename, length-prefixed media type, and length-prefixed exact bytes.
5. Prefix with a domain separator such as:

```text
craftingtable-plan-bundle-digest-v1\0
```

6. Compute SHA-256 over the resulting bytes.

Do not use JSON stringification of an object whose key ordering or binary representation is implicit.

Store:

```text
digest algorithm
digest format version
digest hex
```

The per-artifact SHA-256 is separate.

## 5. Parser and graph design

### 5.1 YAML parsing

Use a maintained safe YAML library.

The parser must:

- return plain data;
- not execute tags or constructors;
- reject multiple YAML documents unless explicitly supported;
- surface source location where practical;
- bound alias expansion or reject excessive aliases;
- reject payloads that exceed the HTTP limits before parsing.

The pure planning package should accept bytes/string plus logical metadata. It should not open files.

### 5.2 Normalization

Recommended output:

```typescript
interface NormalizedPlan {
  document: string;
  repository?: string;
  baselineCommit?: string;
  contract?: string;
  stackRevision?: string;
  phase?: string;
  metadata: JsonValue;
  workItems: readonly NormalizedWorkItem[];
}

interface NormalizedWorkItem {
  sourceId: string;
  title: string;
  risk: string;
  phase?: string;
  primaryAreas: readonly string[];
  exitGate: string;
  requiredDependencies: readonly string[];
  recommendedDependencies: readonly string[];
  sourceFields: JsonValue;
}
```

Retain all unknown top-level and item-level fields in `metadata`/`sourceFields`.

### 5.3 Graph validation

Recommended sequence:

1. validate every item structurally;
2. build source-ID map;
3. detect duplicates;
4. validate self and missing required edges;
5. record recommended-edge warnings;
6. construct required graph;
7. run deterministic cycle detection;
8. emit one or more cycle diagnostics with a stable cycle path;
9. if no fatal diagnostics, generate normalized topological metadata.

The database should not rely on topological order for correctness. It may store a deterministic ordinal for display.

## 6. Migration 0002 guidance

This migration deserves a written pre-implementation review.

A likely sequence:

```text
1. Create audit_action_kinds and workspace_event_kinds.
2. Seed all existing CT-02 kinds and new CT-03 kinds.
3. Drop immutable triggers on old journal tables.
4. Create replacement journal tables with equivalent columns,
   constraints, sequence semantics, and kind foreign keys.
5. Copy all rows preserving IDs and workspace event sequence values.
6. Verify row counts and maximum sequence during migration.
7. Replace old tables.
8. Recreate indexes.
9. Recreate append-only triggers.
10. Create CT-03 planning tables and indexes.
11. Record schema migration version 2 through the existing runner.
```

The exact SQL depends on the current schema.

Tests must start from a real schema-1 database containing:

```text
user
workspace
membership
session
audit rows
workspace-created event with known sequence
```

Then migrate and assert:

- every row survives;
- sequence remains unchanged;
- next event receives a greater sequence;
- old and new kinds insert;
- unregistered kinds reject;
- journal updates/deletes reject;
- foreign keys remain enabled;
- migration is idempotent through the ledger;
- checksum/newer-version behavior still works.

### 6.1 Suggested planning tables

A source-grounded Phase A plan should provide exact SQL. Likely tables:

```text
projects
plan_bundles
plan_versions
plan_import_attempts
plan_artifacts
plan_import_diagnostics
work_items
work_item_dependencies
work_contract_drafts
```

Important constraints:

- workspace ownership on project/import rows;
- unique project slug within workspace if slugs are used;
- unique bundle digest within a bundle or workspace as defined;
- unique `(plan_version_id, source_id)`;
- unique dependency edge;
- one initial draft per admitted work item;
- immutable triggers on plan versions and artifacts if updates are never valid;
- bounded outcome/status/action checks through catalogs or stable checks;
- no cascade that can erase accepted historical planning data through an exposed route.

No delete API is needed.

## 7. Import service transaction

The failed validation import, successful import, duplicate path, and changed-version path must remain semantically distinct.

Recommended service pseudocode:

```typescript
async function importPlan(input, actor): Promise<ImportResult> {
  authorizeWorkspaceMutation(actor, input.workspaceId);

  const bounded = validateMultipartMetadataAndLimits(input.files);
  const analyzed = planning.analyzeBundle(bounded);

  if (analyzed.fatalDiagnostics.length > 0) {
    return storage.transaction((tx) => {
      const attempt = tx.planImports.recordFailure(...);
      tx.planArtifacts.insertFailureArtifacts(attempt.id, bounded);
      tx.diagnostics.insertMany(attempt.id, analyzed.diagnostics);
      tx.audit.append("plan.import.failed", ...);
      return failureResult(attempt, analyzed.diagnostics);
    });
  }

  const duplicate = storage.planVersions.findByDigest(...);

  if (duplicate) {
    return storage.transaction((tx) => {
      const attempt = tx.planImports.recordDuplicate(...);
      tx.audit.append("plan.import.duplicate", ...);
      return duplicateResult(attempt, duplicate);
    });
  }

  const committed = storage.transaction((tx) => {
    const attempt = tx.planImports.recordSuccess(...);
    const project = tx.projects.createOrResolve(...);
    const bundle = tx.planBundles.createOrResolve(...);
    const version = tx.planVersions.insert(...);
    tx.planArtifacts.insertMany(...);
    tx.diagnostics.insertMany(warnings);
    const items = tx.workItems.insertMany(...);
    tx.dependencies.insertMany(...);
    tx.projects.setInitialActiveVersionIfUnset(...);
    tx.audit.append("plan.import.succeeded", ...);
    const events = tx.workspaceEvents.appendMany(...);
    return { attempt, project, version, events };
  });

  notifier.notify();
  return committed;
}
```

Avoid an in-transaction `await`. `better-sqlite3` transaction callbacks are synchronous. Parse and validate outside the transaction; commit the already-built deterministic record set inside it.

The server should not hold a SQLite write transaction while reading multipart streams or parsing YAML.

## 8. Failed-import persistence

There is a tension between preserving failed input for diagnosis and minimizing retention of untrusted data.

Recommended policy:

- apply the same strict upload limits before parsing;
- preserve exact bounded artifact bytes for failed imports;
- mark `plan_version_id` null;
- expose them only through authorized diagnostics views;
- do not create a workspace event;
- allow no browser raw-HTML rendering;
- document that failed source artifacts persist until a future retention feature exists.

A narrower “digest + snippets only” approach may be proposed, but it would reduce reproducibility and should be deliberate.

## 9. Query service and snapshot guidance

### 9.1 Workspace snapshot

Keep it lightweight:

```typescript
interface PlanningStatusSummary {
  projectCount: number;
  importAttentionCount: number;
  proposedCount: number;
  admittedCount: number;
  planningReadyCount: number;
  blockedCount: number;
  riskCounts: Record<string, number>;
}

interface ProjectSummary {
  id: ProjectId;
  name: string;
  activePlanVersionId: PlanVersionId;
  document: string;
  proposedCount: number;
  admittedCount: number;
  planningReadyCount: number;
  blockedCount: number;
  warningCount: number;
}
```

Snapshot computation must occur inside the same consistent read transaction as `asOfSequence`.

### 9.2 Detail queries

Project detail may return:

```text
project
active plan summary
all version summaries
work-item summaries
risk/status/blocker counts
diagnostic summaries
artifact metadata
```

Work-item detail may return:

```text
item
required/recommended predecessor summaries
required dependent summaries
derived blockers
draft contract if present
```

Do not N+1 query every item. Use set-based queries or a bounded number of repository calls.

## 10. Event handling guidance

The browser event reducer should not attempt to patch the entire planning model from summary events.

Recommended behavior:

```text
project-created
    mark workspace/project list stale

plan-version-imported
    mark workspace summary and project detail stale

work-item-admitted
    mark workspace summary, project detail, and work-item detail stale
```

Then refetch through authenticated APIs.

The current sequence cursor still advances through the event. Refetch failure should be visible without discarding the last good projection.

## 11. Browser guidance

### 11.1 Navigation

A lightweight client router is reasonable because project and work-item detail must be deep-linkable.

Good CT-03 paths:

```text
/workspaces/:workspaceId
/workspaces/:workspaceId/projects/:projectId
/workspaces/:workspaceId/projects/:projectId/plans/:planVersionId
/workspaces/:workspaceId/work-items/:workItemId
```

Do not add a full route data framework unless the current Vite/React app clearly benefits.

### 11.2 Import UX

The import surface should:

- select or drop discrete files;
- show assigned artifact roles;
- require a project/display name if not supplied structurally;
- validate local filename/size/count before upload;
- show server diagnostics grouped by severity;
- clearly distinguish:
  - failed validation;
  - imported new version;
  - identical existing version.

Do not implement arbitrary host-directory browsing in the daemon.

### 11.3 Dashboard

The four existing regions can become:

```text
Needs attention
    import warnings or failed attempts needing inspection

Active
    admitted work items

Ready for admission
    proposed items with all required dependencies completed

Dependency-blocked
    proposed/admitted items with unsatisfied required predecessors
```

Because no item can be completed in CT-03, only root proposed items are ready for admission in a new imported graph.

The labels should be visible, not encoded only in tooltips.

### 11.4 Project table

Suggested columns:

```text
ID
Title
Risk
Status
Required predecessors
Blockers
Primary areas
Exit gate summary
```

Sorting/filtering by risk/status is reasonable. Advanced saved views are not.

### 11.5 Draft contract

Render the structured draft with:

- a concise human-readable summary;
- missing-field warnings;
- a read-only YAML or JSON preview;
- explicit “Not executable” language.

Do not add an edit/save/approve workflow.

## 12. Authorization guidance

Role expectations:

```text
Viewer
    list/view projects, plans, work items, artifacts, diagnostics, drafts

Editor
    all viewer operations
    import plan
    admit work item

Owner
    same CT-03 planning operations as Editor
```

Do not accept role from request bodies.

For missing and unauthorized workspace/project/work-item/artifact IDs, preserve CT-02's non-disclosure posture where practical.

Artifact retrieval must verify the artifact's workspace through parent joins rather than trusting a workspace route parameter alone.

## 13. Acceptance implementation sequence

Recommended generations:

### Generation 1 — contract and pure planning core

- record accepted plan and ADR decisions;
- add planning IDs/domain types;
- add `@craftingtable/planning`;
- parse and validate the AQ fixture;
- prove `14` items, `24` required edges, one root;
- prove all invalid graph diagnostics.

### Generation 2 — migration and storage

- add migration 0002;
- prove CT-02 journal preservation;
- add planning repositories;
- prove successful/failure/duplicate transaction shapes.

### Generation 3 — import vertical

- add strict multipart contract and limits;
- add import service and route;
- import exact AQ fixture through real HTTP;
- append audit/events;
- prove notifier fast path.

This is the first complete source-to-database vertical.

### Generation 4 — queries and snapshot

- add project/plan/work-item contracts;
- extend snapshot;
- add authorized query services/routes;
- prove counts, blockers, and workspace isolation.

### Generation 5 — browser planning views

- add navigation;
- add import view;
- add dashboard/project/plan/work-item views;
- add artifact/diagnostic inspection;
- preserve current auth/SSE/outage behavior.

### Generation 6 — admission and draft

- add admission route/service;
- add pure draft projection;
- add UI;
- prove idempotency and notifier fast path.

### Generation 7 — full E2E and documentation

- exact AQ import/admit/refresh/restart path;
- invalid fixture path;
- CT-01/02 regressions;
- completion report;
- full `pnpm check`.

## 14. ADR guidance

Recommended new ADRs:

```text
ADR-011 — Plan bundle import, versioning, and artifact preservation
ADR-012 — Planning domain and dependency semantics
ADR-013 — Journal vocabulary catalogs
ADR-014 — Work-item admission and non-executable draft contracts
```

Possible accepted amendment:

```text
ADR-003
    add CT-03 event kinds and the refetch/invalidation rule
```

Document, do not implement:

```text
plan version activation/editing
general content-addressed artifact store
graph visualization
repository binding
execution contract approval
model-assisted planning
```

## 15. Independent review prompt focus

The reviewer should receive:

```text
binding contract
accepted Phase A plan
acceptance matrix
AQ expectation fixture
exact base/head SHAs
verification output
```

The reviewer should not receive the implementer's full transcript.

Priority review questions:

1. Does migration 0002 preserve every CT-02 journal guarantee?
2. Can malformed YAML consume unbounded resources or construct unsafe objects?
3. Is bundle identity deterministic?
4. Can a failed import leave partial accepted state?
5. Can duplicate import create duplicate items/events?
6. Are plan versions and source artifacts immutable?
7. Can any workspace read another workspace's artifacts or diagnostics?
8. Are Editor/Owner checks enforced in services?
9. Does every daemon event producer call the notifier after commit?
10. Are browser status labels honest about admission versus execution?
11. Is the draft contract unmistakably non-executable?
12. Did CT-04+ behavior enter by convenience?
