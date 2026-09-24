# Architecture

CraftingTable is one daemon and one browser app. The daemon owns all state and every
command; the browser is an authenticated projection reconstructed from a durable
snapshot plus an event cursor.

## Packages and dependency direction

```text
domain      pure TypeScript records, branded identifiers, closed vocabularies
contracts   strict Zod HTTP/SSE schemas (depends on domain)
planning    pure plan-bundle parsing, validation, graph, digest (depends on domain)
storage     SQLite, migrations, repositories (depends on domain)
git         worktree, diff and merge operations (depends on domain)
agents      agent backend seam and Claude Code and Codex adapters (depends on domain)
server      Fastify routes, services, composition (depends on all of the above)
web         React projection (depends on domain + contracts only)
```

Only `storage` owns SQL. Only the explicitly listed adapter modules may spawn a process, and
`scripts/check-forbidden-scope.mjs` enforces that list: the Git operations module, the shared agent process supervisor, the pinned Cargo adapter,
and the local-check/act adapter. No package depends
on ActionQueue, WorldInterface, Exoskeleton, or any other supervised project.

### Persisted records

Every record storage keeps has a kind in `packages/storage/src/records.ts` (work cycles,
roadmaps, runs, journal events, evidence and so on). Three rules hold at the storage
boundary:

- **Reads upcast.** Every repository mapper ends in `readRecord`, which applies the kind's
  upcasters, so the rest of the daemon sees one current shape. When a stored shape stops
  matching the current contract, add an upcaster there instead of teaching readers about the
  old shape.
- **Writes are guarded.** Storage hands every record to the `RecordGuard` it was opened with
  before writing it. The daemon opens storage with `openDaemonStorage`, which checks the
  record against its contract schema (`apps/server/src/persisted-records.ts`), so an
  out-of-bounds record fails where it is created, not in a browser response.
- **Contracts match the domain.** Each kind's schema is pinned to the type storage reads with
  `equivalentSchema`, so a field added to a domain type and not to its schema, or the reverse,
  fails `pnpm typecheck`.

`pnpm db:verify <database>` copies a database with the backup API, migrates the copy and checks
every record against its contract, plus the v0.3 map format and SQLite's integrity and
foreign-key checks. Run it on a snapshot before deploying a contract or schema change. Every
test daemon runs the same check on its database at cleanup. A table-rebuild migration needs a
preservation test (`migration-preservation.ts`) and, from schema 28, an in-migration count
guard (ADR-002).

## The execution model

```text
SourceRepository   a registered local checkout (path, default branch, head at registration)
Worktree           a linked worktree on a fresh branch, bound to one work item and repository
AgentRun           one supervised agent session in a worktree: backend, role, permission
                   posture, brief, status, cost, turns, optional parentRunId lineage
AgentRunEvent      the normalized per-run journal: session-started, user-message,
                   assistant-message, tool-call, tool-result, turn-completed, notice,
                   stderr, run-finished
```

Run status: `starting → running ⇄ waiting → finished | failed | cancelled | interrupted`.
Transitions are guarded by expected-status sets so a late process callback can never
regress a run the operator already cancelled. A stop drains live turns for a bounded time and
records the runs it interrupts as `interrupted` with reason `daemon-drain`; after that clean
stop the controller resumes their vendor sessions (ADR-066). A crash leaves live runs
`interrupted` without a reason, for explicit resume.

Roles (`implement`, `review`, `design`) select a brief template. Together with
`parentRunId` they are the composition seam for orchestrated design/implement/review
cycles: an orchestrator chains runs by role and lineage without new vocabulary.

Runs also record model and billing provenance: `resolvedModel` and `billing`
from normalized session metadata and subsequent reported model reroutes, and for review runs a `verdict` parsed
from the final message's `VERDICT:` line.

## Work item lifecycle and the merge gate

```text
proposed ──admit──▶ admitted ──merge or mark complete──▶ completed
```

"In progress" is derived (an active worktree or a live run), not stored. Completion is
a separate `work_item_completions` row joined on read, while schema 17 permits a guarded
return from admitted to proposed; a completed predecessor unblocks its dependents.

A worktree's merge gate is computed from its runs (`mergeGateFor` in the execution
service): mergeable when the most recent run is a successfully finished review with a `mergeable` verdict and
nothing is live. The shared merge command re-evaluates the gate, reserves a durable operation, and merges with a merge
commit into the worktree's recorded integration branch after verifying the review's
source/target commits and worktree version. The Git commit is reconciled into database
completion before worktree and branch cleanup; cleanup can be retried independently. The merge happens in the primary checkout
only when that checkout already has the target checked out; otherwise it runs in a
scratch worktree under the worktree root. See ADR-021.

A run started with `parentRunId` receives a 256 KiB preview of the parent's final
message plus source files materialized from the journal. The handoff manifest identifies
source runs and event cursors, also recorded on the launch message to pin inherited
context; it includes conversations, final messages, and review assessments throughout
the parent lineage. Source text is not clipped to the inline
preview; a handoff exceeding 32 MiB is rejected before launch. Known upstream truncation
is explicitly reported. Parent and child must belong to the same worktree, and a source
turn must stop running before it can be handed off.

Within the brief: an implement run after a review gets the findings to remediate, a review
after an implement run gets the implementation's own summary as a claim to verify, and
an implement run after a design gets the proposal as its accepted plan. The operator
accepts a design by launching that implement run in the manual flow. The automated
cycle accepts it only when its explicit final Open questions section says `none`.
Those edges plus implement-then-review give every step of the loop the same shape.

Which agent runs each step is a workspace setting, not a property of the previous run.
`workspace_run_profiles` holds four default steps and optional specialist overrides (backend,
model and optional Codex effort). Permission postures remain attached to the original step.
`GET/POST /api/workspaces/:id/run-profiles` reads and replaces workspace defaults; legacy
remediation inherits implementation, and absent specialists inherit their base selection.
Launch forms and handoffs pre-fill the target profile. Cycle setup persists its original
profiles, while finalization retains explicit per-stage profiles.

For existing roadmaps, `GET /api/workspaces/:id/roadmaps/agent-profiles` projects current
selections without Git or graph scans. `POST /api/workspaces/:id/roadmaps/:roadmapId/agent-profiles`
appends a version-checked model assignment to roadmap operational state. It requires paused,
draft or needs-attention scheduling and carries entry IDs, backend/model/effort only. It does
not modify the saved definition or acceptance fingerprint. At launch, the daemon resolves the
latest assignment for the owning attempt (including repair attempts), keeps the original step
permissions, and records the purpose and assignment identity on the immutable run. Previously
accepted reviews continue to match their original launch assignment. Browser cycle projections
show future selections without rewriting the durable cycle profiles. See ADR-064.

Review turns also carry a daemon-validated, versioned findings assessment in their
`turn-completed` event. It is reconstructed from the journal after restart without a
new mutable findings table. A complete report is a structurally valid reviewer
assertion, not proof of correctness or prose coverage. The daemon checks verdict
consistency and preserves finding IDs across reports in the explicit parent lineage.
Finalization requires current dispositions for every previously open finding; already closed
findings may be omitted. Their latest valid dispositions are reconstructed from pinned
source events, including reopenings, and materialized separately from active findings.
Invalid reports and implementer claims never close findings. Work-item reports retain the
original all-ID continuity rule. See ADR-035.
An implementer's disposition remains a claim for the next reviewer. A failed or invalid
latest review clears the stored verdict; unstructured legacy reviews may still supply
one for manual operation. See ADR-024.

`WorkCycleService` uses those commands and handoffs to run one admitted, unblocked work
item through design, implementation, and bounded review/remediation. `work_cycles`
stores the fixed completion policy, step profiles, run reservation, and versioned state.
Changes append audit and workspace events; the browser exposes pause/resume/stop and
persistent attention notices. Standalone cycles stop for merge approval; a roadmap may
explicitly delegate integration merges. Interrupted steps require explicit resume. See ADR-025 for completion and recovery rules.
Before automated review, tracked edits and staged additions can be finalized through a
content-bound, durably reserved Git checkpoint. Negative reviews bypass approval cleanliness
checks and carry housekeeping instructions into the same bounded remediation run; positive
reviews retain exact clean-commit gates. Per-run scratch space is passed to both backends.
See ADR-031 for authority, commit recovery, and retained scratch files.

Run detail reads the latest completed turn directly from the persisted event journal. The
browser shows its complete message above activity independently of feed pagination, folds
only an exact validated review-report block into the findings display, and retains the
original final text in a disclosure.

## Agent backend seam

`packages/agents` defines `AgentBackend` (`describe`, `launch`) and `AgentSession`
(`items`, `send`, `end`, `kill`). A backend owns the child process and translates the
vendor's native output into `NormalizedAgentEvent`s; the daemon owns run state, the
journal, audit, and workspace events. Raw vendor lines are retained, bounded, on each
event for diagnostics but are never the durable vocabulary.

The Claude Code adapter launches `claude -p --input-format stream-json
--output-format stream-json` with the brief as the first stdin message, keeps stdin
open for follow-ups, maps the vendor-neutral permission posture to a CLI permission
mode, and terminates the process group on cancel.

The Codex adapter keeps one supervised `codex app-server --stdio` process per run.
An adapter-local RPC client initializes the connection and starts or resumes a thread;
follow-ups steer an active turn or start another turn on the same thread. It drains
accepted input on End, interrupts and terminates on Cancel, and fails closed on protocol
errors or unexpected exits. Completed items become bounded durable events; transient
text/output deltas are not journaled separately. Optional model and token metadata on
turn-completed events remain vendor-neutral and survive replay. Resolved model changes
also update the run projection. Dollar usage is optional and never inferred from tokens.

Claude background-wait expiry and surviving process-group work normalize to an incomplete
exit. The supervisor keeps that run live until the group drains or is terminated at its
deadline; cancellation escalation survives the leader's exit. The daemon journals the
reason, rejects its review authority, and can reserve two same-step continuations with
the original deadline and handoff. Optional cycle JSON and event fields preserve old
records without a migration; shapes that no longer match are brought forward by upcasters
(see "Persisted records"). Waiting turns keep input open while background work remains
uncollected. Review continuations pin the original branch context at reservation and launch,
allowing inspection of untracked test artifacts but rejecting tracked/index edits and changed
commits; ordinary review and final approval remain clean-worktree gates. See ADR-037.

Both adapters use `packages/agents/src/process.ts`; process authority is confined to the
modules listed in `PROCESS_AUTHORITY` in `scripts/check-forbidden-scope.mjs`. The daemon selects from a backend registry, defaulting to the first available
of Claude Code and Codex. No app-server socket is exposed to the browser or LAN.
See ADR-023 for permission mapping, lifecycle and metadata behavior.

## Git boundary

`createGitOperations` covers exactly what the loop needs: inspect a top-level checkout,
create a worktree on a new branch from an exact base revision, remove a worktree, diff a
worktree against its base (commits, per-file status and counts, bounded unified patch
including untracked files), merge a branch into the checked-out branch with a merge
commit (aborting on conflict), and delete a merged branch. Argument arrays only, bounded lifetime and output,
process-group termination, and paths reach Git only as `cwd` or after `--`.

Plan versions have mutable execution settings in `plan_branch_settings`, separate from
immutable imported documents. New worktrees freeze the configured integration target
and its starting commit. Retargeting and integration updates invalidate old reviews;
all manual and automated reviews record source and target commits. Required predecessors'
recorded integration evidence is checked by ancestry. Commands are owner/editor operations;
the shared review-gated merge command advances an integration branch, under explicit
operator action or delegated roadmap policy. See ADR-026 and ADR-033.

The CT-04A1 read-only inspector and its repository registry were removed (R-B8). Their three
empty tables and the journal's `repository-*` event kinds stay in the schema because
`workspace_events` foreign keys reference the tables; nothing writes them.

## Events

Two journals, one notifier with separate activity and workflow wakeups:

- `workspace_events` is the coarse workspace journal the browser follows to invalidate
  its queries. Execution adds `source-repository-registered`, `worktree-created`,
  `worktree-removed`, `worktree-merged`, `agent-run-started`,
  `agent-run-status-changed`, `work-item-completed`, and `workspace-updated`.
- `agent_run_events` is the high-volume per-run journal, streamed per run over
  `GET /api/workspaces/:id/runs/:runId/events`.

Every mutation writes state, audit rows, and events in one immediate SQLite transaction;
the in-process notifier fires after commit and carries no data. Streams re-authenticate
on every iteration and never touch the session's last-seen time.
Run activity wakes streams immediately. Scheduler, cycle and notification workers wait on
workflow changes: turn completion, run status and persisted commands still wake them promptly,
while ordinary messages/tool output do not trigger full map evaluation. Periodic checks remain
for deadlines and external changes. Map projections share memoized repository reads only within
one synchronous read pass; no snapshot survives a mutation or asynchronous execution boundary.
Decision-binding hashes, approved decisions and evidence prerequisite results share that same
read-pass lifetime. Notification delivery wakes neither browser streams nor workflow workers; only
changes to the active attention set and notification settings wake streams.

## Browser

The app has no router library and no data-fetching library. Routes are parsed by a pure
function; the projection reducer marks scopes stale on events and the app refetches the
authoritative endpoints. `/` resolves to the last used workspace, `/workspaces` lists
them all, and every workspace page hangs off `/workspaces/:id`. The run page loads the
committed events once and then follows the live stream from the last sequence inside
its own scroll pane. No agent output is ever rendered as markup. The visual language is
in `docs/ui-principles.md`.

Background invalidations are batched in a bounded window. Same-workspace snapshots do not move
the stream cursor past unread detail invalidations. Recovery panels retain their disclosures and
draft guidance while refreshing; commands wait for current checks and still use daemon versions.
An in-flight recovery command owns its preparation until completion or failure. Scheduling and
notification delivery defer to it; a failed preparation restores the original attention and reminder
schedule. Restart releases this transient ownership without replaying the command.

The cycle controller (`WorkCycleService.reconcile`) decides what a step's run outcome means in
one pure function, `decideStepOutcome` (`services/step-outcome.ts`): it reads facts gathered
from one cycle and run and returns a typed decision, and every stop for the operator carries an
attention code. `reconcile` applies the decision. `replayStepOutcomes` runs the same gatherer
and decision over any database snapshot, which is how controller refactors are checked against
recorded decisions (`pnpm controller:replay`, and a golden test over scenario snapshots). Tests
step the controller with `WorkCycleService.tick()` and `AgentRunService.quiesce()` instead of
waiting on wall-clock time.

Every stop carries typed attention (`packages/domain/src/attention.ts`). A cycle that enters
`needs-attention` or `awaiting-merge`, a roadmap that enters `needs-attention`, and a held entry
declare a code and an owner in the same write; the compiler rejects a stop without one. The
`awaiting-merge` code is the gate (merge approval, merge requirements, final promotion, scope
evidence, controller wait, scheduling held). While automation will act on a stop (a roadmap that
merges automatically, scope recovery, prerequisite work) the controller records that claim and
the stop is controller-owned; the claim lapses when the automation no longer applies. Phase
blockers carry codes too, with the owner and whether the controller waits on them. Reasons and
messages are display text: nothing in the daemon or the browser parses them, which the scope
check enforces. Records written before codes existed are read through
`attention-legacy.ts`, the one place that maps old reason text to codes.

The notification service reconciles durable work-item attention into a SQLite outbox,
claims deliveries with expiring leases, and schedules retries and local-time reminders. It
sends only operator-owned attention as the controller declared it, and roadmap-level waits as
`RoadmapService.attentionAlerts` reports them; it evaluates no scheduling policy itself.
It wakes from the workspace notifier and a five-second timer; no browser connection is
required. Pushover sits behind an injectable transport. A new occurrence waits a 30-second
settle period before its first push, and the claim re-derives attention, so a state the
controller leaves on its own is never sent. Occurrences are keyed by condition (cycle and
status, roadmap and alert class, roadmap entry), not by row version; wording changes update the
text silently, set-valued alerts re-page only when a member is added, and an occurrence that
reopens within ten minutes keeps its reminder schedule. Storage alerts use hysteresis and
coalesce all volumes; work stopped by a daemon restart shares one message per boot. Only a
provider rate limit or rejection holds every alert; transport errors back off per record.
Settings and attention-set changes append audit and workspace events in the same
transaction; each accepted push appends an audit row only, and retries and claims stay in
the outbox row. See ADR-027 for delivery and credential semantics.

## Roadmaps

`RoadmapService` selects eligible entries in one delegated roadmap per workspace and delegates
whole-item or slice execution to `WorkCycleService`. Sequential mode preserves strict order; parallel
mode scans in priority order under dependency, in-flight, repository, and exclusion constraints. Schema 12 separates immutable roadmap
revisions from mutable, versioned control state and independently identified attempts.
Each attempt reserves its worktree and cycle IDs before Git work; cycle creation and
attempt attachment commit together. Branch targets and effective step settings are bound
explicitly. The scheduler calls the shared merge command only under the effective policy
from the attempt's immutable definition revision. See ADR-029 for admission, capacity, recovery,
and manual takeover behavior; ADR-028 preserves the later slice and Studio boundaries.
Before parallel selection the controller reconciles completed attempts, including manual merges
and parent acceptance recorded while paused. Pending cycles within the same running parallel
roadmap follow its saved entry priority rather than cycle creation order. Existing running agents
are never preempted; unrelated/manual cycles retain their relative positions.

Parallel settings and item holds are additive JSON fields in schema 12; older definitions
retain sequential semantics. Attempts reserve capacity before Git creation. The single
scheduler serializes admission, and repository mutation guards serialize daemon creation,
removal, integration updates, and merges. Paused items retain reservations; item attention
does not disable scheduling for siblings. Only a started attempt's own merge releases its
successors. `WorkCycleService` refreshes actively delegated parallel or automatic-integration attempts, with
limits bound to the attempt's immutable revision. It waits for idle sessions, invalidates
review context before Git, and reserves a fresh review after updating. See ADR-030.

## Integration conflict recovery

`WorkCycleService` persists a resolution operation alongside its cycle: detected, preparing,
resolving, committing, completed or abandoned. The Git adapter captures conflict diagnostics,
prepares pinned merges without committing, validates staged resolutions and reconciles exact
reserved merge commits. A dedicated implementation brief changes agent responsibilities to
resolve/stage/verify while leaving commit authority with the daemon. The browser offers
inspection, agent selection, attempt links, guided retry and explicit abandonment. Operations
reserve the worktree durably and take repository/worktree mutation locks only around Git.
Restart pauses without discarding edits or replaying launches. See ADR-032.


## Delegated integration and finalization

Schema 13 adds durable merge reservations and additional protected destinations; optional
roadmap policy fields retain manual defaults for existing definitions. A reservation pins
source, destination, review, authorizer and definition revision. Recovery verifies a unique
commit marker and its exact parents in bounded first-parent history. Completion and audit
are committed before cleanup. Repository/worktree guards serialize mutation; external Git
is detected through commit and cleanliness checks. Automatic conflicts use the existing
bounded resolution workflow and always lead to fresh review.

Schema 14 permits an explicit plan-version subject on worktrees and runs, preserving existing
item history. `FinalizationService` reserves an integration snapshot and candidate worktree,
then delegates assessment/polish/verification rounds to `WorkCycleService`. Whole-plan
artifacts and a complete item inventory supply context; item completion remains independent.
Finalization holds further integration merges and ends with a separate review. Only an
authenticated finalization command approving the exact candidate/destination pair can
promote it. Preparation reservations survive restart and require explicit resume. See ADR-033.
An exhausted finalization can receive an explicit operator grant of extra remediation.
The cycle's additive allowance, consumed attempt, next run reservation and audit event
commit atomically; original settings and cumulative usage remain. See ADR-036.


## Installation storage management

Schema 15 records one installation storage policy, canonical root/device identities, per-run
materialization directories and registered database snapshots. `StorageService` owns filesystem
inventory and maintenance; SQL and the online backup API stay in `storage`. Execution receives
current future-allocation roots through an explicit config view. Existing worktree paths and
integration merge scratch remain stable, and run directories are registered before backend
launch. Worktree preparation recovery blocks incompatible root changes.

Cleanup previews are daemon-held capabilities. Execution records must show a terminal run and
a merged, removed worktree with no live siblings before its scratch can be reclaimed. The daemon
rechecks that state and filesystem identity before deletion. Retention and backup workers restart
from durable records, never from browser-supplied paths. The browser displays measured capacity,
previewed usage, backup coverage and errors. See ADR-034.


Finalization finding decisions are optional durable cycle fields, with attributed audit records.
The controller compares operator-deferred nit snapshots with the current review and exact branch
context before excluding them from the nit count; the raw review report remains unchanged.
Focused remediation carries a selected batch and cumulative allowance. Browser controls submit
IDs and rationale, not edited findings or approval verdicts. See ADR-038 and the
[staged-finalization roadmap](finalization-roadmap.md).

Post-run maintenance derives cache eligibility from durable run status and live siblings.
Agent completion queues cleanup; automation waits only for that worktree's pending cleanup.
The shared mutation guard prevents deletion racing a launch, and the periodic worker retries
and catches up after restart. Backend-provided CARGO_TARGET_DIR keeps future build outputs
inside the registered run scratch. Verification evidence remains outside disposable caches.
See ADR-039.

Finalization recovery can atomically record a backend/model override with its next-run
reservation and any authorized remediation grant. Launch-time profile resolution applies it
through subsequent phases while retaining each original step's permissions. Omitted input
preserves the current override; null restores the original profiles. See ADR-040.

Plan completion is projected from a completed finalization and its worktree's durable merge
record, including promotions recorded before the completion UI existed. Project summaries use
only the active plan version. Optional integration cleanup is reserved with final approval,
then reconciled separately after promotion. Its pending/blocked/removed state survives restart;
explicit cleanup and retries also support older completed finalizations. See ADR-041.


Staged finalization (ADR-042) adds optional stage definitions and progress inside the existing
versioned finalization/cycle records; absence selects the legacy controller. Each stage owns
its profiles, scope, required check names and policy. Stage usage and lifetime totals update
atomically with run reservations. Optional discovery stops for attributed batch selection;
verification retains that batch even across narrower recovery. New required concerns reopen the
relevant whole-plan stage without resetting its allowance, and invalidate final review completion.

`finalization-stage-policy.ts` validates reports independently of their success and guards final
promotion. A separate materialized JSON ledger supplies adopted obligations, evidence provenance,
selected batches and optional follow-ups. Reports can update known obligations by ID; source and
requirement changes require an explicit version-checked operator decision. Conformance checks
require every in-scope obligation, and final review requires all obligations and full checks on
the current candidate. Completed-stage evidence may be reused only at matching commits and inputs
outside final review. Agent journal records retain original reports and audit preserves decisions.

## Package imports and concurrency-map drafts

Schema 16 retains immutable archive provenance, import attempts, concurrency definitions,
plan archive links and binding revisions. `PackageImportService` composes pure bounded
ZIP/schema/graph validation with existing immutable plan import and transactional binding.
It has no Git or agent authority. Importing a map creates no executable roadmap entries;
its UI lives under Roadmaps as an inactive draft. Exact plans/work items/source artifacts
and configured branch versions are recorded explicitly. Live configuration changes produce
binding diagnostics, never implicit rebinding. See ADR-043 and the cross-project roadmap.

Agenda removal is a version-checked, audited command for unstarted items. The shared
work-item eligibility projection checks run/cycle history, active worktrees and delegated
roadmaps; an in-memory preparation guard covers Git worktree creation before its database
row exists. Schema 17 retains imported-field immutability and rejects reversing completed
or started work. Admission/removal events remain durable; no completion evidence is created.


## Execution scopes and parent acceptance

Schema 18 adds immutable scope identity to worktrees and append-only verification/acceptance
receipts. Cycle and roadmap JSON carry the same frozen definition ID, binding revision,
source ID and activity kind. Live cycle uniqueness is per scope; worktree and repository
mutation guards still apply. Missing scope preserves whole-item behavior.

The daemon resolves scope boundaries from the immutable source map and exact binding before
worktree creation, run launch, merge, verification and acceptance. Slice merges do not call
whole-item completion. A separate review worktree inspects the current integration snapshot
for parent acceptance; required slice commits must remain in its ancestry, and all original
predecessors, slice verification and assigned case obligations must be satisfied. Receipt
insertion and parent completion are atomic. Both service and database completion guards
prevent manual completion from bypassing slice acceptance.

Review reports carry scoped evidence; the run's `craftingtable-scope-evidence.json` artifact
retains prior verification references without expanding the brief with full reports. New
workspace events invalidate the affected item when evidence is recorded. Imported map
capabilities not yet supported (checkpoint evidence, phase resources, decision adoption,
qualified reviewers and pinned environments) remain blockers. See ADR-045.


Schema 19 adds durable phase reservations and exact-binding early-development authorizations.
A shared transition evaluator produces dependency/evidence/review/authorization/resource blockers.
Run admission reserves all resources with the run row in one immediate transaction; terminal
supervision releases them in the terminal transaction. Short Git/evidence operations acquire all
claims before entering the repository lane and release them on success or failure. Startup
releases interrupted claims, preserving their history and existing explicit-resume requirements.
Verification/acceptance slots are separate from development; review-only trees do not consume
roadmap repository development capacity. See ADR-046.


Schema 20 separates immutable runtime generations from source maps and bindings. The runtime
service resolves registered Git refs and validates crate mappings; the Git adapter exports
bounded regular files directly from exact objects. The pinned Cargo adapter runs inside the
agent process group, supplies patches at CLI configuration precedence, verifies resolved paths,
and records the command, toolchain, clean tested commit and manifest digest. Sources live in
per-run scratch; the manifest and frozen terminal build records survive cache cleanup.

External evidence packages carry exact scope, generation, tested code, fixture/environment
identity, source-case hashes, logs and reviewer attestations. Authenticated operator decisions
are separate immutable rows. The shared phase evaluator consumes only current accepted evidence;
Git freshness is checked again at launch, integration and acceptance. Qualification acceptance
does not complete parents, adopt decisions or confer local native/Kata execution authority.
The browser provides explicit configuration, templates/uploads, artifact review and build-record
downloads. See ADR-047.

ADR-058 refines reuse to compare exact relevant inputs across immutable generations. A shared
policy compares each bound consumer's upstream source/crate/conformance identities and environment
inputs; unclassified evidence conservatively compares the full stack. Preview projects a candidate
generation without writing it. An explicit digest-checked save creates the generation and durably
queues affected completed independent reviews in one transaction. Existing owning-slice recoveries
retain their round. Resume dispatches queued reviews through the ordinary phase gates after new
saved-plan acceptance; it does not repeat integrated implementation. Receipts retain their original
run/generation/build provenance. This changes no source, repository policy, reviewer or finalization
gate. Per-read input comparisons and run/build lookups use the existing bounded snapshot cache.


Schema 21 adds immutable exact-binding map adoptions. CrossProjectService computes and previews
milestone closure and resolves layered settings into ordinary roadmap entries; it neither invents
plans nor launches agents directly. RoadmapService owns the one workspace delegation and schedules
development, slice-verification and parent-acceptance entries. Read-only entries use WorkCycleService
review supervision with explicit question checkpoints and no implementation transitions. They consume
verification slots independently of development capacity. Scope receipts and target completion recheck
current evidence and delegation; source decisions never substitute for checkpoint evidence. The browser
projects grouped lanes and dependency links while source maps, generations and attempts retain their
original identity. NotificationService aggregates eligible checkpoint attention into its existing outbox.
See ADR-048.

Operator-designated agent reviewer responsibilities are explicit settings, bound to the attempt's
saved revision and recorded on scope receipts. They are responsibilities under the existing trusted
agent model, not authentication of a human maintainer or a sandbox qualification. The exact supervised
review run must match the assigned backend/model/permission profile and report all scope evidence.
Assignments do not bypass resource authorization, native/Kata execution boundaries or checkpoint
attestations; qualified external reviews remain available.


Schema 22 adds immutable map amendment proposals/decisions, retired execution identities and explicit
integration reuse provenance. MapAmendmentService previews exact revisions and coordinates reviewed
plan activation and RoadmapService revision adoption in one transaction. Running sessions retain their
original context; stale reviews are replaced while compatible development remains intact. Full-plan
finalization records an exact map/runtime context and uses RuntimeEvidenceService for dependency
preparation and promotion checks. The ZIP adapter and future Studio share bounded normalized map
validation; authoring remains separate from binding, adoption and execution. See ADR-049.


Baseline preparation (ADR-052) adds an optional durable reservation to a work-item cycle.
It resolves only repositories from the exact map binding, freezes imported application commits and
explicit historical upstream selections, and creates local baseline tags with create-only ref updates.
Source exports use configured storage; per-run copies are regenerated from exact Git objects rather
than trusting an earlier agent's scratch. Historical Cargo uses a separate launcher and receipt format
inside the existing Cargo process adapter. Its results never enter current-runtime build authority.
Restart marks incomplete preparation for explicit retry. No agent or roadmap is resumed by preparation.


ADR-053 derives build applicability from the exact execution scope. Scoped verification preserves
phase/evidence gates and records clean candidate checks separately from current upstream integration.
Historical preparation can supply development dependencies without changing the runtime generation.
The local-check adapter owns bounded repository checks and optional act execution. Per-run policy,
image and dependency identities are frozen in the existing environment manifest and receipt record.
Container cleanup after terminal/restart runs occurs outside SQLite transactions.

Schema 23 adds immutable native execution approvals separately from dependency generations.
RuntimeEvidenceService collects fixed asynchronous host probes and records attributed approval
or revocation. Phase scheduling admits only the supported native resource with current approval;
missing capabilities are actionable while reservations remain ordinary waits. Managed native
checks run through the explicit native-environment/local-check adapters. Frozen run environments
and build receipts retain approval identity; receipt reuse checks revocation and host freshness.
Kata readiness is a separate root-owned infrastructure receipt, not an agent launch adapter.
