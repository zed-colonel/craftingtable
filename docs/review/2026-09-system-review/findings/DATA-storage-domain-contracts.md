# DATA — Persistence, domain model and wire contracts

Reviewer scope: `packages/storage` (migrations, repositories, types), `packages/domain`,
`packages/contracts`, `apps/server/src/routes/*` (route surface), ADR-002, ADR-010, ADR-013,
ADR-017, ADR-034. Review date 2026-09-22, repo HEAD `bf08c0b`.

Method: code reading with file:line citations; live DB read only through
`sqlite3 "file:...craftingtable.sqlite?mode=ro"` and an online `.backup` copy at
`(review-session analysis artifact, not retained)`
(542 MB, taken 2026-09-22 20:22 local). The copy was checked against the current `src`
contracts with a scratch `tsx` script ((review-session analysis script, not retained)) and timed with
(review-session analysis script, not retained). No repository file, the live DB, or the service was modified. No HTTP
endpoint was called.

## Summary

- **94% of the 542 MB database is `agent_run_events`** (508 MB of pages). About **278 MB of that
  is `raw_json`**: vendor lines kept "for diagnostics". Nothing in the server or web ever reads
  them, yet every run page downloads them, which makes each event page about **3.2× larger**
  (6.4 MB instead of 2.0 MB for 500 events). 657 of the stored raw values are not even valid
  JSON (DATA-01).
- **Nothing ever removes data from the journal.** Append-only triggers block any pruning. Busy
  days add 40–60 MB. The 7 daily backups are full copies (264 MB growing to 536 MB in 7 days), so
  every journal byte is kept about 8 times. Tool-call and tool-result payloads (178 MB) are used
  only for display, not for handoffs or review evidence, so they can safely be compacted
  (DATA-02).
- **A strict response schema meets unmigrated old JSON, and that is a live bug.** The very first
  run's `session-started` event has no `billing` field. `runEventEnvelopeSchema` requires one, so
  `GET …/event-page` for that run throws while building the response and the run page shows no
  events. Storage parses every JSON column with a bare `as` cast (29 `JSON.parse` sites, zero
  validation) and has no read-side upgrade step (DATA-03).
- **The big mutable JSON aggregates have outgrown the JSON-in-column pattern.** `WorkCycle` has
  50 top-level fields, 30 of them optional, and about 10 embedded sub-state-machines. It serves
  two entity kinds, and it mixes read-projection fields into the persisted type. `roadmaps.state_json`
  embeds a byte-identical copy of the latest immutable definition (230 KB out of 248 KB) and
  rewrites it on every one of 173 versions. It also keeps append-only histories inside the
  mutable blob (DATA-04, DATA-07).
- **Attention and operator decisions are not stored as records of their own.** Attention is
  re-derived by scanning about 15 sources. Its notification identity is `cycle:<id>:<version>`
  or a hash of free text, and both the web and the server branch on English prefixes of `reason`
  strings. Operator decisions are spread over at least 10 storage locations. This is the
  data-model root of pain point #1 (DATA-05).
- **Confirmed pain point #3 evidence.** 10 phone notifications ("review meets the completion
  policy… ready") went out for states that the daemon itself resolved automatically 1.6–55 s
  later (auto-merge or automatic scope evidence) (DATA-06).
- **Invalidation fan-out.** 21 of 25 workspace-event kinds mark the whole workspace summary
  stale. Each of those refetches **all** cycles (51 today, including completed ones, about
  515 KB+ of JSON), with no filter. 494 of the 792 `notifications-changed` events are internal
  delivery bookkeeping, and each one still triggers that refetch (DATA-08).
- **Dead CT-04A1/A2 code is still wired in.** It is about 6.0k production lines plus about 4.8k
  test lines, with 3 empty tables, 2 always-NULL journal columns, 5 event kinds and 6 audit
  actions that never occur, and one process-authority module. `RepositoryInspectorProvider` is
  still constructed at startup. Setting `CRAFTINGTABLE_GIT_BIN`, which differs by one word from
  the live `CRAFTINGTABLE_GIT_EXECUTABLE`, switches the dead feature on and makes startup fail
  (DATA-09).
- **Contracts are written by hand in parallel with the domain types.** There are 313 exported Zod
  schemas and no compile-time check that `z.infer<schema>` equals the domain interface.
  `WorkCycle` and `workCycleSchema` have changed in 21 and 24 commits respectively (DATA-10).
- **Agent profile shapes have multiplied.** There are 7 near-identical profile or selection types
  (`FinalizationAgentSelection` is identical to `AgentSelection`), stored in at least 12 places
  and resolved in layers at launch (DATA-11).
- **There is no single read model for dependencies plus progress (pain point #2).** Plan
  dependencies, concurrency-map milestones (as `requirements: string[]` plus a free-text
  `status`) and roadmap progress (statuses but no edges) are three separate representations
  (DATA-12).
- **The route surface is 121 routes (50 GET, 71 POST).** Naming is inconsistent; many endpoints
  serve a single panel; 9 panels build API URLs by hand; and the route-inventory "no approve
  route" check only looks at names (DATA-13).
- **Boundary compliance is good.** The domain imports nothing external, production SQL is only in
  `storage`, routes never touch storage directly, and web depends only on domain and contracts
  (Map §7). The remaining gaps are documentation drift and naming (DATA-15).

## Map

### 1. Schema and migrations

- 26 forward-only SQL migrations in `packages/storage/migrations/0001…0026` (2,784 lines), all
  applied to the live DB between 2026-09-04 and 2026-09-22. Runner: `packages/storage/src/migrations.ts`.
  It checks contiguous versions, SHA-256 checksums, and one immediate transaction per file. A
  `-- requires: foreign_keys=off` directive lets a migration rebuild a table
  (`migrations.ts:168-190`).
- Live DB: 60 tables, 146 indexes, 82 triggers (mostly immutability or append-only guards), no
  views, `auto_vacuum=NONE`, page size 4096, 132,522 pages, SQLite 3.53.4.
- Tables by origin: CT-02 foundation (users, workspaces, memberships, sessions, audit_events,
  workspace_events); CT-03 planning (projects, plan_bundles, plan_versions, plan_import_attempts,
  plan_artifacts, plan_import_diagnostics, work_items, work_item_dependencies, plus kind
  catalogs); CT-04A2 repository registry (repository_inspections, registered_repositories,
  project_repository_bindings, all **empty**); execution (source_repositories, worktrees,
  agent_runs, agent_run_events, work_item_completions, workspace_run_profiles, work_cycles,
  plan_branch_settings, work_item_integration_evidence, merge_operations, finalizations);
  notifications; roadmaps plus roadmap_definitions; storage (storage_settings, run_directories,
  storage_backups); package imports and concurrency maps (import_archives,
  archive_import_attempts, concurrency_definitions, concurrency_bindings, plan_archive_links);
  scopes (scope_receipts, phase_reservations, phase_resource_limits,
  scope_scheduling_authorizations); runtime evidence (runtime_generations,
  evidence_submissions, evidence_decisions, run_environments, run_build_records,
  native_verification_approvals); maps (map_adoptions, map_amendments, scope_integration_reuse,
  retired_scope_worktrees, superseded_map_bindings); plan_repository_policies.
- Tables that are empty in the live DB: project_repository_bindings, registered_repositories,
  repository_inspections, map_amendments, retired_scope_worktrees, scope_integration_reuse,
  scope_scheduling_authorizations, superseded_map_bindings, work_item_integration_evidence.

### 2. JSON-in-column state (live sizes, bytes)

| Column | rows | max | avg | total | kind |
|---|---|---|---|---|---|
| agent_run_events.raw_json | 45,231 | 65,564 | 6,140 | 277.8 M | append-only, never read |
| agent_run_events.payload_json | 46,446 | 137,858 | 4,178 | 194.1 M | append-only journal |
| evidence_submissions.record_json | 33 | 519,059 | 151,981 | 5.0 M | immutable (artifacts inline) |
| plan_artifacts.content | 111 | 366,826 | 34,967 | 3.9 M | immutable |
| run_build_records.record_json | 188 | 62,414 | 10,880 | 2.0 M | immutable |
| roadmap_definitions.definition_json | 14 | 230,804 | 143,797 | 2.0 M | immutable revisions |
| import_archives.content | 3 | 667,416 | 540,219 | 1.6 M | immutable ZIP bytes |
| work_cycles.state_json | 51 | 64,935 | 10,114 | 0.52 M | **mutable, versioned** |
| concurrency_definitions.record_json | 1 | 330,608 | — | 0.33 M | immutable |
| roadmaps.state_json | 4 | 248,074 | 65,329 | 0.26 M | **mutable, versioned (v173)** |
| notification_records.state_json | 139 | 1,510 | 878 | 0.12 M | mutable |
| finalizations / merge_operations / plan_repository_policies / storage_settings / notification_settings .state_json | small | | | | mutable |

Mutable versioned blobs: `work_cycles`, `roadmaps`, `finalizations`, `merge_operations`,
`plan_repository_policies`, `storage_settings`, `notification_settings`, `notification_records`.
Integrity comes from `CHECK (json_extract(state_json,'$.x') = column)` constraints that tie the
mirrored columns to the blob. Optimistic concurrency uses a `version` column. Reads are
`JSON.parse(...) as T` with no validation (for example `repositories/execution/work-cycles.ts:11-15`
and `repositories/roadmaps.ts:10-14`).

### 3. Where the 542 MB goes (dbstat)

| Object | bytes |
|---|---|
| agent_run_events (table) | 508.5 M |
| idx_agent_run_events_run + autoindex(id) | 5.0 M |
| agent_runs (briefs 6.4 MB) | 7.7 M |
| evidence_submissions | 5.1 M |
| plan_artifacts | 4.0 M |
| run_build_records | 2.2 M |
| roadmap_definitions | 2.0 M |
| import_archives | 1.6 M |
| workspace_events / audit_events | 1.2 M / 1.1 M |
| everything else | < 5 M |

agent_run_events by kind (payload / raw, MB): tool-result 159.4 / 228.9; tool-call 19.2 / 40.6;
user-message 6.6 / 0; assistant-message 4.1 / 5.4; turn-completed 4.3 / 0.4; notice 0.3 / 2.3.
There are 308 runs, 150 events per run on average, and a maximum of 2,475 events (16 MB) in one
run. Daily growth on active days is 24–61 MB (2026-09-10 to 09-22).

### 4. Domain (`packages/domain`, 4,082 production lines)

- 215 exported types and interfaces, 55 exported `as const` vocabularies, and 137 exported
  functions and constants. The domain is pure: every import is intra-package
  (`scripts/check-forbidden-scope.mjs` enforces `DOMAIN_FORBIDDEN_PATTERNS`).
- Closed vocabularies are moderate in size: AUDIT_ACTIONS 53, WORKSPACE_EVENT_KINDS 25,
  AGENT_RUN_EVENT_KINDS 9, and 3–7 statuses per aggregate. The growth problem is not the size of
  any one enum. It is that each aggregate has its own status set plus a free-text `reason`
  (cycle 6, roadmap 6, entry progress 9, attempt 3, finalization 4, integration resolution 6,
  baseline preparation 3, run 7, work item 3).
- Core aggregates: `WorkCycle` (`work-cycle.ts:101-202`), `Roadmap`/`RoadmapDefinition`/
  `RoadmapAttempt` (`roadmap.ts`), `Finalization` (`finalization.ts`), runtime evidence
  (`runtime-evidence.ts`), and the concurrency map source (`concurrency-source.ts`, which is the
  roadmap/map import format).

### 5. Contracts (`packages/contracts`, 4,818 production lines)

- 313 exported Zod schemas and 154 exported types. Every schema is written by hand in parallel
  with the corresponding domain interface. The server `.parse`s every response and the web
  `request()` parses every response again (`apps/web/src/lib/api-client.ts:40`).
- Largest files: `workspace-event.ts` 659, `execution.ts` 614, `runtime-evidence.ts` 509,
  `work-cycle.ts` 404, `repository.ts` 338 (dead), `roadmap.ts` 311, `planning.ts` 309.

### 6. Routes

121 routes (`apps/server/src/route-inventory.test.ts:9-131`): 50 GET and 71 POST. By prefix:
concurrency-definitions 20 (13 of them `…/runtime/*`, of which 12 POST actions are registered in
a loop with an if-chain, `routes/runtime-evidence.ts:74-200+`), roadmaps 17, work-items 12,
cycles 10, worktrees 7, runs 7, storage 5, others ≤4. Route files total 3,454 lines.

### 7. Boundary compliance (AGENTS.md)

- The domain has no HTTP, React, process or Git imports. CONFIRMED by an import scan (only
  `./*.js` imports).
- Only `storage` depends on `better-sqlite3` (`packages/storage/package.json:16`). The server
  imports it only in tests (for example `server-execution.test.ts`). Routes call services only; a
  grep for `storage.`/`transaction(` in `routes/` finds nothing.
- Web `package.json` depends only on `@craftingtable/contracts` and `@craftingtable/domain`
  (106 and 102 imports).
- `PROCESS_AUTHORITY` (`scripts/check-forbidden-scope.mjs:48-60`) lists 6 modules, including the
  dead inspector's `packages/git/src/command-runner.ts` (see DATA-09 and DATA-15).

## Findings

### DATA-01: `agent_run_events.raw_json` is 278 MB of never-read data that is also shipped to the browser
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence:
  - Sizes: `sum(length(raw_json))` = 277,759,043 bytes versus 194,060,044 for `payload_json`.
    tool-result raw alone is 228.9 MB. Claude's stream-json line holds the tool output once in
    `message.content[].content` and, for 1,464 events, again in `tool_use_result`, so one tool
    output is stored up to three times.
  - Only writers and pass-through, no consumer: `packages/agents/src/bounded.ts:3,25-27`
    (`RAW_LINE_LIMIT_BYTES = 64 KiB`), `apps/server/src/services/agent-run-service.ts:1664`
    (persist), `packages/storage/src/repositories/execution/index.ts:214` (mapped back onto every
    event), `packages/contracts/src/execution.ts:435` (`raw: z.string().optional()` on
    `runEventBaseSchema`). A grep for `.raw` in `apps/web/src` finds nothing, so the web never
    uses it.
  - It goes over the wire in the event page (`routes/agent-runs.ts:107-136`, 500 events per page)
    and in SSE (`routes/agent-runs.ts:260-262`, `JSON.stringify(event)` including `raw`). The run
    page loads **every** page up front (`apps/web/src/App.tsx:611-620`, up to 20 pages).
  - Measured on the largest run (`736446e8…`, 2,475 events): the first 500-event page is
    6,429,795 bytes of JSON with raw and 1,990,140 without (3.2×). The server-side read takes
    12.3 ms versus 7.6 ms. `SELECT *` is used in every journal read
    (`execution/index.ts:608,625,640`), so handoff materialization (`run-handoff.ts:18-38`) and
    `latestOfKind` also pull raw off disk.
  - 657 tool-result raw values (plus 5 others) are invalid JSON because truncation appends a text
    marker (`bounded.ts:14-23`). The column is named `raw_json` but is not JSON.
  - Old noise is also retained: 2,281 `task_progress`, 600 `sleep`, 555 `tool_progress` and 498
    `thinking_tokens` notice events.
- Impact: The DB, its backups and the WAL are about 2× larger than necessary. The run page is
  slower to load and parse. The largest run costs about 16 MB of transfer plus Zod validation in
  the browser. The ADR-level promise that raw lines are "bounded, for diagnostics" has turned
  into "unbounded total, never used".
- Recommendation:
  1. Stop sending raw on the wire now: drop `raw` from `runEventBaseSchema`
     (`contracts/src/execution.ts:435`) and select explicit columns in `listAfter` and
     `latestOfKind`, leaving `raw_json` out. The web does not use it, so this is safe.
  2. Stop persisting raw by default. Keep it only when normalization produced a `notice` with
     category `other` or failed to parse, or behind an opt-in diagnostic flag. Name the field
     `raw` (text), not `raw_json`.
  3. Migration 0027 (forward-only, data-preserving for everything the product uses): move
     existing raw into a separate, prunable `agent_run_event_raw(sequence PK REFERENCES
     agent_run_events, raw TEXT)` table with a retention policy, or simply NULL it. Either way:
     `DROP TRIGGER agent_run_events_no_update`, `UPDATE … SET raw_json = NULL`, then recreate the
     trigger unchanged. Space is not reclaimed until a `VACUUM` (or `VACUUM INTO` plus a swap at
     restart). Add that as an explicit, operator-triggered maintenance action in `StorageService`
     (ADR-034 already owns DB snapshots), because `VACUUM` cannot run inside the migration
     transaction.
  4. Filter handoff reads by kind (`run-handoff.ts:226-233` uses only message kinds), for example
     `listAfter({kinds:[…]})`.
- Effort: M
- Related: DATA-02, DATA-03
- Plan/roadmap format impact: none

### DATA-02: The journal can never be pruned; growth is unbounded and every byte is duplicated about 8× by backups
- Severity: high
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - `agent_run_events_no_update` and `…_no_delete` triggers (live schema). ADR-002 states "expose
    no … deletion/retention API". ADR-034 retention covers per-run scratch and snapshots only.
  - Daily journal growth (payload plus raw), MB: 09-10 46, 09-12 37, 09-13 42, 09-18 61, 09-19 50,
    09-20 59.
  - `storage_backups`: 7 full snapshots on `<backup volume>/database/`, growing
    from 263,766,016 bytes (09-17) to 535,597,056 bytes (09-23). Policy `backupsToKeep: 7,
    dailyBackups: true` (`storage_settings.state_json`).
  - Load-bearing versus display-only kinds: handoffs read only `user-message`,
    `assistant-message` and `turn-completed` (`run-handoff.ts:226-233`) plus `run-finished`
    (`:111`). Review assessments come from `turn-completed` (`:125`). The only server reference to
    `tool-call`/`tool-result` is the ingestion switch (`agent-run-service.ts:1621`). So the
    178 MB of tool-call and tool-result payload is display-only.
  - The run brief is stored twice: `agent_runs.brief` (6.36 MB) and the first `user-message`
    payload (6.63 MB).
- Impact: At the observed rate the DB passes 1 GB within about two weeks of active use and
  backups exceed 7 GB. The DB is copied in full every day. Queries and backups slow down in step,
  and the only way to reclaim space today is manual SQL outside the daemon.
- Recommendation: Define a journal retention tier in ADR-034. Keep forever: `session-started`,
  `user-message`, `assistant-message`, `turn-completed`, `run-finished`, `stderr`. Compactable:
  `tool-call`/`tool-result` payload content (truncate to a preview, for example 2 KB, and set a
  `compacted: true` flag) and `notice` events, for runs whose worktree is merged or removed and
  older than N days. Implement it as a guarded maintenance command. Replace the blanket no-update
  trigger with one that allows only `payload_json` shrinking on compactable kinds when
  `json_extract(NEW.payload_json,'$.compacted')` is true. Consider compressed or incremental
  backups, or keep fewer daily snapshots once the DB is smaller.
- Effort: M
- Related: DATA-01
- Plan/roadmap format impact: none

### DATA-03: A strict response schema combined with no read-side upgrade makes the first run's events unreadable (live bug), and all persisted JSON is read with bare casts
- Severity: high
- Category: bug
- Status: CONFIRMED (code path and live data; the HTTP call itself was not exercised against the live daemon)
- Evidence:
  - Live event `sequence=3`, run `18ac0910-2587-4f7c-969f-cceaf04577e7` (2026-09-04), payload
    `{"backend":"claude-code",…,"cwd":"…"}` with **no `billing`**.
    `packages/contracts/src/execution.ts:447` requires `billing: z.enum(AGENT_BILLING_SOURCES)`.
    Validating all 46,446 live events against the current contract finds exactly this one
    failure ((review-session analysis script, not retained)).
  - `routes/agent-runs.ts:130-134` calls `runEventPageResponseSchema.parse(...)`. The resulting
    ZodError is not mapped in `server.ts:175-205`, so it becomes a 500. The web's page loader
    (`App.tsx:611-631`) then falls into `.catch` and shows 'disconnected' with no events. The SSE
    path parses per event (`agent-runs.ts:260`) and ends the stream at sequence 3 ("run event
    stream failed").
  - Storage never validates JSON on read: 29 `JSON.parse` sites in `packages/storage/src`, all
    cast (`execution/index.ts:207`, `work-cycles.ts:14`, `roadmaps.ts:13`,
    `map-amendments.ts:24-25`, …). Storage has no `zod` dependency. The daemon's policy is
    "Optional cycle JSON and event fields preserve old records without a migration"
    (`docs/architecture.md:161-162`). Old shapes are therefore handled only if every reader
    remembers the optional field, and the response contract is the first place a mismatch shows
    up.
  - Current live aggregates happen to pass: all 51 cycles, 4 roadmaps, 14 definitions and 1
    finalization validate. Nothing enforces that on write, though. Services build objects typed
    against the domain interface, not the contract bounds (for example contract
    `designDependencyContinuations.max(2)` and `integrationResolution.attempts.max(3)` versus
    plain `number` in the domain).
- Impact: Any tightening of a response schema, or any legacy row, can take an entire list
  endpoint down (`GET /cycles`, `GET /roadmaps` return all rows in one parse). The failure
  appears in the browser, not at write time.
- Recommendation:
  1. Immediate fix: make `billing` optional in the event envelope (like `agent_runs.billing`,
     `execution.ts:298`) or default it to `'unknown'` in `mapAgentRunEvent`.
  2. Structural fix: add a small upcaster layer at the storage read boundary per JSON-bearing
     record (`upcastCycle`, `upcastRoadmap`, `upcastRunEventPayload`). It fills defaults for old
     optional fields so downstream code sees one current shape. Pair it with validation on write,
     using the contract schema at the service's single save path (for example
     `WorkCycleService.save`), so out-of-bounds state fails where it is created.
  3. Add a read-only `pnpm db:verify <path>` script, generalizing (review-session analysis script, not retained), that
     validates every persisted aggregate and event against current contracts. Run it against a
     snapshot before deploying a contract change.
  4. Optionally, a per-item `safeParse` in list endpoints that drops or flags invalid items
     instead of failing the whole response.
- Effort: S (bug) / M (upcasters and verify script)
- Related: DATA-04, DATA-10
- Plan/roadmap format impact: none (upcasters must keep accepting every historical saved roadmap definition)

### DATA-04: `WorkCycle` is a 50-field god record with embedded sub-state-machines, two entity kinds and projection fields mixed in
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `packages/domain/src/work-cycle.ts:101-202`: 50 top-level fields, 30 optional. Embedded
    sub-state: `integrationResolution` (6 statuses), `baselinePreparation` (3), `designRecovery`,
    `providerRecovery`, `checkpoint`, `scopeRepair`, `workflow.activeReview`, `designWait`,
    `phaseWait`, `finalizationProgress`, `deferredNits`.
  - Two entity kinds share one record: a work-item cycle, and a finalization cycle
    (`finalizationId`, `planVersionId`, `polishRound`, `polishPhase`, `deferredNits`,
    `findingFocus`, `finalizationAgentOverride`, `finalizationProgress`), separated only by a Zod
    `.refine` (`contracts/src/work-cycle.ts:356-368`) and a SQL CHECK. The live DB has 50
    work-item cycles and 1 finalization cycle.
  - Read-projection fields sit in the persisted type: `nextAgentSelections`, `scopeReviewWait`,
    `mergeRequirementsWait` (`work-cycle.ts:103,115-116`). `WorkCycleService.list` also
    **overwrites the persisted `workflow.questions`** with a derived value
    (`work-cycle-service.ts:154-161`), so one field name has two meanings depending on the read
    path.
  - `list()` computes those projections for **every** cycle, including completed and stopped
    ones: scope waits, merge waits, profile resolution and a `latestOfKind` journal lookup per
    cycle (`work-cycle-service.ts:135-164`).
  - Live key usage: `designRecovery` averages 42 KB when present (up to 60 KB of attachments
    inline). `finalizationProgress` is never populated (the only finalization uses the legacy
    controller), so the staged-finalization branches (53 references to `finalizationProgress`,
    41 to `.stages`) have zero live records.
  - Every change to any sub-state bumps the one `version`, which is also the notification
    identity (DATA-05 and DATA-06).
- Impact: Every new controller feature adds optional fields to one blob. Any read must know every
  historical combination. Optimistic-concurrency conflicts span unrelated sub-states. The
  projection-in-domain mix makes it unclear whether a field is persisted. This underlies the
  controller-sprawl pain point #3.
- Recommendation (target design, staged):
  1. Split the TypeScript type: `WorkCycleRecord` (persisted) versus `WorkCycleView`
     (record + projections). Stop reusing `workflow` for projected questions (name it
     `routedQuestions`).
  2. Move the rarely present, independently versioned sub-states into their own tables keyed by
     cycle id: `cycle_integration_resolutions`, `cycle_design_recoveries` (with attachments as
     rows), `cycle_baseline_preparations`, `cycle_provider_recoveries`. Each has its own status
     column, so each can be queried without parsing the blob. A forward migration copies
     `json_extract(state_json,'$.integrationResolution')` and similar into the new rows, then
     `json_remove`s the keys. Readers go through upcasters (DATA-03) during the transition.
  3. Make the finalization cycle a separate record type (or at least a separate TS type that
     narrows on `finalizationId`).
  4. Decide whether the legacy finalization controller stays: either migrate the one completed
     legacy finalization to a staged shape or keep the legacy path read-only.
- Effort: L
- Related: DATA-03, DATA-05, DATA-06, DATA-10; controller reviewers
- Plan/roadmap format impact: none (internal persistence only)

### DATA-05: Attention and operator decisions are not first-class; identity is keyed on versions or text hashes, and behavior branches on English `reason` prefixes
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - Attention is derived by scanning cycles, worktrees, runs, roadmaps, holds, environment waits,
    checkpoints and storage (`notification-service.ts:208-440`). Source keys:
    `cycle:${id}:${version}` (`:282`), `roadmap:${id}:${version}` (`:434`),
    `roadmap:…:entry:…:${sha256(hold.reason)}` (`:416`), `run:${id}:${seq}` (`:287`). Live:
    115 cycle notification records. One cycle (`10dbc912…`) produced 14 separate records, one per
    even version from 4 to 30.
  - Behavior keyed on reason text:
    - `apps/web/src/features/execution/CyclePanel.tsx:143` checks
      `reason.startsWith('Remediation limit reached.')`, which matches the string produced at
      `work-cycle-service.ts:2150`.
    - `CyclePanel.tsx:156-157` checks `'Two remediation rounds'` and
      `/^(Implementation|Review) needs your input\./`.
    - `features/planning/RoadmapAttention.tsx:5,31` checks `'Daemon restarted.'`, produced at
      `roadmap-service.ts:946`.
    - Server: `work-cycle-service.ts:1642` checks `/needs your input|Workflow report/`.
  - "Waiting or blocked" is represented at least 9 ways on cycles and roadmaps: `status` +
    `reason`, `phaseWait.blockers: PhaseBlocker[]` (`phase-scheduling.ts:2`), `designWait`,
    `scopeReviewWait` (string), `mergeRequirementsWait` (string), `workflow.waiting` (string),
    `workflow.questions: WorkflowQuestion[]`, `entryHolds[entry].reason`, and
    `RoadmapEntryProgress.status` (9 values) + `reason` + `blockers`. Cross-project nodes add
    `blockers: string[]` and a free-text `status` (`contracts/src/cross-project.ts:65-92`).
  - Operator decisions or authority are persisted in at least 10 places: `evidence_decisions`,
    `native_verification_approvals`, `scope_scheduling_authorizations`,
    `map_amendments.decision_json`, `map_adoptions`, cycle JSON (`instructions`,
    `designRecovery.instructions`, `deferredNits`, `additionalRemediationRounds`,
    `finalizationAgentOverride`, `findingFocus`), roadmap JSON (`delegationAssignments`,
    `agentAssignments`, `scopeRecovery`, `entryHolds`, `decisionPreparations`),
    `plan_branch_settings`, `plan_repository_policies`, and `work_item_completions`.
    "Architecture decisions" are rows in `evidence_submissions` (22 of 33 have
    `architectureDecision`). `operatorDecisions()` rebuilds "decisions" from free-text cycle
    `instructions` (`services/operator-decisions.ts:6-43`).
- Impact: This is the data-model root of pain point #1. There is no single inbox query. Every
  new blocker type adds a new derivation, a new UI location and a new notification key.
  Rewording a reason string silently changes UI behavior (whether recovery controls appear).
  Version-keyed identity produces duplicate notifications for one ongoing problem (DATA-06).
- Recommendation: Introduce two small tables, written in the same transaction as the state change
  (ADR-010 pattern):
  - `attention_items(id, workspace_id, subject_kind, subject_id, cause TEXT CHECK IN (…closed
    vocabulary…), required_action TEXT CHECK IN ('answer-question','approve-merge',
    'authorize-remediation','resume-after-restart','provide-evidence','resolve-conflict',…),
    detail_json, opened_at, resolved_at, resolved_by_decision_id)`
  - `operator_decisions(id, workspace_id, subject_kind, subject_id, kind, payload_json,
    actor_user_id, decided_at)`, append-only.

  Controllers open and close attention items explicitly instead of encoding meaning in `reason`.
  Notifications key on `attention_items.id`. The UI renders one inbox and one decision history,
  and replaces the `startsWith` checks with `cause`/`required_action`. Migration: backfill open
  items from current `needs-attention`/`awaiting-merge` cycles and roadmaps, and backfill the
  decision history from existing tables (keep them; the new table references or indexes them)
  so the change is forward-only and loses nothing.
- Effort: L
- Related: DATA-04, DATA-06, DATA-08; UI and controller reviewers (pain points #1 and #3)
- Plan/roadmap format impact: none

### DATA-06: Phone notifications are delivered for attention states the daemon itself resolves seconds later
- Severity: high
- Category: ux
- Status: CONFIRMED
- Evidence: For each cycle notification record, I joined the next `work-cycle-changed` event for
  the same cycle and the matching `audit_events` row. 29 of 115 records were followed by a cycle
  change within 60 s. For **10** of them the change was `actor_kind='system'` and every one of
  the 10 was delivered (`deliveredCount=1`, `firstSentAt` set). Delays were 1.6, 10.2, 17.3,
  20.7, 25.3, 26.6, 26.9, 31.6, 50.9 and 54.8 s. Messages: "Review meets the completion policy…
  Ready…", resolved by "Worktree integrated; cycle complete." (automatic integration merge) or
  "Independent scope evidence recorded; review cycle complete." (automatic scope acceptance). One
  was "…integration changed. Preview dependency refresh", followed 1.6 s later by "Starting a
  fresh independent review". The suppression logic for automatic merges
  (`notification-service.ts:246-272`) re-derives delegation from roadmap status, holds, recovery
  and definition revision, and it misses these cases. The in-memory `cycleTransitioning` guard
  (`:238`) covers only operator-initiated recoveries.
- Impact: This is pain point #3 directly. The operator is paged for work that needs no action,
  which erodes trust in notifications.
- Recommendation: With DATA-05, the controller opens an attention item only for states that
  require the operator, and awaiting-merge under delegated automatic integration never opens one.
  Short of that, keep attention eligibility on an explicit persisted flag on the cycle, set by
  the controller when it parks for the operator (`awaitingOperator: cause`), instead of
  re-deriving delegation in `NotificationService`. As a cheap stop-gap, add a small debounce
  (for example 60–90 s) before the first delivery of `merge`/`attention` records whose cycle
  belongs to a running delegated roadmap.
- Effort: S (debounce) / M (explicit flag) / L (DATA-05)
- Related: DATA-05; controller and notifications reviewer
- Plan/roadmap format impact: none

### DATA-07: The roadmap state blob embeds a copy of the immutable definition and keeps append-only histories inside the mutable blob; revision lookups load every revision
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - `roadmaps.state_json` for `b81d5f92…` is 248,074 bytes at `version=173`. Its keys:
    `definition` 230,804 bytes, `attempts` 9,423 (25), `agentAssignments` 7,231. For all 4
    roadmaps, `state.definition` is byte-identical (as JSON) to the `roadmap_definitions` row at
    the same revision (query in the report notes). Each state save rewrites the whole definition
    (`repositories/roadmaps.ts:33-60`), and the CHECK constraints `json_extract` the 248 KB blob
    four times per write.
  - Nine service call sites load **all** revisions to pick one:
    `tx.roadmaps.history(ws,id).find(d => d.revision === …)` at `map-adoption-policy.ts:59`,
    `checkpoint-candidate-policy.ts:27`, `notification-service.ts:254`,
    `work-cycle-service.ts:3188`, `workflow-policy.ts:27`, and `roadmap-service.ts:1244,1306,1654,
    1742,2187`. `history()` parses 14 definitions of about 143 KB each, measured at 8.9 ms per
    call. The request-scoped `mapReadSnapshot` proxy memo (`map-read-snapshot.ts:15-79`) exists
    largely to hide repeated JSON parsing like this.
  - Append-only arrays (`attempts`, `agentAssignments`, `delegationAssignments`,
    `decisionPreparations`) live inside the mutable blob, so "append-only" is enforced only by
    service code. Attempts grow without bound as scheduling proceeds.
  - The definition denormalizes per-entry settings: 171 entries each carry `profiles` (about
    300 B), `reviewerRoles` (about 310 B), `policy`, `automation` and `executionScope`
    (about 52 KB each of profiles and reviewerRoles). This is the ADR-048 "layered settings
    resolved into ordinary entries".
- Impact: Write amplification (about 43 MB rewritten over 173 saves of one roadmap), avoidable
  CPU on every scheduler, notification and list pass, and weaker integrity guarantees for
  histories that should be immutable.
- Recommendation:
  1. Add `RoadmapRepository.definition(roadmapId, revision)` (PK lookup) and replace the nine
     `history().find` sites.
  2. Forward migration: store `definitionRevision` in `state_json` and remove `definition`
     (`json_remove`). The repository re-hydrates `definition` from `roadmap_definitions` on read,
     so the domain `Roadmap` type and the wire shape stay unchanged at first.
  3. Move `attempts` and the assignment/preparation arrays into `roadmap_attempts` and
     `roadmap_assignments` tables with immutability triggers. Attempts keep an updatable `status`.
  4. Leave the per-entry denormalization in saved definitions as-is. It is the saved roadmap
     format and the source of truth for what the operator adopted.
- Effort: S (1) / M (2–3)
- Related: DATA-04, DATA-08
- Plan/roadmap format impact: none if step 2 re-hydrates. Saved definition JSON is untouched.

### DATA-08: Workspace-event invalidation is coarse, and every invalidation refetches all cycles; delivery bookkeeping is journaled as a workspace event
- Severity: medium
- Category: performance
- Status: CONFIRMED (structure and live counts); the UI slowness magnitude is a HYPOTHESIS
- Evidence:
  - `apps/web/src/lib/workspace-projection.ts:125-207`: 21 of 25 kinds set
    `workspaceSummary: true`. `App.tsx:455-472` then reloads `GET /cycles` on every
    `refreshToken` change. `WorkCycleService.list` returns every cycle for the workspace,
    including completed and stopped ones (`work-cycles.ts:41-55`), and
    `workCyclesResponseSchema` has no `.max()` (`contracts/src/work-cycle.ts:370`). Live: 51 cycles,
    515,827 bytes of state before projections, 10 of them carrying `designRecovery` (up to 60 KB
    each).
  - Live event counts: `agent-run-status-changed` 1,017, `notifications-changed` 792,
    `work-cycle-changed` 558. `notifications-changed` payload actions: delivery 494, attention
    296. Each delivery writes an audit row and a workspace event (`notification-service.ts:637`,
    `journal()` at `:643-676`), although `docs/architecture.md:236-237` says "claim bookkeeping
    is internal".
  - Each workspace event kind has hand-written domain types, Zod envelopes and a storage mapper:
    about 1,950 lines (`domain/src/workspace-events.ts` 517, `contracts/src/workspace-event.ts`
    659, `storage/src/repositories/workspace-events.ts` 768). The browser uses only `kind` and a
    few IDs to decide what to refetch (`workspace-projection.ts:125-207`).
- Impact: Pain point #3 ("UI slowness as page elements react to automated transitions"). Every
  automated step or push delivery makes every open browser re-download and re-validate every
  cycle, and that cost grows with history.
- Recommendation: (a) Give `GET /cycles` `?state=active` or return a compact summary
  (id, status, step, worktreeId, workItemId, attention cause, updatedAt), and load full detail per
  cycle on demand. (b) Map `notifications-changed` to a `notifications` stale scope, not the
  workspace summary. (c) Do not emit a workspace event or audit row for delivery bookkeeping,
  only for attention transitions and settings changes. (d) Longer term, reduce workspace events
  to a generic `{kind, subject ids}` invalidation envelope validated by one schema. Keep the
  journal table and catalogs, since ADR-013 makes them cheap to extend.
- Effort: S (b, c) / M (a, d)
- Related: DATA-05; UI reviewer (refetch model)
- Plan/roadmap format impact: none

### DATA-09: The dead CT-04A1/A2 repository inspector and registry are still compiled, constructed and schema-resident
- Severity: medium
- Category: dead-code
- Status: CONFIRMED
- Evidence:
  - Architecture itself says they are "uncomposed … candidates for removal"
    (`docs/architecture.md:189-191`).
  - Production code (5,972 lines): `packages/git/src/{command-runner,comparison,configuration,
    environment,path-policy,repository-inspector,types}.ts` (2,648 of the 4,402 lines in git),
    `apps/server/src/services/repository-{inspector-provider,observation-adapter,
    observation-policy,observation-port}.ts`,
    `packages/storage/src/repositories/repository-registry/*`,
    `packages/storage/src/repository-types.ts`, `packages/domain/src/repository.ts` (655;
    only 5 status/reason vocabularies are used elsewhere, by workspace-event typing), and
    `packages/contracts/src/repository.ts` (338; 47 exports with no production consumer).
    Tests: about 4,773 lines (git tests other than operations, server `repository-*.test.ts`,
    storage `repository-*.test.ts`, domain and contracts `repository.test.ts`).
  - Still wired in: `composition.ts:121-134` constructs `RepositoryInspectorProvider` and
    returns it (`:331`), but no route or service uses it. `storage.repositoryRegistry` has no
    production reader (grep in `apps/`).
  - Schema residue: `repository_inspections` (6 triggers), `registered_repositories` (4) and
    `project_repository_bindings` (3) are all empty. `workspace_events.repository_inspection_id`
    and `repository_binding_id` are NULL in all 3,289 rows. Event kinds
    `repository-registered/-status-changed/-evidence-changed`, `project-repository-bound/
    -binding-retired` (0 rows) and audit actions `repository.*` (6, 0 rows) are never used.
  - Configuration trap: `config.ts:89-97` enables the dead feature if **any** of
    `CRAFTINGTABLE_GIT_BIN`, `…_GIT_SEARCH_PATH`, `…_ARTIFACT_ROOT`, … is set, then throws unless
    `CRAFTINGTABLE_REPOSITORY_ROOTS` is also set (`:172-176`). The live git override is
    `CRAFTINGTABLE_GIT_EXECUTABLE` (`config.ts:306`, README:502).
  - `PROCESS_AUTHORITY` still grants `packages/git/src/command-runner.ts` spawn authority
    (`scripts/check-forbidden-scope.mjs:55`).
- Impact: About 10.7k lines to keep compiling and testing, a spawn-authority module with no
  purpose, a startup failure one env-var typo away, and a misleading picture of the domain for
  new agents (the vocabulary covers risk signals and environmental baselines that nothing uses).
- Recommendation: Delete the inspector modules, providers, config parsing, registry
  repositories, domain and contract repository modules (keep the few status vocabularies that
  workspace-event typing needs, or drop those kinds from the web union), and their tests. Remove
  `command-runner.ts` from `PROCESS_AUTHORITY`. Migration 0027: `DROP TABLE` the three empty
  tables, guarded by a `CHECK`-row that aborts if any has rows (the 0002 guard pattern). Leave
  the journal columns and catalog rows in place (rebuilding `workspace_events` is the
  highest-risk operation per ADR-013), and just stop mapping the columns. Keep the 0003 and 0004
  migration tests, trimmed to schema preservation only. Mark ADR-017 and ADR-016 as superseded.
- Effort: M
- Related: DATA-15
- Plan/roadmap format impact: none

### DATA-10: Contracts duplicate domain types by hand, with no compile-time equivalence check
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence: `packages/domain/src/work-cycle.ts:101-202` (TS interface) versus
  `packages/contracts/src/work-cycle.ts:199-368` (Zod, the same 50 keys re-declared). The same
  holds for roadmap (`domain/roadmap.ts` versus `contracts/roadmap.ts:143-222`), finalization and
  runtime evidence. A search for `satisfies z.ZodType`, `expectTypeOf` or type-equality helpers in
  contracts finds none. Churn: `domain/work-cycle.ts` 21 commits, `contracts/work-cycle.ts` 24,
  `domain/roadmap.ts` 11, `contracts/roadmap.ts` 12, all in the last three weeks. There are
  already semantic differences: contracts bound values the domain leaves open
  (`designDependencyContinuations.max(2)`, `attempts.max(3)`, `runIds.max(3)`), and one nested
  object is non-strict (`designWait: z.object`, `contracts/work-cycle.ts:253`). The web imports
  domain types (102 imports) for values that were validated by contract schemas.
- Impact: Every new field is written twice, and a drift shows up only at runtime (DATA-03). That
  doubles the review load for each controller change.
- Recommendation: The domain must stay free of dependencies, so keep domain interfaces as the
  source of truth and add type-level equivalence in contracts for persisted and aggregate records,
  for example `type _Check = Assert<Equals<z.infer<typeof workCycleSchema>, WorkCycleView>>`
  (a two-line helper in contracts). Then `pnpm check` fails on drift. Put numeric bounds that are
  real invariants into the domain as named constants shared by the controller and the schema.
- Effort: S–M
- Related: DATA-03, DATA-04
- Plan/roadmap format impact: none

### DATA-11: Agent profile and selection shapes have multiplied and are stored in at least 12 places
- Severity: medium
- Category: simplification
- Status: CONFIRMED
- Evidence:
  - Types: `AgentRunProfile` (`execution.ts:185`), `Omit<AgentRunProfile,'role'>` (used ad hoc in
    about 8 places), `AgentSelection` (`agent-profiles.ts:22`), `FinalizationAgentSelection`
    (`finalization.ts:61`, identical to `AgentSelection`), `AgentSelections`, `CycleProfiles`
    (`work-cycle.ts:32`), and `WorkspaceAgentProfile`. The contracts mirror them:
    `cycleProfileSchema`, `finalizationAgentSelectionSchema`, `agentSelectionSchema`.
  - Stored in: `workspace_run_profiles`, `cycle.profiles`, `roadmap entry.profiles` (×171 per
    definition), `roadmap.agentAssignments`, `roadmap automation.resolutionProfile`,
    `cycle.finalizationAgentOverride`, finalization stage profiles,
    `integrationResolution.profile`, `providerRecovery.profile`, `designRecovery.profile`,
    `decisionPreparation.profile`, and `agent_runs.profile_selection_json`. Launch resolves them
    in layers (ADR-040, ADR-064; `profileForPurpose`, `effectiveCycleProfiles`).
- Impact: Answering "which model will run next, and why" needs knowledge of 12 sources. That is
  error-prone and hard to show in one place.
- Recommendation: Collapse to `AgentSelection` (backend, model, effort) plus `PermissionMode`
  owned by the step. Delete `FinalizationAgentSelection`. Route every launch through one pure
  `resolveAgent(context) → {selection, source}` that records its `source` (already partly done
  in `profile_selection_json`). Longer term, store overrides in one `agent_assignments(scope_kind,
  scope_id, purpose, selection, applied_at, applied_by)` table instead of five JSON locations.
- Effort: M
- Related: DATA-04, DATA-07
- Plan/roadmap format impact: saved roadmap definitions keep `entries[].profiles`. Resolution can
  read them as the lowest layer.

### DATA-12: No unified dependency and progress read model (data side of pain point #2)
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence: There are three separate graph representations:
  - Plan dependencies: `work_item_dependencies` (236 rows), exposed per item as
    `requiredPredecessors`/`recommendedPredecessors`/`dependents`
    (`contracts/src/planning.ts:228-230`). There is no whole-plan edge list endpoint.
  - Concurrency-map milestones: `crossProjectViewSchema.nodes[]` with `requirements: string[]`
    milestone keys, `blockers: string[]`, and free-text `state`/`status`
    (`contracts/src/cross-project.ts:65-92`). The status string embeds `cycle.reason`
    (`cross-project-service.ts:199-201,214-221`).
  - Roadmap progress: `roadmapViewSchema.progress[]` has statuses and blockers but **no edges**
    (`contracts/roadmap.ts:223-257`).

  The snapshot is explicitly edge-free (`contracts/src/snapshot.ts:14-15`).
- Impact: The browser cannot draw activity together with relationships without joining three
  endpoints and parsing strings. This is why the operator works out dependencies by hand.
- Recommendation: Add one server-side read model, `GET /api/workspaces/:id/progress-graph?scope=
  plan|roadmap|map`, with typed nodes `{key, kind: work-item|slice|checkpoint|entry, title,
  state (closed enum), activity {cycleId, step, runStatus}, attentionItemId?}` and edges
  `{from, to, kind: requires|recommended|milestone, satisfied}`. Build it from existing tables
  and the pure `planning` graph and `concurrency-graph.ts`. No schema or format change is needed.
  It is also the natural home for the DATA-05 attention references.
- Effort: M
- Related: DATA-05; UI reviewer
- Plan/roadmap format impact: none (read-only projection of existing plan and map data)

### DATA-13: The route surface has grown by accretion (121 routes); naming is inconsistent, endpoints are panel-specific, and the "forbidden fragment" guard only checks names
- Severity: low
- Category: simplification
- Status: CONFIRMED
- Evidence:
  - `route-inventory.test.ts:9-131`: 121 routes. Roadmaps alone has 10 POST commands on one
    resource, each a version-checked patch of roadmap state: save, control, scope-recovery,
    delegation, agent-profiles, capacity, prepare-decision, amendments, amendments/preview and
    amendments/decision. Three GETs exist for single panels: `roadmaps/agent-profiles`,
    `roadmaps/capacities` and `roadmaps/:id/decision-preparations`.
  - Naming: `plans/:planVersionId/finalizations` versus
    `plan-versions/:planVersionId/branch-settings`; `concurrency-definitions/:id` versus
    `roadmaps/:roadmapId`; four import prefixes (`plan-imports`, `plan-archives`,
    `concurrency-imports`, `import-archives`).
  - `routes/runtime-evidence.ts:74-200+` registers 12 POST actions in a `for` loop that dispatches
    through an `if` chain, each with its own error message.
  - 9 panels build URLs by hand instead of going through `lib/*-api.ts`
    (`RoadmapDelegationPanel.tsx:62`, `DecisionPreparationPanel.tsx:33`,
    `HostSchedulingPanel.tsx:42`, `RoadmapAgentProfilesPanel.tsx:45,80`,
    `MapAmendmentPanel.tsx:31`, `RoadmapCapacityPanel.tsx:29`, `RuntimeEvidencePanel.tsx:46`,
    `CheckpointRecoveryPanel.tsx:24`, `SharedDecisionInbox.tsx:102`).
  - `FORBIDDEN_ROUTE_FRAGMENTS = ['exec/','command','shell','approve']` (`:138`) is purely
    lexical. Approvals happen at `…/runtime/authorize-native`, `…/runtime/decide`,
    `…/amendments/decision`, and through the body action `approve-plan-change` on
    `finalizations/:id/control` (`contracts/src/finalization.ts`). The allowlist test itself is
    useful. The fragment test gives a false sense of a boundary, which runs against the operator's
    stated preference for structural boundaries.
- Impact: Every feature adds endpoints and ad hoc panel fetches, which feeds the "many paths to
  the same place" UI problem (pain point #1).
- Recommendation: Keep the allowlist. Replace the fragment test with a structural rule: every
  POST handler must go through `authorizeMutation` and a Zod request schema (assert it in the
  test by introspecting route options), and document which routes carry operator authority. Fold
  roadmap reads into `GET /roadmaps/:id` (view + capacities + agents + preparations), fold the
  roadmap patch commands into the existing `/control` discriminated union, and settle on
  `plan-versions`. Route every browser call through `lib/*-api.ts`. After DATA-05, one
  `POST /attention/:id/resolve` could replace several recovery endpoints.
- Effort: M
- Related: DATA-05, DATA-12; UI reviewer
- Plan/roadmap format impact: none

### DATA-14: Table-rebuild migrations lack preservation tests; the runner's FK-off directive contradicts ADR-002
- Severity: low
- Category: testing
- Status: CONFIRMED
- Evidence: Rebuilds happen in `0007` (agent_runs), `0014` (worktrees, agent_runs, work_cycles;
  `0014-plan-finalizations.sql:35-134`) and `0026` (workspace_run_profiles). Dedicated
  preservation tests exist only for 0002, 0003, 0004, 0007 and 0026
  (`migrations.test.ts:73,232`). There is no test that seeds schema-13 rows and checks 0014
  preserved them. Unlike 0002, 0014 has no in-migration count guard. ADR-002 says "`PRAGMA
  foreign_keys` is a no-op inside a transaction … none is possible", but `migrations.ts:168-190`
  implements `-- requires: foreign_keys=off` with a post-check `foreign_key_check`, which is
  good but undocumented.
- Impact: The riskiest future migrations (DATA-01, DATA-04, DATA-07) have no template to follow.
- Recommendation: Add a generic "seed at N-1, migrate, compare row counts and hashes per table"
  test helper, and require the 0002-style guard row in every rebuild migration. Amend ADR-002 to
  describe the directive.
- Effort: S
- Related: DATA-01, DATA-04, DATA-07, DATA-09
- Plan/roadmap format impact: none

### DATA-15: Documentation and vocabulary drift (ADRs, process authority, branded IDs, exports, plan-specific literals)
- Severity: low
- Category: docs
- Status: CONFIRMED
- Evidence:
  - ADR filenames are inconsistent: `docs/decisions/033…050-*.md` and `057-*.md` lack the `ADR-`
    prefix that 001–032 and 051–065 use.
  - `docs/architecture.md:20-23` lists 5 spawn-authority modules and `:167` says "process
    authority remains three modules". `PROCESS_AUTHORITY` has 6 (it adds
    `packages/agents/src/native-environment.ts`).
  - ADR-017 is still "accepted" although it is superseded.
  - Branded IDs are used unevenly: `roadmapId`, `cycleId`, `runId`, `worktreeId` and
    `definitionId` appear as plain `string` in newer domain modules (for example
    `readonly runId: string` ×4 and `worktreeId: string` ×2, while `ids.ts` defines 21 branded
    types).
  - About 250 exported symbols in domain, contracts and storage have no production consumer
    outside their own file (crude grep; 47 in `contracts/src/repository.ts` alone).
  - The generic runtime-evidence contract hard-codes one map's checkpoint ID:
    `checkpoint: z.literal('STACK-PLAN-ACCEPTED')` (`contracts/src/runtime-evidence.ts:426`,
    `services/plan-acceptance-policy.ts:14`).
  - `RUN_EVENT_PAGE_LIMIT = 20` (`App.tsx:145`) silently caps the run page at 10,000 events.
- Impact: New agents are misled, and there are small correctness traps (a map whose plan
  checkpoint has a different name cannot use plan acceptance).
- Recommendation: Rename the ADR files. Regenerate the architecture process-authority paragraph
  from `PROCESS_AUTHORITY`. Mark ADR-016 and ADR-017 superseded. Brand the remaining IDs
  opportunistically. Make the plan-acceptance checkpoint ID come from the map (or document it as
  a required reserved ID in the map format). Show a "history truncated" notice on the run page.
- Effort: S
- Related: DATA-09
- Plan/roadmap format impact: the STACK-PLAN-ACCEPTED literal is effectively part of the current
  map format. Any change must keep existing maps that use that ID valid.

## Remediation direction

**Sequence (each step ships independently and keeps all data):**

1. **Quick wins (S, days):**
   - Fix the `billing` event bug (DATA-03.1).
   - Drop `raw` from the wire and from default `SELECT`s (DATA-01.1).
   - Stop journaling notification delivery as workspace events, and map `notifications-changed`
     to a narrow scope (DATA-08 b, c).
   - Add `RoadmapRepository.definition(id, revision)` (DATA-07.1).
   - Add a notification debounce for delegated roadmaps (DATA-06 stop-gap).
   - Fix documentation drift (DATA-15).
2. **Stop the bleeding on size (M):**
   - Stop persisting raw by default.
   - Migration 0027 moves or NULLs existing raw (drop trigger, update, recreate trigger).
   - Add an operator-triggered VACUUM/compaction maintenance action in `StorageService`.
   - Add a journal retention tier for display-only tool events (DATA-01, DATA-02).
   - Expected result: the DB shrinks from about 540 MB to about 250 MB immediately, and to well
     under 100 MB after tool-payload compaction of merged runs. Backups shrink in proportion.
3. **Safety net before the structural work (S–M):**
   - Upcasters at the storage read boundary and write-time contract validation at each
     aggregate's single save path.
   - A `pnpm db:verify` script run against a snapshot.
   - Type-equivalence assertions between domain and contracts (DATA-03, DATA-10).
   - The generic migration-preservation test harness (DATA-14).
4. **Remove dead weight (M):** delete the CT-04A1/A2 inspector and registry stack and drop the
   three empty tables (DATA-09).
5. **Model the operator loop explicitly (L):**
   - `attention_items` and `operator_decisions` tables, written transactionally by controllers.
   - Notifications keyed on attention IDs.
   - UI inbox driven by `cause`/`required_action` instead of reason prefixes (DATA-05, DATA-06).
   - The progress-graph read model referencing attention items (DATA-12).

   Together these address pain points #1–#3 at the data layer.
6. **Slim the aggregates (L):**
   - Roadmap state references its definition revision instead of embedding it.
   - Attempts and assignments move to tables (DATA-07).
   - `WorkCycle` splits into a record and a view, with sub-state tables for integration
     resolution, design recovery, baseline preparation and provider recovery, and a separate
     finalization-cycle type (DATA-04).
   - One profile-resolution function and store (DATA-11).
   - Consolidate routes and panel fetches around these read models (DATA-13).

**Target design:** narrow mutable JSON aggregates (`status`, `step`, small settings) with a
version; child tables for sub-state and histories; immutable definitions referenced by revision;
first-class attention and decision records as the only source for notifications and the operator
inbox; a journal whose permanent tier is messages and turn results, while diagnostics and tool
payloads are compactable; contracts verified against domain types at compile time; and every
persisted JSON shape upcast on read. The import formats (plan bundles and concurrency-map ZIPs)
and saved roadmap definitions stay exactly as they are. Every step is a projection or storage
refactor underneath them.
