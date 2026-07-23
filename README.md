# CraftingTable

CraftingTable is a local supervisory workbench for planning, delegating, observing, reviewing, verifying, and integrating software work performed by existing coding agents.

It exists to make development of the Exo Stack (ActionQueue, WorldInterface, and Exoskeleton) and other personal projects more manageable. Features are justified by immediate development friction, not hypothetical product completeness.

## Current phase

This repository is at **CT-01: Establish scope, repository contract, and executable skeleton**.

The normative planning artifacts are under [`init/`](init/). The active work contract is [`work-items/CT-01.md`](work-items/CT-01.md). Architectural boundaries are documented in [`docs/architecture.md`](docs/architecture.md) and [`docs/decisions/`](docs/decisions/).

## Quickstart

Prerequisites: pnpm 10 (see [`CONTRIBUTING.md`](CONTRIBUTING.md)). Workspace scripts run under a pnpm-managed Node 24 LTS pinned in `pnpm-workspace.yaml`, downloaded automatically on first use.

```sh
pnpm install
pnpm exec playwright install chromium   # once, for the smoke test
pnpm dev                                # server on 127.0.0.1:4600 + web app via Vite
pnpm check                              # CI-equivalent local quality gate
```

The dashboard shows a simulated agent run streamed over SSE from a fake backend — all data is clearly labeled as simulated; no real agents, Git operations, or persistence exist yet.

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
