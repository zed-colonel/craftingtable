# The browser app

The browser app is a projection of the daemon's state and a control surface: it shows what the
daemon decided and sends commands, and it is never the source of truth (see `AGENTS.md`). These
pages say how it looks, how it is organized and what each page holds. They describe; where they
and the code disagree, the code wins and the page is wrong.

| File | Holds |
|---|---|
| [information-architecture.md](information-architecture.md) | The rules every page keeps: where decisions are made, navigation, what the browser may derive. |
| [glossary.md](glossary.md) | The operator's words: terms, states, merge readiness, stops and who owns them. |
| [visual-language.md](visual-language.md) | Colour, type, spacing, motion, phones, accessibility, page anatomy and copy. |
| [surfaces.md](surfaces.md) | One short spec per page: route, purpose, section order, links and commands. |

Read them in that order before changing the browser app, then the surfaces you touch. The
operator's guide to roadmaps is [../roadmaps.md](../roadmaps.md); the API the pages call is
listed in [../api-routes.md](../api-routes.md) (generated).

## What holds these rules

Some rules are checked by tests over the components' source; the rest are kept by review.

- `apps/web/src/copy-rules.test.ts`: heading length and long prose outside `About`.
- `apps/web/src/links.test.ts`: in-app navigation goes through `Link`, never a raw `href`.
- `apps/web/src/decisions/boundary.test.ts`: each decision command has one posting component,
  in `decisions/<kind>/`; every request is built in an API module; the roadmap board reaches
  no request.
- `apps/web/src/components/anatomy.test.tsx`: the anatomy primitives (`Reasons`, `Section`,
  `StatusStrip`).

## Captures

`pnpm ui:walkthrough` captures every page on desktop and phone at a commit. Take a capture
before and after any change to page structure; how and where is in
[../ui-walkthrough/README.md](../ui-walkthrough/README.md). The captures describe how pages
looked; they do not prescribe.

## Decisions behind the browser app

[ADR-015](../decisions/ADR-015-browser-navigation-and-planning-views.md) (navigation and
planning views), [ADR-072](../decisions/ADR-072-roadmap-neighbourhood-graph.md) (the
neighbourhood graph, which replaced ADR-015's "no graph canvas"),
[ADR-070](../decisions/ADR-070-attention-items.md) (attention items) and
[ADR-003](../decisions/ADR-003-sse-event-contract.md) (the event streams the pages follow).
