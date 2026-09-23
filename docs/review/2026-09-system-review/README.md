# CraftingTable system review, September 2026

A whole-system review of CraftingTable at commit `bf08c0b` (2026-09-22). On 2026-09-23 the
walkthrough images were stripped from Git history, which renamed every commit after
`d6d5dc6`: `bf08c0b` is now `6166384`. The findings keep the hashes they were written
against; [commit-map-2026-09-23.txt](commit-map-2026-09-23.txt) maps old hashes to new. The operator requested
it before building the Development Studio on top of the development automation. It is recorded
here so each finding can be remediated independently, over many sessions, by agents without
the review's conversation context.

This directory is an operator-requested exception to the "no planning documents" rule in
`AGENTS.md`. It is a working record: update item statuses in [register.md](register.md) as
work lands. Do not rewrite the findings files; they are evidence captured at `bf08c0b`.

## How to use this record

| File | Use it for |
|---|---|
| [register.md](register.md) | The backlog: 65 remediation items (`R-A1` … `R-I8`) with phase, effort, status, the findings each resolves, what to change, and a testable "done when". Also indexes all 202 findings. |
| [program.md](program.md) | The order of work: phases, dependencies, and baseline metrics that show whether remediation is working. |
| [target-architecture.md](target-architecture.md) | The target controller, attention model and read side the items converge on. |
| [target-ui.md](target-ui.md) | The target information architecture: the "Needs you" inbox, the roadmap board, and the routes. |
| [findings/](findings/) | Nine area reports with maps of the current system and self-contained findings (evidence with `file:line`, impact, recommendation, effort, format impact). |

To work an item: read its register entry, then the linked findings (each finding stands on
its own), make the change with tests, and update the register status in the same commit.
Line numbers in findings refer to `bf08c0b` and will drift; search for the named symbols.

Area reports and their prefixes:

| Prefix | Report | Scope |
|---|---|---|
| CTRL | [Controller](findings/CTRL-controller.md) | Cycle/roadmap/finalization services, state machines, loops, locks |
| NOTIF | [Attention and notifications](findings/NOTIF-attention-notifications.md) | Attention derivation, Pushover outbox, event journals, wakeups |
| UI | [Information architecture](findings/UI-information-architecture.md) | Routes, decision and blocker surfaces, navigation, the missing progress view |
| PERF | [Browser and read performance](findings/PERF-browser-and-read-performance.md) | Refresh model, polling, endpoint cost, rendering |
| FMT | [Plan and roadmap formats](findings/FMT-plan-and-roadmap-formats.md) | Field-by-field format specification, how services consume it, format appendix |
| DATA | [Storage, domain, contracts](findings/DATA-storage-domain-contracts.md) | Schema, JSON state, DB growth, contracts, routes, dead code |
| AGT/GIT/SEC | [Agents, Git, security](findings/AGT-GIT-SEC-agents-git-security.md) | Backends, supervision, briefs, failure classification, Git, security |
| HIST | [History and live usage](findings/HIST-history-and-live-usage.md) | Commit history since the pivot, and an operational profile from the live database |
| QA/DOC/REPO | [Tests, docs, hygiene](findings/QA-DOC-REPO-tests-docs-hygiene.md) | Test suite, tooling, documentation, repository size and hygiene |

## Method

Nine reviewers worked in parallel, each read-only, on one area. They read the code at
`bf08c0b` and the ADRs. They queried the live database read-only; its 12 days of real use
cover 308 runs, 51 cycles, 4 roadmaps and a 171-entry cross-project roadmap. They timed read
endpoints and pure projections against a private copy of the database, sampled the idle
daemon's CPU, and read the commit history since the 2026-09-04 pivot. Each claim is labelled
CONFIRMED or HYPOTHESIS. The synthesis author spot-checked the most severe findings against
the code: AGT-01, GIT-02, NOTIF-01, REPO-02, and the live 500 in DATA-03.

## What the review found

### The short version

CraftingTable's agents are not the bottleneck; the controller's stops are. 297 of 308 runs
finished successfully, and automated run-to-run hand-offs take a median 3.2 s. But from 09-17
to 09-23 there were about **112 wall-clock hours with no agent running while work waited on
the operator**, against about 30 hours of agent work. The 71 operator-mediated hand-offs had
a median wait of 3.3 h, 524 h in total. The configured parallelism of 4 was reached for less
than 10 hours in total. ([HIST-02](findings/HIST-history-and-live-usage.md), HIST-03)

Most of those stops are not genuine decisions. They include:
- agent-output format failures that could be re-prompted automatically;
- "investigation finished" checkpoints;
- integration-advanced refreshes;
- daemon restarts;
- checkpoint evidence that the same person submits and accepts: 33 submitted, 32 decided,
  all accepted;
- a parent/slice repair loop that consumed 29% of all runs without detecting that it was not
  converging.

The rest are real decisions buried in the UI.

Each stop was handled by adding a recovery mode instead of removing its cause. Since the
pivot:
- 23 of 99 commits responded to a specific live stop within hours;
- `WorkCycle` went from 3 to 41 optional fields;
- about 21 recovery/decision panels, 46 ADRs and 22 migrations landed in 18 days;
- `work-cycle-service.ts` grew from 525 to 4,029 lines.

That is the "spaghetti-fication" the operator described, measured.
([HIST-01](findings/HIST-history-and-live-usage.md), HIST-18)

### Pain point 1: blockers and decisions are handled in many places

- **No single model of "what needs the operator".** At least ten places decide it: cycle
  status writers, three scope-wait predicates, two roadmap projections, the notification
  service, and three web derivations. Some classify by typed kind and some by English message
  prefixes, and they disagree. In one seeded state the Dashboard showed one item while the
  Roadmaps page showed five operator decisions. (CTRL-05, UI-01, NOTIF-09, DATA-05)
- **Recovery routing depends on wording.** The UI picks recovery forms by regex-matching
  `cycle.reason`. The daemon writes navigation instructions into blocker text. The
  controller decides automatic reassessment with a regex on reason text. (UI-02, CTRL-11)
- **One decision, many surfaces.** The same evidence accept/reject command is posted from
  three panels. Architecture decisions can be prepared or requested through five paths.
  "Decision" means four different things. The most consequential decision, a shared ADR that
  gates many slices, sits about 3,400 px down the Roadmaps page, inside "Dependency
  environments and evidence". (UI-03, UI-04)
- **Actions that do nothing.** Resume is accepted when it cannot make progress. One
  review-only cycle was resumed 14 times, and each resume re-ran a ~15-minute review that
  returned the same finding. Command gates and launch gates differ, so commands succeed and
  then bounce within seconds. (CTRL-04, CTRL-12)
- **Many decisions require pausing the whole roadmap.** That stops all parallel work to
  answer one question. (CTRL-19)

### Pain point 2: there is no view of progress and dependencies

- The live cross-project map has 335 milestones and 1,221 dependency edges, expanded into a
  171-entry roadmap. The only "graph" is an indented text tree capped at 60 nodes that
  repeats shared prerequisites. Predecessors and dependents on work-item pages are not links.
  ADR-015's "no graph canvas" rule assumed 14 nodes. (UI-06, HIST-19)
- The Roadmaps page grew from 5,418 px to 21,401 px tall in one week. It renders every
  roadmap, including completed ones, and mounts the supervision and evidence panels twice for
  the same map. There is no per-roadmap route, so every link and notification lands on the
  whole stack. (UI-05)
- The data for a real board already exists: the map DAG with satisfaction state, roadmap
  progress with typed blockers, cycles and runs. What is missing is one read model joining
  them with attention, and a plan-level dependency endpoint. (UI-06, DATA-12)

### Pain point 3: the controller is monolithic, noisy and slow

- **Notifications race the controller.** New records are pushed immediately: median 0.66 s,
  127 of 134 pushes under 2 s. The notification worker wakes on the same notify as the
  attention write, while the automation that would clear the state runs a pass later.
  Confirmed false alarm: a push 1.6 s before the roadmap started the queued review itself.
  Suppression works by predicting automation, and six commits each added a clause.
  Notification identity includes the cycle version, so one unchanged situation produced 13
  occurrences, and the operator's own two-step command paged them twice. 40% of first pushes
  arrived within two minutes of an operator action. (NOTIF-01…03, CTRL-02, CTRL-03, HIST-05)
- **The controller is an accretion.** `WorkCycleService.reconcile` is a 656-line function with
  65 returns. It has no transition table and no unit tests. Cycle state is status × step plus
  about 24 optional JSON sub-states. `awaiting-merge` has six meanings. Roadmap ownership of a
  cycle is resolved 11 different ways. About nine in-memory lock sets have different
  semantics. The run launch method is 780 lines. (CTRL-01, CTRL-07, CTRL-10, CTRL-13, CTRL-17)
- **It polls, on the same event loop as the UI.** The idle daemon uses 15–20% of a core. The
  cycle loop re-reconciles every second with synchronous projections of 40–160 ms, and one
  launch preflight blocks supervision of every other cycle. (CTRL-08)
- **The browser multiplies it.** Every workspace event reloads the whole current page. A run
  hand-off causes a median of 4 reload rounds. Some endpoints cost 400 ms of synchronous CPU
  (10× more than necessary). An idle Roadmaps tab polls about 15 MB/min and uses 7.7% of the
  daemon, even when hidden. The panels on one page follow four different freshness policies,
  so after a transition they update at visibly different times, or never. (PERF-01…07,
  PERF-13)

### Beyond the three pain points

- **Work at risk:**
  - The 42 commits since 2026-09-16 exist only on the workstation disk; `origin/main` is at
    `d6d5dc6`. (REPO-02; operator action, see R-I1.)
  - "Remove worktree" force-deletes uncommitted work without asking. (GIT-02)
  - If the run consumer throws, the run is marked failed while the agent process keeps editing
    the worktree. (AGT-01)
  - A merge that times out in the primary checkout is never aborted. (GIT-01)
- **Integrity:**
  - The build, check and CI receipts that gate delegated merges are written by launchers inside
    the agent's own process tree, into a directory the agent can write. (SEC-01)
  - Agents inherit the daemon's full desktop environment and the operator's personal
    Claude/Codex configuration: hooks, skills, memory and MCP servers. (SEC-02, AGT-14)
- **Automation that never fires:**
  - ADR-062 automatic provider retry has never run on live data, for either backend. (AGT-06,
    AGT-59)
  - One-shot operator guidance leaks into every later step of the cycle. (AGT-52)
- **Formats (ground truth):**
  - 22 services re-interpret raw map JSON. Requirement satisfaction is implemented three times
    and `depends_on` enforcement six times. (FMT-01, FMT-02, FMT-09)
  - A map can pass import and then crash the supervisor. (FMT-03)
  - Features switch on by exact English strings and magic identifiers in the map. (FMT-04)
  - The v0.3 map schema only fits the current three-repository stack. (FMT-05)

  A future Studio that phrases things differently would silently lose behaviour.
- **Data:**
  - Raw vendor JSON is about half the 542 MB database, is never read, and is still shipped to
    the browser. (DATA-01, AGT-03)
  - The journal cannot be pruned. (DATA-02)
  - The first run's event page returns a 500 today. (DATA-03)
  - Every Rust step cold-builds in a fresh target directory: 768 GB written and deleted in 10
    days. (AGT-05)
- **Hygiene:**
  - UI walkthrough PNGs are 99% of the repository (1.5 GB, growing about 155 MiB/day).
    (REPO-01)
  - The unit suite takes 5 min 46 s, and one 14k-line file accounts for nearly all of it.
    (QA-01)
  - The README is a changelog, and half of the spot-checked documentation claims are stale.
    (DOC-01…03)
  - Every deploy restarts the daemon and stops the roadmap (78 restarts). (HIST-06)
  - The daemon runs from the editable development checkout. (REPO-04)

### What is sound and should be kept

- The daemon-owns-truth and browser-as-projection split.
- Atomic state + audit + event writes (ADR-010).
- The agent run state machine with guarded expected-status sets.
- Merge reservations with marker-commit recovery.
- Strict wire contracts.
- The backend seam for CLI agents.
- CSRF, origin and digest-only session tokens.
- Clean package dependency direction: the domain is pure, SQL stays in storage, and routes
  never touch storage.
- The page-anatomy primitives and visual language.
- Live Git state is healthy: no leaked worktrees or scratch merges.

The problems are in how state and decisions are modelled and surfaced, not in the foundations.

## The direction in one paragraph

Make the controller the only producer of a typed `Attention` (owner, code, subject, valid
actions), written in the same transaction as each blocking transition. Every consumer reads
it and never re-derives it: pushes, the rail badge, the inbox, the board, and the work-item
page. Pushes go only to operator-owned attention that has settled after the controller went
quiet. Turn stops that are not decisions into automation. Give decisions one home, a "Needs
you" inbox, ordered by how much work each one unblocks. Give progress one home, a roadmap
board that overlays live activity and attention on the dependency graph. Then shrink the
controller behind a characterization harness into a pure decision core and an event-driven
kernel. Make the read side cheap and event-scoped. None of this changes the plan-bundle or
v0.3 map formats. Format changes are confined to a last-resort appendix
([FMT report, Appendix A](findings/FMT-plan-and-roadmap-formats.md)).
