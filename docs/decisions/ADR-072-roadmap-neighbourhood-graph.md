# ADR-072: A roadmap's neighbourhood graph

- **Status:** accepted
- **Date:** 2026-10-09
- **Supersedes:** ADR-015 in part (the "No graph canvas" clause)
- **Amended:** 2026-10-09 (R-E4): the plan-level graph

## Context

ADR-015 showed dependencies as tables, because CT-03 forbade a graph canvas and a 14-node plan
read well as one. The live cross-project roadmap's map has 33 work items, 69 slices, 95
checkpoints and about 1,080 requirement edges (2026-10-06). Tables and the board's lanes answer
"what does this wait on" one level at a time; seeing a decision's reach, or the chain behind a
card, needs the edges drawn. The whole map drawn at once is unreadable at that size.

## Decision

A roadmap's board gets a second view, the neighbourhood graph (`?view=graph`, desktop only):

- **What it draws.** The selection's neighbourhood at work-item level: a work item and its
  slices are one node, a checkpoint is its own node, edges are the declared requirements between
  them. Two hops up and downstream of the selection, transitively reduced, with "expand" for one
  hop more, and a node cap. Every state and count on a node is the daemon's (the board read);
  the browser only traverses the graph's structure for drawing.
- **How.** SVG rendered by React. Nodes are buttons that select in place, as on the board; there
  is no pan, zoom or drag. The layout is a layered layout (longest-path layers, dummy nodes for
  long edges, barycentre ordering) in a small TypeScript module of the board,
  `layered-layout.ts`, with no new dependency.
- **Cycles.** The map is acyclic, but folded to work items it is not: a checkpoint can need one
  slice of a work item while another slice of it needs the checkpoint (on the live map about a
  third of the selections meet such a loop within two hops). The layout turns each back edge of a
  depth-first walk around to place the nodes, and draws that edge the right way, from right to
  left and dotted. The transitive reduction keeps every edge inside a loop and reduces only
  between loops. A neighbourhood that still cannot be laid out shows a message, never an error
  page.
- **Where not.** No graph on a phone (the grouped list stands in). A plan version's page has the
  plan-level graph since R-E4 (below).

## Amendment (R-E4, 2026-10-09): the plan-level graph

A plan version's page draws its whole dependency graph with the same layout module: every work
item, its required predecessors as edges, transitively reduced. The structure is served once per
version (`GET …/plan-versions/:id/graph`, index-encoded), as a roadmap's graph is served once per
revision, and each node's state comes from the version's detail, in words. A node opens its work
item. Past 60 work items it says so instead of drawing, and the table stands in; as here, there is
no graph on a phone.

## Consequences

- The board owns a layout module and its tests. Its cost is bounded by the node cap, not by the
  map.
- A layout library (dagre, elkjs) stays out; adding one needs the operator first.
- ADR-015's other decisions stand: no routing library, no state-management library.

## Alternatives considered

- **The whole map as one graph:** about 300 nodes and 1,000 edges; unreadable, and slow to lay
  out in the browser.
- **A layout dependency:** better crossings on large graphs, but a new major dependency for a
  view the cap keeps small.
- **Lists only:** they answer one hop at a time, which is what the operator could not see past.
