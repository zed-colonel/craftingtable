# CraftingTable

CraftingTable is a local supervisory workbench for planning, delegating, observing, reviewing, verifying, and integrating software work performed by existing coding agents.

It exists to make development of the Exo Stack (ActionQueue, WorldInterface, and Exoskeleton) and other personal projects more manageable. Features are justified by immediate development friction, not hypothetical product completeness.

## Current state

The app today: a persistent, authenticated local daemon with workspaces and a
durable event journal (CT-02), plan-bundle import with a project and work-item
dashboard (CT-03), and a read-only Git inspection package with repository
persistence that is not yet reachable from the browser (CT-04A, partial).

Active work is the first usable end-to-end loop: from the dashboard, pick a
work item, register a repository, create a worktree, launch Claude Code with
the work item as its brief, watch it live from another machine, and inspect
the resulting diff. That loop is being built as one vertical slice on `main`;
see `AGENTS.md` for the working method and boundaries.

The original product planning package lives under [`init/`](init/) as
background. Architectural, security, and operating boundaries are documented in
[`docs/architecture.md`](docs/architecture.md), [`docs/security.md`](docs/security.md),
[`docs/operations.md`](docs/operations.md), and [`docs/decisions/`](docs/decisions/).
Superseded planning and review artifacts are under [`archive/`](archive/).

## Quickstart

Prerequisites: pnpm 10 (see [`CONTRIBUTING.md`](CONTRIBUTING.md)). Workspace scripts run under a pnpm-managed Node 24 LTS pinned in `pnpm-workspace.yaml`, downloaded automatically on first use.

```sh
pnpm install
pnpm exec playwright install chromium   # once, for the smoke test
pnpm db:migrate
pnpm craftingtable admin bootstrap --username keith
pnpm dev                                # server on 127.0.0.1:4600 + web app via Vite
pnpm check                              # CI-equivalent local quality gate
```

The bootstrap command prompts twice for a password without echo. The browser
then signs in, loads the authorized default workspace from SQLite, hydrates a
durable snapshot, and follows authenticated replayable workspace events. See
the [local operating guide](docs/operations.md) for data-directory,
shutdown, and recoverable reset instructions before moving or copying the
database.

## Non-goals

CraftingTable is not currently:

- a new coding agent;
- a full IDE;
- a general workflow engine;
- a hosted product;
- a browser-accessible shell;
- a replacement for Git or GitHub;
- a runtime dependency of ActionQueue, WorldInterface, Exoskeleton, or any other software package.

## Governing rule

> Do not finish CraftingTable before using CraftingTable.
