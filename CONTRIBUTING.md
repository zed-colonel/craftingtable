# Contributing to CraftingTable

CraftingTable is a personal supervisory workbench. Contributions — human or agent — follow the same contract.

## Read first

`AGENTS.md` is the canonical guidance: product intent, working method, and the
architectural, safety, and quality boundaries. Then `README.md`,
`docs/architecture.md`, `docs/security.md`, and the ADRs under `docs/decisions/`
for the areas you touch.

## Prerequisites

- pnpm 10 (`packageManager` field pins the tested version).
- Node.js ≥ 24 for anything you run outside pnpm scripts (LTS floor; see ADR-008) — `.nvmrc` pins 24. Workspace **scripts** always run under the pnpm-managed Node pinned by `useNodeVersion` in `pnpm-workspace.yaml`; pnpm downloads it automatically on first use, so `pnpm check` works even when no `node` is on `PATH`.
- One-time: `pnpm exec playwright install chromium` for the smoke test.

## Commands

```text
pnpm install       install workspace dependencies
pnpm dev           server (127.0.0.1:4600) + web (Vite) with watch
pnpm start         daemon only, serving the built web app (run pnpm build first)
pnpm build         type-build all packages, bundle the web app
pnpm format        format with Biome
pnpm format:check  formatting check only
pnpm lint          lint with Biome
pnpm typecheck     tsc -b across project references + web app
pnpm test          Vitest unit tests
pnpm test:e2e      Playwright browser smoke test
pnpm db:migrate    migrate the configured SQLite database
pnpm db:status     report configured SQLite schema status
pnpm check:scope   forbidden-scope check (no Exo Stack dependencies, process authority)
pnpm check         CI-equivalent gate: all of the above, fail-fast
```

`pnpm check` must pass before any work is called done.

For a normal local installation, run `pnpm db:migrate`, then
`pnpm craftingtable admin bootstrap --username <name>` and use that account in
the browser. Bootstrap prompts for the password without echo. Data-directory,
shutdown, database-unit, and recoverable reset instructions are in
[`docs/operations.md`](docs/operations.md); never point tests at that operator
directory.

The E2E gate always starts fresh servers from the current source, creates a
unique temporary database, and fails explicitly if ports `4600`/`5173` are
occupied. Stop any running `pnpm dev` first. It never reuses an operator daemon
or normal data directory.

## Quality expectations

- TypeScript strict mode; no new `any` without justification.
- Public wire contracts live in `@craftingtable/contracts` and are runtime-validated on both sides of the wire.
- New behavior ships with focused tests that assert behavior, not implementation trivia.
- Material architectural decisions get an ADR (`docs/decisions/`); later concerns get a short `deferred` ADR rather than a premature design.
- No secrets, credentials, or machine-specific paths in the repository.

## Git expectations

Commit finished increments with clear messages. Do not push, merge, or rewrite
history unless the operator explicitly asks. Leave the worktree cleanly
reviewable and report changed files, commands run, and unresolved issues.
