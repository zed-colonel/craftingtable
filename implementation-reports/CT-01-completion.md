# CT-01 Completion Report

**Work contract:** `work-items/CT-01.md`
**Accepted plan:** `work-items/CT-01-accepted-implementation-plan.md`
**Date:** 2026-07-23
**Result:** complete — all ten acceptance criteria met; `pnpm check` passes end-to-end.

## Verification summary

- `pnpm check` passes: format check, lint, typecheck (`tsc -b` + web `--noEmit`), build, 25 unit tests across 7 files, Playwright smoke test, forbidden-scope check.
- `GET /api/health` on `127.0.0.1:4600` returns the contract-validated health JSON.
- The dashboard was visually reviewed at a 1440×900 viewport: warm-neutral shell per `docs/ui-principles.md` with narrow rail, workspace header, the four suggested regions (`Needs attention`, `Active`, `Ready`, `Blocked`) showing honest simulated counts, the activity panel with all three normalized fake events, and clearly separated "Live" and "Simulated data" badges.
- SSE flows end-to-end through the Vite dev proxy. The smoke test asserts: shell renders, simulated badge visible, connection reaches `Live`, the `run-started` event appears, a normal page refresh reconnects and replays, and zero console errors occur.
- Negative test: temporarily planting a fake `@exo/actionqueue` dependency made `pnpm check:scope` fail with the offending file named; the change was reverted.

## Commands run (key)

```text
pnpm install
pnpm exec playwright install chromium   # one-time browser download (revision 1228)
pnpm dev                                # verified health, web app, proxied SSE
pnpm check                              # full CI-equivalent gate, passing
pnpm check:scope                        # plus the negative-injection test
```

## Changed files

- **Workspace roots:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `.nvmrc`, `tsconfig.json`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `playwright.config.ts`
- **Packages:** `packages/domain` (branded IDs, event-kind vocabulary), `packages/contracts` (Zod health + `AgentEventEnvelope` schemas), `packages/agents` (`AgentBackend` seam), `packages/git` (`GitService` seam), `packages/testing` (`FakeAgentBackend`, `FakeGitService`, fixture loader) — each with colocated tests
- **Apps:** `apps/server` (Fastify; health route; SSE route with heartbeats, hijacked raw stream, and clean shutdown; inject + streaming tests), `apps/web` (React shell, `useEventStream` hook, `ConnectionBadge`/`SimulatedBadge`/`StatusRegions`/`ActivityPanel`, design tokens + global CSS)
- **Supporting:** `e2e/dashboard.spec.ts`, `scripts/check-forbidden-scope.mjs`, `fixtures/agent-events/demo-run.json`
- **Documents:** ADR-001 through ADR-008, `docs/architecture.md`, `CONTRIBUTING.md`, `README.md` (quickstart added, charter preserved), `work-items/CT-01-accepted-implementation-plan.md`, this report

## Decisions made (accepted ADRs)

- **ADR-001 — server and web framework:** Fastify 5; React 19 + Vite 8; Zod 4 schemas in `@craftingtable/contracts` validated on both sides of the wire.
- **ADR-003 — SSE event contract:** SSE over WebSockets; `event: agent-event` frames with `id: <sequence>` and a JSON `AgentEventEnvelope`; deliberately minimal kind vocabulary (`run-started`, `status-changed`, `completion-proposed`); heartbeat comments; per-connection deterministic replay of the scripted fake run.
- **ADR-008 — toolchain and quality gates:** pnpm workspaces without Nx/Turborepo; TypeScript strict with project references; Biome as the single formatter/linter; Vitest; Playwright (chromium-only, 1440×900); tsx for server dev; Node 24 LTS as the supported floor; `pnpm check` as the CI-equivalent gate.

## Deferred decisions

ADR-002 (SQLite and migrations, CT-02), ADR-004 (diff viewer, CT-04), ADR-005 (Codex integration, CT-05), ADR-006 (local TLS, CT-08), and ADR-007 (full agent execution boundary, CT-05) are recorded as short `deferred` ADRs with notes for their future decision points.

## Scope confirmation

No CT-02-or-later functionality was implemented: no authentication or users, no SQLite or migrations, no persistent audit events, no plan import, no repository registration, no real Git commands or worktrees, no real Codex/Claude Code/OpenCode integration, no verification runners beyond repository quality commands, no diff viewing, no merge operations, no parallel runs, no Planning Studio, no LAN exposure or `systemd` deployment, and no Exo Stack runtime dependency (enforced by `pnpm check:scope`).

## Unresolved risks

1. **Node version:** the workstation runs Node 26.2.0 (Current line). The repository documents Node ≥ 24 (LTS) as the floor, but nothing was actually executed on Node 24; a one-time verification on 24 would close the gap. Node 26 enters LTS in October 2026.
2. **TypeScript 7:** dependency resolution selected TypeScript 7 (the Go-based compiler). Everything passes, but it required an explicit `types: ["node"]` in `tsconfig.base.json`, and other TS 5→7 behavior differences may surface later. Pinning `typescript@^5.9` is a straightforward fallback.
3. **Playwright browser cache:** chromium revision 1228 (~114 MB) was downloaded to match `@playwright/test` 1.61; future Playwright upgrades will trigger re-downloads.
