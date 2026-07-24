# ADR-015 — Browser navigation and planning views

- **Status:** accepted
- **Date:** 2026-07-24

## Context

CT-02's browser is one screen: `App.tsx` coordinates authentication, workspace
selection, snapshot loading, audit, sessions, and SSE. CT-03 adds an import
surface plus project, plan-version, and work-item detail views, and those views
should be deep-linkable.

ADR-001 chose "no router (CT-01 has one screen)". That premise no longer holds,
so the choice needs to be made deliberately rather than inherited.

## Decision

### Navigation without a router dependency

`apps/web/src/lib/route.ts` exports pure `parseRoute(pathname)` and
`buildPath(route)`; `lib/use-route.ts` is a small `pushState` and `popstate`
hook. No routing library is added.

```text
/
/workspaces/:workspaceId
/workspaces/:workspaceId/import
/workspaces/:workspaceId/projects/:projectId
/workspaces/:workspaceId/projects/:projectId/plans/:planVersionId
/workspaces/:workspaceId/work-items/:workItemId
```

Four static route shapes need roughly fifty lines. A routing library would bring
loaders, actions, and a data layer that ADR-001 deliberately excluded and that
CT-03 §5.14 warns against ("do not let that trigger an unrelated frontend
rewrite or state-management framework"). Keeping `parseRoute` pure also means
navigation is unit-testable under the `node` environment with no DOM.

Vite's default SPA fallback serves `index.html` for unknown paths, so deep links
work in development and under Playwright without server changes. The daemon does
not serve the SPA in CT-03.

### Component boundaries

Planning views live in `apps/web/src/features/planning/`. `App.tsx` keeps
authentication, session, snapshot, and SSE wiring and gains route dispatch.
Status and label derivation lives in a pure `lib/planning-labels.ts` so the
honest-vocabulary rules are testable without rendering.

### Honest status vocabulary

The snapshot's `statusSummary` keys are renamed from CT-02's `ready` and
`blocked` to `planningReady` and `dependencyBlocked`. The dashboard regions read
**Needs attention**, **Active**, **Ready for admission**, and
**Dependency-blocked**.

This is a breaking change to an accepted CT-02 contract, made because CT-03
§5.11 and the source assessment §13.4 both identify a bare "Ready" as semantic
debt: it is indistinguishable from executable readiness and merge readiness,
neither of which CT-03 owns. Labels are rendered as text, not encoded only in
colour or tooltips.

### Safe source rendering

Artifact and diagnostic text renders as React text children inside `<pre>`.
There is no `dangerouslySetInnerHTML`, no Markdown renderer, and no remote
content loading anywhere in the planning views. A committed
`script-injection.yaml` fixture drives a test that asserts escaped output and no
script execution.

### Component test environment

`apps/web` gains `jsdom` and `@testing-library/react` as development-only
dependencies, with a Vitest project split so server, storage, planning, and
script tests keep running under `node`. The acceptance matrix names component
tests as evidence for the dashboard, work-item, import, rendering-safety, and
outage cases, and those are rendering properties that a pure function test
cannot establish.

### No graph canvas

Dependencies are shown as tables and summaries. CT-03 §5.14 forbids an
interactive graph canvas, and for a 14-node graph a table with predecessor and
blocker columns carries the same information at a fraction of the complexity.

## Consequences

The browser stays a projection with no routing framework, no state-management
library, and no component library. Deep links work and are testable.

The custom router handles only the shapes listed above; anything more elaborate
(nested layouts, route-level data loading, scroll restoration) would be a reason
to revisit this decision rather than to extend the module.

Renaming the snapshot keys touches CT-02's reducer, components, and tests. That
churn is one-time and is what makes the vocabulary honest before CT-04 adds
executable and merge readiness on top of it.

Two new development dependencies enter the toolchain, and `pnpm test` now runs
two Vitest environments.

## Alternatives considered

- **`react-router`** — brings a data framework the daemon-as-authority design
  does not want; ADR-001 excluded meta-frameworks for the same reason.
- **Hash-based routing** — avoids the SPA fallback question but produces uglier,
  less linkable URLs for no benefit here.
- **Keeping everything in `App.tsx` with local view state** — no deep links, and
  the source assessment already flags the component as close to brittle.
- **Playwright-only rendering coverage** — slower feedback, and the matrix names
  component tests explicitly.
- **Keeping `ready`/`blocked`** — avoids CT-02 churn but preserves exactly the
  semantic debt the contract asks CT-03 to remove.
