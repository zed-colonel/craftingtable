# Information architecture

The rules every page keeps. Each says what holds it: a test, or review alone. The words are in
[glossary.md](glossary.md); what each page holds is in [surfaces.md](surfaces.md).

## Decisions are made in Needs you; other pages link

What needs the operator is a stop the daemon recorded as an attention item
([ADR-070](../decisions/ADR-070-attention-items.md)). **Needs you** (`/workspaces/:id/inbox`) lists
the open items, most blocking first, then oldest, and each item's page
(`/workspaces/:id/inbox/:itemId`) hosts the decisions that resolve it, chosen from the item's
typed code by `apps/web/src/decisions/registry.ts`. Notifications open these pages.

- **Where the stop happened, a page links.** A work item, run, plan version or roadmap whose stop
  an open item carries shows one line naming where it is decided, such as "This merge is decided
  in Needs you. Open the decision", never the decision itself.
- **One exception: no item carries the stop.** Then the page renders the decision in place, with
  the same component, for example a manual merge on its worktree or a cycle stop no item holds.
- **Setup is decided where it is set up.** A roadmap's setup steps and a repository's checks (on
  Repositories) host the same decision components the operator uses before anything stops. An
  item for such a stop renders that one setup step or panel, not a copy of it.
- **A new kind of stop is a new kind of item,** never a new panel on the page where it surfaced.
  No new per-stop recovery panels ([program.md](../review/2026-09-system-review/program.md), rule 1).

Held by: `decisions/boundary.test.ts` for the components (below); review for linking instead of
rendering.

## One component posts each decision command

Every command that resolves an operator-owned stop has exactly one posting component, in
`apps/web/src/decisions/<kind>/`, and its requests live in that kind's own `*-api.ts`, importable
only from its directory. A command whose decision is in its body (`cycles/:id/control`,
`finalizations/:id/control`) names one component per decision. The decision commands are the
routes the daemon tags `decision` in its generated inventory ([../api-routes.md](../api-routes.md)).

Held by: `decisions/boundary.test.ts`, which reads every module's syntax tree and fails on a
second poster, an unowned or doubly owned `decision` route, a request outside an API module, or a
kind's module imported from outside its directory. Its header lists the limits of a static check.

## The browser derives no stop

What needs the operator comes from one feed, `GET /api/workspaces/:id/attention`: the inbox, the
rail's count, the dashboard's section, the strip on every other page and a roadmap's own list all
read it, and none computes it from cycle or roadmap state. Who acts next on a slice or a board
card, and what an entry waits on, are the daemon's words, shown as given. Where the daemon returns
the actions it offers (a cycle's and a finalization's), the page offers only those. Pages still
choose which controls to show from a record's status. Commands on versioned records (cycles,
roadmaps, finalizations, settings) carry the version the page was shown, and the daemon refuses a
stale one; a merge re-checks its gate at exact commits instead.

Held by: review; the roadmap board's modules reach no request (`decisions/boundary.test.ts`).

## One vocabulary, from codes

Labels come from the glossary and from typed codes through the label maps in `apps/web/src/lib/`
(`attention-labels.ts`, `execution-labels.ts`, `planning-labels.ts`) and
`features/planning/roadmap-labels.ts`. The browser branches on codes, never on a message's text
(program rule 4). Colour never carries a state alone; the label is always visible text.

Held by: the exhaustive label maps (a new code without a label fails `pnpm typecheck`); review.

## Navigation

- **The rail is the one list of destinations.** It holds the workspace picker, the workspace's
  pages, the pages outside any workspace (Workspaces, Account), the connection badge, the theme
  toggle and Log out. No page rebuilds a menu of pages.
- **Within a page:** `SectionNav` ("On this page") reaches a long page's sections, and `PageTabs`
  its sibling pages: a roadmap's board, setup and history, and the Settings pages.
- **In a page's body, links go to the thing they name:** an item, a run, a work item, the setup
  step or Settings page that holds a value. That is a link to a subject, not navigation.
- **A page's `h1` is its rail label.** The dashboard is the exception: its `h1` is the workspace's
  name. Pages below a list are titled by their subject.
- **In-app links go through `Link`** (`lib/navigation.tsx`), or `PathLink` for a path the daemon
  supplied; a plain `<a href>` to an in-app path would reload the page and drop unsaved drafts.
  In-page fragments, API downloads and external URLs stay plain anchors. Held by
  `apps/web/src/links.test.ts`.

## The address holds the view

The path names the page and its subject: a roadmap's tab, a Settings page, the work items' filter,
an inbox item. A roadmap's board adds `?view=board|graph|list` and `?select=<node key>`; selecting
replaces the history entry rather than adding one. A `#focus` names an element the page reveals
once it has loaded, so a deep link never depends on a panel being open. Links stored before a page
was split still open the page that now holds their element (`lib/route.ts`). Parsing and building
are pure functions (`parseRoute`, `buildPath`), with no routing library
([ADR-015](../decisions/ADR-015-browser-navigation-and-planning-views.md)).

## Forms open from named actions

A page with nothing to do does not read as a form. Forms open from an action that names them
("New roadmap", "Launch a run…", "Set up finalization", "Import concurrency map"); the one
exception is a form that is the next step, such as the launch form on a work item with no run and
no automation. Reference and history start closed; working sections are open. An unsent answer
to a stop survives a data refresh, a refused command and a move between the stop's views (one
draft per stop for the page's life, `decisions/cycle/answer-draft.ts`), and a form saved from a
version that has since changed is refused, not merged. Held by review.
