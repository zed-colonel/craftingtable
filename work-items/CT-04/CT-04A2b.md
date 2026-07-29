# CT-04A2b — Repository journal and authorized lifecycle

**Status:** Source-grounded parent contract proposed for operator adoption  
**Parent:** CT-04A2 — Repository registry and project binding  
**Depends on:** accepted CT-04A1 and accepted CT-04A2a  
**Source branch head:** `e3b69c612a51b0b2a8d436ae3ea5355abd40745e`  
**A2a merge commit:** `957874b96eb236c0042d6b7828d9b8ea26577bd9`  
**Risk:** Critical

## 1. Objective

Complete the read-only repository-registration lifecycle by composing:

```text
accepted A1 observer
    +
accepted A2a domain, contracts, reducer, and schema-3 persistence
    +
structurally correlated workspace journal and browser projection
    +
authenticated services, audit, routes, and post-commit notification
```

A2b is the only production layer permitted to translate A1 observations and errors into A2a assessments, inspections, repository transitions, audit records, workspace events, and public HTTP results.

## 2. Recursive decomposition

The preliminary A2b contract combined:

- a schema-4 append-only journal rebuild;
- five new event kinds and structural ownership correlations;
- exhaustive storage and browser event handling;
- optional Git feature configuration;
- the first production import of `@craftingtable/git`;
- six authenticated lifecycle commands;
- audit/event/notifier transaction composition;
- HTTP routes and full parent fan-in.

That is more than one coherent review surface. A2b therefore fans out:

```text
CT-04A2b1 — Repository journal correlation and browser projection
    ↓
CT-04A2b2 — Authorized repository lifecycle and CT-04A parent fan-in
```

The split is ordered so no production command can emit a repository event until its schema, structural ownership, storage mapper, strict wire contract, and browser projection are already accepted.

## 3. Source pins

```text
Current source head:
    e3b69c612a51b0b2a8d436ae3ea5355abd40745e

Attached source bundle SHA-256:
    aaccbdbfc60eecb63fd22980c96af119d19ae270e6ed87a981b5e53b49fd652d

Accepted A2a implementation plan SHA-256:
    e3490f16333c9e80b9eab667cea10d57312bbbdbab9434ddb05bc7794e1da747

A2a final review record SHA-256:
    e6cb2207d20dfa5e621b84073eff36a0c9e9f94f3cc601985e16830973c45899

Accepted migration 0003 SHA-256:
    526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4

Original CT-04 protected spec SHA-256:
    ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64

A2 protected supplement SHA-256:
    1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c
```

The original protected files remain immutable. This package adds a separately pinned A2b supplement; it does not rewrite prior expectations.

## 4. Accepted foundations

### 4.1 A1

The package-root A1 API exposes observation-only creation, inspection, recorded-observation parsing, and observation comparison. A1 owns process, filesystem, Git executable, path-admission, repository-class, bounded-output, and observation semantics.

A2b may not reconstruct A1 logic, invoke child processes directly, interpret raw Git output, or implement an alternate path policy.

### 4.2 A2a

A2a already provides:

- repository, inspection, and binding identifiers;
- complete status and evidence vocabulary;
- exact stored observation bytes and SHA-256 helpers;
- immutable, globally sequenced inspection evidence;
- strict public request/response schemas;
- pure repository reducer;
- schema 3 and direct-SQL ownership/transition guarantees;
- typed storage primitives for registration, verification, transition, reaffirmation, retirement, binding, unbind, and queries;
- audit action catalog entries for every A2b command.

A2b must use those records and primitives. It may extend the domain only where the accepted source exposes a genuine downstream gap.

## 5. Source-grounded domain correction

The accepted A2a status vocabulary includes:

```text
identity-mismatch / repository-class-changed
```

and maps A1 codes such as `symlink-rejected`, `ownership-refused`, `not-primary-repository`, `not-git-repository`, `unsupported-object-format`, and `unsupported-repository-extension` to subject `repository-class-changed`.

However, the implemented `RepositoryObservationAssessment` union has no `repository-class-changed` variant. A2b2 must add one rather than misclassifying class failures as core-fingerprint differences.

Conceptually:

```ts
{
  kind: 'repository-class-changed';
  errorCode: RepositoryClassChangedErrorCode;
}
```

The reducer transitions any ordinary inspectable state to:

```text
identity-mismatch / repository-class-changed
```

Terminal and retired behavior remains unchanged. Tests cover every permitted error code and exhaustive handling.

## 6. Child allocation

### 6.1 CT-04A2b1

Owns:

- schema 4 workspace-event rebuild;
- repository/inspection/binding correlation columns and foreign keys;
- kind-specific structural-correlation checks;
- repository event domain types;
- strict event wire schemas;
- storage append and exhaustive row mapping;
- workspace-event introduced-schema mapping;
- browser stale-scope extension;
- browser activity descriptions;
- migration, direct-SQL, mapper, SSE/snapshot, and projection tests;
- journal/projection ADR and documentation.

Does not import Git or add repository service/routes.

### 6.2 CT-04A2b2

Owns:

- optional-but-strict repository feature configuration;
- exact server adapter as the sole production `@craftingtable/git` import;
- A1/domain vocabulary parity checks;
- lazy inspector creation and bounded failure policy;
- authentication and role authorization before host access;
- registration, inspection, reaffirmation, retirement, binding, and unbind services/routes;
- exact stored-evidence verification and comparison;
- the `repository-class-changed` assessment addition;
- atomic state + audit + accepted b1 event transactions;
- post-commit notifier behavior;
- server error mapping and route inventory;
- complete A1+A2a+A2b and original CT-04A parent fan-in.

## 7. Parent invariants

### A2B-I01 — No second Git authority

Only the accepted server adapter imports `@craftingtable/git`. No route, lifecycle service, storage module, browser module, or domain module imports it.

### A2B-I02 — Authorization precedes feature creation and host access

Insufficient role, missing membership, and foreign-workspace requests return before lazy inspector creation, filesystem inspection, or Git execution.

### A2B-I03 — Stored evidence is verified before comparison

A2b verifies exact stored bytes against their digest, parses through A1, and checks projected fields before using evidence. Failure creates storage-integrity evidence and never calls A1 comparison with untrusted state.

### A2B-I04 — Event structure precedes event emission

No repository lifecycle command emits a new event kind until b1's schema, correlation, mapping, wire, and browser behavior is accepted.

### A2B-I05 — State, audit, and events are one transaction

Every successful state transition or binding transition commits its state, required audit rows, and required workspace events atomically. The notifier runs only after commit.

### A2B-I06 — Inspection evidence is immutable and total ordered

Every explicit verification or reaffirmation produces immutable evidence, including bounded failures. Unchanged verification appends evidence and audit but no workspace event or notifier.

### A2B-I07 — Detection failure does not become identity judgment

`observation-raced`, timeout, overflow, spawn, and general process/configuration failures record failure evidence without silently moving repository status. Only mapped unavailable, repository-class, successful comparison, or storage-integrity conditions may change state.

### A2B-I08 — Exact optimistic preconditions are checked twice

Inspect, reaffirm, binding, unbind, and retirement check expected versions before host access where applicable and again in the authoritative transaction.

### A2B-I09 — Reaffirmation is evidence-bearing

Owner reaffirmation requires the expected repository version, expected latest successful inspection, a fresh core-matching observation, and an `environment-evidence-changed` assessment. It preserves RepositoryId and bindings while advancing the accepted environmental baseline.

### A2B-I10 — Retirement is terminal and complete

Repository retirement requires no A1 availability, retires every active binding atomically, emits one repository status event plus one binding-retired event per binding, and never reactivates.

### A2B-I11 — Journal correlations are structural

Repository, inspection, binding, project, work-item, and workspace identities are enforced through structural columns and composite foreign keys, not payload-only convention.

### A2B-I12 — Event projection remains exhaustive

Every new event kind has a storage mapper, strict wire schema, invalidation rule, and activity description. Permissive default arms are forbidden.

### A2B-I13 — Feature absence is explicit, not fatal to planning

If no repository roots are configured, the daemon starts with repository host operations disabled. Explicit malformed repository configuration fails startup rather than silently disabling the feature.

### A2B-I14 — No false readiness

Repository `active`, binding `active`, successful inspection, and feature availability do not imply executable work, approved scope, agent assignment, verification, review, or merge readiness.

### A2B-I15 — Original protected obligations remain the parent gate

Child suites supplement but never replace the original CT-04 and A2 protected specifications.

## 8. Parent non-goals

No branch, target ref, change request, worktree, diff, artifact store, agent execution, check runner, review finding, readiness, merge, remote Git, Git mutation, LAN deployment, or Exo Stack runtime dependency.

## 9. Parent exit gate

A2b is complete only when:

```text
schema 4 preserves all prior journal history and sequence behavior
all five repository event kinds are structurally correlated and projected
Owner can register one real accepted local repository
Editor/Viewer are denied before host inspection where required
explicit inspection records evidence and governed state transitions
Owner can reaffirm environmental evidence without replacing identity
Owner/Editor can bind and unbind one project
Owner can retire a repository and all bindings atomically
missed notifier delivery is recovered from the durable journal
foreign-workspace access remains non-disclosing
all original and supplemental protected cases pass
no Git, process, branch, worktree, diff, agent, check, review, or merge authority leaks beyond scope
```
