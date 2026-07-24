# CT-01 Remediation Report

**Review:** `review-findings/CT-01-initial-review.md` (reviewed commit `89304dd`, disposition: changes requested)
**Date:** 2026-07-23
**Result:** all five findings remediated and verified; the non-blocking Biome deprecation note is also resolved.

Every finding was independently reproduced before fixing.

## CT01-R1 (High) — unauthenticated daemon could bind a LAN address — fixed

Reproduced: `configFromEnv({ CRAFTINGTABLE_HOST: "0.0.0.0" })` returned the non-loopback host unchanged.

**Fix:** `apps/server/src/config.ts` now rejects every host that is not explicitly loopback (`127.0.0.1`, `localhost`, `::1`) with an error referencing ADR-006, and validates the port as an integer in `1–65535`. New `apps/server/src/config.test.ts` covers the default, loopback overrides, non-loopback rejection (`0.0.0.0`, `::`, a LAN IP, a hostname), and malformed ports. ADR-006 now records that loopback-only is enforced, not just documented.

## CT01-R2 (High) — E2E gate could silently test a stale server — fixed

Reproduced by inspection: both Playwright `webServer` entries used `reuseExistingServer: !process.env.CI`, and `pnpm check` does not set `CI`.

**Fix:** `playwright.config.ts` sets `reuseExistingServer` from an explicit interactive-loop opt-in (`CRAFTINGTABLE_E2E_REUSE=1`); the quality gate never sets it. Verified negatively: with a stale server already listening on 4600, `pnpm test:e2e` now fails explicitly ("http://127.0.0.1:4600/api/health is already used…") instead of reusing it. Documented in ADR-008 and `CONTRIBUTING.md`.

## CT01-R3 (Medium) — a normal SSE outage never showed the error state — fixed

Reproduced by inspection: `EventSource` stays in `CONNECTING` while retrying an unreachable server, so the hook never reached `disconnected` and the activity panel never showed its error message.

**Fix:** connection-state policy was extracted into a pure reducer (`apps/web/src/lib/streamState.ts`): a closed source is `disconnected` immediately, and **two consecutive errors** without an intervening open also transition to `disconnected` while EventSource keeps retrying underneath; a later successful open fully recovers. `useEventStream` now drives the reducer via `useReducer`, and the disconnected message states that retries continue automatically. New `streamState.test.ts` (7 tests) covers the transient case, the sustained outage (the reviewed failure mode), immediate closure, recovery, and event/invalid-event accounting.

## CT01-R4 (Medium) — forbidden-scope checker missed side-effect imports — fixed

Reproduced: the previous regex returned no match for `import 'exoskeleton';`.

**Fix:** `scripts/check-forbidden-scope.mjs` was restructured into exported, unit-tested functions (`isForbidden`, `findForbiddenImports`, `findManifestViolations`, `runCheck`) with a main-module guard. The specifier pattern now covers default/named/namespace imports, `export … from`, side-effect `import 'mod'`, dynamic `import()`, and `require()`. The forbidden-name patterns also gained `action-queue` (hyphenated). New `scripts/check-forbidden-scope.test.mjs` asserts every supported import form against forbidden names (including a relative path into a sibling Exo Stack checkout), clean-source and clean-manifest negatives, manifest detection across all four dependency fields, and that `runCheck` passes against the actual repository.

## CT01-R5 (Medium) — documented `pnpm check` not reproducible — fixed

Reproduced exactly: with no `node` on `PATH`, the standalone pnpm executable falls back to its embedded Node 20.11.1 and `engine-strict` correctly refuses (`Expected version: >=24 / Got: v20.11.1`). With `node` 26 visible the same command passed, which is why the original verification did not catch it.

**Fix:** the workspace now pins the script runtime with `useNodeVersion: 24.18.0` (current Node 24 LTS) in `pnpm-workspace.yaml`. pnpm downloads that Node once (~one-time network fetch, like the Playwright browser) and runs every workspace script under it. Verified: in the previously failing environment (shell available, no `node` on `PATH`), `pnpm run` commands now succeed and `pnpm exec node --version` reports `v24.18.0`. This also retires the completion report's risk #1 — the full quality gate now actually executes under Node 24 LTS rather than only documenting it as a floor. ADR-008, `README.md`, and `CONTRIBUTING.md` were updated; the literal `pnpm check` is the verified invocation.

## Non-blocking note — Biome deprecation — resolved

`biome migrate --write` moved `linter.rules.recommended` to the `preset: "recommended"` syntax; lint output no longer carries the deprecation notice.

## Verification

- `pnpm check` passes end-to-end after all fixes (format check, lint, typecheck, build, unit tests — now 43 across 10 files — fresh-server Playwright smoke test, forbidden-scope check), executing under pnpm-managed Node 24.18.0.
- Negative verifications performed: non-loopback host rejected at startup config; occupied port fails the E2E gate explicitly; side-effect forbidden import detected; `pnpm run` succeeds with no `node` on `PATH`.

## Not addressed (intentionally)

- The reviewer's non-blocking CT-02 notes (widening the `simulated: true` descriptor fields, making a durable event journal authoritative for SSE) remain CT-02+ scope, per the review itself.
