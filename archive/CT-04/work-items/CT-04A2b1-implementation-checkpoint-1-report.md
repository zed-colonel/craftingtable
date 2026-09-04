# CT-04A2b1 implementation checkpoint 1 report

**Status:** Immutable implementation-turn report; mandatory schema-4 checkpoint
**Date:** 2026-07-29
**Planning/implementation base:** `37d621a2e974d2f44cc2ff68122a8922a9970e7d`
**Implementation head:** pending — the source worktree is intentionally uncommitted
**Migration 0004 SHA-256:** `ae3786b86982735a57490d9b291c6c4335511736b4a1480c3110d5a5de5b9454`

## 1. Scope completed in this turn

The operator committed the planning/review package and authorized implementation.
Accepted-plan slices 0–2 are now implemented:

1. exact nine-kind domain vocabulary and schema-introduction map;
2. explicit exported `WorkspaceEventBase`;
3. five repository event variants;
4. strict per-kind Zod envelopes across all nine variants;
5. Zod payload/structural ID agreement and retirement coupling;
6. schema-4 journal rebuild;
7. three composite repository ownership FKs with `ON DELETE RESTRICT`;
8. kind-scoped structural correlation CHECK with the all-NULL future-kind arm;
9. exact AUTOINCREMENT high-water preservation;
10. exact legacy row and payload-byte guards;
11. focused migration, correlation, and contract proofs.

No slice-3 storage mapper, append boundary, snapshot/SSE, browser projection, activity,
scope-checker, ADR, or documentation implementation has started.

## 2. Migration design presented for checkpoint

Migration 0004 is 394 lines and has SHA-256:

```text
ae3786b86982735a57490d9b291c6c4335511736b4a1480c3110d5a5de5b9454
```

It:

- preserves migrations 0001–0003 byte-for-byte;
- adds exactly five schema-4 catalog rows;
- rebuilds `workspace_events` with repository, inspection, and binding correlations;
- retains the inherited valid-JSON-object CHECK;
- adds no `json_extract` or kind-specific payload-semantic CHECK;
- includes every structural presence/absence arm;
- forces all repository correlations NULL for an unlisted future kind;
- restores the exact old AUTOINCREMENT high-water, or normalizes an empty journal to
  sequence row zero;
- restores the exact named index and append-only triggers;
- verifies bilateral row equality and exact payload bytes;
- verifies catalogs, schema objects, FKs, integrity, and sequence before old-table drop;
- repeats critical checks after old-table drop;
- contains one unique, load-bearing `B1_GUARD_TEST_SENTINEL`.

## 3. Commands and results

### 3.1 Planning package commit

```text
37d621a2e974d2f44cc2ff68122a8922a9970e7d
ct-04a2b1: accept repository journal implementation plan
```

Four artifacts were committed: proposed plan, independent design review, design-review
disposition, and accepted plan.

### 3.2 Baseline

The first sandboxed `pnpm check` reached the test suite and failed ten SSE tests solely
because the sandbox denied `listen(127.0.0.1)` with `EPERM`.

The exact command was rerun with local loopback binding permitted:

```text
66 test files passed
545 tests passed
4 Playwright tests passed
scope check passed
protected-package check passed
```

### 3.3 Slice 1

```bash
pnpm exec tsc -b packages/domain packages/contracts
pnpm exec vitest run \
  packages/domain/src/workspace-events.test.ts \
  packages/contracts/src/workspace-event.test.ts
```

Result:

```text
2 test files passed
17 tests passed
```

### 3.4 Slice 2

```bash
pnpm exec vitest run \
  packages/domain/src/workspace-events.test.ts \
  packages/contracts/src/workspace-event.test.ts \
  packages/storage/src/migrations.test.ts \
  packages/storage/src/migration-0002.test.ts \
  packages/storage/src/migration-0003.test.ts \
  packages/storage/src/migration-0004.test.ts
pnpm check:scope
git diff --check
```

Result:

```text
6 test files passed
63 tests passed
scope check passed
diff whitespace check passed
```

The focused cases include:

- `B1-MIG-001`–`010`;
- `B1-COR-001`–`012` and `014`;
- `B1-CON-001`–`012`;
- inherited `A2B-JRN-001`;
- exact migration-0001/0002/0003 hashes.

## 4. Deliberate checkpoint type state

Domain and contracts compile cleanly.

`pnpm exec tsc -b packages/storage` currently fails in the pre-B1
`repositories/workspace-events.ts` mapper because:

1. its union-derived base cannot represent the new correlations; and
2. its four-kind switch does not map the five new kinds.

These are the exact compile failures predicted by B1-F-04/B1-F-05 and are the intended
slice-3 work. They are not bypassed with a temporary cast or permissive default before
the operator reviews migration 0004.

The full gate is therefore not claimed at this checkpoint.

## 5. Current source worktree

Modified:

```text
packages/domain/src/workspace-events.ts
packages/domain/src/workspace-events.test.ts
packages/contracts/src/workspace-event.ts
packages/contracts/src/workspace-event.test.ts
packages/storage/src/migrations.test.ts
packages/storage/src/migration-0002.test.ts
packages/storage/src/migration-0003.test.ts
```

Added:

```text
packages/storage/migrations/0004-ct04a2b-repository-journal.sql
packages/storage/src/migration-0004.test.ts
work-items/CT-04/CT-04A2b1-implementation-checkpoint-1-report.md
```

No implementation commit exists, so this report does not fabricate an implementation
head.

## 6. Checkpoint decision requested

The operator should review:

1. the exact schema-4 table definition;
2. the structural CASE arms and all-NULL ELSE;
3. the three composite FKs and delete actions;
4. absence of payload-semantic DDL;
5. sequence restoration;
6. pre-drop/post-drop guards;
7. the one-marker rollback derivation.

Approval authorizes accepted-plan slices 3–5. A requested migration change amends 0004 in
place under the accepted pre-release amendment policy and produces a new immutable
checkpoint/remediation report.

## 7. Forbidden-scope status

No production server file, route, service, feature configuration, A1/Git import,
repository lifecycle command, repository state write, notifier producer, repository fetch,
or repository UI was added.

B2 lifecycle commands remain absent.
