# ADR-072: A roadmap's neighbourhood graph

Status: accepted (decided by the operator 2026-10-06, P3 design pass, R-E3b)
Date: 2026-10-09
Supersedes: the "No graph canvas" clause of [ADR-015](ADR-015-browser-navigation-and-planning-views.md)

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
- **Where not.** No graph on a phone (the grouped list stands in), and none on a plan version's
  page: the plan-level graph waits for R-E4.

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
