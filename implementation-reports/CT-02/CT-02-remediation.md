# CT-02 Remediation Report

**Date:** 2026-07-24
**Initial review:** `review-findings/CT-02/CT-02-initial-review.md`
**Reviewed implementation:** `466649bbfa9f99d777ed899c9dae00fe4b7713ec`
**Disposition:** all findings remediated or recorded as an explicit future
acceptance constraint

## Summary

The independent review found no high- or medium-severity defect and confirmed
all CT02-A01–A43 evidence. This remediation closes the four low code findings,
reconciles the completion record, and makes both informational handoffs durable
without expanding CT-02 scope.

No binding contract, acceptance matrix, accepted CT-01 record, migration, or
schema was changed.

## Finding dispositions

### CT02-F1 — CLI schema validation and read-only status — fixed

- Added `MigrationValidationError` with explicit
  `unsupported-version`, `name-mismatch`, and `checksum-mismatch`
  classifications.
- Added `inspectMigrationStatus()`, which opens an existing database with
  `readonly: true` and `fileMustExist: true`.
- A missing database is reported as schema `0/1`, pending migration 1, without
  creating the database or its directory.
- `db status` no longer calls the normal read/write database configurator, so
  it does not switch journal mode or create WAL/SHM companions.
- Both `db status` and `db migrate` emit
  `schema invalid (<classification>): <message>` and return dedicated exit
  code 4 for an unsupported or tampered migration ledger.
- Tests cover missing-database non-creation, unchanged `DELETE` journal mode,
  absent WAL/SHM files, checksum mismatch, and unsupported version CLI output.

Evidence:

- `packages/storage/src/migrations.ts`
- `packages/storage/src/migrations.test.ts`
- `apps/server/src/cli.ts`
- `apps/server/src/cli.test.ts`
- `docs/operations.md`

### CT02-F2 — Explicit SSE cross-site protection — fixed

The authenticated workspace SSE route now applies the same configured
Origin/`Sec-Fetch-Site` policy used by login and authenticated mutations.
`SameSite=Strict` remains defense in depth rather than the sole stream guard.
An authenticated cross-site stream request receives the generic typed 403
before the response is hijacked.

Evidence:

- `apps/server/src/routes/workspace-events.ts`
- `apps/server/src/server-events.test.ts`
- `docs/decisions/ADR-003-sse-event-contract.md`

### CT02-F3 — CT-03 same-process notifier obligation — recorded

CT-02 correctly has no daemon-process workspace-event producer: bootstrap runs
in the CLI process, so a running daemon discovers that commit through durable
bounded re-query. Architecture and ADR-003 now require every CT-03+ daemon
producer to call the daemon-composed notifier only after its event transaction
commits. Future acceptance coverage must prove fast-path delivery independently
of the fallback poll.

Evidence:

- `docs/architecture.md`
- `docs/decisions/ADR-003-sse-event-contract.md`

### CT02-F4 — Per-connection one-second fallback cost — recorded

The production fallback is now a named `STREAM_REQUERY_INTERVAL_MS = 1000`
constant. Documentation records why the interval is correctness-critical for
revocation and dropped-notification recovery, its
O(idle connections/second) database cost, and the obligation to revisit it
before activated multi-user or CT-08 operation.

Evidence:

- `apps/server/src/services/workspace-event-stream-service.ts`
- `docs/architecture.md`
- `docs/decisions/ADR-003-sse-event-contract.md`

### CT02-F5 — Authentication/identifier validation ordering — fixed

Snapshot, audit, and SSE endpoints now authenticate before validating
workspace IDs, audit cursors, or event cursors. Unauthenticated requests
therefore receive the same typed 401 even when identifiers/cursors are
malformed. Authenticated malformed resources retain their typed 404/400
behavior.

Evidence:

- `apps/server/src/routes/workspaces.ts`
- `apps/server/src/routes/workspace-events.ts`
- `apps/server/src/server-workspaces.test.ts`
- `apps/server/src/server-events.test.ts`

### CT02-F6 — Completion commit status — fixed

The completion report now records implementation commit `466649b` and explains
that the operator explicitly authorized it after completion. It also preserves
the distinction that the accepted implementation plan itself granted no commit
authority.

Evidence:

- `implementation-reports/CT-02/CT-02-completion.md`

### CT02-F7 — Browser diagnostic conflation — fixed

The browser projection now tracks schema-invalid payloads and correctly parsed
events addressed to another workspace in separate counters. The latter remains
a defense-in-depth/server-impossible condition, but its alert no longer claims
contract validation failed. Duplicate same-workspace sequences remain silently
idempotent.

Evidence:

- `apps/web/src/lib/workspace-projection.ts`
- `apps/web/src/lib/workspace-projection.test.ts`
- `apps/web/src/components/ActivityPanel.tsx`
- `apps/web/src/App.tsx`

## Verification

Commands run during remediation:

| Command | Result |
|---|---|
| `pnpm format && pnpm lint && pnpm typecheck` | Pass; one import-type warning was then removed |
| Focused five-file Vitest remediation suite | Pass: 29 tests in 5 files |
| `pnpm check` | Pass: format, lint, strict typecheck, build, 103 unit/integration tests, fresh Playwright flow, forbidden-scope check |
| `git diff --check` | Pass |

## Scope and residual risk

- CT-02 remains loopback-only.
- No CT-03 producer, project/work-item model, Git/agent/process execution,
  multi-user activation, LAN/TLS deployment, or backup CLI was added.
- The 1000 ms durable re-query remains intentional for CT-02. Its scaling cost
  and the same-process producer notification requirement are explicit future
  gates rather than silently implemented adjacent scope.
- Schema version remains 1 and no migration checksum changed.

All initial-review findings are addressed. The complete CT-02 acceptance matrix
continues to pass under the operator-approved CT02-A07 amendment.
