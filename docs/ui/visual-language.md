# Visual language

CraftingTable is a technical tool used for hours at a time, often from a laptop on the couch while
agents work on the workstation. It should read like a good terminal: dark, dense enough that
nothing important is off-screen, calm, and honest about state. The tokens are in
`apps/web/src/styles/tokens.css`; the rules in `styles/global.css`.

## Colour, type and spacing

- **Dark by default.** Near-black surfaces, high-contrast text and one saturated accent, teal,
  for focus, links and the primary action. A light theme redefines the same tokens; the toggle is
  in the rail, the choice persists in the browser, and the OS preference is not consulted.
- **Semantic colour is for state only:** attention amber, active blue, ready green, blocked red,
  done grey. Colour never carries a state alone; the label is always visible text.
- **Tight spacing.** Panels are padded 1rem (0.75rem on phones) on a 0.25–2rem scale. Body text
  is 14px (`--text-base`), 16px on phones; smaller sizes are for hints and labels. Empty space is
  a layout tool, not a default.
- **Monospace** for identifiers, branches, paths, models and numbers; sans-serif for prose.
- **Every number is a door:** a count on the dashboard opens the list it counts.
- Dense operational detail where work is inspected (runs, diffs, the board); summaries elsewhere.
- **Motion only for a state change:** the live-run pulse. No decorative animation, and none at all
  under reduced motion (`prefers-reduced-motion` turns every animation and transition off).

## Widths and phones

- Wider than 900px the rail sits on the left (220px). At 900px and narrower a compact header
  has a Menu button; the navigation opens in the page and closes on navigation or Escape, and a new
  destination starts at the top.
- On a phone (600px and narrower, or 900px and narrower with a coarse pointer), controls are at
  least 44px tall, form text is 16px, controls and metadata stack, and long paths, branch names
  and findings wrap. Tables and patches scroll inside their own panel, never by widening the page.
- The roadmap board's lanes and graph, and the plan version's dependency graph, need 900px; below
  that the board is a grouped list and the graphs are not drawn.

## Accessibility

Full keyboard navigation with a visible focus ring; semantic landmarks and one `h1` per page;
colour never the only carrier of state; reduced motion respected. A `Section` keeps its landmark
and accessible name whether or not it is collapsed.

## Page anatomy

Every page reads top to bottom in the same order, built from the primitives in
`apps/web/src/components/`, which are the only way to build these parts:

1. **Identity.** `PageHeader`: crumbs, one `h1`, one line of context, the page-level status badge
   and the actions that apply to the whole page. Sections below never repeat them.
2. **State.** A `StatusStrip` of labelled facts (branch, target, model, cost, turns, revision),
   never an unlabelled "a · b · c" line.
3. **What needs you.** An `ActionBar` with the primary action first and danger last. Waiting
   reasons are grouped by who moves them (`Reasons`). A sibling page of one subject adds
   `PageTabs` under the header.
4. **Working sections.** Open `Section`s, each with a title, an optional count and a one-line
   summary of its state. A long page carries a `SectionNav` ("On this page").
5. **Reference and history.** `Section`s that collapse and start closed: branch settings once
   work has started, plan metadata, diagnostics, activity, audit.

Explanation of the model lives in an `About` disclosure inside the section it explains, which
starts closed: a section shows state first and explains itself on request.

## Copy

- A heading (`h1`–`h6`, `legend`, a `Section` or `PageHeader` title) is a name, not a sentence:
  at most eight words of fixed text.
- A paragraph is at most 160 characters of fixed text; longer explanation goes in `About`. Only a
  paragraph that reports state may be longer, and it says so: `role="status"` or `"alert"`, or an
  `error-state`, `warning-state` or `empty-state` class. Rendering a paragraph under a condition
  does not make it state.
- A one-line consequence sits beside the action it describes ("Does not resume the roadmap"), not
  in a paragraph above the form.
- A recovery control renders only while there is something to recover, and goes once the stop
  is resolved.

`apps/web/src/copy-rules.test.ts` checks the first two rules on every component.
