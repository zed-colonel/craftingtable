# CT-01 Remediation Review

**Reviewed commit:** `bbef4ee` (`CT-01: remediate initial review findings R1-R5`)
**Prior review:** `review-findings/CT-01-initial-review.md`
**Review date:** 2026-07-23
**Disposition:** Approved
**CT-01 status:** Complete

## Summary

CT-01 is complete. All five findings from the initial review are remediated. The fixes are focused,
tested, and consistent with the CT-01 work contract. No new blocking findings, architectural
regressions, or CT-02+ scope expansion were found.

The addendum to `implementation-reports/CT-01-completion.md` and the evidence in
`implementation-reports/CT-01-remediation.md` accurately describe the implemented changes and the
current verification result.

## Finding closure

| Finding | Status | Re-review evidence |
| --- | --- | --- |
| CT01-R1 — non-loopback daemon binding | Closed | `configFromEnv` permits only `127.0.0.1`, `localhost`, and `::1`. Focused tests pass, and an actual startup attempt with `CRAFTINGTABLE_HOST=0.0.0.0` exits before listening with the expected loopback error. |
| CT01-R2 — E2E gate could reuse stale servers | Closed | Server reuse now requires the explicit `CRAFTINGTABLE_E2E_REUSE=1` opt-in. With a server intentionally occupying port 4600, the normal `pnpm test:e2e` command fails with an “already used” error instead of reusing it. The normal full gate starts and cleans up fresh servers. |
| CT01-R3 — outage error state was not visible | Closed | Connection policy is isolated in a tested reducer. A forced browser-level SSE failure first showed `Reconnecting…`, then after the second failed attempt showed `Disconnected` and the visible retrying alert. Reducer tests also cover recovery to `open`. |
| CT01-R4 — forbidden-scope checker missed side-effect imports | Closed | The scanner now covers side-effect imports, import/export-from forms, dynamic imports, and `require`. Its focused tests include `import 'exoskeleton'` and a relative sibling-repository path; all pass. |
| CT01-R5 — literal quality command was not reproducible | Closed | The pnpm-managed script runtime reports Node `v24.18.0`, while the shell Node remains v26.2.0. The literal `pnpm check` now succeeds with the workstation's standalone pnpm. A reduced `PATH` containing pnpm and a shell but no Node also successfully ran a workspace script under managed Node 24.18.0. |

## Regression and scope assessment

- The loopback enforcement strengthens the existing deployment boundary without adding
  authentication, TLS, or LAN deployment.
- The event-stream reducer changes browser projection behavior only; the daemon remains
  authoritative and the shared event schema is unchanged.
- The scope-check refactor adds testability without adding dependencies or a generalized framework.
- The pnpm runtime pin uses an existing workspace capability and does not introduce build
  orchestration.
- No database, persistence, real Git, real agent integration, command execution, diff viewing,
  planning, review workflow, merge authority, or other CT-02+ functionality was added.
- The original domain/contracts/package layering remains intact and suitable for CT-02.

## Verification performed

- Inspected commit `bbef4ee`, its complete diff, the completion-report addendum, and the remediation
  report.
- Focused remediation tests: 18 tests across server configuration, stream-state policy, and the
  forbidden-scope scanner — passed.
- Non-loopback startup attempt — rejected before listen.
- Occupied-port `pnpm test:e2e` negative check — failed explicitly instead of reusing the server.
- Forced Chromium SSE outage — visible disconnected alert appeared after the bounded retry
  threshold.
- `pnpm exec node --version` — `v24.18.0`.
- Workspace script with no Node on `PATH` — passed under managed Node 24.18.0.
- Literal `pnpm check` — passed end to end:
  - format and lint;
  - strict TypeScript typecheck;
  - production build;
  - 43 unit tests across 10 files;
  - one fresh-server Playwright smoke test;
  - forbidden-scope check.

## CT-02 readiness

CT-01 is approved as the foundation for CT-02. The previously noted future work remains correctly
deferred: CT-02 should make its durable event journal authoritative for snapshot/replay behavior,
while real backend and Git descriptors remain CT-04/CT-05 concerns.
