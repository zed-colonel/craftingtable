# CT-01 Initial Review

**Reviewed commit:** `89304dd` (`CT-01: establish scope, repository contract, and executable skeleton`)  
**Review date:** 2026-07-23  
**Disposition:** Changes requested

## Summary

CT-01 is appropriately small and largely follows the accepted implementation plan. The package
graph is clear, TypeScript is strict, the daemon owns the event source, the browser validates wire
data rather than trusting it, the schemas are a sound initial vocabulary, the fake boundaries are
focused, and the UI establishes the intended visual language without adding a router, component
framework, database, real process execution, or other CT-02+ scope.

The implementation is not ready to accept unchanged. Two findings weaken explicit CT-01 safety and
acceptance guarantees: the unauthenticated server can be configured to bind to a non-loopback
address, and the CI-equivalent browser gate can silently test a pre-existing server rather than the
reviewed source. Three additional findings cover the required outage state, the forbidden-scope
guard, and local command reproducibility.

After these are addressed, CT-02 can build cleanly on the current domain/contracts layering,
dependency-injected server construction, and SSE wire shape. CT-02 should replace the direct fake
backend stream with its authoritative persisted event source; that is an expected extension rather
than a CT-01 defect.

## Findings

### CT01-R1 — High — The unauthenticated daemon can bind to a LAN address

**Location:** `apps/server/src/config.ts:9`

`configFromEnv` accepts any `CRAFTINGTABLE_HOST` value:

```ts
host: env.CRAFTINGTABLE_HOST ?? '127.0.0.1'
```

Setting `CRAFTINGTABLE_HOST=0.0.0.0` therefore exposes the CT-01 server on non-loopback interfaces.
This contradicts the CT-01 non-goal of LAN exposure and ADR-006's statement that the server binds
loopback only. CT-01 deliberately has no authentication or TLS, so an environment setting must not
be able to create an undeclared network security boundary.

This was reproduced directly:

```text
configFromEnv({ CRAFTINGTABLE_HOST: "0.0.0.0", CRAFTINGTABLE_PORT: "4600" })
=> { "host": "0.0.0.0", "port": 4600 }
```

**Recommendation:** Until the authenticated TLS deployment work item, remove the host override or
reject every value that is not explicitly loopback. Add focused configuration tests for the default
and rejection paths.

### CT01-R2 — High — The local E2E gate may pass against stale server code

**Location:** `playwright.config.ts:26`

Both Playwright web servers use:

```ts
reuseExistingServer: !process.env.CI
```

`pnpm check` is documented as the local CI-equivalent gate, but it does not set `CI`. If port 4600
or 5173 is already occupied by a compatible process, Playwright reuses it instead of starting the
reviewed source. During this review, a server process started at 00:08 was already listening on
4600, while the reviewed commit was created at 00:20. The successful E2E run reused that older
process. The test result therefore did not prove that the committed server entry point and
composition passed end to end.

**Recommendation:** Make `pnpm test:e2e` and `pnpm check` require fresh managed servers
(`reuseExistingServer: false`). If reuse is useful for an interactive developer loop, put it behind
an explicit opt-in command or environment variable that the quality gate never sets.

### CT01-R3 — Medium — A normal SSE outage never reaches the implemented error message

**Locations:** `apps/web/src/lib/useEventStream.ts:38`,
`apps/web/src/components/ActivityPanel.tsx:34`

The hook marks an error as `disconnected` only when the native `EventSource.readyState` is
`CLOSED`; ordinary connection failures leave EventSource in `CONNECTING` while it retries, so the
hook reports `reconnecting`. The activity panel displays its error guidance only for
`disconnected`.

A browser check that forced every `/api/events` request to fail remained at `Reconnecting…` with
zero `.error-state` elements across repeated observations. Thus the common case—server stopped or
unreachable—shows no minimal error explanation, despite the work contract and accepted plan
requiring one.

**Recommendation:** Treat sustained reconnecting as an error-visible state, or introduce a bounded
timer/retry policy that transitions to a user-visible disconnected state while still permitting
EventSource recovery. Add a browser or hook test for an unavailable SSE endpoint.

### CT01-R4 — Medium — The forbidden-scope checker misses valid static imports

**Location:** `scripts/check-forbidden-scope.mjs:20`

The import regex recognizes `from "..."`, dynamic `import("...")`, and `require("...")`, but not a
static side-effect import:

```ts
import 'exoskeleton';
```

Testing the script's regex against that statement produced no match. A direct path import to a
sibling Exo Stack repository can therefore evade the source scan without appearing in a workspace
manifest. This conflicts with `docs/architecture.md` and ADR-008, which say every import specifier
is checked.

**Recommendation:** Cover side-effect imports (and other supported module syntax) using a parser or
a complete, tested scanner. Add negative tests for each recognized import form and at least one
relative path containing each forbidden repository name.

### CT01-R5 — Medium — The documented literal quality command is not reproducible on this workstation

**Locations:** `package.json:7`, `.npmrc:1`, `README.md:20`,
`implementation-reports/CT-01-completion.md:10`

The shell resolves `node` to v26.2.0 and `pnpm` to 10.10.0, matching the documented prerequisites,
but the installed standalone pnpm executable embeds Node 20.11.1. With `engine-strict=true`, the
required command fails before any repository script runs:

```text
pnpm check
ERR_PNPM_UNSUPPORTED_ENGINE
Expected version: >=24
Got: v20.11.1
```

Running the same pinned pnpm package under the installed Node 26 runtime
(`npm exec --yes pnpm@10.10.0 -- check`) passes the full gate. This isolates the problem to the
supported pnpm installation/runtime path rather than the TypeScript implementation, but it still
contradicts the quickstart and completion report's claim that the literal command is locally
runnable.

**Recommendation:** Define and document a pnpm installation method that executes under the pinned
Node runtime, verify the literal `pnpm check` command in a fresh Node 24 environment, and update the
completion report with the actual invocation. Alternatively, adjust the toolchain policy if the
standalone pnpm distribution is intended to be supported.

## Review matrix

| Area | Result | Notes |
| --- | --- | --- |
| Scope compliance | Pass with R1 | No database, auth, real Git/agent execution, diff, planning, merge, LAN deployment artifacts, or Exo Stack dependency was added. The configurable non-loopback bind is the exception. |
| Architectural boundaries | Pass | Dependency direction is clear; domain remains pure; contracts are shared; fakes live in the testing boundary; apps compose dependencies. |
| TypeScript correctness | Pass | Strict compilation and project references pass. Branded identifiers remain non-interchangeable and runtime guards back the public schemas. |
| Daemon/browser separation | Pass | The browser receives normalized projections over SSE and has no Git, process, or arbitrary-command surface. |
| Schema design | Pass | The discriminated event union is deliberately small, validates kind-specific payloads, and carries the required scoped IDs and sequencing fields. |
| Testability | Changes requested | Unit seams are good, but R2 allows stale E2E subjects, R3 lacks an outage assertion, and R4 leaves the boundary guard incomplete. |
| Security assumptions | Changes requested | R1 permits unauthenticated non-loopback exposure despite the documented trust model. No secrets or browser shell surface were found. |
| Framework complexity | Pass | pnpm workspaces, Fastify, React/Vite, Zod, Biome, Vitest, and one Playwright test are proportionate; no unnecessary framework layer was introduced. |
| CT-02 foundation | Conditional pass | The package layout, schemas, DI composition, and SSE shape are usable. Resolve the findings first; CT-02 can then add storage/auth/audit services without undoing the CT-01 layering. |

## Verification performed

- Read the binding work contract, accepted implementation plan, required implementation-plan
  sections, UI principles, assumption ledger, work breakdown, architecture document, and ADR-001
  through ADR-008.
- Inspected all committed source, configuration, fixtures, tests, documentation, and the CT-01
  completion report.
- `git show --check HEAD` — passed.
- `git diff --check HEAD^ HEAD` — passed.
- `pnpm check` — blocked before scripts by R5.
- `npm exec --yes pnpm@10.10.0 -- check` under Node 26.2.0 — passed:
  format, lint (one Biome deprecation notice), typecheck, build, 25 unit tests, one Playwright smoke
  test, and the forbidden-scope check.
- Visually inspected the dashboard at 1440×900; the warm-neutral hierarchy, rail, status regions,
  simulated labeling, and activity presentation follow `docs/ui-principles.md`.
- Forced SSE request failure in Chromium; reproduced R3.
- Exercised the host configuration and forbidden-import regex directly; reproduced R1 and R4.

## Non-blocking notes for later work

- `BackendDescriptor.simulated: true` and `RepositorySnapshot.simulated: true` are intentionally
  CT-01-specific. They are acceptable for CT-02's continued fake boundaries but must be widened or
  replaced when real implementations arrive in CT-04/CT-05.
- The SSE route currently streams `AgentBackend` output directly. CT-02 should make the daemon's
  durable event journal authoritative and add snapshot/replay behavior, as already deferred by
  ADR-003.
- Biome reports that `linter.rules.recommended` is deprecated and should migrate to the newer
  preset syntax before the next major Biome upgrade.
