# ADR-001 — Server and web framework

- **Status:** accepted
- **Date:** 2026-07-23

## Context

CT-01 requires a running server and browser app with shared runtime-validated contracts. The work contract fixes the baseline: Fastify, React, Vite, Zod, TypeScript strict mode. This ADR records the rationale so the choice is deliberate rather than incidental.

## Decision

- **Server:** Fastify 5 on Node.js. Routes return values validated against `@craftingtable/contracts` schemas before they cross the wire. SSE is written through the raw response after `reply.hijack()`.
- **Web:** React 19 with Vite 8. Plain CSS with design tokens; no component library, no router (CT-01 has one screen).
- **Shared validation:** Zod 4 schemas in `@craftingtable/contracts`, consumed identically by server and browser.

## Consequences

- One HTTP framework and one rendering library; both are small, typed, and widely understood by coding agents.
- The browser never trusts wire data: it re-validates each SSE envelope with the same schema the server used.
- Later work items (auth, SQLite, diff viewing) build on these choices; replacing them would now require a superseding ADR.

## Alternatives considered

- **Express** — weaker TypeScript story, slower, no benefit for this scope.
- **Hono/Elysia** — fine servers, but Fastify is the contract's named baseline and has the mature SSE/raw-response story.
- **Next.js or another meta-framework** — brings routing, SSR, and deployment machinery CraftingTable must not accumulate; the daemon is the product, the browser is a projection.
- **WebSockets-first stack** — rejected; see ADR-003.
