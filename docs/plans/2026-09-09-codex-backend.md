# Codex Backend Implementation Plan

> **For agentic workers:** work through the tasks in order, one commit per task,
> running the named checks before each commit. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `AGENTS.md` first; it is the repository's canonical guidance and this
> plan does not restate it.

**Goal:** Add OpenAI Codex as a second `AgentBackend` so the operator can run
implement, review, and remediation runs on either agent from the same launch form,
with the same run page, the same follow-up messages, and the same review-gated merge.

**Architecture:** The daemon already talks to agents only through the `AgentBackend`
and `AgentSession` seam in `packages/agents` and stores a `backend` kind on every run.
This plan (1) makes the daemon and browser backend-plural, with one added "Agent"
selector on the launch form and nothing else visibly different; (2) adds a Codex adapter
that speaks the `codex exec --json` JSONL protocol and hides Codex's one-turn-per-process
model behind the existing multi-turn `AgentSession` so run statuses, follow-up messages,
and verdict parsing behave identically. Every vendor-specific difference is absorbed in
`packages/agents/src/codex/`; the daemon and browser never learn Codex vocabulary.

**Tech Stack:** TypeScript strict, pnpm workspace, Fastify daemon, React browser app,
SQLite via better-sqlite3, zod contracts, vitest, Playwright, biome. Node 24.

**Spec:** the Design section of this document. There is no separate spec.

## Global constraints

- **UI parity is the acceptance bar.** The only new control on the launch form is an
  "Agent" select, shown only when the daemon lists more than one backend. The run
  page, run table, follow-up message box, end/cancel buttons, review verdict, merge
  gate, and remediation button must work unchanged for a Codex run.
- **Vendor facts must be verified before use.** Every item marked `VERIFY` below is the
  plan author's recollection of the Codex CLI, not a checked fact. The implementer has
  access to current OpenAI documentation: confirm each `VERIFY` item against the
  installed `codex --version` and the docs, correct this document in place, and only
  then implement the task that depends on it. Capture real `codex exec --json` output
  as the normalizer fixture; do not hand-write it from memory.
- **Boundaries from `AGENTS.md` hold.** Domain types stay free of vendor shapes. Raw
  vendor lines are retained only as bounded `raw` diagnostics. Processes are spawned
  with argument arrays from a module listed in `scripts/check-forbidden-scope.mjs`.
  No merge authority reaches the agent.
- **Quality gate per task:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
  must pass before each commit. `pnpm test:e2e` and `pnpm check:scope` must pass before
  the final commit. Never push, never merge.
- **No new configuration surface beyond** `CRAFTINGTABLE_CODEX_EXECUTABLE` and
  `CRAFTINGTABLE_CODEX_MODELS`, mirroring the existing Claude variables.

---

## Design

### 1. Backend vocabulary

`AGENT_BACKENDS` becomes `['claude-code', 'codex']`. A backend has a label for the
browser (`Claude Code`, `Codex`), which lives in the domain next to the kind so both
server and web read the same string. Nothing else in the run vocabulary changes: roles,
statuses, permission modes, event kinds, billing sources, and verdicts are already
vendor-neutral and are sufficient.

### 2. Backend selection

- `POST .../runs` accepts an optional `backend`. When absent, the daemon uses its
  default backend: the first *available* backend in the fixed order
  `['claude-code', 'codex']`. This keeps every existing client and test valid.
- The daemon holds a registry `ReadonlyMap<AgentBackendKind, AgentBackend>` of the
  backends whose executables were found at startup. `GET /api/execution/status` lists
  every known kind, available or not, with its models, so the Repositories page shows
  both tool statuses and the launch form can populate its selector.
- The run's persisted `backend` column already exists; only its CHECK constraint must
  be widened (migration 0007, see Task 1).

### 3. Turn-per-process sessions (the core adapter decision)

Claude Code runs as one long-lived process fed follow-up messages over stdin. Codex's
headless mode (`codex exec`) runs one turn per process and continues a conversation by
resuming a thread id in a fresh process (`codex exec resume <THREAD_ID>` (verified with CLI 0.153.4)).

The Codex adapter hides this completely behind `AgentSession`:

| `AgentSession` operation | Claude adapter | Codex adapter |
| --- | --- | --- |
| `launch()` | spawn once, write prompt line to stdin | spawn `codex exec … --json` with the brief on stdin; remember `thread_id` from the first event |
| process exits after a turn | session ends (`exited` item) | **not** the end of the session: yield `turn-completed`, keep `items` open, wait for `send`/`end` |
| `send(text)` | write another stdin line | if a turn is running, queue `text`; otherwise spawn `codex exec resume <thread_id> --json` with `text`; return `true` |
| `end()` | close stdin, process exits | if a turn is running, end after it finishes; otherwise yield `exited { exitCode: 0 }` and close |
| `kill()` | SIGTERM/SIGKILL the group | terminate the current child if any, drop the queue, yield `exited { signal }` |

Because of this, the daemon's `consume` loop in `agent-run-service.ts` and the run page
work unchanged: `starting → running → waiting → running → … → finished`. The queued
`send` mirrors Claude Code, which also queues a message arriving mid-turn.

Failure semantics: if a Codex process exits non-zero **and** no `turn.completed` event
was seen, the adapter yields `turn-completed { outcome: 'error' }` followed by
`exited { exitCode }`, which the daemon maps to `failed`, matching how a Claude crash
surfaces today. If `resume` fails to start (executable vanished, thread missing), the
adapter yields a `notice`, then `exited { exitCode: 1 }`.

### 4. Browser rules

- `DelegationPanel` gets an `Agent` select before `Role`, rendered only when
  `backends.length > 1`. Its options are the backends from execution status; unavailable
  ones are listed but disabled with "(not found)". Default is the first available.
- The model picker is fed by the **selected** backend's models. Changing the agent
  resets the model to empty (backend default).
- The "not found" warning becomes backend-generic and appears only when **no** backend
  is available; when the selected one is unavailable the launch button is disabled with
  the same generic hint.
- The runs table shows the backend label next to the model when more than one backend
  exists (`Codex · gpt-5`), otherwise it is unchanged.
- The run page already prints `run.backend`; it switches to the label and drops the
  Claude-specific cost sentence in favour of a per-backend one.
- **Remediation** ("Remediate" on a changes-requested review) launches an implement run
  on the backend and model of the latest finished *implement* run for that worktree, if
  one exists, else the review's. Rationale: in an adversarial setup the implementer and
  reviewer are different agents, and remediation belongs to the implementer.
- "Launch review" from the runs table uses the form's currently selected agent and
  model. That is how the operator says "review this with the other agent".

### 5. Capability parity

| Capability | Claude Code | Codex (verified CLI 0.153.4) | Adapter behaviour |
| --- | --- | --- | --- |
| Prompt delivery | stdin stream-json | `codex exec -` reads the prompt from stdin | same: never on argv |
| Working directory | spawn `cwd` | spawn `cwd` (`-C` is available but unnecessary) | same |
| Model | `--model` | `--model` / `-m` | same |
| Permission posture | `--permission-mode` | `-c sandbox_mode="workspace-write"` + `-c approval_policy="never"` (table in §7) | mapped |
| Follow-up message | stdin line | `codex exec resume <thread_id>` new process | hidden (§3) |
| Session id | `session_id` in init | `thread_id` in `thread.started` | `backendSessionId` |
| Brief directory read access | `--add-dir` | not needed for the selected workspace-write policy: external brief reads verified | ignore `additionalDirectories` if verified; else map to the equivalent flag |
| Appended system prompt | `--append-system-prompt` | no flag; not used by the daemon today | emit a `notice` if a request carries one |
| Budget cap | `--max-budget-usd` | none | emit a `notice` if a request carries one |
| Session name | `--name` | none | ignore silently |
| Cost | `total_cost_usd` in result | token `usage` only, no dollars | `costUsd` omitted; UI already prints `—` |
| Billing source | `apiKeySource` | not in the observed stream | `api-key` when `OPENAI_API_KEY` or `CODEX_API_KEY` is set in the child env, else `unknown` |
| Model actually used | `model` in init | absent in the observed stream | the requested model, else `'default'` |
| Git repo check | none | `codex exec` checks the repository; linked worktrees pass without a skip flag | verify a linked worktree passes; add the skip flag only if it does not |

### 6. Event mapping

`VERIFY` every event and field name against the installed CLI's `--json` output. The
names below are the plan author's recollection of the `codex exec --json` schema.

| Codex JSONL | Normalized event | Payload |
| --- | --- | --- |
| `thread.started { thread_id }` | `session-started` | `backend: 'codex'`, `backendSessionId: thread_id`, `model`, `permissionMode`, `cwd`, `billing` |
| `turn.started` | none | |
| `item.started` / `item.completed` type `agent_message` | `assistant-message` on completion only | `text` (bounded to `MESSAGE_TEXT_LIMIT_BYTES`) |
| `item.*` type `reasoning` | none | Claude adapter also drops thinking |
| `item.started` type `command_execution { id, command }` | `tool-call` | `toolUseId: id`, `name: 'command'`, `input: { command }`, `summary: 'Run: <first line>'` |
| `item.completed` type `command_execution { aggregated_output, exit_code }` | `tool-result` | `content` bounded to `TOOL_RESULT_LIMIT_BYTES`, `isError: exit_code !== 0` |
| `item.completed` type `file_change { id, changes: [{path, kind}] }` | `tool-call` then `tool-result` | `name: 'file-change'`, `summary: 'Edited 3 files: a, b, c'`, result `content: ''` |
| `item.completed` type `mcp_tool_call { server, tool, arguments, result }` | `tool-call` then `tool-result` | `name: '<server>/<tool>'` |
| `item.completed` type `web_search { query }` | `tool-call` then `tool-result` | `name: 'web-search'` |
| `item.*` type `todo_list` | none | |
| `item.completed` type `error { message }` | `notice { category: 'other' }` | |
| `turn.completed { usage }` | `turn-completed` | `outcome: 'success'`, `resultText` = last `agent_message` text of this turn, `turns: <adapter counter>`, `durationMs: <adapter clock>`; no `costUsd` |
| `turn.failed { error }` | `turn-completed { outcome: 'error' }` | `resultText: error.message` |
| top-level `error { message }` | `notice` | rate-limit text → `category: 'rate-limit'` |
| unknown line | `notice { category: 'other' }` | same policy as the Claude normalizer |

The review verdict is parsed by the daemon from `resultText` (`brief.ts:parseVerdict`),
so a Codex review returns a verdict with no adapter involvement as long as
`resultText` is the final assistant message.

### 7. Permission mapping (CLI 0.153.4)

Non-interactive Codex cannot answer approval prompts, so every mode uses
`-c approval_policy="never"`, the same way the Claude adapter passes
`--permission-prompts none`.

| CraftingTable mode | Codex flags |
| --- | --- |
| `edit-only` | `-c sandbox_mode="workspace-write" -c approval_policy="never"` |
| `auto` | `-c sandbox_mode="workspace-write" -c approval_policy="never"` (this adapter does not enable Codex automatic approval review; document that `auto` equals `edit-only` on Codex in the launch form hint) |
| `unrestricted` | `--dangerously-bypass-approvals-and-sandbox` |

### 8. Protocol verification

Verified on 2026-09-09 with `codex-cli 0.153.4`, installed help, and official
[non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode),
[CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), and
[models](https://learn.chatgpt.com/docs/models).

Two real turns in a throwaway linked worktree are captured in
`packages/agents/fixtures/codex-stream.jsonl`. Both exited 0. A nonexistent model
emitted `error` and `turn.failed`, exiting 1. An invalid UUID on resume exited 1
with a stderr error and no stdout. Stdout contained JSONL only; diagnostics went
to stderr. Neither model nor billing source appears in the successful stream.
File changes have both started and completed events (the call can be shown live).
The observed command, file, message, thread, turn, and error shapes match §6;
unobserved MCP/search variants are handled defensively, with unknowns becoming notices.

`exec` has no `--ask-for-approval` flag; use the config override. `resume` has no
`--sandbox` flag; use `-c sandbox_mode="workspace-write"` for both commands and
`-c approval_policy="never"`. Both overrides were accepted in the real capture.
`unrestricted` uses the explicit bypass flag. `--add-dir` grants write access and
is unnecessary for read-only brief access: the capture read a file outside cwd.
Model IDs below use the current documented model list; availability depends on login.

### Original verification checklist

Confirm and correct in place before Task 5:

- [x] Exact subcommand and flags: `codex exec`, `--json`, `-m/--model`, `--sandbox`,
      `--ask-for-approval`/`-a`, `--dangerously-bypass-approvals-and-sandbox`, `-C`,
      `--skip-git-repo-check`, reading the prompt from stdin with `-`.
- [x] Resume: `codex exec resume <THREAD_ID> [PROMPT]`, whether it accepts `--json`,
      the same sandbox flags, and stdin for the prompt.
- [x] The captured JSONL event and item type names and field names in §6, including where
      `thread_id` appears and whether the model name appears anywhere.
- [x] Whether `--json` output is line-delimited and whether any non-JSON lines are
      printed to stdout (progress, banners) that the normalizer must tolerate.
- [x] Exit code conventions: success, turn failure, invalid thread on resume.
- [x] Whether a linked Git worktree passes the Git repository check.
- [x] Whether read access outside `cwd` is allowed under `workspace-write`.
- [x] How Codex signals the credential source, if at all.

---

## File structure

**Domain and contracts**
- Modify `packages/domain/src/execution.ts` — widen `AGENT_BACKENDS`, add `AGENT_BACKEND_LABELS`.
- Modify `packages/contracts/src/execution.ts` — `backend` on `startAgentRunRequestSchema`.

**Storage**
- Create `packages/storage/migrations/0007-agent-backends.sql` — rebuild `agent_runs` with the widened CHECK.
- Modify `packages/storage/src/migrations.ts` — honour a `-- requires: foreign_keys=off` header.
- Create `packages/storage/src/migration-0007.test.ts`.

**Daemon**
- Modify `apps/server/src/config.ts` — `codexExecutable`, `codexModels`.
- Modify `apps/server/src/composition.ts` — backend registry, status lists both kinds.
- Modify `apps/server/src/services/agent-run-service.ts` — accept `ReadonlyMap`, select by `input.backend`.
- Modify `apps/server/src/services/execution-service.ts:113-118` — status type is already plural; widen `kind`.
- Modify `apps/server/src/server-execution.test.ts` — two scripted backends, selection, default.

**Agents package**
- Move `packages/agents/src/claude-code/process.ts` → `packages/agents/src/process.ts` (shared supervision).
- Create `packages/agents/src/codex/arguments.ts` — pure argv builder, resume argv builder.
- Create `packages/agents/src/codex/models.ts` — `CODEX_MODELS`, reuse `parseModelList`.
- Create `packages/agents/src/codex/normalize.ts` — `CodexStreamNormalizer`.
- Create `packages/agents/src/codex/session.ts` — `CodexSession`: turn-per-process state machine.
- Create `packages/agents/src/codex/backend.ts` — `CodexBackend`.
- Create `packages/agents/fixtures/codex-stream.jsonl` — captured from a real run.
- Create tests beside each module.
- Modify `packages/agents/src/index.ts` — exports; move `parseModelList` out of `claude-code/models.ts` into `packages/agents/src/models.ts`.
- Modify `scripts/check-forbidden-scope.mjs:47-50` — process authority path.

**Browser**
- Modify `apps/web/src/features/execution/DelegationPanel.tsx` — agent select, per-backend models, generic copy, backend column.
- Modify `apps/web/src/features/execution/RunPage.tsx:321-338` — label and cost sentence.
- Modify `apps/web/src/App.tsx:1136-1143,785-797` — pass backends, remediation backend choice.
- Modify `apps/web/src/features/execution/execution-views.test.tsx`.

**End to end and docs**
- Create `e2e/fake-codex.mjs`; modify `playwright.config.ts`, `apps/server/src/e2e-entry.ts`, `e2e/delegation.spec.ts`.
- Create `docs/decisions/ADR-022-codex-backend-and-turn-per-process-sessions.md`.
- Modify `README.md:128-129`, `docs/architecture.md:73-86`, `docs/operations.md:49`.

---

### Task 1: Backend vocabulary, request contract, and migration 0007

**Files:**
- Modify: `packages/domain/src/execution.ts:77-78`
- Modify: `packages/contracts/src/execution.ts:290-297`
- Modify: `packages/storage/src/migrations.ts:157-183`
- Create: `packages/storage/migrations/0007-agent-backends.sql`
- Test: `packages/storage/src/migration-0007.test.ts`, `packages/contracts/src/execution.test.ts` (create if absent; the sibling `*.test.ts` files show the style)

**Interfaces:**
- Produces: `AGENT_BACKENDS = ['claude-code', 'codex']`, `AGENT_BACKEND_LABELS: Readonly<Record<AgentBackendKind, string>>`, `StartAgentRunRequest.backend?: AgentBackendKind`.

- [ ] **Step 1: Widen the domain vocabulary**

```ts
// packages/domain/src/execution.ts
export const AGENT_BACKENDS = ['claude-code', 'codex'] as const;
export type AgentBackendKind = (typeof AGENT_BACKENDS)[number];

/** Operator-facing names, shared by the daemon's status endpoint and the browser. */
export const AGENT_BACKEND_LABELS: Readonly<Record<AgentBackendKind, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};
```

- [ ] **Step 2: Add `backend` to the start-run request**

```ts
// packages/contracts/src/execution.ts, inside startAgentRunRequestSchema
  /** Which agent runs it; absent means the daemon's first available backend. */
  backend: z.enum(AGENT_BACKENDS).optional(),
```

Write a contract test asserting that `{ worktreeId, backend: 'codex' }` parses, that
`backend: 'gemini'` is rejected, and that the field is optional.

- [ ] **Step 3: Teach the migration runner about foreign keys**

`runMigrations` executes each file inside an immediate transaction with
`foreign_keys = ON` (`database.ts:14`). Rebuilding `agent_runs` requires dropping a
table that `agent_run_events` and `agent_runs.parent_run_id` reference, which fails
with foreign keys on, and the pragma is a no-op inside a transaction. Add a header
convention:

```ts
// packages/storage/src/migrations.ts
const FOREIGN_KEYS_OFF_HEADER = /^--\s*requires:\s*foreign_keys=off\s*$/m;

// inside runMigrations, per migration:
const foreignKeysOff = FOREIGN_KEYS_OFF_HEADER.test(migration.sql);
if (foreignKeysOff) database.pragma('foreign_keys = OFF');
try {
  database.transaction(() => {
    /* existing body */
    if (foreignKeysOff) {
      const violations = database.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`Migration ${migration.version} left ${violations.length} foreign key violations`);
      }
    }
  }).immediate();
} finally {
  if (foreignKeysOff) database.pragma('foreign_keys = ON');
}
```

- [ ] **Step 4: Write migration 0007 as a table rebuild**

```sql
-- 0007-agent-backends.sql
-- requires: foreign_keys=off
--
-- Widens agent_runs.backend to admit 'codex'. SQLite cannot alter a CHECK in
-- place, so the table is rebuilt (the documented twelve-step procedure): create
-- the new table, copy rows, drop the old table, rename, recreate the indexes.
-- Foreign keys are off for this migration; the runner verifies
-- foreign_key_check is clean before committing.

CREATE TABLE agent_runs_new (
    -- copy every column and constraint from 0005 plus the 0006 ALTERs
    -- (resolved_model, billing, verdict) verbatim, changing only:
    backend            TEXT NOT NULL CHECK (backend IN ('claude-code', 'codex')),
    -- …
) STRICT;

INSERT INTO agent_runs_new SELECT
    id, workspace_id, worktree_id, repository_id, project_id, work_item_id,
    parent_run_id, backend, role, status, permission_mode, model, brief,
    backend_session_id, created_at, created_by_user_id, started_at, finished_at,
    exit_code, outcome_summary, cost_usd, turn_count, version,
    resolved_model, billing, verdict
  FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_work_item ON agent_runs (workspace_id, work_item_id, created_at, id);
CREATE INDEX idx_agent_runs_worktree  ON agent_runs (workspace_id, worktree_id, created_at, id);
CREATE INDEX idx_agent_runs_status    ON agent_runs (status, workspace_id);
```

Copy the column list and index names from `0005-execution.sql:82-127` and the three
`ALTER TABLE agent_runs ADD COLUMN` lines in `0006-workflow.sql:26-31`; do not
paraphrase them. Keep the column order identical to the old table so the
`INSERT … SELECT` is positional-safe; then list columns explicitly anyway.

- [ ] **Step 5: Test the migration**

Following `migration-0004.test.ts`: open a temp database, run migrations through 0006,
insert a workspace, user, repository, worktree, work item, one `agent_runs` row with
`backend = 'claude-code'` and one `agent_run_events` row pointing at it, then run 0007
and assert: the run row survives with every column intact, the event row still joins,
`PRAGMA foreign_key_check` is empty, `PRAGMA foreign_keys` is back to 1, inserting a
run with `backend = 'codex'` succeeds, and `backend = 'other'` fails the CHECK.

- [ ] **Step 6: Run the checks and commit**

```bash
pnpm typecheck && pnpm test
git add packages/domain packages/contracts packages/storage
git commit -m "Admit a codex backend kind and widen the runs table to store it"
```

---

### Task 2: Daemon backend registry and selection

**Files:**
- Modify: `apps/server/src/config.ts:25-39,299-331`
- Modify: `apps/server/src/composition.ts:59-60,110-158`
- Modify: `apps/server/src/services/agent-run-service.ts:38-45,88-123,225-300`
- Modify: `apps/server/src/services/execution-service.ts:113-118`
- Modify: `README.md:128-129`
- Test: `apps/server/src/server-execution.test.ts`, `apps/server/src/config.test.ts` (exists beside `config.ts`; extend)

**Interfaces:**
- Consumes: `AGENT_BACKENDS`, `AGENT_BACKEND_LABELS`, `StartAgentRunRequest.backend`.
- Produces: `AgentRunService` constructor takes `backends: ReadonlyMap<AgentBackendKind, AgentBackend>`; `AgentRunService.defaultBackend(): AgentBackendKind | undefined`; `StartRunInput.backend?: AgentBackendKind`; composition override `agentBackends?: ReadonlyMap<AgentBackendKind, AgentBackend>` replacing `agentBackend`.

- [ ] **Step 1: Config**

Add `codexExecutable?: string` and `codexModels?: string` to `ExecutionConfig`, read
from `CRAFTINGTABLE_CODEX_EXECUTABLE` and `CRAFTINGTABLE_CODEX_MODELS`, validated the
same way as the Claude variables in `config.ts:299-306`. Extend the config test with a
relative-path rejection for the new variable.

- [ ] **Step 2: Registry in composition**

Replace the single `agentBackend` with:

```ts
const backends = new Map<AgentBackendKind, AgentBackend>();
if (overrides.agentBackends === undefined) {
  const claude = resolveExecutable('claude', config.execution.claudeExecutable, process.env, [join(homedir(), '.local', 'bin')]);
  if (claude !== undefined) {
    backends.set('claude-code', new ClaudeCodeBackend({ executable: claude, models: parseModelList(config.execution.claudeModels, CLAUDE_CODE_MODELS) }));
  }
  const codex = resolveExecutable('codex', config.execution.codexExecutable, process.env, [join(homedir(), '.local', 'bin')]);
  if (codex !== undefined) {
    backends.set('codex', new CodexBackend({ executable: codex, models: parseModelList(config.execution.codexModels, CODEX_MODELS) }));
  }
} else {
  for (const [kind, backend] of overrides.agentBackends) backends.set(kind, backend);
}
```

`CodexBackend` does not exist until Task 7. For this task, register only Claude and
leave a one-line `// Task 7 adds CodexBackend here` marker, or land Task 2 after Task 7;
either order compiles. The status function lists **every** kind in `AGENT_BACKENDS`:

```ts
backends: AGENT_BACKENDS.map((kind) => {
  const backend = backends.get(kind);
  return {
    kind,
    label: AGENT_BACKEND_LABELS[kind],
    available: backend !== undefined,
    ...(backend === undefined ? {} : { executable: backend.describe().executable }),
    models: backend === undefined ? [] : backend.describe().models,
  };
}),
```

`parseModelList` gains a second parameter, the fallback list, so it serves both
backends (Task 4 moves it to `packages/agents/src/models.ts`).

- [ ] **Step 3: Selection in `AgentRunService.start`**

```ts
const kind = input.backend ?? this.defaultBackend();
const backend = kind === undefined ? undefined : this.backends.get(kind);
if (backend === undefined) {
  throw new ExecutionRequestError(
    'unavailable',
    kind === undefined
      ? 'No agent executable was found; install Claude Code or Codex, or set CRAFTINGTABLE_CLAUDE_EXECUTABLE / CRAFTINGTABLE_CODEX_EXECUTABLE'
      : `${AGENT_BACKEND_LABELS[kind]} was not found on this workstation`,
  );
}
```

`defaultBackend()` returns the first kind in `AGENT_BACKENDS` present in the map.
`backendAvailable()` becomes `this.backends.size > 0`. Everything downstream already
uses `backend.kind`.

- [ ] **Step 4: Tests**

In `server-execution.test.ts`, give `ScriptedBackend` a constructor parameter for its
`kind` and add cases:

1. status lists both kinds with `available` flags reflecting the map;
2. a run with no `backend` uses `claude-code` when both are present;
3. a run with `backend: 'codex'` records `backend: 'codex'` on the run, the audit
   metadata, and the `agent-run-started` workspace event;
4. a run with `backend: 'codex'` when only Claude is registered returns the
   `unavailable` error naming Codex;
5. with only Codex registered, a run with no `backend` uses Codex.

- [ ] **Step 5: README**

Add the two environment variables to the table at `README.md:128-129` and mention
Codex beside Claude Code in the prerequisites at `README.md:52`.

- [ ] **Step 6: Checks and commit**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
git add apps/server README.md
git commit -m "Let the daemon hold several agent backends and pick one per run"
```

---

### Task 3: Browser agent selector and parity copy

**Files:**
- Modify: `apps/web/src/features/execution/DelegationPanel.tsx`
- Modify: `apps/web/src/features/execution/RunPage.tsx:321-340`
- Modify: `apps/web/src/App.tsx:785-797,1130-1145`
- Test: `apps/web/src/features/execution/execution-views.test.tsx`

**Interfaces:**
- Consumes: `ExecutionStatusResponse.backends`, `AGENT_BACKEND_LABELS`, `LaunchInput.backend`.
- Produces: `DelegationPanel` props `backends: ExecutionStatusResponse['backends']` replacing `models` and `backendAvailable`; `LaunchInput.backend?: AgentBackendKind`.

- [ ] **Step 1: Replace the two props with one**

`DelegationPanel` takes `backends`. Derive inside the component:

```ts
const availableBackends = backends.filter((b) => b.available);
const [backendKind, setBackendKind] = useState<AgentBackendKind | ''>('');
const selectedBackend =
  backends.find((b) => b.kind === backendKind) ?? availableBackends[0];
const models = selectedBackend?.models ?? [];
const anyAvailable = availableBackends.length > 0;
```

- [ ] **Step 2: Render the selector only when there is a choice**

Place it in the same `form-row` as Worktree and Role, before Role:

```tsx
{backends.length > 1 && (
  <label className="field">
    Agent
    <select
      value={selectedBackend?.kind ?? ''}
      onChange={(event) => { setBackendKind(event.target.value as AgentBackendKind); setModel(''); }}
      disabled={busy}
    >
      {backends.map((b) => (
        <option key={b.kind} value={b.kind} disabled={!b.available}>
          {b.label}{b.available ? '' : ' (not found)'}
        </option>
      ))}
    </select>
  </label>
)}
```

Include `backend: selectedBackend.kind` in the `onLaunch` payload whenever
`backends.length > 1`, so the daemon default still applies for single-backend
installs. Replace the warning copy at `DelegationPanel.tsx:426-431` with
"No agent executable was found on the workstation, so runs cannot start. See the
Repositories page for the tool status." The permission hint for `auto` reads
"On Codex this is the same as edit-only" when the selected backend is `codex`.

- [ ] **Step 3: Runs table and run page**

In the runs table cell at `DelegationPanel.tsx:576`, prefix the model with
`AGENT_BACKEND_LABELS[run.backend] · ` when `backends.length > 1`. In `RunPage.tsx:321`
print `AGENT_BACKEND_LABELS[run.backend]`; at `:338` choose the sentence by backend:
Claude keeps the existing text, Codex says "Codex reports token usage but no cost;
the figure is unavailable."

- [ ] **Step 4: Remediation backend**

In `App.tsx:785-797`, `handleRemediate` receives the review run; look up the runs for
that worktree from the loaded execution projection, take the latest finished run with
`role === 'implement'`, and use its `backend` and `model`; fall back to the review's.
Pass `backend` through `handleLaunch`.

- [ ] **Step 5: Wire `App.tsx`**

Replace the `models=` and `backendAvailable=` props at `App.tsx:1136-1143` with
`backends={executionStatus?.backends ?? []}`.

- [ ] **Step 6: Component tests**

In `execution-views.test.tsx` add: (a) with one backend, no "Agent" select is rendered
and the launch payload carries no `backend`; (b) with two, the select is rendered,
the model picker lists only the selected backend's models, changing the agent clears
the model, and the launch payload carries `backend: 'codex'`; (c) an unavailable
backend appears disabled with "(not found)".

- [ ] **Step 7: Checks and commit**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
git add apps/web
git commit -m "Offer an agent selector on the launch form when several backends exist"
```

---

### Task 4: Share process supervision across adapters

**Files:**
- Move: `packages/agents/src/claude-code/process.ts` → `packages/agents/src/process.ts`
- Move: `parseModelList` from `packages/agents/src/claude-code/models.ts` → `packages/agents/src/models.ts` (with the fallback parameter)
- Modify: `packages/agents/src/claude-code/backend.ts:16`, `packages/agents/src/index.ts`
- Modify: `scripts/check-forbidden-scope.mjs:47-50`

- [ ] **Step 1: Move the module with `git mv`, update the import, and rename the scope entry**

```js
// scripts/check-forbidden-scope.mjs
['packages/agents/src/process.ts', 'Agent backend process supervision'],
```

Update the doc comment at the top of `process.ts` to say it serves every backend.

- [ ] **Step 2: Run the scope check and tests**

```bash
pnpm check:scope && pnpm test
git add -A packages/agents scripts
git commit -m "Share the supervised process module between agent backends"
```

---

### Task 5: Codex argument builders and model list

**Files:**
- Create: `packages/agents/src/codex/arguments.ts`, `packages/agents/src/codex/models.ts`
- Test: `packages/agents/src/codex/arguments.test.ts`

**Interfaces:**
- Produces:

```ts
export function codexExecArguments(request: AgentLaunchRequest): readonly string[];
export function codexResumeArguments(threadId: string, request: AgentLaunchRequest): readonly string[];
export const CODEX_MODELS: readonly AgentModelOption[];
```

Complete the `VERIFY` checklist (§8) before this task and correct §5 to §7 in place.

- [ ] **Step 1: Write the exact-argv tests first**

Mirror `normalize.test.ts:14-45` for Claude: one test per permission mode, one with a
model, one for resume. Expected vectors are whatever the verified flags are, for example:

```ts
expect(codexExecArguments({ cwd: '/work/x', prompt: 'do it', permissionMode: 'edit-only', model: 'gpt-5' }))
  .toEqual(['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '--model', 'gpt-5', '-']);
expect(codexResumeArguments('thread-1', { cwd: '/work/x', prompt: 'more', permissionMode: 'unrestricted' }))
  .toEqual(['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox', 'thread-1', '-']);
```

- [ ] **Step 2: Implement the builders**

Pure functions, discrete argv entries, prompt never in argv (delivered on stdin).
The unsupported request fields (`appendSystemPrompt`, `maxBudgetUsd`, `sessionName`,
`additionalDirectories`) are ignored here; Task 7 emits the notices.

- [ ] **Step 3: Model list**

```ts
export const CODEX_MODELS: readonly AgentModelOption[] = [
  // VERIFY current ids against the docs; keep the same "id, label" shape as CLAUDE_CODE_MODELS
];
```

- [ ] **Step 4: Checks and commit**

```bash
pnpm typecheck && pnpm test
git add packages/agents/src/codex
git commit -m "Build Codex exec and resume argument vectors"
```

---

### Task 6: Codex stream normalizer with a captured fixture

**Files:**
- Create: `packages/agents/fixtures/codex-stream.jsonl`
- Create: `packages/agents/src/codex/normalize.ts`
- Test: `packages/agents/src/codex/normalize.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CodexNormalizerOptions {
  readonly permissionMode: AgentPermissionMode;
  readonly cwd: string;
  readonly requestedModel?: string;
  readonly billing: AgentBillingSource;
}
export class CodexStreamNormalizer {
  constructor(options: CodexNormalizerOptions);
  /** Translate one stdout line; returns zero or more events. */
  normalizeLine(line: string): readonly NormalizedAgentEvent[];
  /** The thread id seen so far, for resume. */
  threadId(): string | undefined;
  /** True once a turn.completed or turn.failed has been seen since the last reset. */
  turnEnded(): boolean;
  /** Called by the session before each resumed process so per-turn state restarts. */
  beginTurn(): void;
}
```

- [ ] **Step 1: Capture the fixture**

Run a real, cheap Codex session in a throwaway Git repository and save its JSONL:

```bash
mkdir -p /tmp/codex-fixture && cd /tmp/codex-fixture && git init -q
echo 'Create a file named HELLO.md containing the word hello, then run `ls`.' \
  | codex exec --json -c sandbox_mode="workspace-write" -c approval_policy="never" - \
  > ~/src/craftingtable/packages/agents/fixtures/codex-stream.jsonl
```

Then resume it once with a second prompt and append that output to the same file, so
the fixture holds two turns. Redact nothing that is not a secret; do check that no
token or home path leaked into it.

- [ ] **Step 2: Write the tests against the fixture**

Follow `claude-code/normalize.test.ts`: feed every fixture line through one normalizer
and assert the event sequence kinds, the `session-started` payload (thread id,
`backend: 'codex'`, billing from options, model = requested or `'default'`), that a
`command_execution` yields `tool-call` then `tool-result` with `isError` from the exit
code, that a `file_change` yields a call whose summary names the files, that
`turn-completed.resultText` equals the last agent message, that a truncated tool
output sets `truncated: true`, that an unknown line becomes a bounded `notice`, and that
`raw` is bounded to `RAW_LINE_LIMIT_BYTES`.

- [ ] **Step 3: Implement**

Reuse the bounded-text helpers by exporting `truncateUtf8`, `boundedRaw`,
`boundedJson`, `isRecord`, `stringOf`, `firstLine` and the limit constants from a new
`packages/agents/src/bounded.ts` and importing them from both normalizers, so the two
adapters share one truncation policy. Treat every line as untrusted: `JSON.parse` in a
try, unknown `type` → `notice`, missing fields → empty strings, never throw.

- [ ] **Step 4: Checks and commit**

```bash
pnpm typecheck && pnpm test
git add packages/agents
git commit -m "Normalize Codex exec JSONL into run events"
```

---

### Task 7: Codex session and backend

**Files:**
- Create: `packages/agents/src/codex/session.ts`, `packages/agents/src/codex/backend.ts`
- Modify: `packages/agents/src/index.ts` (export `CodexBackend`, `CODEX_MODELS`)
- Modify: `apps/server/src/composition.ts` (register `CodexBackend`, from Task 2's marker)
- Test: `packages/agents/src/codex/backend.test.ts`

**Interfaces:**
- Consumes: `spawnSupervisedProcess` (Task 4), `codexExecArguments`/`codexResumeArguments` (Task 5), `CodexStreamNormalizer` (Task 6).
- Produces: `class CodexBackend implements AgentBackend` with `kind = 'codex'`, options `{ executable, env?, terminationGraceMs?, models? }`, identical in shape to `ClaudeCodeBackendOptions`.

- [ ] **Step 1: Write the session state machine**

```ts
type SessionState =
  | { readonly phase: 'turn-running'; readonly child: SupervisedProcess }
  | { readonly phase: 'awaiting-input' }
  | { readonly phase: 'closed' };

export class CodexSession implements AgentSession {
  private state: SessionState;
  private readonly queuedMessages: string[] = [];
  private endRequested = false;
  private killed = false;
  private readonly output = new AsyncQueue<AgentSessionItem>(); // export AsyncQueue from process.ts
  readonly items = this.output;
  pid: number | undefined;

  send(text: string): boolean {
    if (this.state.phase === 'closed' || this.endRequested) return false;
    this.queuedMessages.push(text);
    if (this.state.phase === 'awaiting-input') void this.startNextTurn();
    return true;
  }
  end(): void { /* mark endRequested; if awaiting-input, close now with exit 0 */ }
  kill(): void { /* terminate child if any, clear queue, close with the signal */ }
}
```

`startNextTurn` shifts a queued message, spawns `codex exec resume <threadId>` with
the message on stdin, pipes lines through the normalizer, and on `exited`:

- if `normalizer.turnEnded()` and exit code 0 → state `awaiting-input`; then if another
  message is queued start it, else if `endRequested` close with `exited { exitCode: 0 }`;
- else → yield `turn-completed { outcome: 'error', resultText: <stderr tail or 'Codex exited without completing the turn'> }`, then `exited { exitCode }`, state `closed`.

The first turn uses `codexExecArguments` and the brief; it is started by `launch`.

- [ ] **Step 2: Unsupported request fields**

In `CodexBackend.launch`, before spawning, yield a `notice` for each of
`appendSystemPrompt` and `maxBudgetUsd` present in the request:
`"Codex does not support a budget cap; the request's $5 limit was ignored"`.

- [ ] **Step 3: Tests with a fake `codex`**

Copy the pattern in `claude-code/backend.test.ts:14-40`: a Node script written to a
temp directory that inspects `process.argv` and prints JSONL. Cases:

1. `launch` yields `session-started` with the thread id, then `turn-completed`, and the
   session does **not** yield `exited` when the child exits.
2. `send('again')` spawns a second process whose argv contains `resume` and the thread
   id and whose stdin received `again`; the session yields a second `turn-completed`.
3. `send` during a running turn returns `true` and the message runs after the current
   one (the fake sleeps briefly; assert two processes ran in order).
4. `end()` while awaiting input yields `exited { exitCode: 0 }` and closes `items`.
5. `end()` during a turn finishes that turn first.
6. `kill()` during a turn terminates the child (the fake ignores SIGTERM under
   `FAKE_IGNORE_TERM=1`, exercising SIGKILL) and yields `exited` with the signal.
7. a non-zero exit without `turn.completed` yields `turn-completed { outcome: 'error' }`
   then `exited { exitCode: 2 }`.
8. in `apps/server/src/services/executables.test.ts` (create beside `executables.ts` if absent), `resolveExecutable('codex', undefined, env)` finds the fake through `PATH`.

- [ ] **Step 4: Register in composition and re-run the daemon tests**

Replace Task 2's marker with the `CodexBackend` construction shown there.

- [ ] **Step 5: Checks and commit**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm check:scope
git add packages/agents apps/server/src/composition.ts
git commit -m "Add the Codex backend with turn-per-process sessions"
```

---

### Task 8: End-to-end run on Codex, ADR, and docs

**Files:**
- Create: `e2e/fake-codex.mjs`
- Modify: `playwright.config.ts:4-5,40`, `apps/server/src/e2e-entry.ts:18-20`, `e2e/delegation.spec.ts`
- Create: `docs/decisions/ADR-022-codex-backend-and-turn-per-process-sessions.md`
- Modify: `docs/architecture.md:73-86`, `docs/operations.md:49`, `docs/decisions/ADR-005-codex-integration.md` (status line: superseded by ADR-022)

- [ ] **Step 1: Fake Codex for the browser suite**

`e2e/fake-codex.mjs` mirrors `e2e/fake-claude.mjs` in the Codex JSONL: on `exec` it
emits `thread.started`, a `command_execution` item, a `file_change` item that writes
and commits `SMOKE-<n>.md`, an `agent_message`, and `turn.completed`, then exits 0. On
`exec resume <id>` it does the same with the next number. When the prompt contains the
review role marker it emits a message ending in `VERDICT: mergeable` and changes no
files. Pass it through `CRAFTINGTABLE_CODEX_EXECUTABLE` in `playwright.config.ts` and
`e2e-entry.ts` exactly like the Claude variable.

- [ ] **Step 2: Extend the delegation spec**

After the existing Claude implement run and its review, add: select "Codex" in the
`Agent` select, launch a review run, assert the run heading, assert the feed shows the
Codex command summary and the verdict, assert the merge gate opens, and merge. Then
launch a Codex implement run with a follow-up message and assert a second turn ran
(`SMOKE-2.md` appears in the diff) and "Awaiting your input" shows between turns. Also
assert the Repositories page lists both tools.

- [ ] **Step 3: ADR-022**

Record: Codex as the second backend via `codex exec --json`; the turn-per-process
session hidden behind `AgentSession` so run states and UI are unchanged; `auto` equals
`edit-only` on Codex; no cost figure; default backend order; remediation follows the
implementer's backend. Mark ADR-005 superseded by ADR-022.

- [ ] **Step 4: Architecture and operations docs**

In `docs/architecture.md` "Agent backend seam", add a paragraph on the Codex adapter
beside the Claude one and the shared `process.ts`. In `docs/operations.md:49`, note
that the service account must also be signed in to Codex (`codex login`) for that
backend to be available.

- [ ] **Step 5: Full check and commit**

```bash
pnpm check
git add e2e playwright.config.ts apps/server/src/e2e-entry.ts docs
git commit -m "Run the browser suite against a fake Codex and record the decision"
```

---

## Out of scope

- Automating the implement/review/remediate cycle. Roles and `parentRunId` remain the
  orchestration seam; this plan adds no new run or event kinds, which is the check
  that it has not pre-empted the orchestrator.
- The Codex app-server protocol (ADR-005's original target). `exec --json` is enough
  for parity with what the Claude adapter offers today; app-server can replace the
  session module later without touching the daemon.
- Approval prompts relayed to the browser, for either backend.
- Resuming a Codex thread after a daemon restart. Interrupted runs stay `interrupted`
  for both backends, as today.

## Self-review

- Every Design section maps to a task: §1 → Task 1, §2 → Tasks 1–2, §3 → Task 7, §4 →
  Task 3, §5–§7 → Tasks 5–7, §8 → gate before Task 5.
- Names used across tasks: `AGENT_BACKEND_LABELS` (T1, T2, T3), `StartRunInput.backend`
  (T2, T3), `codexExecArguments`/`codexResumeArguments` (T5, T7),
  `CodexStreamNormalizer` with `threadId`/`turnEnded`/`beginTurn` (T6, T7),
  `spawnSupervisedProcess`/`AsyncQueue` from `packages/agents/src/process.ts` (T4, T7),
  `parseModelList(value, fallback)` (T2, T4).
- Deliberately unresolved: the exact Codex flag and event names, marked `VERIFY`, to be
  settled by the implementer against current documentation before Task 5.
