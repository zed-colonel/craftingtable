# Target UI: one inbox for decisions, one board for progress

This page covers the information architecture the UI items in the [register](register.md)
converge on (R-A5, R-A6, R-E1 to R-E6). The full inventory of today's surfaces, the navigation
map and the per-component disposition table are in the
[UI report](findings/UI-information-architecture.md) (Deliverables 1–5).

The visual language in `docs/ui-principles.md` stays: dark theme, one teal accent, semantic
state colours, dense layout, and the page-anatomy primitives. The problem is the information
architecture, not the styling.

## Principles

1. **Decisions are made in one place.** The daemon's attention feed
   ([target-architecture §1–2](target-architecture.md)) drives a **Needs you** inbox. Every
   other page shows at most a one-line banner or chip linking to the inbox item. A new blocker
   kind becomes a new inbox item kind, never a new panel on the page where it happened to
   surface.
2. **Progress is a board and a graph, not a list.** The roadmap (or plan) board is the primary
   progress surface. Work items and runs are drill-downs for detail, not places to make
   decisions.
3. **Setup is a checklist, not a page of panels.** Roadmap setup is its own route, with ordered
   steps and a clear "ready to start" state.
4. **One status vocabulary, typed by the daemon.** The UI switches on attention codes and
   blocker codes, never on message text. A glossary of about 15 operator-facing terms lives in
   ui-principles.
5. **Navigation is routing.** There is one `Link` component and no raw in-app `href`s. Deep
   links carry typed parameters (inbox item, roadmap, tab, focus node) and never depend on a
   particular panel happening to be mounted.

## Routes (near term, before the Development Studio)

| Route | Page | Contents |
|---|---|---|
| `/workspaces/:ws` | **Home** | Needs-you summary (top items and total, grouped by roadmap, each with "unblocks N"); roadmap progress cards with a mini board and live pulse; live runs; operator-wait hours (R-C1); activity, collapsed |
| `/inbox` | **Needs you** | Attention items filterable by roadmap, project and kind, sorted by items blocked downstream, then age. Split view on desktop; list then detail on a phone |
| `/inbox/:itemId` | **Decision** | Subject card, the gate chain (what this blocks and what blocks it), evidence links, the one decision component for the kind, and its consequences |
| `/roadmaps` | Roadmaps | Active roadmaps as cards; completed roadmaps under History; New roadmap; Import concurrency map |
| `/roadmaps/:id` | **Roadmap board** | Scheduler state and controls, then the board or graph (below), then a selection side panel |
| `/roadmaps/:id/setup` | Setup checklist | Bindings → dependency environment → verification environments → reviewer responsibilities and delegation → automation and agents → plan acceptance |
| `/roadmaps/:id/history` | History | Revisions, amendments, decision records, evidence submissions (read-only) |
| `/plans/:planVersionId` | Plan | Single-project board or graph plus finalization progress |
| `/work-items/:id` | Work item (drill-down) | Header, attention banner, slice strip, then tabs: Cycle · Runs · Branches & worktrees · Gates · Diff. Predecessors, dependents and blockers are links |
| `/work-items` | Work items | Table with filters (the former Agenda and status cards) |
| `/runs`, `/runs/:id` | Runs | Unchanged. The run page loads the tail first and omits raw vendor data |
| `/sources` | Sources | Projects, plan imports, concurrency-map imports and bindings, repositories |
| `/settings/:section` | Settings | general · agents · capacity · notifications · storage |

The rail has seven entries: Home (count), **Needs you** (count), Roadmaps, Work items, Runs
(live count), Sources, Settings.

When the Development Studio arrives, it takes over Home as the operator's primary surface
(ideate → plan → roadmap). The inbox and the board remain the places where execution asks
for input and shows progress.

## The roadmap board (pain point 2)

The data already exists:
- the map DAG with satisfaction state (`supervision/preview` nodes and requirements);
- roadmap progress with typed blockers;
- cycles and runs.

The daemon adds one read model, `GET roadmaps/:id/board`, returning
`{nodes, edges, gates, attention, summary}`, and a plan-level `GET plan-versions/:id/graph`
built from `work_item_dependencies`. Both are invalidated by existing events. (R-E3)

```text
┌ Cross-project roadmap ─ Running · 3 live · 4 need you · 18/171 done ─ [Pause] [Setup] ┐
│ Target: EXO-12 ▾   Scope: prerequisites only ▾   View: Board | Graph                  │
├───────────────┬─────────────────────────────────────────────────────────────────────┤
│ WI  (Fabric)  │ [WI-01 ✓] [WI-02 ✓] [WI-04 ◐ merge-gate ⚑]──►[WI-07 · waiting]      │
│               │            └─ slices: domain ✓merged ✓verified · runtime ● running  │
│ EXO (V3)      │ [EXO-01 ✓] [EXO-03 ⏸] [EXO-05 ⚑ ADR-012 needed]──►[EXO-06..11 ░]    │
│ STACK         │ ◆ STACK-PLAN-ACCEPTED ✓   ◆ WI-WORKER-G1 ⚑ evidence                 │
├───────────────┴─────────────────────────────────────────────────────────────────────┤
│ ⚑ Approve WI-ADR-012 — unblocks 14 milestones (EXO-05…EXO-11)          [Open decision] │
└─────────────────────────────────────────────────────────────────────────────────────┘
  ✓ done   ● running (pulses)   ◐ in review/merge   ⚑ needs you   ⏸ paused   ░ waiting on other work
```

- **Board (default).** Project swimlanes. Each parent work item is a card, with its slices as
  chips that progress development → merged → verified → parent accepted. Checkpoints are gate
  badges on the nodes that consume them; they are not repeated as nodes.
- **Graph.** A focused neighbourhood around the selection: upstream and downstream,
  transitively reduced, with the critical path to the selected target highlighted. Never all
  1,221 edges at once. Layout is layered longest-path ranks computed in TypeScript; ask the
  operator before adding a layout library. A short ADR supersedes ADR-015's "no graph canvas"
  clause.
- **Overlays.**
  - Live runs pulse on their nodes.
  - Attention markers carry the count of downstream items they block. This is what answers
    "which decision matters most".
  - Waiting nodes name what they wait on.
- **Selection side panel.**
  - State and gates by phase.
  - The live run link.
  - The attention item, which opens the inbox item in place.

  The side panel never hosts its own decision form.
- **Phone.** A grouped list with the same status chips.

## Inbox item kinds and the one component each

| Inbox kind (attention code) | Component | Absorbs today's |
|---|---|---|
| `agent-question`, `remediation-exhausted`, `no-progress`, `step-failed` | CycleContinuation | CycleGuidanceRecovery, CycleRemediationRecovery, ScopeReviewRecovery, plain Resume |
| `architecture-decision` | ArchitectureDecision (prepare with agent · author manually · approve full or limited · clarify) | SharedDecisionInbox (both hosts), ArchitectureDecisionPanel, DecisionPreparationPanel, DesignRecoveryPanel's decision part |
| design questions (while investigating) | DesignQuestions | DesignRecoveryPanel, BaselinePreparationPanel, SourceRunReport |
| `evidence-review` | EvidenceDecision | CheckpointRecoveryPanel, RuntimeEvidencePanel evidence review, plan-acceptance review |
| `environment-approval` | EnvironmentApproval | NativeVerificationPanel approval |
| `integration-conflict` | IntegrationConflict | IntegrationResolutionPanel |
| scope repair | ScopeRepair | ScopeRepairPanel |
| `map-adoption`, `amendment-decision`, `dependency-refresh-approval` | MapAdoption, AmendmentDecision, DependencyRefresh | CrossProjectPanel adoption, MapAmendmentPanel, DependencyRefreshPanel |
| finalization step, `final-promotion` | FinalizationStep, FinalPromotion | FinalizationStageDecision, FinalizationCheckpoint, promotion approval |
| `provider-exhausted` | ProviderRecovery (exhausted only; a pending retry is a status chip) | ProviderRecovery on work-item and run pages |
| `merge-approval` | MergeApproval | DelegationPanel merge form (manual merge stays available as a control) |

Migration order (R-A5 then R-A6):
1. Mount the existing forms, unchanged, inside the inbox detail.
2. Show "Decide in Needs you" banners on the old pages.
3. For each kind, move to the consolidated component and delete the original, together with
   its e2e spec, in the same commit. Take walkthrough captures before and after each step.

## Work-item page as a drill-down (R-E4)

```text
AQ-02 · Introduce target core vocabulary          In progress · Awaiting your merge approval ⚑ → Needs you
Slices:  domain ✓merged ✓verified   runtime ● implement (run 3, 12 min)   ─ parent acceptance ░
[Cycle] [Runs 10] [Branches & worktrees] [Gates] [Diff]
Predecessors: AQ-01 ✓   Dependents: AQ-03 ░, AQ-05 ░
```

The Cycle tab shows status and manual controls only: pause, stop, open run, manual handoff.
It carries no recovery forms.
