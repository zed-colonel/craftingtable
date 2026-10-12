# Architecture

CraftingTable is one daemon and one browser app. The daemon owns all state and every
command; the browser is an authenticated projection reconstructed from durable reads plus an
event cursor. This document describes the current design by component. Decisions and their
reasons are in the [ADRs](decisions/README.md); the trust model is in
[security.md](security.md) and the procedures in [operations.md](operations.md).

## Packages and dependency direction

```text
domain      pure TypeScript records, branded identifiers, closed vocabularies
contracts   strict Zod HTTP/SSE and persisted-record schemas (depends on domain)
planning    pure plan-bundle, ZIP and concurrency-map parsing and validation (depends on domain)
storage     SQLite, migrations, repositories (depends on domain)
git         worktree, diff, merge and ref operations (depends on domain)
agents      agent backend seam, Claude Code and Codex adapters, check/build/native adapters
            (depends on domain)
server      Fastify routes, services, composition (depends on all of the above)
web         React projection (depends on domain + contracts only)
```

Only `storage` owns SQL. Only the modules named in `PROCESS_AUTHORITY` in
`scripts/check-forbidden-scope.mjs` may spawn a process; that map is the authoritative list,
each entry with its reason. The same check (`pnpm check:scope`) keeps `planning` pure (it may
import only `domain` and `contracts`) and `domain` free of imports, forbids Git and vendor-agent
libraries elsewhere, fails any branching on the text of a `reason` or `message` in the daemon,
the browser and the shared packages, and keeps the map vocabulary the controller gives a meaning
to in one table (`V03_VOCABULARY`, `packages/domain/src/map-capabilities.ts`), and lets `domain`,
`contracts` and `storage` export only what another module imports, resolved through the compiler
to the declaration (a short map names the types declaration emit needs). No package depends
on ActionQueue, WorldInterface, Exoskeleton, or any other supervised project. The check reads
what the TypeScript projects compile, through the compiler: tests are what `vitest.config.ts`
runs, test support is what only tests import, and everything else is production, whatever its
name.

Each package's tests and test support live in its `test/` directory: `tsconfig.json` compiles
`src` alone into `dist`, `tsconfig.test.json` type-checks `test` without emitting, so nothing a
test needs ships with a release (the e2e daemon lives in `apps/server/test/e2e/`). Tests reach
the code by a relative path into `src`. The browser app's tests stay beside its components: vite
builds only what `index.html` loads.

## Persisted records and migrations

Migrations live in `packages/storage/migrations/` and run forward only, whenever the daemon or a
CLI command opens the database (`craftingtable db migrate` runs them alone; `db:verify` migrates
only a copy). A populated database is first copied into `pre-migration/` beside it; the newest
copy is kept, and at each start older ones past 14 days are removed. A CLI command that would
migrate takes the single-daemon lock, so it cannot change the schema under a running daemon. A
table-rebuild migration needs a preservation test
(`packages/storage/test/migration-preservation.ts`) and an in-migration count guard (ADR-002).

Every record storage keeps has a kind in `packages/storage/src/records.ts`. Three rules hold at
the storage boundary:

- **Reads upcast.** Every repository mapper ends in `readRecord`, which applies the kind's
  upcasters, so the rest of the daemon sees one current shape. A stored shape that stops matching
  the contract gets an upcaster there; readers never learn old shapes.
- **Writes are guarded.** Storage hands every record to its `RecordGuard` before the write
  commits; row-shaped kinds are read back and guarded inside the transaction, and that read-back
  refuses a record an upcaster would change (`readWritten`). The daemon opens storage with
  `openDaemonStorage` (`apps/server/src/persisted-records.ts`), whose guard checks each record
  against its contract, so an out-of-bounds record fails where it is created.
- **Contracts match the domain.** Each kind's schema is pinned to the type storage reads with
  `equivalentSchema`, so a field added to one and not the other fails `pnpm typecheck`.

`pnpm db:verify <database>` migrates a backup-API copy and checks every record against its
contract and the v0.3 map format, plus SQLite's integrity and foreign keys and every evidence
head against its record; test daemons run the same check at cleanup.

Imported plans, archives, source maps, roadmap definitions, runtime generations, evidence,
decisions and receipts are immutable (enforced by triggers); mutable state lives in separate
versioned rows, and a command on such a row (a cycle, a roadmap, a finalization, a setting)
carries the version it read.

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
template; with `parentRunId` they are the composition seam for design/implement/review loops.
Runs record `resolvedModel` and `billing` from session metadata, and a review run records a
`verdict` from its final `VERDICT:` line, which must agree with its structured report. A question
stop's investigation (R-C16) is a read-only run beside its cycle, never in the worktree's lineage.

Each run gets a registered run directory for its brief and plan documents; its `scratch` is the
commands' `TMPDIR`, `TMP` and `TEMP`, while a sandboxed Claude Code process itself gets a short
private directory under the agents' temporary root, where its sandbox makes its sockets.
`CARGO_TARGET_DIR` is the worktree's build cache, shared by its steps (`worktree_build_caches`,
ADR-039), and `CARGO_HOME` the daemon's own Cargo home.

**Briefs.** The brief (R-G6) states the goal and acceptance first, then where the agent is and
its build environment, its role and the ordered parts of its final message (`brief-review.ts`,
`brief-implement.ts`, `brief-design.ts`), the files to read, the controller's step rules and the
operator's words. The rules it refers to are `plan/craftingtable-rules.md`. A parent run appears
as a bounded digest (a short quote of its final message, its open findings, an unmet exit gate)
pointing to the handoff files. Tool results over 4 KiB (`TOOL_RESULT_PREVIEW_BYTES`) keep a
preview in the journal and their gzipped body in the run directory, where it expires with the
run's scratch; `craftingtable db compact-journal` applies the same rule to older runs (ADR-068).

**Handoffs.** A run started with `parentRunId` gets its parent lineage's conversations, final
messages and review assessments materialized from the journal, unclipped, with a manifest of
source runs and event cursors; a handoff over 32 MiB or 1,000 source runs is refused before
launch (`services/run-handoff.ts`). Parent and child share a worktree, and a source turn must
stop before it is handed off (ADR-024).

**Drain and resume.** A stop (SIGTERM/SIGINT, or a request file written by
`pnpm deploy:daemon`) drains (`services/daemon-drain.ts`): admissions stop, live turns get up to
`CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS` to finish, the rest are recorded `interrupted` with reason
`daemon-drain`, and a clean stop is written. The next start consumes it: running cycles and
roadmaps continue, and each drained step resumes its vendor session (`services/restart-resume.ts`,
ADR-066). After a crash, live runs are `interrupted` without a reason and wait for an explicit
resume; the next start ends a run's surviving process group only when the record the daemon wrote
at launch (`state/processes/<runId>.json`) proves it is the run's (R-G11).

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
worktrees freeze the configured integration target and its starting commit. Retargeting and
integration updates invalidate earlier reviews; every review records the source and target
commits it saw. Required predecessors' integration evidence is checked by Git ancestry
(ADR-026). Repository policy records (ADR-055) are immutable operator records that runs receive
with fresh local observations; they configure no hosting protection and move no refs.

**Merge gate.** `mergeGateFor` (`services/execution-service.ts`) is mergeable only when nothing
is live and the most recent run is a finished review with a `mergeable` verdict whose branch
context matches the worktree's current version and target; where the repository has adopted
checks, the merge also needs the daemon's clean, successful receipt of each on the reviewed head.
The shared merge command re-evaluates the gate, verifies the reviewed commits, reserves a
durable merge operation, and builds the merge commit without a worktree (`merge-tree`, then
`commit-tree`, R-G10). The target moves by compare-and-swap, or fast-forwards the primary
checkout that has it checked out; a dirty checkout, untracked files in the way, a target that
moved, or one checked out elsewhere is refused by code and nothing moves. Completion is recorded
before worktree and branch cleanup, which can be retried independently (ADR-021, ADR-033).

**Review reports and findings.** Review turns carry a daemon-validated, versioned findings
assessment in their `turn-completed` event, reconstructed from the journal after restart; finding
IDs persist across the parent lineage. A valid report is a reviewer assertion, not proof;
invalid reports and implementer claims never close findings or supply a verdict, and a failed or
invalid latest review clears the stored verdict (ADR-024, ADR-035).

**Agent selection.** Which agent runs a step is a setting, not a property of the previous run.
`workspace_run_profiles` holds the four step defaults (design, implement, review, remediate) and
optional specialist overrides (security, checkpoint, acceptance, conflict, investigation), each a
backend, model and optional reasoning effort; absent specialists inherit their base step
(`packages/domain/src/agent-profiles.ts`). One pure decision table, `resolveAgent`
(`services/agent-resolution.ts`), picks every effective selection from its layers (a resumed
session, an action's own choice, the latest ADR-064 assignment, the cycle's or entry's profiles,
the workspace default, the run a hand-off continues, the daemon's default) and reports its source;
the browser derives none.
Permissions belong to the step: a roadmap save carries permission modes, never an agent, and
agents change only through an ADR-064 assignment (`POST roadmaps/:id/agent-profiles`) while the
roadmap is a draft, paused or needs attention. An assignment changes no saved definition or
acceptance input and reaches future steps of started cycles.

## The cycle controller

`WorkCycleService` runs one admitted, unblocked work item (or a slice, verification, parent
acceptance or finalization stage) through design, implement, review and bounded remediation.
`work_cycles` stores the fixed completion policy, step profiles, next-run reservation and
versioned state; changes append audit and workspace events. Completion requires zero open
blocking, major and minor findings and at most the nit allowance (default 3); remediation rounds
and step time are bounded. Standalone cycles stop for merge approval; a roadmap may delegate
integration merges (ADR-025).

`WorkCycleService.reconcile` decides what a step's outcome means in one pure function,
`decideStepOutcome` (`services/step-outcome.ts`), over facts gathered from one cycle and run.
`replayStepOutcomes` runs the same gatherer and decision over any database snapshot, so
controller refactors are checked against recorded decisions (`pnpm controller:replay`, and a
golden test over scenario snapshots); `controller:replay --scheduler` does the same for one
`RoadmapService.tick()`, recording each entry's decision, the command it would issue, the status
lists and the attention items, with every command and Git call intercepted. Tests step the
controller with `WorkCycleService.tick()` and `AgentRunService.quiesce()`, not wall-clock time.
`pnpm replays` (`scripts/replays.mjs`) is the replay gate: its manifest names each live
snapshot and golden by a path relative to `$XDG_DATA_HOME` with its SHA-256 (the snapshots hold
real plans and stay outside the repository) and each expected difference with its reason, and it
fails on any other. It covers classification and scheduling choice, not what runs after an
intercepted command.

**Typed attention.** Every stop carries typed attention (`packages/domain/src/attention.ts`,
ADR-067). A cycle entering `needs-attention` or `awaiting-merge`, a roadmap entering
`needs-attention`, and a held roadmap entry declare a code and an owner in the same write; the
write types make a stop without one a compile error. `awaiting-merge` codes name the gate
(merge approval, merge requirements, final promotion, scope evidence, controller wait,
scheduling held). While automation will act on a stop (a roadmap that merges, verifies or
accepts automatically, conflict automation, scope recovery, prerequisite work) the controller
records that claim and the stop is controller-owned until it lapses. Phase blockers and roadmap
entry waits (`services/entry-waits.ts`) carry codes too; reasons and messages are display text.
`packages/domain/src/attention-legacy.ts` is the one place that maps old reason text to codes.

**Recovery within a cycle.** Operator guidance continues a stopped step without adding budget;
an exhausted review can be granted 1–20 more remediation rounds. Agent questions stop the cycle
(ADR-063); a question stop can run a read-only investigation that proposes answers, and its
commands are refused if the worktree changed meanwhile (`worktree-changed`). Bounded automatic
recovery covers output-format faults, provider failures (ADR-062), usage limits, background work
left uncollected at exit (ADR-037) and mapped design dependencies. Before an automated review,
tracked edits can be committed through a content-bound, reserved Git checkpoint (ADR-031).

**Integration updates and conflicts.** When the integration branch moves, parallel and
automatic-integration attempts wait for idle sessions, invalidate review context, update the
worktree with a normal merge and reserve a fresh review; a running cycle whose roadmap is held
refreshes the same way just before its review (R-C4). A conflict can be handed to an agent: the
cycle persists a resolution operation, the Git adapter prepares the pinned merge without
committing, the agent resolves, stages and verifies, and the daemon validates and commits the
exact reserved merge, in up to three attempts (ADR-032).

**Design recovery and decisions.** An idle design cycle can gather the exact bound plan sources
for its recorded questions and run a bounded investigation (ADR-051). Shared architecture
decisions are prepared as exact proposals, by command or under a roadmap's standing preparation
grant, and approved only by an authenticated operator; approved choices reach later runs
(ADR-059, ADR-065). Historical baseline preparation (ADR-052) creates local baseline tags with
create-only ref updates and exports sources under the worktree root (`.baselines`, with a shared
`.historical-cargo` registry); it starts no run and approves no evidence.

## Roadmaps

`RoadmapService` owns at most one delegated roadmap per workspace (a partial unique index on
`roadmaps.workspace_id` over running, paused and needs-attention roadmaps). It selects eligible
entries and delegates whole-item or slice execution to `WorkCycleService`. Sequential mode keeps
strict order; parallel mode scans in priority order under dependency, in-flight, repository and
exclusion-group limits. Definitions are immutable rows in `roadmap_definitions`; the control row
stores only `definitionRevision`. Each attempt reserves its worktree and cycle IDs before Git
work. A cycle records the attempt that owns it, and every ownership question goes through
`cycleOwnership` (`services/cycle-ownership.ts`). Every pass records each entry's typed wait.

The scheduler merges only under the policy of the attempt's own definition revision, and never
into `main`, `master`, the repository default, a finalization destination or a protected branch.
It reconciles completed attempts, manual merges included, before selection, and never preempts a
running agent. Only a started attempt's own merge releases its successors (ADR-029, ADR-030,
ADR-033). Automatic scope recovery rounds (R-C5) start from a pinned source review and stop when
consecutive reports show they are not converging (`services/recovery-progress.ts`).

Capacity is layered: workstation pools for development and for verification/acceptance
(`CRAFTINGTABLE_DEVELOPMENT_CAPACITY` / `CRAFTINGTABLE_VERIFICATION_CAPACITY`, overridden by the
saved setting, 1–32 each, ADR-061) and per-roadmap in-flight and per-repository ceilings. These
coordinate daemon work, not host CPU or isolation.

**The board.** A roadmap's page read (`RoadmapService.page`, `GET roadmaps/:id/view`) returns its
view, status list and board from one transaction, one map snapshot and one evaluation of the map.
The board (`services/roadmap-board.ts`, R-E3b) is a pure read model: the roadmap's static graph
at one revision (a map's milestones, or a sequential roadmap's work items and required
predecessors; served once per revision by `GET roadmaps/:id/graph/:revision`) joined with the
evaluation, the status list's states and actors and the open attention items of its
checkpoints. It finds each
node's root blockers and the slices it unblocks, and decides no state again. On a map roadmap an
inbox item's "unblocks N" counts slices. Who acts next on a work item's slices comes from the
same rule (`services/scope-next.ts`, R-E4).

## Concurrency maps and execution scopes

**Imports.** `PackageImportService` validates ZIPs, schemas and graphs through the pure
`planning` package and records immutable archives, import attempts, concurrency definitions,
plan archive links and binding revisions; it has no Git or agent authority. An imported map is
an inactive draft under Roadmaps until exact plan versions and repositories are bound.
Configuration changes produce binding diagnostics, never implicit rebinding (ADR-043).

**What a map declares.** `mapCapabilities` (`packages/domain/src/map-capabilities.ts`, R-F2)
reads a map into what the controller can automate: the plan checkpoint (the single plan approval
the stack owns, whatever its id), the architecture decisions with the decision-owner review
contract, the security reviewer role, resources and their adapters, and independent work items.
Anything else is a typed gap (`plan-contract-changed`, `resource-adapter-missing`, …) left to
independently reviewed evidence or the operator, never silently attested.

**Adoption and supervision.** `CrossProjectService` previews milestone closure for a chosen
target, records immutable exact-binding adoptions of a map's scheduling proposals, and resolves
layered settings into ordinary roadmap entries; it launches nothing itself. Read-only
verification and parent-acceptance entries use review supervision without implementation steps.
Saved-plan acceptance is generated evidence (`saved-plan-v2`) whose digest covers only what plan
acceptance is about (the map, binding and archives, adopted decisions and staged clauses,
reviewer roles, target and selection, resources, implemented-upstream pins). The first
acceptance for a map digest and binding revision is the operator's; an operator command that
re-generates it carries the acceptance in its own transaction (`carryPlanAcceptance`), audited
with the changed inputs, and the scheduler never accepts (ADR-048, ADR-050).

**Scopes and parent acceptance.** Worktrees, cycles and roadmap entries carry an immutable scope
identity (definition, binding revision, source ID, activity kind); a missing scope means a whole
work item. The daemon resolves scope boundaries from the source map and exact binding
(`services/execution-scope.ts`) before worktree creation, launch, merge, verification and
acceptance. A slice merge does not complete its parent. Slice verification stays a separate gate
(ADR-071); one whose gate is met and verdict mergeable, with only minor or nit findings open, is
recorded with them as follow-ups. Parent acceptance reviews the current
integration snapshot, where every required slice commit, predecessor, verification and case
obligation must hold. Receipts in `scope_receipts` are append-only,
and a receipt and its parent's completion commit in one transaction (ADR-045). Source changes
found by independent reviews are delegated to the owning slice (ADR-056).

**Phase gates and resources.** `scopePhaseBlockers` produces dependency, evidence, review,
authorization and resource blockers for start, integration, verification and acceptance.
Resource claims live in `phase_reservations`, whose capacity trigger enforces the limit: run
admission reserves with the run row in one transaction, terminal supervision releases in the
terminal transaction, and short Git or evidence operations hold claims only for their duration
(`services/phase-resources.ts`). Early development of a bound slice needs an explicit exact
authorization (ADR-046).

**Runtime generations and evidence.** `RuntimeEvidenceService` keeps immutable runtime
generations separate from maps and bindings: resolved Git refs, crate mappings, conformance
identities and environment fingerprints. Evidence packages and operator decisions on them are
separate immutable rows; each submission also has an immutable head (`evidence_submission_heads`,
R-H4) without its artifacts' contents, which views and policies read instead of the record. Phase
gates consume only current accepted evidence and recheck Git freshness at launch, integration and
acceptance (ADR-047). A dependency refresh previews a candidate generation, and a digest-checked
save creates it and queues the affected completed reviews in one transaction (ADR-058). Candidate
checkpoint evidence permits only the exact slice's merge (ADR-060).

**Checks and builds.** A run held to checks gets a verification manifest and launchers on its
PATH: `ct-check`, and with a pinned dependency environment also `ct-act` (a GitHub Actions job),
`ct-native` and a Cargo launcher. A launcher runs nothing: it leaves a request in its run's spool
(`packages/agents/src/check-spool.ts`), and `CheckRequestService` runs the command in a transient
systemd user unit outside the agent's process tree and records the receipt in the database; the
run's build record is frozen from those rows (ADR-053). A repository's checks are declared in
`.craftingtable/checks.json` and adopted only by a person (`RepositoryChecksService`). Adopted
checks, and a pinned build of a clean worktree, run on a daemon-private clone of the committed
head, against daemon-private checkouts of the pins where the run has them. A run with no pinned
environment in a repository with adopted checks gets a check-only manifest and `ct-check` alone
(R-G13), and the daemon runs the adopted checks before its review; a roadmap's cycle in a
repository with no adoption stops as `repository-checks-undeclared`. Native verification needs an
attributed operator approval of the audited host (`native_verification_approvals`); `ct-native`
then runs fixtures in a bounded user service. Kata readiness is a separate root-owned receipt
(`CRAFTINGTABLE_KATA_READINESS`), not an agent launch path (ADR-054). What each unit may see is
in [security.md](security.md#checks-and-builds).

**Amendments.** `MapAmendmentService` records immutable amendment proposals and decisions,
retired execution identities and explicit integration reuse. Applying one activates reviewed
plans and adopts the new roadmap revision in one transaction; running sessions keep their
context, stale reviews are replaced and compatible development stays (ADR-049).

## Finalization

`FinalizationService` finalizes a whole plan version once every item is completed and has
integration commit evidence. It pins an integration snapshot, prepares a candidate worktree and
holds further daemon merges into that integration branch until it ends, then delegates the work
to `WorkCycleService`. Only an authenticated command approving the exact candidate and
destination commits promotes it; no stage or roadmap policy can. Plan completion is
projected from the completed finalization and its durable merge record (ADR-033, ADR-041).

Every finalization is staged (ADR-042): correctness, conformance, simplification, polish and a
final independent review, each with its own profiles, scope, required checks and remediation
budget. Stage usage updates atomically with run reservations. `finalization-stage-policy.ts`
validates stage reports and guards promotion. A materialized ledger holds obligations, evidence
provenance, selected batches and follow-ups; the final review requires every obligation and the
full checks on the current candidate. At a spent remediation allowance with only nits open, a
stage parks them as follow-ups and continues; a simplification or polish stage started with
`optionalFindings: 'follow-up'` keeps its optional findings as follow-ups instead of stopping to
select a batch. Operators can grant more remediation (ADR-036), select findings for focused
remediation (ADR-038) and override the recovery agent (ADR-040).

The round-based controller that preceded stages is retired (R-B10); its records still read
(`fixtures/records/legacy-finalization-2026-09-13.json`,
`apps/server/test/legacy-finalization-record.test.ts`). A new start must carry stages. A
stage-less finalization still open allows only Stop, promotion and cleanup: resume, remediation,
stage decisions and any agent launch are refused, and its cycle stops with
`legacy-finalization-retired`.

## Agent backend seam

`packages/agents` defines `AgentBackend` (`describe`, `launch`, `listModels`) and `AgentSession`
(`items`, `send`, `end`, `kill`). A backend owns the child process and translates vendor output into
`NormalizedAgentEvent`s; the daemon owns run state, the journal, audit and workspace events. A
bounded raw vendor line travels only on a notice for output the adapter could not normalize; it
is never the durable vocabulary. Both adapters use the shared supervisor in
`packages/agents/src/process.ts`; the default backend is the first available of Claude Code and
Codex. Model pickers offer each CLI's own catalog (`services/model-catalog-service.ts`), and a
model that is not a catalog id is refused at launch.

An agent starts from named variables of the daemon's environment only
(`packages/agents/src/child-environment.ts`) plus the run's own. Each adapter maps the
vendor-neutral permission posture onto its backend's controls; what a posture means per backend
is on `AgentPermissionMode` (`packages/domain/src/execution.ts`). The sandboxes, the reads they
deny (`sandbox-reads.ts`) and the outside sources a sandboxed command may reach
(`outside-sources.ts`) are in [security.md](security.md#agent-sandboxes).

The Claude Code adapter launches `claude -p` with stream-json input and output and no settings
from any scope, sends the brief as the first stdin message, keeps stdin open for follow-ups, maps
the posture to a CLI permission mode, and terminates the process group on cancel. A result given
while tracked background tasks are pending is a progress notice: the turn ends at the result
that collects them, or at the last such result if the session exits first (R-G11). Background-wait
expiry and surviving process-group work normalize to an incomplete exit; the supervisor keeps the
run live until the group drains or its deadline passes, and such a run has no review authority.

The Codex adapter keeps one supervised `codex app-server --stdio` process per run, with the
operator's plugins, hooks, memories, MCP servers and skills switched off. An adapter-local RPC
client starts or resumes a thread; follow-ups steer an active turn or start another. It drains
accepted input on End, interrupts and terminates on Cancel, and fails closed on protocol errors or
unexpected exits. Token and model metadata stay vendor-neutral, and dollar usage is never inferred
from tokens (ADR-023).

## Git boundary

`createGitOperations` (`packages/git/src/operations.ts`) is the only Git surface: inspection,
branches and heads, ancestry, worktree creation and removal, bounded diffs (untracked files
included), change snapshots and checkpoints, integration updates, merge prediction and merges,
conflict resolution, merge recovery, reads and exports from an exact commit, and baseline tags.
Every call is an argument array with no shell, bounded lifetime and output, and process-group
termination; paths reach Git only as `cwd` or after `--`.

The factory spreads one plain object from modules split by concern (R-G10): `refs`, `worktrees`,
`diff`, `merge` (merges, worktree updates, merge prediction and recovery), `resolution`,
`checkpoint` and `export`, each a `(runner) => partial` builder over `runner.ts`, the package's
only process authority. The runner runs a command buffered under the output limit or streams it,
and starts Git hardened: named environment variables only, no system configuration, the daemon's
identity file as the only global configuration, hooks and fsmonitor off. Every command against a
repository or worktree names its Git directories explicitly (`pinning.ts`), and a Git directory
the daemon does not trust (`services/git-trust.ts`) is refused as `untrusted-git-directory`
(R-G14); the rules are in [security.md](security.md#the-daemons-own-git).

Merge reservations (`merge_operations`) pin source, destination, review, authorizer and
definition revision. Recovery after an interruption checks the unique commit marker and its exact
parents in bounded first-parent history before recording completion, so a finished merge is never
repeated. Repository and worktree mutation guards serialize daemon creation, removal, updates and
merges; external Git changes are detected through commit and cleanliness checks. A run's
repository's branches and tags are read when it starts and ends: a ref no managed worktree owns
that moved, and that no daemon operation left there, is recorded in `protected_ref_moves`
(`services/ref-watch.ts`).

The CT-04A1/A2 repository inspector and registry are gone: migration 0040 dropped their tables
and the journal's correlation columns (R-H6); their event kinds and audit actions keep their
catalog rows, and a trigger on each journal refuses them (ADR-013). Their old environment
variables only produce a startup warning.

## Events and notifications

Two journals, one notifier with separate activity and workflow wakeups:

- `workspace_events` is the coarse workspace journal the browser follows to invalidate its
  queries; its kinds are `WORKSPACE_EVENT_KINDS` (`packages/domain/src/workspace-events.ts`),
  mirrored by a migration-owned catalog the `kind` foreign key references.
- `agent_run_events` is the high-volume per-run journal, read by page
  (`GET …/runs/:runId/event-page`) and streamed per run (`GET …/runs/:runId/events`).

Every mutation writes state, audit rows and events in one immediate SQLite transaction; the
in-process notifier fires after commit and carries no data. Streams re-authenticate on every
iteration without touching the session's last-seen time. Workers wait on workflow changes, with
periodic checks for deadlines and external changes.

**Attention items (ADR-070).** What needs the operator is stored, not re-derived:
`attention_items` holds one row per occurrence of a subject stopped at one operator-owned code.
The storage reports every write to `AttentionProjector`, which re-derives only the affected
worktree, roadmap or finalization just before the transaction commits, so an item opens and
resolves with the state that causes it. The roadmap scheduler syncs the sets it evaluates from
the map (verification setup, checkpoints ready for evidence, held entries) after each pass, and
the storage monitor syncs capacity alerts on its own timer. Resolved items are immutable and
record whether the operator, automation or a new stop resolved them.

`NotificationService` delivers from items only (its storage type has no cycles, roadmaps or
maps): it claims due items with expiring leases and sends one Pushover digest per workspace. A
first push waits a 30-second settle period, a pass of every running controller, and a five-minute
grace while the operator is watching; reminders follow a fixed schedule, and an item that reopens
within ten minutes continues its predecessor's. Every attempt is appended to
`notification_deliveries` (ADR-070; the reminder schedule, kept from ADR-027, is in
[operations.md](operations.md#notifications)).

## Routes and reads

Every API route declares its access (`public`, `session`, `member`, `editor`, `owner`,
`installation`) and, for a command, a tag (`decision`, `control` or `config`) and a body schema
from the contracts; a GET is a `read` (`routes/route-access.ts`, R-I3, R-H5). The daemon refuses
to start on a route without an acceptable declaration. One guard authenticates the caller and
checks a mutation's CSRF token, origin and role before the body is read; then step-up where
required; then the body is parsed with the declared schema, and the handler reads the parsed
value and the caller (`contextOf`). [api-routes.md](api-routes.md) is generated from the route
table (`pnpm routes:inventory`); the route inventory test fails when it differs, and checks
against `fixtures/routes/before-r-h5.json` that no route's access fell and no step-up rule was
lost (see [security.md](security.md#route-access-and-step-up)).

A page reads one answer per region (`services/page-views.ts`, R-D5): a work item's page
(`GET work-items/:id/view`), a run's, a roadmap's. Each region is read in one transaction over one
map snapshot (`services/map-read-snapshot.ts`), which memoizes only within that synchronous pass:
a scope's phase blockers apart from the caller's own resource check (R-D8), receipt currency and
milestone satisfaction are computed once per read, and a roadmap's decision holds build only the
decision briefs they need (`decisionBriefs`, R-D7), not the whole decision inbox.

## Browser

The app has no router library and no data-fetching library. Routes are parsed and built by pure
functions (`apps/web/src/lib/route.ts`); `/` resolves to the last used workspace, and every
workspace page hangs off `/workspaces/:id`. Reads go through a keyed query store
(`lib/query-store.ts`, R-D4): workspace events are invalidation signals only, mapped to the keys
they make stale (`lib/event-invalidations.ts`); only watched keys are re-read, after a debounce
and a maximum wait, and a hidden page defers them. The run page reads the committed events by
page and then follows the live stream from the last sequence.

Requests are sent only from API modules (`lib/<name>-api.ts`, and a decision kind's own
`decisions/<kind>/<kind>-api.ts`), and each decision command is posted from exactly one component
in `decisions/<kind>/` (R-A6); `decisions/boundary.test.ts` enforces both from the syntax trees
and reads the `decision` tags from [api-routes.md](api-routes.md).

What needs the operator comes from one feed, `GET /api/workspaces/:id/attention` (the open
attention items, most blocking first), reloaded on `attention-changed` events; the Needs you
inbox, the rail count, the dashboard, the strip on other pages and each roadmap read it, and no
page derives it from cycle or roadmap state. An inbox item's page renders the decision kinds its
typed code names (`decisions/registry.ts`). The roadmap board and graph draw the daemon's board
read; graphs are laid out by `features/roadmap-board/layered-layout.ts` (ADR-072). No agent
output is ever rendered as markup. Commands on versioned records carry the version they were
shown and are refused when stale; a merge re-checks its gate at exact commits instead. The visual
language, information architecture and per-surface specs are in [ui/README.md](ui/README.md).

## Installation storage and maintenance

`StorageService` owns one installation storage policy (worktree, run and backup roots, cleanup and
backup settings, free-space reserve), per-run directory registrations and database snapshots; SQL
and the online backup API stay in `storage`. The environment roots seed the policy on first start;
later changes affect only future allocations. Cleanup previews are daemon-held capabilities: the
daemon rechecks durable state (terminal runs, a merged and removed worktree, no live siblings) and
filesystem identity before deleting anything, and never follows a browser-supplied path.
Build caches are cleaned after their run ends (a worktree's shared Cargo target once it is
merged or removed and idle), other scratch expires after the retention window, and daily SQLite
backups and a free-space reserve are policy settings (ADR-034, ADR-039; defaults in
[operations.md](operations.md#storage-backups-and-restore)).

## Deploy and the single-daemon lock

Only one process can use a data directory, or an agents' temporary root:
`apps/server/src/instance-lock.ts` takes their locks before anything opens the database. Each is
a socket file the holder publishes in the directory (`state/daemon.lock.<id>`), which a process
in any network namespace finds, and on Linux first an abstract socket, which a crash never leaves
stale; a starter checks again after publishing its own and withdraws if another appeared.
The CLI's migrate and compaction commands take the data directory's lock, and so do
`admin reset-password` and `admin bootstrap` when the database has pending migrations.

`scripts/deploy-daemon.mjs` fetches the requested commit into a bare clone under the deploy root,
builds it into its own release directory, checks the release's migrations against the live
database read-only (a mismatch stops the deploy before anything is switched), asks the running
daemon to drain through a request file, repoints `current` (the systemd user unit's working
directory) in one rename, restarts the unit, and restores the previous release if the health
check fails; `--rollback` returns to the previous release under the same migration check. The
unit and the procedures are in [operations.md](operations.md#deploying-and-rolling-back).
