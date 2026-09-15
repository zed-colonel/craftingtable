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
git         worktree/diff operations and the read-only inspector (depends on domain)
agents      agent backend seam and Claude Code and Codex adapters (depends on domain)
server      Fastify routes, services, composition (depends on all of the above)
web         React projection (depends on domain + contracts only)
```

Only `storage` owns SQL. Only three modules may spawn a process, and
`scripts/check-forbidden-scope.mjs` enforces that list: the Git inspector runner,
the Git operations module, and the shared agent process supervisor. No package depends
on ActionQueue, WorldInterface, Exoskeleton, or any other supervised project.

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
regress a run the operator already cancelled. A daemon restart moves every live run to
`interrupted`.

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
a separate `work_item_completions` row joined on read, so the CT-03 admission-only
trigger on `work_items` stays in force; a completed predecessor unblocks its dependents.

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
`workspace_run_profiles` holds one profile per role (backend, model, permission
posture); `GET/POST /api/workspaces/:id/run-profiles` reads and replaces the set, filling
unsaved roles with the daemon's default backend. The launch form applies the profile of
the selected role, and a handoff opens the same inline form pre-filled from the target
role's profile so the operator can override it per launch. The cycle form seeds its
four step choices from these profiles and stores the operator's chosen settings at start.

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
records without a migration. Waiting turns keep input open while background work remains
uncollected. Review continuations pin the original branch context at reservation and launch,
allowing inspection of untracked test artifacts but rejecting tracked/index edits and changed
commits; ordinary review and final approval remain clean-worktree gates. See ADR-037.

Both adapters use `packages/agents/src/process.ts`; process authority remains three
modules. The daemon selects from a backend registry, defaulting to the first available
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

The CT-04A1 read-only inspector and its repository-evidence persistence remain in the
tree, uncomposed. They are superseded for the working loop by the simpler source
repository model and are candidates for removal.

## Events

Two journals, one notifier:

- `workspace_events` is the coarse workspace journal the browser follows to invalidate
  its queries. Execution adds `source-repository-registered`, `worktree-created`,
  `worktree-removed`, `worktree-merged`, `agent-run-started`,
  `agent-run-status-changed`, `work-item-completed`, and `workspace-updated`.
- `agent_run_events` is the high-volume per-run journal, streamed per run over
  `GET /api/workspaces/:id/runs/:runId/events`.

Every mutation writes state, audit rows, and events in one immediate SQLite transaction;
the in-process notifier fires after commit and carries no data. Streams re-authenticate
on every iteration and never touch the session's last-seen time.

## Browser

The app has no router library and no data-fetching library. Routes are parsed by a pure
function; the projection reducer marks scopes stale on events and the app refetches the
authoritative endpoints. `/` resolves to the last used workspace, `/workspaces` lists
them all, and every workspace page hangs off `/workspaces/:id`. The run page loads the
committed events once and then follows the live stream from the last sequence inside
its own scroll pane. No agent output is ever rendered as markup. The visual language is
in `docs/ui-principles.md`.

The notification service reconciles durable work-item attention into a SQLite outbox,
claims deliveries with expiring leases, and schedules retries and local-time reminders.
It wakes from the workspace notifier and a five-second timer; no browser connection is
required. Pushover sits behind an injectable transport. Settings and workflow/delivery
changes append audit and workspace events in the same transaction; claim bookkeeping is
internal. See ADR-027 for delivery and credential semantics.

## Roadmaps

`RoadmapService` selects eligible entries in one delegated roadmap per workspace and delegates
whole-item execution to `WorkCycleService`. Sequential mode preserves strict order; parallel
mode scans in priority order under dependency, in-flight, repository, and exclusion constraints. Schema 12 separates immutable roadmap
revisions from mutable, versioned control state and independently identified attempts.
Each attempt reserves its worktree and cycle IDs before Git work; cycle creation and
attempt attachment commit together. Branch targets and effective step settings are bound
explicitly. The scheduler calls the shared merge command only under the effective policy
from the attempt's immutable definition revision. See ADR-029 for admission, capacity, recovery,
and manual takeover behavior; ADR-028 preserves the later slice and Studio boundaries.

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
