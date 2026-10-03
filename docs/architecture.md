# Architecture

CraftingTable is one daemon and one browser app. The daemon owns all state and every
command; the browser is an authenticated projection reconstructed from a durable snapshot
plus an event cursor. This document describes the current design by component. Decisions
and their reasons are in the ADRs under `docs/decisions/`.

## Packages and dependency direction

```text
domain      pure TypeScript records, branded identifiers, closed vocabularies
contracts   strict Zod HTTP/SSE and persisted-record schemas (depends on domain)
planning    pure plan-bundle, ZIP and concurrency-map parsing and validation (depends on domain)
storage     SQLite, migrations, repositories (depends on domain)
git         worktree, diff, merge and ref operations (depends on domain)
agents      agent backend seam, Claude Code and Codex adapters, build/check/native adapters
server      Fastify routes, services, composition (depends on all of the above)
web         React projection (depends on domain + contracts only)
```

Only `storage` owns SQL. Only the modules named in `PROCESS_AUTHORITY` in
`scripts/check-forbidden-scope.mjs` may spawn a process; that map is the authoritative list,
each entry with its reason. The same check keeps `planning` pure and `domain` free of
imports, forbids Git and vendor-agent libraries elsewhere, and fails any branching on the
text of a `reason` or `message` in the daemon, the browser app and the `contracts`, `domain`,
`planning` and `storage` packages. No package depends on ActionQueue, WorldInterface,
Exoskeleton, or any other supervised project. The check reads what the TypeScript projects
compile, through the compiler: their files, syntax trees and resolved imports. Tests are what
`vitest.config.ts` runs, test support is what only tests import, and everything else is
production, whatever its name.

Each package's tests and test support live in its `test/` directory, beside `src/`, as in
`packages/git`: `tsconfig.json` compiles `src` alone into `dist`, and `tsconfig.test.json`
type-checks `test` without emitting (`pnpm typecheck` runs each). So nothing a test needs is
built into `dist` or shipped with a release; the e2e daemon Playwright starts lives in
`apps/server/test/e2e/`. `pnpm check:scope` fails a test, a module that imports a test runner,
or a module no manifest or page entry reaches, that a production package's build would emit;
every module such a build emits is checked as production. A test reaches the code it tests by a relative
path into `src` (`../src/x.js`); the daemon's tests also use the storage and planning
packages' test support. The browser app's tests stay beside its components: vite builds only
what `index.html` loads.

## Persisted records and migrations

Migrations live in `packages/storage/migrations/` and run forward only, whenever the daemon or a
CLI command opens the database (`craftingtable db migrate` runs them alone; `db:verify` migrates
only a copy). A populated database is first copied into `pre-migration/` beside it (the last three
copies are kept). A CLI command that would migrate takes the single-daemon lock, so it cannot
change the schema under a running daemon. A table-rebuild migration needs a preservation test
(`migration-preservation.ts`) and an in-migration count guard (ADR-002).

Every record storage keeps has a kind in `packages/storage/src/records.ts` (work cycles,
roadmaps, runs, journal events, evidence and so on). Three rules hold at the storage boundary:

- **Reads upcast.** Every repository mapper ends in `readRecord`, which applies the kind's
  upcasters, so the rest of the daemon sees one current shape. When a stored shape stops
  matching the current contract, add an upcaster there instead of teaching readers about the
  old shape.
- **Writes are guarded.** Storage hands every record to the `RecordGuard` it was opened with
  before its write commits. Row-shaped kinds are read back inside the write's transaction and
  guarded there, and that read-back refuses any record an upcaster would change
  (`readWritten`), so an upcaster cannot hide a writer defect. The daemon opens storage with
  `openDaemonStorage` (`apps/server/src/persisted-records.ts`), which checks each record
  against its contract schema, so an out-of-bounds record fails where it is created.
- **Contracts match the domain.** Each kind's schema is pinned to the type storage reads with
  `equivalentSchema`, so a field added to a domain type and not to its schema, or the reverse,
  fails `pnpm typecheck`.

`pnpm db:verify <database>` copies a database with the backup API, migrates the copy and checks
every record against its contract, plus the v0.3 map format and SQLite's integrity and
foreign-key checks. Run it on a snapshot before deploying a contract or schema change. Test
daemons run the same check on their database at cleanup (one stream test opts out with
`verifyRecords: false`).

Imported plans, archives, source maps, roadmap definitions, runtime generations, evidence,
decisions and receipts are immutable (enforced by triggers); mutable state lives in separate
versioned rows, and commands carry the version they read.

## Execution model

```text
SourceRepository   a registered local checkout (path, default branch, head at registration)
Worktree           a linked worktree on a fresh branch, bound to a work item (or a plan version
                   for finalization), a repository, a frozen integration target and optional scope
AgentRun           one supervised agent session in a worktree: backend, role, permission
                   posture, brief, status, cost, turns, optional parentRunId lineage
AgentRunEvent      the normalized per-run journal: session-started, user-message,
                   assistant-message, tool-call, tool-result, turn-completed, notice,
                   stderr, run-finished
```

Run status: `starting → running ⇄ waiting → finished | failed | cancelled | interrupted`.
Transitions are guarded by expected-status sets so a late process callback can never regress
a run the operator already cancelled. Roles (`implement`, `review`, `design`) select a brief
template; together with `parentRunId` they are the composition seam for design/implement/review
loops. Runs record `resolvedModel` and `billing` from session metadata, and a review run records
a `verdict` from its final `VERDICT:` line, which must agree with its structured report.

Each run gets a registered run directory for its brief and plan documents, with a `scratch`
subdirectory passed to both backends as their temporary directory. Tool results over 4 KiB
(`TOOL_RESULT_PREVIEW_BYTES`) keep a preview in the journal and their gzipped body in the run
directory, where it expires with the run's scratch; `craftingtable db compact-journal` applies
the same rule to older runs (ADR-068). Run detail reads the latest completed turn straight from
the journal, so the final message shows independently of feed pagination.

**Drain and resume.** A stop (SIGTERM/SIGINT, or a request file written by
`pnpm deploy:daemon`) drains (`services/daemon-drain.ts`): admissions stop, live turns get up to
`CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS` to finish, then the rest are recorded `interrupted` with
reason `daemon-drain` and a clean stop is written. The next start consumes that record: running
cycles and roadmaps continue, and each drained step resumes its vendor session
(`services/restart-resume.ts`, ADR-066). After a crash, live runs are `interrupted` without a
reason and wait for an explicit resume.

## Work items, plan versions and branch settings

```text
proposed ──admit──▶ admitted ──merge or mark complete──▶ completed
```

"In progress" is derived (an active worktree or a live run), not stored. Completion is a
separate `work_item_completions` row joined on read; a completed predecessor unblocks its
dependents. Removing an unstarted item from the agenda is a guarded, audited return from
admitted to proposed that creates no completion evidence; the eligibility check covers run and
cycle history, active worktrees and delegated roadmaps, plus an in-memory guard for worktree
creation in progress. The whole-item predecessor rule is in one place,
`services/transition-gate.ts`, read by commands, launches and the roadmap scheduler.

Plan versions keep immutable imported documents and mutable execution settings in
`plan_branch_settings` (repository, integration branch, additional protected branches);
`work_item_integration_evidence` attaches integration commits to older manual completions. New
worktrees freeze the configured integration target and its starting commit. Retargeting and integration updates invalidate
earlier reviews; every review records the source and target commits it saw. Required
predecessors' integration evidence is checked by Git ancestry (ADR-026). Repository policy
records (ADR-055) are immutable operator records that runs receive with fresh local
observations; they configure no hosting protection and move no refs.

**Merge gate.** `mergeGateFor` (`services/execution-service.ts`) is mergeable only when nothing
is live and the most recent run is a finished review with a `mergeable` verdict whose branch
context matches the worktree's current version and target. The shared merge command
re-evaluates the gate, verifies the reviewed source and target commits, reserves a durable merge
operation, and merges with a merge commit into the recorded integration branch. The primary
checkout is used only when it already has the target checked out; otherwise the merge runs in a
scratch worktree under the worktree root. The Git commit is reconciled into database completion
before worktree and branch cleanup, and cleanup can be retried independently (ADR-021, ADR-033).

**Handoffs.** A run started with `parentRunId` receives a 256 KiB preview of the parent's
final message plus source files materialized from the journal. The handoff manifest names
source runs and event cursors, recorded on the launch message; it includes conversations,
final messages and review assessments across the parent lineage. Source text is not clipped to
the preview; a handoff over 32 MiB is rejected before launch (`services/run-handoff.ts`). Parent
and child share a worktree, and a source turn must stop before it can be handed off. An
implement run after a review gets the findings; a review after an implement run gets the
implementer's summary as a claim to verify; an implement run after a design gets the proposal
as its plan (ADR-024).

**Review reports and findings.** Review turns carry a daemon-validated, versioned findings
assessment in their `turn-completed` event, reconstructed from the journal after restart
without a mutable findings table. The daemon checks verdict consistency and preserves finding
IDs across the explicit parent lineage. A valid report is a structural reviewer assertion, not
proof of correctness; invalid reports and implementer claims never close findings or supply a
merge verdict, and a failed or invalid latest review clears the stored verdict. Finalization
reports may omit findings already closed by a valid review; their dispositions are
reconstructed from pinned source events (ADR-035).

**Agent profiles.** Which agent runs a step is a workspace setting, not a property of the
previous run. `workspace_run_profiles` holds the four step defaults (design, implement, review,
remediate) and optional specialist overrides (security, checkpoint, acceptance, conflict,
investigation), each a backend, model and optional reasoning effort (both backends); absent specialists inherit
their base step (`packages/domain/src/agent-profiles.ts`). Cycles persist the profiles they
started with. For existing roadmaps an operator appends a version-checked model assignment to
roadmap operational state while the roadmap is a draft, paused or needs attention; it changes
no saved definition or acceptance fingerprint, keeps each step's original permissions, and is
recorded on the runs it selects (ADR-064).

## The cycle controller

`WorkCycleService` runs one admitted, unblocked work item (or a slice, verification, parent
acceptance or finalization stage) through design, implement, review and bounded remediation.
`work_cycles` stores the fixed completion policy, step profiles, next-run reservation and
versioned state; changes append audit and workspace events. Completion requires zero open
blocking, major and minor findings and at most the nit allowance (default 3); remediation rounds
and step time are bounded. Standalone cycles stop for merge approval; a roadmap may delegate
integration merges (ADR-025).

`WorkCycleService.reconcile` decides what a step's outcome means in one pure function,
`decideStepOutcome` (`services/step-outcome.ts`): it reads facts gathered from one cycle and run
and returns a typed decision, which `reconcile` applies. `replayStepOutcomes` runs the same
gatherer and decision over any database snapshot, which is how controller refactors are checked
against recorded decisions (`pnpm controller:replay`, and a golden test over scenario
snapshots). Tests step the controller with `WorkCycleService.tick()` and
`AgentRunService.quiesce()` instead of waiting on wall-clock time.

`controller:replay --scheduler` does the same for one `RoadmapService.tick()`: it records each
roadmap entry's decision, the arguments of the command it would issue (as ids, kinds and
digests of free text), each status list and the attention items, with every command and Git
call intercepted. `pnpm replays` (`scripts/replays.mjs`) is the replay gate. Its committed
manifest, `scripts/replays.manifest.json`, names each recorded live snapshot and its goldens by
paths relative to `$XDG_DATA_HOME`, with each file's SHA-256, because the snapshots hold real
plans and stay outside the repository. It also lists each expected difference by record key, the hash of the new value
and the reason. The gate runs `tsc -b` first, since workspace packages resolve to their built
`dist`. It replays private copies and exits non-zero on any difference the manifest does not
expect. "0 changed" covers classification and scheduling choice only: the replay does not run
`prepare()` or anything after an intercepted command.

**Typed attention.** Every stop carries typed attention (`packages/domain/src/attention.ts`,
ADR-067). A cycle entering `needs-attention` or `awaiting-merge`, a roadmap entering
`needs-attention`, and a held roadmap entry declare a code and an owner in the same write; the
write types make a stop without one a compile error. `awaiting-merge` codes name the gate
(merge approval, merge requirements, final promotion, scope evidence, controller wait,
scheduling held). While automation will act on a stop (a roadmap that merges or verifies
automatically, conflict automation, scope recovery, prerequisite work) the controller records
that claim and the stop is controller-owned until the claim lapses. Phase blockers carry codes
too, with their owner and whether the controller waits on them. Reasons and messages are
display text only. Records written before codes existed are read through
`packages/domain/src/attention-legacy.ts`, the one place that maps old reason text to codes.

**Recovery within a cycle.** Operator guidance continues a stopped step without adding budget;
an exhausted review can be granted 1–20 more remediation attempts. Agent questions stop the
cycle (ADR-063). Bounded automatic recovery exists for provider failures (ADR-062), Claude
background work left uncollected at exit (up to two same-step continuations under the original
deadline, ADR-037), and mapped design dependencies (at most two rechecks). Before an automated
review, tracked edits and staged additions can be committed through a content-bound, durably
reserved Git checkpoint; negative reviews carry housekeeping into remediation, positive reviews
keep exact clean-commit gates (ADR-031).

**Integration updates and conflicts.** When the integration branch moves, parallel and
automatic-integration attempts wait for idle sessions, invalidate review context, update the
worktree with a normal merge and reserve a fresh review. A conflict can be handed to an agent: the
cycle persists a resolution operation (`detected → preparing → resolving → committing →
completed | abandoned`), the Git adapter prepares the pinned merge without committing, the agent
resolves, stages and verifies, and the daemon validates and commits the exact reserved merge.
Up to three agent attempts are allowed; abandoning aborts the merge. Operations reserve the
worktree durably and hold repository/worktree mutation locks only around Git (ADR-032).

**Design recovery and decisions.** An idle design cycle can gather the exact bound plan sources
for its recorded questions and run a bounded investigation (ADR-051). Shared architecture
decisions are prepared as exact proposals and approved only by an authenticated operator; approved
choices reach later runs (ADR-059, ADR-065). Historical baseline preparation (ADR-052) resolves
repositories from the exact map binding, creates local baseline tags with create-only ref updates,
and exports sources under the worktree root (`.baselines`, with a shared `.historical-cargo`
registry); it starts no run and approves no evidence.

## Roadmaps

`RoadmapService` owns at most one delegated roadmap per workspace (a partial unique index on
`roadmaps.workspace_id` over running, paused and needs-attention roadmaps). It selects eligible
entries and delegates whole-item or slice execution to `WorkCycleService`. Sequential mode keeps strict order; parallel mode scans in priority order
under dependency, in-flight, repository and exclusion-group limits. Definitions are immutable
rows in `roadmap_definitions`; the control row stores only `definitionRevision`, and attempts are
separately identified. Each attempt reserves its worktree and cycle IDs before Git work; cycle
creation and attempt attachment commit together. A cycle records the attempt that owns it, and
every ownership question goes through `cycleOwnership` (`services/cycle-ownership.ts`).

The scheduler calls the shared merge command only under the policy of the attempt's own
definition revision. `main`, `master`, the repository default, finalization destinations and
configured protected branches always require operator approval. Before selection the controller
reconciles completed attempts, including manual merges while paused. Running agents are never
preempted. Only a started attempt's own merge releases its successors (ADR-029, ADR-030,
ADR-033).

Capacity is layered: workstation pools for development and for verification/acceptance
(`CRAFTINGTABLE_DEVELOPMENT_CAPACITY` / `CRAFTINGTABLE_VERIFICATION_CAPACITY`, overridden by the
saved setting, 1–32 each, ADR-061) and per-roadmap in-flight and per-repository ceilings. These
coordinate daemon work, not host CPU or isolation.

## Concurrency maps and execution scopes

**Imports.** `PackageImportService` validates ZIPs, schemas and graphs through the pure
`planning` package and records immutable archives, import attempts, concurrency definitions,
plan archive links and binding revisions. It has no Git or agent authority. Importing a map
creates no executable entries; it is an inactive draft under Roadmaps until exact plan versions
and repositories are bound. Configuration changes produce binding diagnostics, never implicit
rebinding (ADR-043).

**Adoption and supervision.** `CrossProjectService` previews milestone closure for a chosen
target, records immutable exact-binding adoptions of a map's scheduling proposals, and resolves
layered settings into ordinary roadmap entries; it launches nothing itself. Read-only
verification and parent-acceptance entries use review supervision without implementation
steps. Saved-plan acceptance evidence is generated from the saved map, bindings, decisions,
pins, reviewer settings and resources, and accepted explicitly by the operator before Start
(ADR-048, ADR-050). Operator-designated reviewer responsibilities are settings bound to the
attempt's revision; they are not human authentication or sandbox qualification.

**Scopes and parent acceptance.** Worktrees, cycles and roadmap entries carry an immutable scope
identity (definition, binding revision, source ID, activity kind); a missing scope means a whole
work item. The daemon resolves scope boundaries from the source map and exact binding
(`services/execution-scope.ts`) before worktree creation, launch, merge, verification and
acceptance. A slice merge does not complete its parent. Parent acceptance reviews a separate
worktree on the current integration snapshot; required slice commits must be in its ancestry, and
every predecessor, slice verification and case obligation must hold. Receipts in `scope_receipts`
are append-only, and receipt insertion and parent completion are atomic (ADR-045). Source
changes found by independent reviews are delegated to the owning slice (ADR-056).

**Phase gates and resources.** `scopePhaseBlockers` produces dependency, evidence, review,
authorization and resource blockers for start, integration, verification and acceptance.
Resource claims live in `phase_reservations`, whose capacity trigger enforces the limit: run
admission reserves with the run row in one transaction, terminal supervision releases in the
terminal transaction, and short Git or evidence operations hold claims only for their duration
(`services/phase-resources.ts`). Early development of a bound slice needs an explicit exact
authorization (ADR-046).

**Runtime generations and evidence.** `RuntimeEvidenceService` keeps immutable runtime
generations separate from maps and bindings: resolved Git refs, crate mappings, conformance
identities and environment fingerprints. The Git adapter exports bounded files from exact objects;
the pinned Cargo adapter runs in the agent's process group, supplies patches, verifies resolved
paths and records a clean-commit build receipt. External evidence packages and operator
decisions on them are separate immutable rows; phase gates consume only current accepted
evidence and recheck Git freshness at launch, integration and acceptance (ADR-047). A dependency
refresh previews a candidate generation, and a digest-checked save creates it and queues the
affected completed reviews in one transaction (ADR-058). Candidate checkpoint evidence permits
only the exact slice's merge (ADR-060).

**Local checks and native verification.** Scoped runs get `ct-check` for repository scripts
and `ct-act` for a GitHub Actions job through the local-check adapter, with optional rootless
Docker (ADR-053, `CRAFTINGTABLE_ACT_CONFIG`). Native verification needs an attributed operator
approval of the audited host (`native_verification_approvals`); independent reviewers then get
`ct-native`, which runs fixtures in a bounded user service managed by the native-environment
adapter. Kata readiness is a separate root-owned receipt (`CRAFTINGTABLE_KATA_READINESS`), not an
agent launch path (ADR-054).

**Amendments.** `MapAmendmentService` records immutable amendment proposals and decisions,
retired execution identities and explicit integration reuse. Applying one activates reviewed plans
and adopts the new roadmap revision in one transaction; running sessions keep their context,
stale reviews are replaced and compatible development stays (ADR-049).

## Finalization

`FinalizationService` finalizes a whole plan version once every item is completed and has
integration commit evidence. It pins an integration snapshot, prepares a candidate worktree and
holds further daemon merges into that integration branch until it ends, then delegates the work to
`WorkCycleService`. Only an authenticated command approving the exact candidate and destination
commits promotes it; no stage or roadmap policy can. Optional local removal of the
integration branch is reserved with the approval and reconciled after promotion. Plan completion
is projected from the completed finalization and its durable merge record (ADR-033, ADR-041).

Every finalization is staged (ADR-042): correctness, conformance,
simplification, polish and a final independent review, each with its own profiles, scope,
required checks and remediation budget. Stage usage updates atomically with run reservations.
`finalization-stage-policy.ts` validates stage reports and guards promotion. A materialized JSON
ledger holds adopted obligations, evidence provenance, selected optional batches and follow-ups;
plan adjustments need a version-checked operator decision, and the final review requires every
obligation and the full checks on the current candidate. Operators can grant more remediation
(ADR-036), select findings for focused remediation (ADR-038) and override the recovery agent
(ADR-040).

The round-based controller that preceded stages is retired (R-B10). Its records still read: the
contracts keep `rounds`, `polishPhase` and `deferredNits`, and the completed 2026-09-13 record
renders (`fixtures/records/legacy-finalization-2026-09-13.json`,
`legacy-finalization-record.test.ts`). A new start must carry stages. For a stage-less
finalization that is still open, resume, remediation, stage decisions and any agent launch are
refused (finalization and cycle controls, and `AgentRunService.startForCycle`); Stop, promotion
and cleanup remain, and the controller stops its cycle with `legacy-finalization-retired`.

## Agent backend seam

`packages/agents` defines `AgentBackend` (`describe`, `launch`) and `AgentSession` (`items`,
`send`, `end`, `kill`). A backend owns the child process and translates vendor output into
`NormalizedAgentEvent`s; the daemon owns run state, the journal, audit and workspace events. A
bounded raw vendor line travels only on a notice for output the adapter could not normalize; it
is never the durable vocabulary. Both adapters use the shared supervisor in
`packages/agents/src/process.ts`. The daemon's backend registry holds whichever of Claude Code and
Codex it found, and defaults to the first available in that order. No app-server socket is exposed
to the browser or LAN.

The Claude Code adapter launches `claude -p` with stream-json input and output, sends the brief as
the first stdin message, keeps stdin open for follow-ups, maps the vendor-neutral permission
posture to a CLI permission mode, and terminates the process group on cancel. Background-wait
expiry and surviving process-group work normalize to an incomplete exit; the supervisor keeps the
run live until the group drains or its deadline passes, and such a run has no review authority.

The Codex adapter keeps one supervised `codex app-server --stdio` process per run. An
adapter-local RPC client starts or resumes a thread; follow-ups steer an active turn or start
another. It drains accepted input on End, interrupts and terminates on Cancel, and fails closed
on protocol errors or unexpected exits. Completed items become bounded durable events; token and
model metadata stay vendor-neutral, and dollar usage is never inferred from tokens (ADR-023).

Both backends receive the run's scratch directory and the worktree's Cargo target directory, one
per worktree and shared by its steps (`worktree_build_caches`, ADR-039).

## Git boundary

`createGitOperations` (`packages/git/src/operations.ts`) is the only Git surface: inspect a
checkout and list or resolve branches; test commit ancestry and find a common ancestor; create a branch or worktree from an exact base and remove a
worktree; diff a worktree against its base (commits, per-file status, bounded unified patch
including untracked files); inspect and checkpoint worktree changes; update a worktree from integration;
merge with a merge commit (aborting on conflict) and delete a merged branch; preview, prepare,
inspect, finish and abort a conflict resolution; inspect a recorded merge operation; export files
from an exact commit; and list and create baseline tags. Every call is an argument array with no shell,
bounded lifetime and output, and process-group termination; paths reach Git only as `cwd` or
after `--`.

Merge reservations (`merge_operations`) pin source, destination, review, authorizer and
definition revision. Recovery after an interruption checks the unique commit marker and its exact
parents in bounded first-parent history before recording completion, so a finished merge is never
repeated. Repository and worktree mutation guards serialize daemon creation, removal, updates and
merges; external Git changes are detected through commit and cleanliness checks.

The removed CT-04A1/A2 repository inspector and registry left three empty tables and their
journal event kinds (`repository-*` and `project-repository-*`) in the schema, because `workspace_events` foreign keys reference them;
nothing writes them, and `pnpm db:verify` reports any row in them (`RETIRED_TABLES`). Its old
environment variables only produce a startup warning.

## Events and notifications

Two journals, one notifier with separate activity and workflow wakeups:

- `workspace_events` is the coarse workspace journal the browser follows to invalidate its
  queries; its kinds are `WORKSPACE_EVENT_KINDS` (`packages/domain/src/workspace-events.ts`),
  mirrored by a migration-owned catalog the `kind` foreign key references.
- `agent_run_events` is the high-volume per-run journal, streamed per run over
  `GET /api/workspaces/:id/runs/:runId/events`.

Every mutation writes state, audit rows and events in one immediate SQLite transaction; the
in-process notifier fires after commit and carries no data. Streams re-authenticate on every
iteration without touching the session's last-seen time. Run activity wakes streams immediately;
scheduler, cycle and notification workers wait on workflow changes (turn completion, run status,
persisted commands), with periodic checks for deadlines and external changes. Map projections
share memoized reads only within one synchronous read pass (`services/map-read-snapshot.ts`).

**Attention items (ADR-070).** What needs the operator is stored, not re-derived:
`attention_items` holds one row per occurrence of a subject stopped at one operator-owned code.
The storage reports every write to `AttentionProjector`, which re-derives only the affected
worktree, roadmap or finalization just before the transaction commits, so an item opens and
resolves with the state that causes it. The roadmap scheduler syncs the sets it evaluates from
the map (verification setup, checkpoints ready for evidence, held entries) after each pass, and
the storage monitor syncs capacity alerts on its own timer. Resolved items are immutable, and
record whether the operator, automation or a new stop resolved them.

`NotificationService` delivers from items only; its storage type has no cycles, roadmaps, maps
or filesystem. It wakes on workflow changes or every five seconds, claims due items with
expiring leases and sends one digest per workspace, rendered from the items' current text, to
Pushover behind an injectable transport. A first push waits a 30-second settle period, a
completed pass of every running controller worker that began after the item opened, and a
five-minute grace while the operator is watching (an open event stream or a recent command).
Reminders (+30 minutes, +1 hour, then hourly to +6 hours, then daily at the configured local
time, 21:00 America/Los_Angeles by default) wait while the operator is issuing commands; an item
that reopens within ten minutes continues its predecessor's schedule. Every attempt is appended
to `notification_deliveries`. Storage alerts use hysteresis. Only a provider rate limit or
rejection holds every alert; transport errors back off per item (ADR-027).

## Browser

The app has no router library and no data-fetching library. Routes are parsed by a pure function
(`apps/web/src/lib/route.ts`); the projection reducer marks scopes stale on events and the app
refetches the authoritative endpoints, batching background invalidations in a bounded window.
`/` resolves to the last used workspace, `/workspaces` lists them all, and every workspace page
hangs off `/workspaces/:id`. The run page loads the committed events once and then follows the
live stream from the last sequence. What needs the operator comes from one feed,
`GET /api/workspaces/:id/attention` (the open attention items, most blocking first), reloaded on
`attention-changed` events; the Needs you inbox, the rail count, the dashboard, the strip on other
pages and each roadmap read it, and no page derives it from cycle or roadmap state. No agent output
is ever rendered as markup. Commands carry the
daemon versions they were shown and are refused when stale. The visual language and page anatomy
are in `docs/ui-principles.md`.

## Installation storage and maintenance

`StorageService` owns one installation storage policy (worktree, run and backup roots, cleanup and
backup settings, free-space reserve), per-run directory registrations and database snapshots; SQL
and the online backup API stay in `storage`. The environment roots seed the policy on first start;
later changes affect only future allocations. Cleanup previews are daemon-held capabilities: the
daemon rechecks durable state (terminal runs, a merged and removed worktree, no live siblings) and
filesystem identity before deleting anything, and never follows a browser-supplied path. Recognized
build caches in a run's scratch are cleaned after the run ends, and automation waits for that
worktree's cleanup; a worktree's shared Cargo target goes once it is merged or removed and idle;
other scratch expires after the retention window (30 days by default). Daily SQLite backups keep
seven snapshots by default, and new runs and worktrees need the free-space reserve (5 GiB by
default) (ADR-034, ADR-039).

## Deploy and the single-daemon lock

Only one process can use a data directory: `apps/server/src/instance-lock.ts` takes the lock
before anything opens the database, as a listening socket in the abstract namespace on Linux (a
socket file elsewhere), so a crash leaves no stale lock. The CLI's migrate and compaction commands
take the same lock. `scripts/deploy-daemon.mjs` fetches the requested commit into a bare clone
under the deploy root, builds it into its own release directory, and atomically repoints `current`,
which is the systemd user unit's working directory. It asks the running daemon to drain through a
request file, restarts the unit, and restores the previous release if the health check fails;
`--rollback` returns to the previous release. `docs/operations.md` has the unit and the procedures.
