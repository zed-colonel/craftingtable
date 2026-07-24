# CT-02 Remediation Review

**Reviewer role:** independent remediation verification (read-only inspection; this record only)
**Review date:** 2026-07-24
**Initial review:** `review-findings/CT-02/CT-02-initial-review.md`
**Remediation report:** `implementation-reports/CT-02/CT-02-remediation.md`

## Commits

| Role | SHA | Subject |
| --- | --- | --- |
| CT-01 accepted baseline | `693445257d61222959c2efa9fc82c621fa8c6653` | CT-01: record remediation review and completion |
| Initial-review head | `466649bbfa9f99d777ed899c9dae00fe4b7713ec` | CT-02: add persistent authenticated daemon |
| Remediation code commit | `e5da801` | CT-02: remediate initial review findings |
| **Reviewed head** | `4eb4a6b` | chore: place remediation report in canonical location |

Remediation diff `466649b..4eb4a6b`: 20 files, +744 / −51. No binding contract, acceptance matrix,
accepted CT-01 record, schema, or migration checksum was changed (schema remains version 1).

## Deterministic verification (re-run by the reviewer at head `4eb4a6b`)

| Gate component | Result |
| --- | --- |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | pass |
| `pnpm build` | pass |
| `pnpm test` | **103 passed** (was 96; +7 remediation tests) |
| `pnpm test:e2e` | **1 passed** — `authenticated snapshot, replay, outage recovery, and logout` |
| `pnpm check:scope` | pass — no Exo Stack runtime dependencies |

Full `pnpm check` green under pinned Node `24.18.0`. The added SSE Origin check did **not** regress
the authenticated stream e2e, confirming legitimate same-origin `EventSource` requests are still
accepted.

## Finding-by-finding disposition

### CT02-F1 — Confirmed fixed
`packages/storage/src/migrations.ts` adds `MigrationValidationError` with
`unsupported-version | name-mismatch | checksum-mismatch` classifications and
`inspectMigrationStatus()`, which opens with `{ readonly: true, fileMustExist: true }` and returns
`0/1` (pending migration 1) for a missing database **without creating it or its directory**. The
`db status` path (`cli.ts:105-114`) uses `inspectMigrationStatus` and no longer runs the read/write
configurator, so it does not flip journal mode or create `-wal`/`-shm`. Both `db status` and
`db migrate` catch `MigrationValidationError`, print `schema invalid (<classification>): <message>`,
and return the dedicated exit code `4`. Covered by new `migrations.test.ts` and `cli.test.ts` cases
(missing-DB non-creation, unchanged `DELETE` journal mode, absent WAL/SHM, checksum/version output).

### CT02-F2 — Confirmed fixed
`routes/workspace-events.ts:44-57` now authenticates, then applies the same
`isAllowedBrowserRequest(Origin/Sec-Fetch-Site, publicOrigin)` policy used by login and mutations,
throwing the generic `ForbiddenError` (403) **before** `reply.hijack()`. `SameSite=Strict` is now
explicitly defense-in-depth rather than the sole cross-site guard. `config` is threaded through
`buildServer` → `registerWorkspaceEventRoute` (typecheck confirms wiring). New coverage in
`server-events.test.ts`; ADR-003 records the dependency.

### CT02-F3 — Confirmed recorded
`docs/architecture.md:67-72` and `docs/decisions/ADR-003-sse-event-contract.md:62-63` state that every
CT-03+ daemon producer must call the daemon-composed notifier after its event transaction commits, and
that acceptance must prove fast-path delivery independently of the fallback poll. The forward risk is
now a durable, written obligation.

### CT02-F4 — Confirmed recorded
`workspace-event-stream-service.ts:16` introduces `STREAM_REQUERY_INTERVAL_MS = 1000`, used as the
production wait timeout. Architecture/ADR docs record why the interval is correctness-critical
(revocation + dropped-notification recovery), its O(idle connections/second) database cost, and the
obligation to revisit it before activated multi-user / CT-08.

### CT02-F5 — Confirmed fixed
Snapshot and audit routes now call `authenticate()` before validating the workspace id / cursor
(`routes/workspaces.ts:50-54,67-71`), and the SSE route authenticates first as well
(`routes/workspace-events.ts:43-44`). An unauthenticated request now receives the generic `401`
regardless of a malformed identifier or cursor; authenticated-but-malformed requests retain their
typed `404`/`400`. New negative tests in `server-workspaces.test.ts` and `server-events.test.ts`.

### CT02-F6 — Confirmed fixed
`implementation-reports/CT-02/CT-02-completion.md` now records implementation commit `466649b` and
states the operator explicitly authorized the review commit after completion, while preserving that
the accepted plan itself granted no commit authority. Report and repository state now agree.

### CT02-F7 — Confirmed fixed
`apps/web/src/lib/workspace-projection.ts:16-17,72-89` splits diagnostics into `invalidPayloadCount`
(schema-invalid) and `foreignWorkspaceEventCount` (correctly parsed but addressed to another
workspace). Duplicate same-workspace sequences remain silently idempotent (`sequence <= lastSequence`
→ unchanged state). `ActivityPanel`/`App` and reducer tests updated; behavior verified by the passing
gate.

## Regression and scope check

- CT-01 findings R1–R5 remain held (loopback rejection, fresh E2E server, visible sustained-failure
  state, forbidden-scope import forms, literal `pnpm check` under Node 24.18.0).
- No forbidden CT-03+ domain (projects, work items, repositories, real Git/agents, process execution,
  reviews, merge, multi-user activation, LAN/TLS, backup CLI) was introduced.
- The full CT02-A01–A43 acceptance matrix continues to pass under the operator-approved A07 amendment.

## Conclusion

**All seven initial-review findings are resolved** — five code fixes verified against the
implementation and two informational risks made durable in ADR/architecture records — with no new
defects, no scope creep, and a green quality gate. There is nothing further to address; CT-02 is
approved and ready for the final branch commit and merge to `main`.
