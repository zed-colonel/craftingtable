# ADR-008 — Toolchain and quality gates

- **Status:** accepted
- **Date:** 2026-07-23
- **Amended:** 2026-07-23 after the CT-01 initial review (findings CT01-R2, CT01-R5)
- **Amended:** 2026-07-24 for CT-02 native persistence and authenticated E2E

## Context

CT-01 requires a deliberately simple TypeScript workspace with one documented formatter/linter approach and a CI-equivalent local quality gate (the work contract allows this companion tooling ADR alongside ADR-001).

## Decision

- **Workspace:** pnpm workspaces (`apps/*`, `packages/*`) without Nx or Turborepo. Internal packages are consumed as built output via TypeScript **project references**; `tsc -b` enforces the dependency graph.
- **Node version:** supported floor is **Node 24 (active LTS)** — `engines: ">=24"` with `engine-strict`, `.nvmrc` pinned to `24`. The workspace additionally pins the **script runtime** with `useNodeVersion: 24.18.0` in `pnpm-workspace.yaml`: pnpm downloads that exact Node once and runs all workspace scripts under it, so `pnpm check` behaves identically regardless of which Node (if any) is on `PATH` and which runtime the pnpm executable itself embeds. This closes review finding CT01-R5, where a standalone pnpm binary fell back to its embedded Node 20 when `node` was absent from `PATH` and the engines gate refused to run.
- **Formatter + linter:** **Biome** (single tool, single config, formats and lints TS/TSX/CSS/JSON). Chosen over Prettier + ESLint for simplicity; its smaller rule set is acceptable for this codebase.
- **Tests:** **Vitest** for unit and real-file SQLite integration tests (root config aliases workspace packages to source, so `pnpm test` needs no prior build). **Playwright** runs one chromium-only authenticated flow at a 1440×900 viewport. It always starts a fresh daemon with a unique temporary data directory and a fresh Vite server; occupied ports fail rather than reusing stale processes (finding CT01-R2).
- **Server dev runner:** `tsx watch`.
- **Quality gate:** `pnpm check` = `format:check → lint → typecheck → build → test → test:e2e → check:scope`, fail-fast, fully local, no GitHub Actions required. `check:scope` (`scripts/check-forbidden-scope.mjs`) fails on any Exo Stack dependency or import.

## Consequences

- One command reproduces CI-equivalent verification on any machine with Node ≥ 24 and pnpm.
- Biome and Vitest/Playwright versions are pinned by `pnpm-lock.yaml`; Playwright browser downloads happen once per revision via `pnpm exec playwright install chromium`.
- pnpm 10 blocks postinstall scripts by default; `esbuild`, `better-sqlite3`,
  and `argon2` are explicitly allow-listed in `pnpm-workspace.yaml`
  (`onlyBuiltDependencies`). The full gate and native builds run under the
  pnpm-managed Node 24.18.0 runtime.

## Alternatives considered

- **Nx/Turborepo** — build orchestration this repository does not need; explicitly excluded by the work contract.
- **Prettier + ESLint** — two tools, two configs, plugin management; more capability than CT-01 needs.
- **Jest** — slower, heavier ESM story than Vitest under Vite-based tooling.
