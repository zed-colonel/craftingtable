# Review: agent backends, process supervision, Git operations, build/verification adapters, security

Reviewer scope: `packages/agents`, `packages/git`, the Cargo, local-check/act and native adapters, the launch and supervision side of `agent-run-service.ts`, `brief.ts`, `run-handoff.ts`, `auth-service.ts`, `server.ts`, `docs/security.md`, and ADR-007/009/016/020/022/023/031/032/037/054/062.

The review was read-only and was done at commit `bf08c0b` on 2026-09-22. Live facts come from read-only queries against `~/.local/share/craftingtable/state/craftingtable.sqlite` (308 agent runs, 46,446 run events) and from read-only inspection of `~/.local/share/craftingtable/runs/`, which is a symlink to `<runs volume>/runs`.

Prefixes: AGT = agents and process, GIT = Git, SEC = security. AGT-50 and above cover briefs and failure classification.

## Summary

- **The backend seam holds up for CLI agents, but the adapters carry build-system and controller knowledge.**
  - Both adapters inject `CARGO_TARGET_DIR` themselves (AGT-04).
  - Backend capability differences such as reasoning effort are branched on `backend === 'codex'` in about 15 places, 7 of them in web components (AGT-10).
  - The backend kind is a closed SQL `CHECK` in five migrations.
  - Adding a third CLI agent is feasible. A persistent Hermes/OpenClaw-style agent does not fit the one-process-per-run `launch()` model (AGT-11).
- **Supervision has one real process-leak path.** If the run consumer throws, the run is marked `failed` and dropped from the live map, but the agent process group is never killed (AGT-01). Separately, restart recovery depends entirely on systemd's cgroup kill; no pid or pgid is persisted (AGT-02).
- **`raw_json` is roughly half of the 517 MB database and is also sent to the browser.**
  - Event `raw_json` holds 265 MB against 185 MB of normalized payload.
  - For Codex, "raw" is a re-serialized notification, and the same completed item is duplicated onto both the tool-call and tool-result events.
  - The contract ships `raw` to the browser on every event page and SSE frame, and nothing in the web app reads it (AGT-03).
- **Every run cold-builds Rust from scratch.**
  - Each run gets a fresh `CARGO_TARGET_DIR` under its scratch directory, which is deleted when the run ends.
  - Audit shows 101 cache removals totalling 768 GB in 10 days, averaging 7.8 GB and peaking at 131 GB per run.
  - This is a large hidden time and I/O cost per design, implement and review step (AGT-05).
- **A benign Codex item type blocks automatic provider retry.** Codex `sleep` items (600 events across 71 runs) hit the "unknown item" branch, which sets `unsafeContinuation`. Any provider failure in that turn then becomes not-safe-to-retry, which silently defeats ADR-062 (AGT-06). Unknown vendor subtypes also become thousands of notice events, each carrying raw (AGT-07).
- **Verification evidence is agent-forgeable, and verification is Rust-only.**
  - Build, check, CI and native receipts are appended by launchers running inside the agent's own process tree, into a directory the agent can write (SEC-01).
  - Verification exists only for Cargo; there is no generic adapter (AGT-08).
  - ct-check timeouts kill only the direct child (AGT-09).
- **`launchAuthorized` in `agent-run-service.ts:503-1282` is a single ~780-line function.** It mixes authorization, Git preflight, file materialization, brief composition (part in `brief.ts`, part inline at `:1039-1068`), environment preparation and bookkeeping. It writes run directories before the run row exists, which already left an orphan directory (AGT-12). Manual launches also allow two live agents in the same worktree (AGT-13).
- **Operator configuration leaks into supervised runs.**
  - Claude runs inherit the operator's `~/.claude` hooks, plugins, skills, auto-memory and global CLAUDE.md. Live runs invoked `superpowers:*` and `code-review` skills.
  - Codex runs inherit `~/.codex/config.toml` plugins and MCP servers.
  - Every agent also inherits the daemon's whole desktop environment: DBUS, WAYLAND, HYPRLAND (AGT-14, SEC-02).
- **Git has two issues that can lose or strand work.**
  - "Remove worktree" force-deletes uncommitted and untracked work with no confirmation (GIT-02).
  - A merge that times out in the primary checkout is never aborted (GIT-01).
  - About 7–8k lines of the CT-04A1 inspector are dead but still composed and configurable, and setting a dead config key crashes startup (GIT-04).
- **Security basics (CSRF, origin, SameSite, digest-only session tokens) are sound, but structurally fragile.**
  - Every route handler must remember its own auth call (SEC-05).
  - Login has no rate limit, sessions have no idle expiry, and there is no step-up authentication for `unrestricted` runs or promotion (SEC-04).
  - Daemon-side Git runs repository-controlled hooks and fsmonitor (SEC-03, GIT-08).
- **Per-event writes block the event loop.** Each normalized event is its own `synchronous=FULL` SQLite transaction plus a notifier wake on the main event loop, with no batching. This is a plausible contributor to the operator's UI-slowness complaint (AGT-15, HYPOTHESIS on magnitude).
- **Briefs and failure data:** see AGT-50 and above.

## Map

### packages/agents (5.0k lines including tests)

| File | Lines | Responsibility |
|---|---|---|
| `src/index.ts` | 132 | The seam: `AgentBackend {kind, describe(), launch(request)}` and `AgentSession {items, send, end, kill, pid, backgroundWorkPending}`. `AgentLaunchRequest` carries cwd, prompt, permissionMode, model, reasoningEffort, readOnly, `buildEnvironment{binDirectory,namespace}`, `temporaryDirectory`, `deadlineAt`, `additionalDirectories`, resume id, budget and session name. |
| `src/process.ts` | 274 | The only agent spawn point. `detached:true` (own process group), `shell:false`. Splits stdout into lines with a per-line byte cap (4 MiB from the adapters), passes stderr chunks through, and escalates SIGTERM to SIGKILL on the group. Keeps the session "live" after the leader exits while the process group still has members (a `/proc` scan every 500 ms) until the deadline. Uses an unbounded `AsyncQueue`. |
| `src/bounded.ts` | 49 | Byte caps: raw line 64 KiB, tool input 16 KiB, tool result 32 KiB, message 256 KiB. |
| `claude-code/arguments.ts` | 73 | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompts none`, plus the posture flags: `acceptEdits`, `auto`, or `bypassPermissions --dangerously-skip-permissions`. Read-only uses `--restricted --tools Read,Glob,Grep --strict-mcp-config --permission-mode dontAsk`. Also `--add-dir`, `--resume`, `--max-budget-usd`, `--name`. All flags were verified against the installed `claude` 2.1.280. |
| `claude-code/backend.ts` | 211 | Resolves the executable, builds the environment (daemon env + PATH shim + CARGO_TARGET_DIR/TMPDIR), writes the prompt to stdin, buffers stderr into ≥8 KiB events, and maps exit to a background-work reason. |
| `claude-code/normalize.ts` | 447 | stream-json to normalized events. Tracks background tasks, pending tools and interactive requests. Derives `providerFailure` from the `assistant.error` discriminant (ADR-062). |
| `codex/session.ts` | 400 | One `codex app-server --stdio` process per run: JSON-RPC initialize, `account/read`, `thread/start` or `thread/resume`, `turn/start` or `turn/steer`, interrupt then terminate. Declines approval requests. Each stderr chunk becomes an event (8 KiB cap). |
| `codex/normalize.ts` | 290 | Only completed items become events. Accumulates token usage, computes `unsafeContinuation` and provider failure. |
| `codex/rpc.ts` | 75 | Request/response correlation with timeouts. |
| `codex/arguments.ts` | 49 | Thread and turn sandbox/approval parameters (`workspace-write`, `network_access:false`, `on-request` + `auto_review` for auto). |
| `codex/provider-failure.ts` | 43 | Maps structured `CodexErrorInfo` to a `ProviderFailure`. |
| `pinned-cargo.ts` | 440 | Writes the controller launcher `bin/cargo` (a node shebang script) plus the manifest. The launcher runs inside the agent's process tree, checks the resolved `cargo metadata` graph against the pins, runs cargo, and appends a receipt to `dependencies/build-receipts.jsonl`. Also contains the historical baseline launcher. |
| `local-check.ts` | 431 | Launchers `ct-check` (any argv, with a receipt), `ct-act` (act/rootless Docker, pinned image, per-run labels) and `ct-native` (a transient `systemd-run --user` unit with CPU/memory/tasks/runtime limits). Receipts go to the same JSONL file. Also cleans up CI containers and native units. |
| `native-environment.ts` | 184 | Fixed host probes (`~/.cargo/bin/cargo`, rustc, systemd-run), the host digest and the native unit arguments. |
| `local-toolchain.ts` | 50 | `observeRustToolchain` through `process.ts`. |

Process authority, enforced by `scripts/check-forbidden-scope.mjs` `PROCESS_AUTHORITY`, covers 6 modules: native-environment, local-check, git command-runner, git operations, agents process, pinned-cargo. The enforcement is an import scan. `docs/architecture.md:167` still says "three modules".

### Server launch and supervision (`apps/server/src/services/agent-run-service.ts`, 1860 lines)

- `start` and `startForCycle` lead to `launchAuthorized` (`:503-1282`):
  1. authorization and scope checks;
  2. `mutations.during(worktree)`;
  3. Git preflight and review branch context;
  4. `runDirectory = runsRoot/<runId>` with `scratch/`, `plan/*` (plan artifacts plus up to about 8 `craftingtable-*.json` controller documents), `handoff/` and `dependencies/` (the pinned launchers);
  5. `composeBrief` (`brief.ts`, 384 lines) plus inline Cargo, native and historical text (`:1039-1068`);
  6. `brief.md` is written;
  7. a transaction inserts the run, audit and workspace event;
  8. `backend.launch`;
  9. `consume()`.
- `consume` (`:1537-1648`): each item leads to `appendEvent` (one SQLite transaction, then `notifier.notify`) and `transition`. Review turns are assessed synchronously. On exit it calls `finalize()`, which releases the phase reservation, freezes build receipts, writes `run-finished`, audit and the status event, then schedules runtime-evidence cleanup and build-cache cleanup.
- Deadlines:
  - Cycle steps are enforced by the work-cycle loop (`work-cycle-service.ts:1785`), which calls `finishCycleTurn(cancel)`.
  - Decision preparation uses a per-run timer.
  - Manual runs have no deadline, apart from the 30-minute post-exit drain.
- `recoverInterrupted` marks every live row `interrupted` at startup. `shutdown()` kills every live session and waits up to 10 s. It is called from the Fastify `onClose` hook in `routes/agent-runs.ts:51-57`.
- Backends are composed in `composition.ts:145-171`: a `Map<'claude-code'|'codex', AgentBackend>` built from executables resolved on PATH.

### Git (`packages/git`)

Summary of the Git sub-review:

- **`operations.ts` (1754 lines)** is the live module: one factory returning a 24-method `GitOperations`. It covers:
  - worktree create, remove and diff;
  - merge in the primary checkout or in a scratch worktree, with marker-commit recovery;
  - safe branch delete and worktree update;
  - ADR-031 checkpoint commits and the ADR-032 conflict-resolution flow;
  - `exportCommit` (the whole tree in memory, used for Cargo pinning);
  - baseline tags.
- Every Git call goes through its own `run()`: argument arrays, its own process group, SIGTERM then SIGKILL after 1 s, 60 s timeout, 16 MiB output cap, none of which are configurable.
- Server-side serialization:
  - `BranchService.duringMerge` is an in-memory set keyed by repository path.
  - `WorktreeMutationGuard` (25 lines) is in memory per worktree.
  - `merge_operations` rows plus the `CraftingTable integration merge <uuid>` marker commit give restart recovery.
  - `recoverMergeScratch` recovers scratch worktrees.
- **The CT-04A1 inspector is dead.** It comprises `repository-inspector.ts`, `path-policy.ts`, `command-runner.ts`, `configuration.ts`, `comparison.ts` and `types.ts` (about 2.5k lines, plus about 2.1k test lines), about 1.16k server lines, a 974-line storage registry and three empty tables. It is built in `composition.ts:122-131`, but only tests read it.
- Live state is healthy: 15 active worktrees match `git worktree list`, no scratch worktrees are left over, and all 29 merges are cleaned.

### Security surface

- **Deployment.** A systemd user unit runs `pnpm start`, which is `tsx src/index.ts` from the live checkout. It binds `127.0.0.1:4600`, fronted by `tailscale serve` HTTPS. `EnvironmentFile` holds non-secret settings. The unit uses default `KillMode=control-group`.
- **Auth.** Argon2id, session-token SHA-256 digests, a per-session CSRF token, an exact-match origin policy and a `Sec-Fetch-Site` check. Each handler calls `authenticate` or `authorizeMutation` itself; there is no global hook. SSE streams re-authenticate on every loop.
- **Pushover.** Credentials are write-only through the API and stored in plaintext in `notification_settings`. The transport is well bounded.
- **Agent environment.** Agents inherit the daemon's full `process.env`. Only ct-native (`env -i`) and ct-act use a minimal environment.

## Findings

### AGT-01: A supervision failure leaves the agent process running while the run is marked failed
- Severity: high
- Category: reliability
- Status: CONFIRMED (code path). No live occurrence: 0 runs carry "Run supervision failed".
- Evidence:
  - `agent-run-service.ts:1273-1279`: `liveRun.done = this.consume(liveRun).catch(... this.finalize(workspaceId, runId, 'failed', { message: 'Run supervision failed' }))`. There is no `liveRun.session.kill()`.
  - `finalize` (`:1724-1810`) removes the run from `this.live` (`:1739`).
  - After that, `cancel()` (`:1381-1411`) cannot reach the session (`liveRun === undefined`). It only finalizes the already-terminal row and returns `accepted:false`.
  - `requireNoBackgroundWork` (`:463-481`) only inspects `this.live`, so the worktree looks free.
  - `consume` can throw on any of these:
    - a storage write failure (disk full on `<runs volume>`, a CHECK violation on an oversized payload);
    - `assessReviewReport`, `scopeRepairPacket` or `assessStageReport` throwing on an unexpected state (`:1593-1630`);
    - `runtimeEvidence.freezeRun` inside `finalize`.
  - ADR-039's storage policy already anticipates "supervision error without observed exit" (`packages/storage/src/repositories/maintenance.ts:52-55` withholds cache deletion), which shows the state is known to occur. The process itself is simply not terminated.
- Impact:
  - An agent keeps editing the worktree, running builds and consuming model quota with no journal, no cancel control and no deadline.
  - The work cycle sees a failed step and may launch the next agent into the same worktree. Two agents then edit concurrently, and the orphan's edits land in whatever the next review evaluates.
- Recommendation:
  - In the `.catch`, call `liveRun.cancelRequested = true; liveRun.session.kill()` before `finalize`.
  - Keep the `LiveRun` in a separate `orphaned` map until the session's `items` iterator yields `exited`, drained in a best-effort loop that ignores storage.
  - Make `requireNoBackgroundWork` and launch checks consult that map as well.
  - Add a test: a backend whose event makes `appendEvent` throw. Assert that the process group is gone and a new launch is refused until then.
- Effort: S
- Related: AGT-02, AGT-13
- Plan/roadmap format impact: none

### AGT-02: Restart recovery relies entirely on systemd; no process identity is persisted
- Severity: medium
- Category: reliability
- Status: CONFIRMED for the design. The orphan scenario outside systemd is a HYPOTHESIS.
- Evidence:
  - The `agent_runs` schema has no pid, pgid or start-time column (`.schema agent_runs`).
  - `recoverInterrupted` (`agent-run-service.ts:1494-1505`) just marks live rows `interrupted` ("their processes are gone").
  - Children are spawned `detached: true` (`process.ts:137-144`), so they are not in the daemon's process group. Only a cgroup kill reaches them.
  - `~/.config/systemd/user/craftingtable.service` has no `KillMode` (defaults to control-group) and `Restart=on-failure`, which is safe in production.
  - The development path `pnpm dev`, which runs `tsx watch src/index.ts` (`apps/server/package.json:8`), restarts the daemon on every source edit. It relies on `index.ts` SIGTERM handling that waits at most 10 s (`SHUTDOWN_GRACE_MS`, `:112`). A hard kill or an OOM outside systemd leaves detached agent groups running against worktrees whose runs are now `interrupted`.
  - `shutdown()` kills runs with `cancelRequested=true`, so runs stopped by a clean shutdown are finalized as `cancelled`, not `interrupted`. That attributes the stop to a cancellation nobody requested; the run-finished payload has no message.
- Impact:
  - In development mode, orphaned agents mutate worktrees after "restart" and can collide with the next launch.
  - Shutdown-cancelled runs are indistinguishable from operator cancels in history, and ADR-039 treats them as eligible for cache deletion.
- Recommendation:
  - Persist `{pid, pgid, processStartTime}` (from `/proc/<pid>/stat` field 22) on launch.
  - In `recoverInterrupted`, when the pgid still exists with a matching start time, SIGTERM then SIGKILL the group before marking the run interrupted, and journal what was reaped.
  - Give shutdown-initiated kills a distinct reason (`finalize(..., 'interrupted', {message:'Daemon shutdown'})`).
- Effort: S–M
- Related: AGT-01
- Plan/roadmap format impact: none

### AGT-03: Raw vendor lines take about half the database and are shipped to the browser, which never reads them
- Severity: high (performance and storage growth)
- Category: performance
- Status: CONFIRMED
- Evidence:
  - DB page total 517 MB. `agent_run_events` totals: `payload_json` 185 MB, `raw_json` 265 MB.

    | Kind | Payload | Raw |
    |---|---|---|
    | Codex tool-result | 125 MB | 180 MB |
    | Claude tool-result | 26 MB | 38 MB |
    | Codex tool-call | 15 MB | 31 MB |

  - Codex "raw" is `boundedRaw(JSON.stringify({method, params}))` (`codex/normalize.ts:56`), a re-serialization rather than the vendor line.
  - `item()` (`codex/normalize.ts:185-289`) attaches the same `raw` (the full `item/completed` payload, including `aggregatedOutput`, up to 64 KiB) to both the tool-call and the tool-result event. `raw` also exceeds the 32 KiB tool-result payload cap (`bounded.ts:3-5`).
  - `packages/contracts/src/execution.ts:435`: `raw: z.string().optional()` is part of `runEventBaseSchema`. The event page route (`routes/agent-runs.ts:122-133`) and the run SSE (`:244-266`) serialize it.
  - `grep` finds no reader of `.raw` in `apps/web/src`.
  - The journal is append-only by trigger (`agent_run_events_no_update/no_delete`), so this cannot be pruned in place.
- Impact:
  - The database grows about 1.5x faster than needed; 542 MB after about 3 weeks.
  - Every run page load and SSE frame carries up to 64 KiB of unused JSON per event, which adds to UI slowness.
  - Backups and the WAL grow in step.
- Recommendation:
  - Drop `raw` from the wire contract now (S).
  - Stop retaining `raw` for events whose payload is lossless: assistant-message, tool-call, session-started, turn-completed. Keep it only for `notice` and unknown or unparseable shapes, where it is the only diagnostic.
  - For tool-result, keep at most one copy.
  - Optionally move raw into a size-capped per-run diagnostic file under the run directory, which already has a retention policy.
  - Existing rows need a migration that copies the table without `raw_json`, because the append-only trigger blocks an in-place update. Schedule it with a backup.
- Effort: S (wire), M (retention and migration)
- Related: AGT-07, AGT-15, events/UI reviewers
- Plan/roadmap format impact: none

### AGT-04: The adapters hard-code Cargo and controller build concepts
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `claude-code/backend.ts:94-110` and `codex/session.ts:51-66` each assemble the same environment: `CRAFTINGTABLE_RUN_NAMESPACE`, a PATH prefix from `buildEnvironment.binDirectory`, `CARGO_TARGET_DIR=${temporaryDirectory}/target`, and TMPDIR/TMP/TEMP. The code is duplicated verbatim.
  - `AgentLaunchRequest.buildEnvironment` (`index.ts:35`) is a controller concept inside the vendor seam.
  - `brief.ts:275` tells every agent in every repository about `CARGO_TARGET_DIR`, including non-Rust ones.
  - ADR-039 codifies "both backends set CARGO_TARGET_DIR".
- Impact:
  - Every new backend must re-implement Rust-specific environment policy.
  - Supporting a Node or Python repository means editing vendor adapters.
  - The environment policy lives in three copies: two adapters plus the brief.
- Recommendation:
  - Replace `buildEnvironment` and `temporaryDirectory` with a generic `environment: Readonly<Record<string,string>>` overlay plus `pathPrefix: string[]`, computed once by the daemon from a per-repository toolchain profile. Cargo contributes `CARGO_TARGET_DIR`; others contribute their own variables.
  - Adapters merge the overlay onto an allowlisted base environment (see SEC-02a) and do nothing else.
  - Brief text about build caches should come from the same profile.
- Effort: S–M
- Related: AGT-05, AGT-08, AGT-11, SEC-02
- Plan/roadmap format impact: none

### AGT-05: Per-run `CARGO_TARGET_DIR` forces a cold Rust build on every step (768 GB written and deleted in 10 days)
- Severity: high (throughput)
- Category: performance
- Status: CONFIRMED (data). The time cost is inferred.
- Evidence:
  - `CARGO_TARGET_DIR=<runsRoot>/<runId>/scratch/target` is set by both adapters (`claude-code/backend.ts:104`, `codex/session.ts:61`) and by the pinned launcher manifest (`runtime-evidence-service.ts:2280`: `targetDirectory: join(runDirectory,'scratch','target')`).
  - The cache is deleted after each run (ADR-039, `storage-service.ts:612-638`).
  - Audit query over `action='storage.cleaned'`, `phase='removed'`: 101 removals totalling 768.4 GB, averaging 7.79 GB and reaching 133,715 MB (about 131 GB) for one run, between 2026-09-13 and 2026-09-23.
  - Example: review run `d8c322bc…` created a 1.18 GB target in its first 3 minutes before being stopped. Audit shows this at `2026-09-20T20:24:05`.
  - The brief also forbids reuse: "do not reuse earlier runs' cache directories" (`brief.ts:275`).
- Impact:
  - Every design, implement, review and remediation step on a Rust workspace pays a full dependency plus workspace compile, likely minutes per step and the dominant cost of short review steps.
  - It burns disk-write endurance (about 77 GB/day) and step deadline budget, and inflates step time-limit failures.
- Recommendation:
  - Use a per-worktree target directory (for example `<worktreeRoot>/.ct-target/<worktreeId>` or under the run root keyed by worktree), reused across that worktree's runs and deleted at worktree removal. The agents in one worktree run sequentially, which AGT-13 should enforce.
  - Additionally or alternatively, configure `sccache` (`RUSTC_WRAPPER`) with a shared cache dir, which is safe across worktrees.
  - Keep per-run isolation only for pinned-evidence builds where provenance matters. Cargo fingerprints already invalidate correctly, and the receipt records the resolved graph.
  - Revise ADR-039 accordingly.
- Effort: S–M
- Related: AGT-04
- Plan/roadmap format impact: none

### AGT-06: Codex `sleep` items (and any unknown item type) silently disable ADR-062 automatic provider retries
- Severity: high (automation blocked needlessly)
- Category: bug
- Status: CONFIRMED
- Evidence:
  - `codex/normalize.ts:264-267`: `default: this.unsafeContinuation = true; return completed ? [notice('Backend item: …')] : []`.
  - `complete()` (`:130-165`) sets `safeToRetry` false whenever `unsafeContinuation` is true.
  - Live: 600 `Backend item: sleep` notices across 71 runs, most recently `2026-09-23T00:51`. Example raw: `{"method":"item/completed","params":{"item":{"type":"sleep","id":"call_…","durationMs":30000},…}}`. The item is a benign wait, typically while builds run.
  - `unsafeContinuation` is reset only per turn (`beginTurn`), and automated steps are usually one long turn. Any Codex step that ever slept therefore loses bounded retry for a later `serverOverloaded`, `internalServerError` or transport failure and goes to operator attention instead.
  - Context, not proof: run `a1948181…` failed with `codexErrorInfo:"serverOverloaded", willRetry:false`, and its `turn-completed` has no `providerFailure` at all. That is expected, because the failure (2026-09-22T01:23Z) predates the ADR-062 commit `f3b3f27` (2026-09-22T06:45Z). ADR-062 retries have never been exercised on live data (see AGT-61).
- Impact: The "minimal operator input" goal is undermined. Transient capacity errors on Codex, the backend used for 281 of 308 runs, escalate to the operator instead of auto-retrying.
- Recommendation:
  - Add an explicit allowlist of known-benign item types (`sleep`, `plan`, `todoList`, `imageView` and so on, taken from the installed app-server's generated schema) that neither emit notices nor taint continuation.
  - Taint only on item types known to spawn external or delegated work (`collabAgentToolCall`, dynamic tools with side effects).
  - Log unknown types once per run, not per item.
  - Add a regression test with a `sleep` item followed by a `serverOverloaded` error.
- Effort: S
- Related: AGT-07, AGT-50+ (failure classification)
- Plan/roadmap format impact: none

### AGT-07: Unknown vendor messages become journal events with raw payloads (thousands of noise notices)
- Severity: low
- Category: performance
- Status: CONFIRMED
- Evidence:
  - `claude-code/normalize.ts:172-182` and `:272-282` emit `notice` plus `raw` for every unknown type or subtype.
  - Live: `task_progress` 2281, `tool_progress` 555, `thinking_tokens` 498 (now filtered at `:216`), `sleep` 600. `task_progress` alone holds 921 KB of raw.
  - Claude `task_progress` and `tool_progress` stopped appearing after 2026-09-15, which suggests they were handled or the CLI changed. Each new CLI release can reintroduce this class of noise.
  - Each notice also triggers `notifier.notify('activity')` (`agent-run-service.ts:1669-1673`).
- Impact: Journal noise in the run feed, wasted storage, and wake-ups for every SSE listener.
- Recommendation: Coalesce unknown types: emit at most one notice per `(type, subtype)` per run, and count the rest into the `turn-completed` payload. Drop raw for progress-type messages.
- Effort: S
- Related: AGT-03, AGT-06
- Plan/roadmap format impact: none

### AGT-08: Verification exists only for Cargo; non-Rust repositories get no controller-supplied verification
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - The only build adapter is `pinned-cargo.ts` (ADR-047: "The first build adapter is Cargo").
  - `native-environment.ts:16-21` hard-codes `~/.cargo/bin/cargo` and `rustc` into the host digest.
  - The `ct-native` environment hard-codes `CARGO_HOME`, `RUSTUP_HOME` and `~/.cargo/bin` (`local-check.ts:258-270`).
  - The act mounts are `cargo-registry` and `cargo-git` (`local-check.ts:155`).
  - Server generic code refers to Cargo in: runtime-evidence-service (41 references), baseline-preparation (11), agent-run-service (7), storage-files `cargoCaches` (4).
  - `exportCommit`'s consumer parses `Cargo.toml` (`runtime-evidence-service.ts:96`).
  - Project-specific vocabulary (Kata, AQ, EXO, WI) appears in generic services such as `plan-acceptance-policy.ts:19`, `execution-scope.ts:295` and `runtime-evidence-policy.ts:359-366`, and in the native audit.
  - `ct-check -- <anything>` is language-agnostic but only records receipts when a pinned manifest exists, which requires a Cargo runtime definition.
- Impact:
  - For any non-Rust project, the controller has no verification evidence path.
  - Merge gates reduce to the reviewer's word.
  - The concepts don't carry over when the Development Studio targets other stacks.
- Recommendation:
  - Split the runtime-evidence feature into a generic core (manifest, receipt, freshness, scoped checks via `ct-check`) and a Cargo plugin module (graph verification, patches, `cargo metadata`).
  - Let `ct-check` produce receipts without a Cargo pin.
  - Move Kata/AQ/EXO strings into plan-derived data, since the plan format already names them.
- Effort: L
- Related: AGT-04, SEC-01, GIT-10
- Plan/roadmap format impact: none required. The concurrency-schema fields (`crate_version`) stay as they are; the generic core would treat them as Cargo-profile data.

### AGT-09: A ct-check or ct-act timeout kills only the direct child, not its process tree
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - `local-check.ts:292-295`: `stop = () => { killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000); …; child.kill('SIGTERM') }`.
  - The child is spawned without `detached` (`:281-286`), so `child.kill` targets one pid. For `ct-check -- cargo test`, test binaries and build scripts survive.
  - ct-native is different: its systemd unit uses `KillMode=control-group` (`native-environment.ts:66`). ct-act removes containers through labels.
- Impact:
  - A timed-out check leaves grandchildren running inside the agent's process group.
  - That group then never drains, so the supervisor's background-work logic (`process.ts:211-227`) holds the run live until the step deadline. The operator sees "waiting for process group" for up to the whole remaining step time.
- Recommendation: Spawn with `detached: true` and kill `-pid` (the group). Mirror `process.ts`'s `killGroup`, or reuse `spawnSupervisedProcess`, which is already the process authority.
- Effort: S
- Related: AGT-01, SEC-01
- Plan/roadmap format impact: none

### AGT-10: Backend capabilities are expressed as `backend === 'codex'` checks scattered across daemon, domain, contracts and web
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `grep "=== 'codex'"`-style branches:
    - `agent-run-service.ts:185,529`
    - `work-cycle-service.ts:87`
    - `packages/domain/src/agent-profiles.ts:51`
    - `packages/contracts/src/agent-profiles.ts:16`
    - `HandoffForm.tsx:63,100`
    - `DelegationPanel.tsx:205,563,586`
    - `DesignRecoveryPanel.tsx:252,374`
    - `WorkspaceProfilesSection.tsx:62`
    - `RunPage.tsx:487`
    - `DecisionPreparationPanel.tsx:134`
    - `AgentSelectionFields.tsx:44`
    - `AgentSelectionsEditor.tsx:13`
  - `backend IN ('claude-code','codex')` CHECK appears in migrations 0005, 0007, 0008, 0014 and 0026.
  - The error "Reasoning effort is supported for Codex profiles only" (`agent-run-service.ts:529-533`) is out of date: the installed Claude Code 2.1.280 supports `--effort <low|medium|high|xhigh|max>`.
  - `AgentBackendDescriptor` (`index.ts:97-103`) exposes only `kind`, `label`, `executable` and `models`. There are no capability flags for effort levels, budget caps, steering, resume, read-only support or sandbox semantics.
  - `edit-only` means different things per backend: Claude `acceptEdits` denies Bash (no tests can run), while Codex `workspace-write` can run any sandboxed command. This is documented in `docs/security.md:57-67`, but the domain comment (`packages/domain/src/execution.ts:151-159`) presents the posture as vendor-neutral.
- Impact:
  - Adding a backend touches about 20 files plus a table-rebuild migration.
  - The UI encodes backend knowledge.
  - Profile semantics silently differ across backends.
- Recommendation:
  - Add `capabilities: { reasoningEfforts: readonly Effort[]; budgetCap: boolean; steering: 'queue'|'steer'|'none'; readOnly: boolean; postures: Record<Posture, {description, confinement:'os-sandbox'|'tool-policy'|'none'}> }` to the descriptor.
  - Serve it through the existing backends endpoint and derive all UI and validation from it.
  - Replace the SQL CHECK with a text column validated at the domain boundary. Changing the CHECK needs a table rebuild once, and then never again.
  - Wire Claude `--effort`.
- Effort: M
- Related: AGT-11
- Plan/roadmap format impact: none. Roadmap agent-profile assignments carry `backend` and `effort` strings that remain valid.

### AGT-11: The seam cannot host persistent (Hermes/OpenClaw-style) agents without redesign
- Severity: medium (strategic)
- Category: architecture
- Status: CONFIRMED (analysis of the interface)
- Evidence:
  - `AgentBackend.launch(request) → AgentSession` (`index.ts:109-113`) assumes one fresh child process per run, with `cwd` equal to the worktree, a prompt as the first message, and `kill()` terminating a process group.
  - `pid` is part of the session.
  - `AgentLaunchRequest` embeds controller concerns: `buildEnvironment`, `temporaryDirectory`, `deadlineAt` as a process-drain deadline, and `readOnly`.
  - ADR-062 deliberately forbids session resume ("Fresh sessions are deliberate. Thread resume can carry stale cwd, sandbox/additional directories…").
  - A persistent agent has:
    - a long-lived identity and memory across runs;
    - a transport that is not a child process (socket, HTTP or queue);
    - its own sandbox;
    - cancellation that is a request, not a signal;
    - possibly concurrent assignments.
- Impact: The operator's stated future direction needs a second seam. Squeezing it into `launch()` would leak process-model assumptions (pid, process-group drain, `background-work-*` exit reasons) into a network agent.
- Recommendation: Split the seam into two layers, and record the split in an ADR before the first persistent backend.
  1. `AgentTransport`: process (current) or endpoint (future). It owns liveness, cancel and escalation semantics, and reports `exited | disconnected | cancelled`.
  2. `AgentBackend`: vendor protocol plus normalizer, capability descriptor (AGT-10), and `openSession({workspace: {cwd, writableRoots, env overlay}, brief, posture, model})`.
  - Make "assignment" (run) distinct from "agent identity" so a persistent agent can serve many runs with a durable `agentInstanceId`.
  - Keep the existing normalized event vocabulary. It is already vendor-neutral and is the right durable contract.
  - Move background-work drain reasons behind the process transport.
- Effort: M (design), L (first persistent backend)
- Related: AGT-04, AGT-10
- Plan/roadmap format impact: none

### AGT-12: `launchAuthorized` is a ~780-line mixed-responsibility function; its side effects precede the durable record
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `agent-run-service.ts:503-1282` contains, in one closure:
    - authorization rechecks (`:710-723`);
    - Git preflight and review snapshots (`:651-703`);
    - `runDirectory` creation (`:727-729`), then pinned-launcher preparation, historical materialization and 8+ controller JSON documents (`:730-970`);
    - brief composition split across `composeBrief` (`:971-1037`) and inline template strings (`:1039-1068`);
    - `brief.md` write (`:1069`);
    - only then the run row insert (`:1072-1170`) and `registerRun` (`:1177`).
  - Every `throw ExecutionRequestError` between `:727` and `:1072` leaves an unregistered `runsRoot/<uuid>` directory. Examples: "Repository policy changed during review preparation" (`:937-941`) and "Dependency generation changed" (`:1152-1156`).
  - Live: `runs/25266f84-f451-4d85-9a93-f6f3319f144a` (created 2026-09-20 04:52, containing only `scratch/`) has no `agent_runs` row, so storage maintenance never sees it.
  - `this.mutations.during(worktreeId, …)` holds the worktree guard across all of this (seconds of Git plus Cargo metadata). A concurrent merge attempt gets a misleading "A merge or removal is already in progress" (`worktree-mutation-guard.ts:6`).
- Impact:
  - This is the hardest function to change safely in the area. Every new controller feature adds another `if (cycle?.x)` document and another brief paragraph, which is the "controller sprawl" pain point.
  - It leaks orphan directories.
  - It mixes read and write phases, which makes retry semantics unclear.
- Recommendation: Decompose into explicit phases with typed inputs and outputs:
  1. `authorizeLaunch()` (pure checks plus a DB read snapshot);
  2. `prepareWorkspaceContext()` (Git preflight, returning `ReviewContext`);
  3. `materializeRunFiles(runId)`, which returns a manifest of files, is idempotent, and is keyed off a pre-inserted `starting` row, or is cleaned up in a `finally` when insertion fails;
  4. `composeBrief()`, where all text lives in `brief.ts` or a template module, including the Cargo, native and historical sections;
  5. `insertRun()`;
  6. `spawn()`.

  Insert the run row (status `starting`) before touching the filesystem, so every directory has an owner. Rename the guard message by operation.
- Effort: M
- Related: AGT-50+ (brief content), controller-sprawl reviewers
- Plan/roadmap format impact: none

### AGT-13: Manual launches allow two live agents in the same worktree
- Severity: medium
- Category: bug
- Status: CONFIRMED (code). No test covers it, so intent is unclear.
- Evidence:
  - `start()` (`agent-run-service.ts:252-270`) calls `requireManualControl`, which blocks only when a cycle is running or awaiting merge, when an integration resolution owns the worktree, or when a live run has `backgroundWorkPending` (`:463-502`).
  - Nothing refuses a second manual `implement` launch while another run in the same worktree is `running` or `waiting`.
  - The handoff check (`:602-607`) forbids only `starting` or `running` parents, so a `waiting` parent's process stays alive (stdin open) while its child runs.
  - `grep` over `server-execution.test.ts` finds no test asserting either behavior.
- Impact: Two agents can edit the same checkout concurrently, and a follow-up message can be sent to the idle parent mid-child. The resulting diff and review attribution is ambiguous. With AGT-01 this becomes more likely.
- Recommendation:
  - Enforce "at most one non-terminal run per worktree" in the run-insert transaction, via a partial unique index or a check in `tx.execution.runs.insert`.
  - When handing off from a `waiting` parent, `end()` the parent first (the backend drains) and wait for exit.
  - If concurrency is intended for read-only reviewers, make that an explicit posture.
- Effort: S
- Related: AGT-01
- Plan/roadmap format impact: none

### AGT-14: Supervised agents inherit the operator's personal Claude/Codex configuration (hooks, plugins, skills, memory, MCP)
- Severity: medium
- Category: reliability (reproducibility) and security
- Status: CONFIRMED
- Evidence:
  - `claudeCodeArguments` (`claude-code/arguments.ts:12-54`) passes neither `--bare`, `--setting-sources` nor `--settings`. The CLI therefore loads:
    - `~/.claude/settings.json`: the `superpowers` plugin, `effortLevel: high`, `model: opus[1m]`, broad `permissions.allow` entries such as `Bash(cargo)`, `Write`, `Read(~/src)`;
    - user hooks and CLAUDE.md;
    - auto-memory.
  - Live journal: automated Claude runs invoked the `Skill` tool 13 times (`code-review` ×7, `superpowers:receiving-code-review` ×5, `superpowers:brainstorming` ×1). There were 27 `Hook SessionStart:startup` notices.
  - Codex threads load `~/.codex/config.toml`: `approvals_reviewer="guardian_subagent"` (overridden per thread), 10 plugins including `browser`, `unified-computer-use` and `chrome`, and the `node_repl` MCP server. `codex/arguments.ts` does not disable these.
- Impact:
  - Run behavior depends on the operator's interactive setup and changes when they tweak it. For example, a brainstorming skill can inject "ask the user" behavior into a headless run, which then stalls or ends incomplete.
  - Personal permission allowlists change what `auto` actually permits.
  - Computer-use and browser plugins are available to headless coding runs.
  - This is not reproducible across machines.
- Recommendation:
  - Claude: launch with `--setting-sources project,local` (or `--bare` with explicit `--settings` and `--mcp-config` supplied by CraftingTable) and `--disable-slash-commands` unless a profile opts in.
  - Codex: pass a `config` override that disables plugins and MCP servers, or use a CraftingTable-owned `CODEX_HOME` that shares only `auth.json`.
  - Record the effective settings source in `session-started`.
- Effort: S–M
- Related: SEC-02, AGT-10
- Plan/roadmap format impact: none

### AGT-15: Each agent event is a separate fsync'd transaction plus a notifier broadcast on the main event loop
- Severity: medium
- Category: performance
- Status: CONFIRMED for the mechanism. The impact on UI latency is a HYPOTHESIS; no profiling was done.
- Evidence:
  - `appendEvent` (`agent-run-service.ts:1650-1674`) runs `storage.transaction(...)` per event, then `notifier.notify('activity')`.
  - `packages/storage/src/database.ts:15-16` sets `journal_mode=WAL` and `synchronous=FULL` (fsync per commit), and better-sqlite3 is synchronous.
  - `notify()` (`workspace-event-notifier.ts:30-38`) resolves every waiting SSE and workflow waiter whose generation changed. Each then re-queries.
  - A Codex `fileChange` or `commandExecution` completion yields two events, so two fsyncs and two broadcast storms.
  - A `turn-completed` event on a review run additionally runs report assessment synchronously in the consumer (`:1583-1631`).
  - Parallel roadmaps multiply all of this (development capacity defaults to 2).
- Impact: Event-loop stalls and re-query fan-out while agents are busy. This plausibly contributes to the operator's "UI slowness as page elements react to automated transitions."
- Recommendation:
  - Batch: accumulate events per run for one macrotask (`setImmediate`) or up to N events, and write them in one transaction.
  - Coalesce `notify('activity')` to at most one per 100–250 ms.
  - Consider `synchronous=NORMAL` for WAL, which is the SQLite-recommended durability for WAL. It loses at most the last transactions on power loss, not integrity. Keep FULL for the workflow tables if necessary by using separate connections.
- Effort: S–M
- Related: AGT-03, events/UI reviewers
- Plan/roadmap format impact: none

### AGT-16: Smaller supervisor defects
- Severity: low
- Category: reliability
- Status: CONFIRMED (code)
- Evidence:
  - (a) `backgroundWorkDeadlineMs: Date.parse(request.deadlineAt)` (`claude-code/backend.ts:114`, `codex/session.ts:69`) is an absolute epoch in a field named "Ms". An unparsable `deadlineAt` gives `NaN`: `Date.now() >= NaN` is always false, so drain never times out (`process.ts:221`).
  - (b) Stderr handling differs between backends. Claude buffers to ≥8 KiB before emitting (`claude-code/backend.ts:165-175`); Codex emits every chunk as an event (`codex/session.ts:369-372`). Neither rate-limits, so a chatty `RUST_LOG` or app-server log becomes one DB transaction per pipe chunk. Only 5 stderr events are recorded live, so this is latent.
  - (c) `AsyncQueue` is unbounded and stdout is never paused (`process.ts:52-93`, `:150-184`). This is safe today only because the consumer is synchronous.
  - (d) The Claude `providerFailure` is cleared by any later assistant message, including sub-agent messages whose `parent_tool_use_id` is set (`claude-code/normalize.ts:290-315`, the `else` branch). A sub-agent message after a main-thread error therefore erases the classification. The same defect is recorded as the secondary point of AGT-59.
  - (e) `lineBuffer` recomputes `Buffer.byteLength` over the whole accumulated line on every chunk (`process.ts:159`), which is quadratic up to 4 MiB.
- Impact: Edge-case hangs, misclassification and journal amplification.
- Recommendation:
  - Rename the field to `backgroundWorkDeadlineAt` and validate that it is finite.
  - Unify stderr buffering in `process.ts` with a per-run byte budget (for example 1 MiB, then a single "stderr suppressed" notice).
  - Only reset `providerFailure` on main-thread messages.
  - Track the byte length incrementally.
- Effort: S
- Related: AGT-06
- Plan/roadmap format impact: none

### AGT-17: Documentation drift in the agent seam
- Severity: low
- Category: docs
- Status: CONFIRMED
- Evidence:
  - `docs/architecture.md:167` says "process authority remains three modules", but there are six (`scripts/check-forbidden-scope.mjs` `PROCESS_AUTHORITY`).
  - ADR-007 is superseded but is still the file named "agent execution boundary".
  - The domain comment on `AgentPermissionMode` (`packages/domain/src/execution.ts:151-159`) claims backend-neutral semantics that do not hold (AGT-10).
  - `docs/security.md:125-132` says credentials are omitted from "spawned-agent environments", while agents receive the full desktop environment (SEC-02).
- Recommendation: Fix these as part of the AGT-10 and AGT-11 ADR.
- Effort: S
- Related: SEC-09
- Plan/roadmap format impact: none

### Brief and failure-classification statistics (measured)

**Brief sizes.** Source: `agent_runs.brief`, 308 runs. Tokens are estimated as bytes/4.

| Group | n | Median | p90 | Max |
|---|---|---|---|---|
| All runs | 308 | 20.3 KB (~5.1k tokens) | 35.2 KB | 81.8 KB |
| design | 40 | 16.2 KB | 48.2 KB | 54.7 KB |
| implement | 106 | 18.8 KB | 31.9 KB | 81.8 KB |
| review | 162 | 20.8 KB | 34.1 KB | 69.5 KB |
| Scoped/pinned (roadmap slice) | 188 | 24.4 KB | 36.2 KB | – |
| Non-scoped | 120 | 9.4 KB | – | – |

**Brief composition (medians).**
- Fixed controller boilerplate: 5.3 KB (p90 9.7 KB).
- Plan-document path list: 4.1 KB.
- Inlined parent final message: 3.7 KB. That is 28% of the brief at the median, 55% at p90, and up to 86%.
- Pinned Cargo trailer: 2.2 KB.
- "Operator instructions": 1 KB (max 8.5 KB).
- The actual goal (exit gate plus source definition): under 5%.

**Side artifacts.**
- Handoff directories: 236 runs, median 199 KB, max 2.7 MB, 107 MB total.
- `plan/` directories: median 1.1 MB, 278 MB total.
- `craftingtable-scope-evidence.json`: median 491 KB (~120k tokens), max 908 KB.

**Jargon frequency (briefs containing the term / average occurrences per brief).**

| Term | Briefs | Avg |
|---|---|---|
| controller | 281 | 6.8 |
| obligation | 220 | 6.9 |
| checkpoint | 217 | 3.0 |
| ledger | 193 | 3.0 |
| receipt | 191 | 4.4 |
| slice | 188 | 7.8 |
| Kata | 186 | 1.9 |
| Cargo | 263 | 7.4 |

**Outcomes.**
- Run status: finished 300, failed 3, cancelled 3, interrupted 2. By backend: Codex 281, Claude 27.
- All 10 errored turns are provider errors: 9 Claude session-limit turns in one run, and 1 Codex `serverOverloaded`.
- Non-finished runs: 1 quota, 1 capacity, 1 background-work-incomplete (continued automatically), 2 daemon restarts, 3 cancels, 0 genuine agent failures.
- The two provider stalls lasted 7.1 h and 6.1 h before the next run.
- Review-turn validity: 146 complete, 35 invalid despite success (33 because "latest turn omitted structured report"), 10 invalid because the turn errored, 17 legacy.

### AGT-50: Briefs are mostly controller-protocol boilerplate; the task itself is a small fraction
- Severity: medium
- Category: simplification
- Status: CONFIRMED
- Evidence:
  - The brief is assembled from:
    - `brief.ts:179-384`
    - `agent-run-service.ts:969-1075`
    - the cycle-step text at `agent-run-service.ts:371-431`
    - `workflowPrompt` (`workflow-policy.ts:153-165`)
    - `finalizationInstructions` (`finalization-policy.ts:45-120`)
    - `REPOSITORY_POLICY_GUIDANCE` (`repository-policy.ts:124`)
  - The design role text alone (`brief.ts:142-155`) is about 3.5 KB of JSON-schema prose (the craftingtable-design block, checkpoint decision shape, coverage/consumers rules). It is sent to every design run, even when the plan has no checkpoints.
  - In the sampled WI-04 design brief, the exit gate first appears at line 31 of 496.
- Impact:
  - Agents spend context and attention on controller rules.
  - The goal is buried.
  - Rules added incident by incident pile up; this is the agent-facing counterpart of the "spaghetti" complaint.
- Recommendation:
  - Adopt a fixed skeleton:
    1. Goal and acceptance.
    2. Where you are (worktree, scratch, tools).
    3. What you must produce (a single generated output contract, see AGT-54).
    4. Files to read (handoff, plan, evidence).
    5. Operator guidance (verbatim).
  - Move schema prose into a versioned `craftingtable-output-contract.md` in `plan/`.
  - Emit role- or plan-specific clauses only when the underlying data exists.
  - Add a size-budget test in `brief.test.ts` with a target under 8 KB.
- Effort: M
- Related: AGT-51, AGT-53, AGT-54, AGT-55, AGT-12
- Plan/roadmap format impact: none

### AGT-51: Controller-authored text is presented to agents as "## Operator instructions"
- Severity: medium
- Category: ux
- Status: CONFIRMED
- Evidence:
  - `startForCycle` (`agent-run-service.ts:371-431`) concatenates all of these into `instructions`:
    - `workflowPrompt`
    - `cycle.instructions`
    - provider-retry text
    - scope-repair text
    - design-recovery text
    - finalization text
    - housekeeping text
    - integration-resolution text
    - continuation text
    - the nohup/setsid rule
    - "one step of an operator-authorized automated cycle"
    - the Open-questions rule
    - the remediation policy
  - `brief.ts:356-358` renders all of it under `## Operator instructions`. 286 of 308 briefs have this section.
  - Run `ba6ba2d5`: that section contains only controller boilerplate.
  - Run `8b7fc57b`: genuine operator text is interleaved with controller recovery paragraphs.
- Impact: Agents cannot tell the operator's actual intent, which carries the highest authority, from generic controller policy. The operator also cannot see what they actually said.
- Recommendation:
  - Split `BriefInput.instructions` into two fields:
    - `controllerStepRules`, rendered under "## Step rules";
    - `operatorGuidance`, verbatim, attributed and dated.
  - Store them as separate fields on the cycle.
- Effort: S–M
- Related: AGT-52, AGT-50
- Plan/roadmap format impact: none

### AGT-52: One-shot operator guidance persists into every later cycle step and contradicts them
- Severity: high
- Category: bug
- Status: CONFIRMED
- Evidence:
  - `work-cycle-service.ts:1004`: `const instructions = [cycle.instructions, input.instructions].filter(Boolean).join('\n\n')` feeds `reviewRemediation`.
  - `:2988` then persists `instructions: grant.instructions` into cycle state.
  - The same pattern appears at `:1108`, `:1275`, `:1356` and `:1399`. The only bound is a 16,000-character cap.
  - `startForCycle` re-sends `cycle.instructions` on every step (`agent-run-service.ts:374`).
  - Live example, the finalization worktree of run `d39b8769`. The text "For this retry of the initial assessment only, correct the previous report's format… Preserve all 117 findings… and the changes-requested verdict… Avoid repeating the full verification suite solely to correct IDs" appears in 5 consecutive runs:
    - `ef4676cd` (review): the intended target;
    - `2ba026d3` (implement);
    - `d7d7b12d` (review);
    - `d39b8769` (implement);
    - `569ca889` (review).
  - Query: `instr(brief,'For this retry of the initial assessment only')>0` for runs in that worktree.
  - The implement runs were told in the same brief both to preserve the verdict and to fix every finding.
- Impact:
  - Agents receive contradictory, stale directives.
  - Later reviews can be told not to rerun verification.
  - Guidance accumulates until the 16k cap blocks new operator guidance.
- Recommendation:
  - Model guidance as an append-only list of `{text, scope:'next-step'|'cycle', stepKind?, createdAt}`.
  - Render only the entries applicable to the current step.
  - Guidance attached to a retry or remediation grant defaults to `next-step`.
  - Show active cycle-scoped guidance in the UI, with a way to retire it.
- Effort: M
- Related: AGT-51
- Plan/roadmap format impact: none. Only cycle state changes; old strings migrate as `scope:'cycle'`.

### AGT-53: The parent's final message is inlined verbatim, duplicating the handoff and breaking brief structure
- Severity: medium
- Category: simplification
- Status: CONFIRMED for the structure. HYPOTHESIS for any measurable effect on agent behaviour.
- Evidence:
  - `brief.ts:326-355` inlines `parent.finalMessage`, up to 256 KiB (`PARENT_MESSAGE_LIMIT_BYTES`, `agent-run-service.ts:110`).
  - `brief.ts:305-324` also points to the same text in `handoff/0000-final.md`, `0000-review.json` and `findings.json`.
  - The parent's own `##` headings survive inlining. Across the 308 briefs:
    - 92 contain a top-level `## Open questions`;
    - 48 contain `## Review report`;
    - 86 inline a full `craftingtable-review` JSON (up to 70 KB);
    - 43 contain more than one `VERDICT:` line.
  - Run `d39b8769` (81.8 KB brief): "Review findings to address" is 219 bytes, followed by the parent's `## Open questions\n\nnone` and a 70 KB `## Review report` as sibling sections. The same brief repeats one handoff warning line 20 times.
- Impact:
  - Tokens are doubled.
  - The brief's hierarchy becomes ambiguous: a parent's "VERDICT: changes-requested" or "Open questions: none" reads like a directive to the new agent.
- Recommendation:
  - Inline only a bounded digest: active finding IDs, severities and titles for a review parent, or a summary for an implement parent.
  - Point to the handoff files for the rest.
  - Fence or demote the headings of anything that is quoted.
  - Collapse repeated warnings.
- Effort: S–M
- Related: AGT-50, AGT-56
- Plan/roadmap format impact: none

### AGT-54: Structured-output instructions are scattered across 6 modules and conflict for some roles
- Severity: medium
- Category: bug
- Status: CONFIRMED
- Evidence:
  - Output-protocol text lives in:
    - `brief.ts` `ROLE_INSTRUCTIONS` and `REVIEW_REPORT_INSTRUCTIONS` (`:98-114`);
    - the scope block (`brief.ts:205-208`);
    - `workflow-policy.ts:157-164`;
    - `agent-run-service.ts:419-425`;
    - `finalization-policy.ts:53`;
    - the integration-resolution text.
  - `workflowPrompt` is added for every step, including design and implement (`agent-run-service.ts:372`).
  - Design brief `117cd918` says both "Immediately before Open questions, include one fenced craftingtable-design JSON block" and "Before ## Open questions, include exactly one fenced craftingtable-workflow JSON block". Only one block can be immediately before.
  - Implement briefs receive reviewer text ("Return your normal complete review report and final verdict when reviewing").
- Impact: This contributes to 35 invalid successful review turns and to report-format retries. Every new rule adds another place to keep consistent.
- Recommendation:
  - Build one `OutputContract` per (role, context) in a single module that produces both the brief text and the parser expectations.
  - The brief states one ordered list: "your final message must end with, in order: …".
  - Add a test that each role gets exactly one instruction per block.
- Effort: M
- Related: AGT-50, AGT-62
- Plan/roadmap format impact: none

### AGT-55: Rust- and project-specific text is hard-coded into generic brief paths
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `brief.ts:275` puts the `CARGO_TARGET_DIR` paragraph in 235 of 308 briefs.
  - The pinned trailer (`agent-run-service.ts:1043-1056`) hard-codes:
    - "The image includes Rust 1.89, rustfmt/clippy";
    - `cargo --config "$CRAFTINGTABLE_CARGO_CONFIG"`;
    - Kata disclaimers (186 briefs);
    - a stale incident note ("Earlier reports describing rejection of upstream-free checks refer to the previous launcher… update stale instructions") that is now permanent prompt text.
- Impact:
  - A non-Rust repository, including CraftingTable itself, gets irrelevant Cargo directives.
  - One-off incident notes never retire.
- Recommendation:
  - Render toolchain guidance from the per-repository verification or toolchain profile proposed in AGT-04 and AGT-08.
  - Delete the incident sentence.
  - Keep Kata wording with the runtime-evidence profile that owns it.
- Effort: M
- Related: AGT-04, AGT-05, AGT-08
- Plan/roadmap format impact: none

### AGT-56: Per-run context artifacts are oversized and copied on every run
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - `craftingtable-scope-evidence.json` is written per run (`agent-run-service.ts:888-898`): median 491 KB, max 908 KB.
  - In run `41d6b730`, `acceptedExternalEvidence[].artifacts` accounts for 783 KB of 890 KB, and a single entry is 518 KB. Briefs tell agents to "use" this file (`brief.ts:151,207`).
  - `plan/` is copied into every run: 278 MB in total.
  - `writeRunHandoff` (`run-handoff.ts:191-331`) re-exports the full lineage (up to 1000 sources) for each child: 107 MB in total, 2.1–2.7 MB per deep lineage.
  - The brief is stored three times: `agent_runs.brief`, `brief.md`, and the `user-message` event payload (6.6 MB).
- Impact: Disk growth. Agents skim huge JSON files and can miss the relevant evidence.
- Recommendation:
  - Replace the evidence dump with an index file: IDs, states, digests and short summaries, with artifact bodies in separate files.
  - Share plan bundles by content hash in a read-only shared directory instead of copying them.
  - Make handoffs incremental: reference the parent's existing handoff and export only new material.
  - Keep the brief in one place (the run row) and have the event refer to it.
- Effort: M
- Related: AGT-03, AGT-53, AGT-57
- Plan/roadmap format impact: none

### AGT-57: Briefs inherit links into other runs' scratch and plan paths that later expire
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - Inlined parent messages contain absolute links such as `<runs volume>/runs/5615d81e…/scratch/verification/summary.md`.
  - A scan of all 308 `brief.md` files found 154 briefs containing 349 references into other runs' directories. 90 of those targets no longer exist.
  - `brief.ts:275` itself says scratch "may expire".
- Impact: Evidence cited as proof becomes unreachable for the next reviewer, who may then treat it as missing verification.
- Recommendation:
  - At handoff time, copy cited files that still exist into `handoff/evidence/`, or mark missing ones `[expired: path]`.
  - Direct durable evidence into a retained `evidence/` directory.
  - Tie retention of `scratch/verification` and `scratch/review` to the lifetime of the cycle.
- Effort: S–M
- Related: AGT-53, AGT-56
- Plan/roadmap format impact: none

### AGT-58: The scope section repeats the goal three times and dumps internal-ID JSON
- Severity: low
- Category: ux
- Status: CONFIRMED
- Evidence:
  - `brief.ts:180-187` replaces the exit gate with `scope.scope`. `:203` prints it again, and it appears a third time as the final evidence obligation.
  - Raw JSON is included with `definitionId`, `digest`, `bindingRevision` and `gateInterpretation`, as is `workflowPrompt`'s "Current controller obligations: {JSON}".
  - Design-recovery runs list 32 `source-N.txt` files individually.
  - `brief.ts:308-309` emits empty lines.
- Impact: Noise, and agents have to interpret internal records.
- Recommendation:
  - Render scope as prose bullets: in scope / not in scope / evidence required / cases.
  - Keep IDs and digests in the evidence file only.
  - List a directory once, with its manifest, instead of every file.
- Effort: S
- Related: AGT-50
- Plan/roadmap format impact: none

### AGT-59: Claude transient service failures never qualify for ADR-062 automatic retry
- Severity: high
- Category: bug
- Status: CONFIRMED for the 429 record shape. HYPOTHESIS that 5xx and overloaded errors use the same shape.
- Evidence:
  - `claude-code/normalize.ts:403-413` sets `safeToRetry` only when `message.subtype === 'error_during_execution'`. The unit test uses a synthetic record of that shape (`normalize.test.ts:271`).
  - The live Claude API-error result (run `736446e8`, sequence 25618) is `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"terminal_reason":"api_error",…}`. The preceding assistant record carries `"error":"rate_limit","is_api_error_message":true`.
  - A Claude `server_error` would therefore be classified as `unavailable` but with `safeToRetry:false`, and `work-cycle-service.ts:1886-1897` sends that to operator attention.
  - Secondary defect: `normalize.ts:315` clears `providerFailure` on any sub-agent message (AGT-16d).
- Impact: The ADR-062 retry path for Claude is effectively dead, so Claude overload failures stall cycles.
- Recommendation:
  - Classify from `terminal_reason==='api_error'` plus `api_error_status`:
    - 5xx or 529: unavailable/capacity (retryable);
    - 429 or 402: quota;
    - 401 or 403: authentication.
  - Reset `providerFailure` only on top-level messages.
  - Add a fixture test built from recorded raw lines 25617 and 25618.
- Effort: S
- Related: AGT-06, AGT-60, AGT-16
- Plan/roadmap format impact: none

### AGT-60: Quota and session-limit failures with a known reset time always need the operator
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - Codex `usageLimitExceeded`, `rateLimitExceeded` and HTTP 429 map to `quota` with `safeToRetry:false` (`codex/provider-failure.ts:17-18,36-37`). Claude `rate_limit` and `billing_error` do the same (`claude-code/normalize.ts:302-307`).
  - The controller retries only `capacity`, `unavailable` and `transport` (`work-cycle-service.ts:1886`).
  - Claude emits `rate_limit_event` with `resetsAt` (sequences 25591 and 25616: `five_hour`, `resetsAt:1789483800`), but it is only journaled as a notice.
  - Run `736446e8` kept running for 31 minutes after the limit hit. Its background subagents produced 9 error turns (cumulative cost $94.67 to $96.82). The next review started 7.1 hours later.
- Impact: Overnight automation halts at every subscription window, and the operator has to notice and resume by hand.
- Recommendation:
  - Add a `quota` sub-kind that carries `resetsAt`.
  - Schedule a resource-free wait until reset plus a margin, bounded by the step deadline or an operator cap.
  - Send one notification ("paused until 07:50").
  - Terminate the session promptly on a terminal quota error.
- Effort: M
- Related: AGT-59
- Plan/roadmap format impact: none

### AGT-61: Failure data is sparse, and the ADR-062 path has never run on live data
- Severity: low
- Category: testing
- Status: CONFIRMED
- Evidence:
  - All 10 errored turns are provider errors, and neither failure record carries `providerFailure` (both predate `f3b3f27`).
  - The other non-finished runs:
    - `a1ea25f0`: background-work-incomplete, recovered by continuation `1ea99bd9`;
    - `b6bd761d` and `73a606f5`: interrupted by a restart. `73a606f5` had already produced complete review turns, which were discarded.
- Impact: Recovery correctness rests only on synthetic fixtures, and restart discards completed review output.
- Recommendation:
  - Build a replay harness that feeds recorded `raw_json` lines from real failures through each normalizer.
  - Consider reusing an interrupted review's last complete report under the pinned-commit rules.
- Effort: S
- Related: AGT-59, AGT-02
- Plan/roadmap format impact: none

### AGT-62: Claude background-task notifications create streams of invalid review turns and status churn
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - Every Claude `result` becomes a `turn-completed`, including those with `origin.kind:'task-notification'`.
  - `agent-run-service.ts:1571-1606` assesses each review turn and writes `verdict:null` for invalid ones.
  - `:1626-1640` then sets the run to waiting, and the next assistant message sets it back to running.
  - Each `turn-completed` is also a workflow wake-up (`:1668`).
  - Run `25d95643` recorded 32 `turn-completed` events in 25 minutes, 31 of them invalid progress pings ("Platform clippy passed. Waiting."). It emitted 64 `agent-run-status-changed` workspace events.
  - This pattern accounts for 33 of the 35 invalid-but-successful review turns.
- Impact:
  - Invalidation storms in the UI and repeated controller wake-ups, which matches pain point 3.
  - The run's verdict flips repeatedly.
- Recommendation:
  - In the Claude adapter, treat task-notification results as intermediate: emit a notice and stay `running`.
  - Assess only the turn that follows collection of background work, or the final result before End.
- Effort: S–M
- Related: AGT-15, AGT-54
- Plan/roadmap format impact: none

---

### GIT-01: A merge that times out in the primary checkout is never aborted
- Severity: high
- Category: reliability
- Status: CONFIRMED for the code path. HYPOTHESIS for the triggers (slow hooks, commit signing, large repositories).
- Evidence:
  - `operations.ts:916-930`: `mergeInto` returns immediately when `run()` itself fails (timeout, output overflow or spawn failure). `merge --abort` runs only on a non-zero git exit (`:932-938`).
  - The kill in `run()` (`:363-381`) can leave `MERGE_HEAD`, a half-written index or a stale `index.lock` behind.
  - A merge in the primary checkout (`:1030-1042`) therefore strands the operator's own checkout. `updateWorktree` (`:1203`) has the same gap in agent worktrees.
  - After a daemon crash mid-merge, `recoverMergeScratch` (`execution-service.ts:1560-1605`) handles only scratch worktrees. The primary checkout is left as it is, the record is marked `failed`, and a retry says "uncommitted changes; commit or stash them" (`operations.ts:1036`), which invites committing a half-merge.
  - No test covers a merge timeout (`operations.test.ts:405` covers only a generic timeout).
- Impact: The operator's checkout can be left mid-merge with misleading guidance. ADR-021's "leave as found" claim is violated.
- Recommendation:
  - After any failed merge `run()`, check for `MERGE_HEAD` and run `merge --abort`. Remove a stale `index.lock` only once the killed process group is gone.
  - Extend recovery to the primary checkout: when the target branch is checked out there and `MERGE_HEAD` equals the reserved source SHA, abort.
  - Give "merge in progress" and "dirty checkout" distinct refusal messages.
  - Add a test using a hook that sleeps past a short timeout.
- Effort: S–M
- Related: GIT-06, GIT-05
- Plan/roadmap format impact: none

### GIT-02: One-click worktree "Remove" force-deletes uncommitted and untracked work
- Severity: high
- Category: bug
- Status: CONFIRMED
- Evidence:
  - `removeWorktree` adds `--force` unless the caller passes `force === false` (`operations.ts:554-565`).
  - Manual removal (`execution-service.ts:1104`) and finalization (`finalization-service.ts:179`) both omit `force`.
  - The UI button has no confirmation (`DelegationPanel.tsx:424-430`, `App.tsx:870`).
  - The server checks for live runs and cycles but not for a dirty worktree.
  - Only merge cleanup and recovery pass `force:false` (`execution-service.ts:1601,1615,1636`).
- Impact: A single misclick destroys uncommitted agent edits and untracked or ignored files. Leaving edits uncommitted is common for agents, which is why ADR-031 checkpoints exist.
- Recommendation:
  - Default to non-force, with an explicit `discardChanges:true` option.
  - Have the server return 409 listing the dirty paths.
  - Add a UI confirmation that shows the number of files at risk.
- Effort: S
- Related: GIT-07
- Plan/roadmap format impact: none

### GIT-03: Large diffs fail outright instead of truncating, and the diff-limit setting is partly ignored
- Severity: medium
- Category: bug
- Status: CONFIRMED
- Evidence:
  - `worktreeDiff` reads the tracked patch under the runner's fixed 16 MiB cap (`operations.ts:707`, `:237`). A larger patch fails the whole request with "Could not compute diff" (`execution-service.ts:1703`).
  - `CRAFTINGTABLE_DIFF_LIMIT_BYTES` accepts values up to 64 MiB (`config.ts:357-363`), but anything above 16 MiB can never take effect.
  - `inspectWorktreeChanges` and the checkpoint hash the full binary diff under the same cap (`:1223-1239`). A worktree with more than 16 MiB of changes can never be checkpointed, so its cycle stalls.
  - Untracked files get one `diff --no-index --numstat` spawn each, sequentially and with no count limit (`:711-728`). Only the patch output is capped, at 100 files.
- Impact: Diffs and finalization fail on large but legitimate changes. Unignored build output can trigger thousands of git spawns.
- Recommendation:
  - Stream the patch and stop at `maxPatchBytes`.
  - Hash while streaming.
  - Count untracked files in one call, or cap the count and report "N more".
- Effort: M
- Related: GIT-06
- Plan/roadmap format impact: none

### GIT-04: The CT-04A1 inspector is dead code (about 7–8k lines) but is still composed, configured and tested
- Severity: medium
- Category: dead-code
- Status: CONFIRMED
- Evidence:
  - `composition.ts:122-131` constructs `RepositoryInspectorProvider` and exposes it (`:331`), but only tests read it.
  - Zero rows exist in `repository_inspections`, `registered_repositories` and `project_repository_bindings`.
  - `storage.repositoryRegistry` has no use outside the storage package.
  - `command-runner.ts` is on the `PROCESS_AUTHORITY` list only because of this dead code, and it duplicates the runner in `operations.ts` and `agents/process.ts`.
  - Config trap: setting any inspector variable (`config.ts:89-101`), such as `CRAFTINGTABLE_GIT_TIMEOUT_MS`, enables the feature. It then requires `CRAFTINGTABLE_REPOSITORY_ROOTS` and startup fails (`config.ts:174-183`). None of these settings affect live Git, which uses `CRAFTINGTABLE_GIT_EXECUTABLE`, not `CRAFTINGTABLE_GIT_BIN`.
  - `docs/architecture.md` already calls the inspector a removal candidate.
- Impact:
  - Maintenance burden.
  - Settings that look relevant do nothing, or crash startup.
  - Extra `pnpm check` time.
  - ADRs 016–019 read as current.
- Recommendation:
  - Delete the inspector modules, the server observation and provider files, and the storage registry.
  - Add a migration dropping the 3 empty tables, and remove the dead config.
  - Take `command-runner.ts` off the process-authority list and mark ADRs 016–019 superseded.
  - Before deleting, harvest the hardening (`-c core.fsmonitor=false`, ignoring global and system config, and the risk scan) into the live runner. See SEC-03.
- Effort: M
- Related: SEC-03, GIT-06
- Plan/roadmap format impact: none

### GIT-05: Scratch-worktree merges check out the whole target every time, and the target check is not atomic
- Severity: medium
- Category: simplification
- Status: CONFIRMED as the design. The cost on large repositories is a HYPOTHESIS.
- Evidence:
  - Every non-primary merge runs `worktree add` of the target, then `merge`, then `worktree remove --force` (`operations.ts:1053-1082`).
  - The HEAD-equals-expected-target check (`:902-911`) is a separate step before the merge.
  - This path needs its own crash recovery (`recoverMergeScratch`).
  - Git 2.55 is installed, and `merge-tree --write-tree` is already used in `previewIntegration` (`:1398`).
- Recommendation: For a target that is not checked out, merge with plumbing:
  1. `merge-tree --write-tree`, reporting conflict paths;
  2. `commit-tree` with the marker message and both parents;
  3. `update-ref refs/heads/<target> <new> <expectedTargetSha>`, which is an atomic compare-and-swap.

  This removes the scratch path, its recovery code and the non-atomic check. Keep working-tree merges only for the primary checkout.
- Effort: M
- Related: GIT-01
- Plan/roadmap format impact: none

### GIT-06: Git timeouts and output limits are hard-coded
- Severity: low–medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - Every operation gets 60 s and 16 MiB (64 MiB for `exportCommit`), fixed at `composition.ts:143`. This covers worktree add, merge, commit with hooks, and `cat-file --batch`.
  - The code itself notes that worktree add can be slow on a large repository (`operations.ts:18`).
  - The only settings that look relevant belong to the dead inspector (GIT-04).
- Impact: Unexplained timeouts on larger repositories, which then lead into GIT-01.
- Recommendation: Add a `CRAFTINGTABLE_GIT_COMMAND_TIMEOUT_MS` setting, or per-operation timeouts for add, merge and commit.
- Effort: S
- Related: GIT-01, GIT-03, GIT-04
- Plan/roadmap format impact: none

### GIT-07: Promotions into the primary checkout are brittle
- Severity: low
- Category: ux
- Status: CONFIRMED for the code. HYPOTHESIS for the race with operator edits.
- Evidence:
  - The cleanliness check uses `status --porcelain` including untracked files (`operations.ts:1033-1039`), so any stray untracked file blocks promotion with "commit or stash".
  - The check and the merge are not atomic.
  - All three live repositories have `main` checked out in the primary checkout, so every final promotion takes this path.
- Recommendation:
  - Use `--untracked-files=no`; git itself refuses to overwrite untracked files.
  - Make the error message precise.
  - Make it clear in the UI that promotion updates the operator's checkout.
- Effort: S
- Related: GIT-01, GIT-05
- Plan/roadmap format impact: none

### GIT-08: Daemon-authored commits and merges run repository hooks outside agent supervision
- Severity: low
- Category: security
- Status: HYPOTHESIS. The live repositories have no hooks.
- Evidence:
  - The checkpoint commit (`operations.ts:1339-1352`), the resolution commit (`:1519-1530`) and merges all run hooks.
  - A tracked `core.hooksPath` (husky-style) is agent-editable, so its hooks would run in the daemon's context under the 60 s Git timeout, outside the agent's process group.
  - A hook that reformats staged files makes the commit succeed but then fail verification ("Checkpoint HEAD changed", `:1293`).
- Recommendation: Pass `-c core.hooksPath=<empty daemon-owned dir>` on daemon-authored commits and merges, or make hooks an explicit per-repository policy.
- Effort: S
- Related: SEC-03
- Plan/roadmap format impact: none

### GIT-09: Merge cleanup deletes the branch without pinning its commit
- Severity: low
- Category: bug
- Status: CONFIRMED
- Evidence:
  - `cleanupMerge` (`execution-service.ts:1642`) calls `deleteBranch` without `expectedHeadSha`, although it knows `operation.sourceSha`.
  - Without that argument, the code falls back to `branch -D` after a separate ancestry check (`operations.ts:1083-1090`).
  - Finalization does pin the commit (`finalization-service.ts:407`).
- Impact: A commit added in the gap between the ancestry check and the delete could be dropped. The window is narrow.
- Recommendation: Pass `expectedHeadSha: operation.sourceSha`, and always delete with `update-ref -d <ref> <old>`.
- Effort: S
- Plan/roadmap format impact: none

### GIT-10: `operations.ts` is one 1754-line factory behind a 24-method interface
- Severity: low
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - The interface (`:111-230`) and the single factory (`:325-1753`) mix worktree lifecycle, merge and recovery, conflict resolution, checkpoints, source export and baseline tags.
  - `exportCommit` serves Cargo pinning only: its consumer parses `Cargo.toml` (`runtime-evidence-service.ts:96`). It holds the whole tree in memory (64 MiB / 10,000 files) and rejects symlinks and submodules (`:1640-1648`).
  - Server test doubles copy the whole object (`server-execution.test.ts:5222`).
- Recommendation:
  - Split into runner, worktrees, merge, resolution, checkpoint and export modules behind the same factory.
  - Move `exportCommit` next to the pinned-build feature, and consider `git archive` or a detached worktree for it.
  - Keep one shared bounded runner.
- Effort: M
- Related: GIT-04, AGT-08
- Plan/roadmap format impact: none

### GIT-11: The risky Git paths lack tests
- Severity: medium
- Category: testing
- Status: CONFIRMED
- Evidence:
  - Already tested: scratch-merge interruption and marker recovery (`server-execution.test.ts:5220-5260`, `5490-5515`), and conflict abort (`operations.test.ts:335`).
  - Untested:
    - a merge that times out or overflows its output;
    - recovery of a mid-merge primary checkout;
    - a diff over 16 MiB;
    - many untracked files;
    - dirty-worktree removal;
    - the scheduler retry after `duringMerge` refuses.
- Recommendation: Add these tests alongside the GIT-01, GIT-02 and GIT-03 fixes.
- Effort: S–M
- Plan/roadmap format impact: none

What held up in Git:
- Validation of refs, SHAs and paths, with paths passed only after `--`.
- A cleaned Git environment (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`).
- Durable merge reservation plus marker-commit recovery.
- Exact verification of checkpoint and resolution commits.
- No Cargo coupling inside `packages/git` beyond `exportCommit`'s consumer.
- Live state matches: 15 worktrees agree with `git worktree list`, there are no orphan `ct/*` branches, and no scratch merge worktrees are left over.

---

### SEC-01: Agents can forge the build/check/CI/native receipts that gate integration
- Severity: high
- Category: security
- Status: CONFIRMED that forgery is possible. No forgery was found in the journal.
- Evidence:
  - Receipts are written to `runDirectory/dependencies/build-receipts.jsonl` (`runtime-evidence-service.ts:2140,2285`).
  - `runDirectory` is passed as a writable additional directory (`agent-run-service.ts:1199-1203`), and the Codex writable roots include it (`codex/arguments.ts`, thread and turn params).
  - The launchers `cargo`, `ct-check`, `ct-act` and `ct-native` run inside the agent's own process tree and simply `appendFileSync` JSON lines (`pinned-cargo.ts:216-247`, `local-check.ts:359-382`).
  - `freezeRun` copies the file into the database verbatim (`runtime-evidence-service.ts:2469-2493`).
  - Acceptance checks only fields the agent can read or compute: success, clean, headSha, manifestDigest, runId, runtimeId, kind, policyDigest. There is no signature and no daemon-side record of what ran.
  - The launchers are mode 0500, but their directory is writable, so they can be replaced.
  - 168 of 188 `run_build_records` contain local-ci receipts, all from Codex `auto` runs.
  - ADR-047 and `security.md:295-301` say this is "not a sandbox", but `security.md:301` also says "Reviews without a successful frozen pinned-build record cannot authorize integration", so the receipt acts as an authorization token.
- Impact: One appended line can satisfy a pinned-build, scoped-check or native gate, which then authorizes delegated integration merges.
- Recommendation:
  - Make the check launchers thin clients that send `{kind, argv}` over a daemon-owned Unix socket.
  - The daemon runs the command in its own supervised process group, outside the agent's writable roots, and writes the receipt straight to SQLite. The agent receives only the log stream and the exit code.
  - Until that exists, label receipts in the UI as agent-reported.
- Effort: M–L
- Related: SEC-02, AGT-08, AGT-09
- Plan/roadmap format impact: none

### SEC-02: Agent confinement is cooperative in practice (inherited desktop environment, routine sandbox escalation, Docker socket)
- Severity: high
- Category: security
- Status: CONFIRMED for the environment and the escalations. HYPOTHESIS for the specific escape commands.
- Evidence:
  - The daemon's environment (`/proc/<pid>/environ`) includes `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE` and `npm_*`. All of it is passed to both adapters (`claude-code/backend.ts:94-110`, `codex/session.ts:51-66`), to pinned cargo (`:151`, `:336`) and to ct-check (`local-check.ts:279`). Only ct-native (`env -i`) and ct-act use a minimal environment.
  - Codex `auto` mode uses `on-request` plus `auto_review`, and escalations are routine. The journal shows:
    - "The commit needs a sandbox escalation because this worktree's Git index is stored outside its directory";
    - "Loopback socket creation is denied in the sandbox, so transport tests need a sandbox escalation";
    - an `act-escalated.log`;
    - 188 tool-call and 1885 tool-result events matching escalation or approval patterns.
  - Claude postures give no OS-level confinement (documented).
  - The rootless Docker socket sits at a fixed path, `$XDG_RUNTIME_DIR/craftingtable-docker.sock`.
- Impact:
  - "The agent never holds merge authority" and "cancel kills the process group" hold only while agents cooperate.
  - An agent can run `git merge` in the primary checkout, write the SQLite database, or start work outside its process group (`systemd-run --user`, `hyprctl dispatch exec`, `docker run`) that survives cancel and deadline.
  - The sandbox layout trains agents to request escalation for ordinary commits and tests.
- Recommendation:
  - (a) Build the child environment from an allowlist, in one place (see AGT-04): HOME, USER, LOGNAME, PATH, LANG/LC_*, TERM, the XDG config/data/cache/state variables that vendor logins need, plus the run overlay.
  - (b) Lay out the sandbox so ordinary work needs no escalation:
    - either have the daemon own commits (ADR-031 checkpoints), or add the worktree admin directory to the writable roots;
    - allow loopback;
    - then consider `approvalPolicy:never` for `auto`.
  - (c) Enable Claude Code's sandbox through `--settings` for every posture except `unrestricted`.
  - (d) Snapshot main and integration refs before and after each run, and flag moves the daemon did not make.
- Effort: M
- Related: SEC-01, SEC-03, AGT-14
- Plan/roadmap format impact: none

### SEC-03: Daemon Git calls execute repository-controlled hooks and config; the existing hardening is unused
- Severity: medium
- Category: security
- Status: CONFIRMED that the hardening is missing. HYPOTHESIS for the full chain.
- Evidence:
  - The environment for `operations.ts` (`:278-292`) strips only four `GIT_*` variables. It does not ignore system or global config, does not set `core.fsmonitor=false`, and does not override `hooksPath`.
  - The `worktreeDiff` patch (`:708`) and `diff --no-index` (`:714`, `:727`) lack `--no-ext-diff` and `--no-textconv`, although later diffs in the same file pass them (`:1202-1203`, `:1291-1292`, `:1329-1330`).
  - Merges and commits run hooks.
  - The dormant inspector already has the hardening: `command-runner.ts:90-106` (`-c core.fsmonitor=false`), `environment.ts:37-48` (ignore system and global config), and a risk scan for hooksPath, fsmonitor, diff.external, textconv and filters (`types.ts:5-6`).
- Impact: An agent that can write `.git/config` or hooks can plant a command. That includes any Claude run, or a Codex run after escalation. The command then runs in the daemon's context when the operator views a diff (GET), merges, or checkpoints, sometimes in the primary checkout.
- Recommendation:
  - Add one shared argument prefix for every daemon Git call: `-c core.fsmonitor=false -c core.hooksPath=<empty daemon-owned dir>`.
  - Pass `--no-ext-diff --no-textconv` on every diff.
  - Run the risk scan at repository registration and before each mutation.
  - Decide the hook policy for checkpoints explicitly.
- Effort: S–M
- Related: GIT-04, GIT-08, SEC-06
- Plan/roadmap format impact: none

### SEC-04: Authentication hardening is weak for a session that amounts to code execution
- Severity: medium
- Category: security
- Status: CONFIRMED
- Evidence:
  - Login has no rate limit, lockout or concurrency cap (`routes/auth.ts:86-117`, `auth-service.ts:41-69`).
  - Argon2 runs at default cost, about 64 MiB per verification, so concurrent login floods can exhaust memory (`password-hasher.ts:23`).
  - Every failed login writes an uncapped audit row (`auth-service.ts:54-67`).
  - Sessions last 30 days absolute, with no idle timeout (`config.ts:423`).
  - No step-up (password re-entry) is required for `unrestricted` launches, steering messages, delegation, or final promotion. The browser can choose `unrestricted` and supply arbitrary instruction text.
  - The `__Host-` cookie prefix deferred in ADR-009 was never adopted.
- Impact: A stolen cookie, or a login flood from any device on the tailnet, becomes code execution or a DoS.
- Recommendation:
  - Per-username backoff, and a global limit of about 2 concurrent Argon2 verifications.
  - Coalesce failed-login audit rows.
  - Idle expiry.
  - Recent-password re-entry for `unrestricted`, delegation grants and promotion.
  - A `__Host-` cookie under an HTTPS origin.
- Effort: S–M
- Related: SEC-05
- Plan/roadmap format impact: none

### SEC-05: Route authorization depends on every handler remembering to call it
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `server.ts:127-173` registers 17 route modules and adds no shared pre-handler.
  - Every handler calls `authenticate` or `authorizeMutation` itself. The counts match today: POST handlers equal `authorizeMutation` calls in every file, except `auth.ts`, where login is exempt.
  - `route-inventory.test.ts` checks paths only. No test asserts that each route rejects an unauthenticated request.
- Impact: About 100 routes are growing quickly, and one omission exposes a route. The operator prefers structural boundaries over allowlists.
- Recommendation:
  - Add a default-deny `onRequest` hook for `/api/*`.
  - Require each route to declare `config.access` as `public`, `read` or `mutation`, and fail startup when a route has none.
  - The hook performs auth, CSRF and origin checks and attaches the auth context.
  - Add a test that walks `printRoutes` and asserts 401 without a cookie and 403 for a mutation without CSRF.
- Effort: S
- Related: SEC-04
- Plan/roadmap format impact: none

### SEC-06: The browser can register any host path as a repository
- Severity: low
- Category: security
- Status: CONFIRMED
- Evidence:
  - `rootPath` in `registerSourceRepositoryRequestSchema` (`packages/contracts/src/execution.ts:117-120`) flows to `ExecutionService.registerRepository` (`execution-service.ts:209-218`), then `inspectRepository`, which runs `rev-parse` and `status` in that path (`operations.ts:461-496`). `status` can trigger fsmonitor.
  - The allowed-roots check exists only for the dead inspector (`config.ts:164-195`).
  - This contradicts `security.md`: "never submits … a path the daemon will execute".
- Recommendation: Use `CRAFTINGTABLE_REPOSITORY_ROOTS` as the registration allowlist, and apply the SEC-03 hardening in `inspectRepository`.
- Effort: S
- Related: SEC-03
- Plan/roadmap format impact: none

### SEC-07: Missing browser security headers and Host check
- Severity: low
- Category: security
- Status: CONFIRMED
- Evidence:
  - `static-web.ts:55-59` sets only `nosniff`. `curl -I` shows no CSP, frame-ancestors or Referrer-Policy.
  - There is no Host-header check, so DNS rebinding can reach login and health.
  - No XSS sinks exist today: there is no `dangerouslySetInnerHTML`, and `SourceText.tsx` forbids Markdown rendering.
- Recommendation: Add `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'` and `Referrer-Policy: no-referrer`, and accept only the public origin host and loopback.
- Effort: S
- Plan/roadmap format impact: none

### SEC-08: Stored credentials are readable by agents, and old DB copies are retained
- Severity: low
- Category: security
- Status: CONFIRMED
- Evidence:
  - The Pushover token and user key are stored in plaintext in `notification_settings.state_json`, and CSRF tokens in plaintext in `sessions`.
  - Agents run as the same OS user, and the Codex sandbox restricts writes, not reads.
  - `<runs volume>/before-schema14-*` and `backups/` hold full copies of the database.
  - This is documented in `security.md:129-134`.
- Recommendation:
  - Expire the pre-migration copies.
  - After SEC-02, move the Pushover credentials to a separate 0600 file outside agent-readable roots, or accept and keep documenting the exposure.
- Effort: S
- Plan/roadmap format impact: none

### SEC-09: `docs/security.md` is an accreted per-slice log with stale claims
- Severity: low
- Category: docs
- Status: CONFIRMED
- Evidence:
  - The file is 444 lines. From about the midpoint it is a run of per-ADR paragraphs with no headings.
  - It says agent environments exclude credentials, but they inherit the full desktop environment (SEC-02).
  - It says the browser never submits executable paths (contradicted by SEC-06).
  - `architecture.md:167` says "three modules" (AGT-17).
- Recommendation: Rewrite it as a trust-boundary table with four columns: boundary, what enforces it, what is only cooperative, and the covering test. Move workflow rules into the ADRs.
- Effort: S–M
- Plan/roadmap format impact: none

### SEC-10: The daemon runs straight from the editable development checkout
- Severity: low
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - `apps/server/package.json:9` is `"start": "tsx src/index.ts"`, and the unit sets `WorkingDirectory=%h/src/craftingtable` and `Restart=on-failure`.
  - The generated launchers `ct-check`, `ct-act`, `ct-native` and `cargo` import modules from this tree at run time (`import.meta.url` in `pinned-cargo.ts:64`, `local-check.ts:59`).
- Impact:
  - After any crash-restart, whatever is in the working tree becomes the daemon, with no build or check. That includes uncommitted edits from concurrent sessions or another checked-out branch.
  - Live agent launchers can change behaviour mid-run when a developer edits `packages/agents`.
- Recommendation: Deploy from a pinned, built copy: a separate worktree at a tag, then `pnpm build`, then `node dist`. The launchers should reference that immutable path.
- Effort: S
- Related: AGT-02
- Plan/roadmap format impact: none

What held up in security:
- CSRF, origin and SameSite checks.
- Digest-only session tokens.
- SSE re-authentication.
- Constant-time CSRF comparison and a uniform login error (with a dummy hash for unknown users).
- Password change and reset revoke other sessions.
- The bounded Pushover transport.
- No XSS sinks.
- ct-native `env -i`; ct-act uses `/dev/null` env, secret and var files and a restricted workflow path.
- Plan artifact filenames are validated against traversal (`packages/planning/src/bundle.ts:122-160`) before being written into run directories.

## Remediation direction

### Sequencing

1. **Stop the bleeding.** All S, independent and testable.
   - AGT-01: kill on supervision failure.
   - GIT-02: removal without force by default.
   - GIT-01: abort a stranded merge.
   - AGT-52: step-scoped operator guidance.
   - AGT-06 and AGT-59: provider-failure classification (Codex benign items; Claude `terminal_reason`/`api_error_status`).
   - AGT-09: group-kill on ct-check timeout.
   - AGT-13: one live run per worktree.
2. **Cheap performance wins, likely to help the operator's UI-slowness complaint.**
   - AGT-03: drop `raw` from the wire contract, then from retention for lossless kinds.
   - AGT-15: batch event writes and coalesce `notify('activity')`.
   - AGT-62: Claude task-notification results stop producing turn and status churn.
   - AGT-05: per-worktree `CARGO_TARGET_DIR` or sccache. This is the largest wall-clock win for Rust projects.
   - AGT-07: coalesce unknown vendor notices.
3. **Structural security.**
   - SEC-05: default-deny route hook plus an unauthenticated-route sweep test.
   - SEC-02a/AGT-04: allowlisted child environment built once by the daemon.
   - SEC-03: shared Git hardening prefix, harvested from the inspector before deleting it (GIT-04).
   - SEC-07 headers, then SEC-04 login limits and step-up for `unrestricted` and promotion.
   - AGT-14: isolate agents from the operator's personal Claude and Codex config.
4. **Launch pipeline decomposition (AGT-12) and the brief rewrite (AGT-50 to AGT-58) as one change set.**
   - Insert the `starting` run row first.
   - Materialize files through one idempotent function.
   - Move all agent-facing text into a brief/output-contract module (AGT-54), with operator guidance separated from controller step rules (AGT-51).
   - Replace the verbatim parent message with a digest (AGT-53).
   - Replace the scope-evidence dump with an index (AGT-56).
   - Resolve foreign-run links at handoff (AGT-57).
   - Target a brief under 8 KB, enforced by a test.
5. **Evidence integrity and generality (L).**
   - SEC-01: the daemon executes checks via a socket and owns the receipts.
   - AGT-08: split a generic verification core from a Cargo profile, so non-Rust repositories get real verification.
   - Plan formats stay unchanged: Cargo-specific plan fields become Cargo-profile data.
6. **Backend seam v2 (AGT-10, AGT-11, AGT-16, AGT-17).** Record it in an ADR.
   - Capability descriptors drive UI and validation, replacing `=== 'codex'` checks and the SQL CHECK.
   - Split transport (process versus endpoint) from vendor protocol.
   - Keep the durable normalized event vocabulary unchanged.
   - Separate "agent identity" from "assignment/run" so a persistent Hermes/OpenClaw-style agent can take assignments without pretending to be a process group.
   - Persist process identity for restart reaping (AGT-02).
7. **Git simplification.**
   - Delete the dead inspector (GIT-04).
   - Plumbing-based merges for targets that are not checked out (GIT-05), which removes scratch merges and their recovery.
   - Configurable timeouts (GIT-06), streaming diffs (GIT-03), and a module split (GIT-10), with GIT-11 tests alongside.
8. **Deployment and docs.**
   - SEC-10: run from a built, pinned copy.
   - SEC-09 and AGT-17: rewrite `security.md` as a trust-boundary table and fix the architecture doc's drift.

### Target design

- **The agents package** contains:
  - vendor protocol adapters that are pure translation plus a capability descriptor;
  - one process transport (today's `process.ts`, extended with persisted identity and a stderr budget);
  - later, an endpoint transport.
  - It knows nothing about Cargo, briefs, receipts or controller documents.
- **The daemon** owns:
  - a single launch pipeline: authorize, then reserve a `starting` row, prepare context, compose the brief, spawn, then consume in batches;
  - the child environment, built from an allowlist plus a per-repository toolchain profile;
  - verification execution and receipts, over a socket;
  - all Git mutations, hardened against repository-controlled config and hooks.
- **Briefs** are short, goal-first documents with one generated output contract. Operator guidance is scoped and attributed, and large context lives in indexed files.
- **Journal:** normalized events without redundant raw payloads, written in batches, with coalesced wake-ups.
