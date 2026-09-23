# Target architecture

This is the design that the controller, attention, read-side and data items in the
[register](register.md) converge on. It combines the target designs in the CTRL, NOTIF, PERF
and DATA reports into one picture.

It is a direction, not a contract. Record material decisions as short ADRs when an item lands.
Everything here keeps existing plan bundles, v0.3 maps, saved roadmap definitions and
persisted records valid: new fields are optional and derived when absent, and migrations only
move forward.

## 1. The core idea: attention is declared, typed and owned

Today, whether something "needs the operator" is inferred in at least ten places from status,
free-text reasons and predictions of what automation might do next (CTRL-05, NOTIF-02). The
target inverts this.

**The component that decides a transition also declares who acts next**, in the same
transaction as the state change.

```ts
// packages/domain (sketch)
type AttentionOwner = 'operator' | 'controller';

interface Attention {
  readonly code: AttentionCode;          // closed vocabulary, below
  readonly owner: AttentionOwner;        // controller-owned attention is never pushed
  readonly subject: AttentionSubject;    // cycleId | roadmapId+entryId | checkpointId | decisionId | ...
  readonly message: string;              // display only; never parsed
  readonly actions: readonly AttentionAction[]; // the only operator actions that can make progress
  readonly refs?: AttentionRefs;         // plan/roadmap node ids, blocking items, evidence ids
  readonly openedAt: string;
}
```

- Cycles, roadmap entries/holds, roadmap status and finalization carry an optional `attention`,
  written by the decision code. A `PhaseBlocker` gains `code` and `owner`.
- Records written before this change get their attention derived on read by **one** tested
  legacy-mapping function. That function is the only place allowed to look at old reason
  strings. (R-A3)
- `awaiting-merge` stays in the DB enum for compatibility, but gains a typed gate:
  `operator-merge | promotion | record-evidence | automatic-merge | controller-wait |
  scheduling-held`. Only `operator-merge` and `promotion` are operator-owned. (CTRL-10)
- The UI, the notification outbox, the rail badge, the inbox and the board read attention.
  None of them re-derive it.

### Initial attention code catalogue

This list is seeded from the live stop reasons ranked in HIST-03 and the inbox kinds in UI-01.
Treat it as a starting point; the rule is that every blocking transition maps to exactly one
code.

**Operator-owned (appear in the inbox; may be pushed once settled)**

| Code | Typical source today | Valid actions |
|---|---|---|
| `merge-approval` | standalone/manual-policy review passed | merge, review again, stop |
| `final-promotion` | finalization candidate approved by review | approve promotion (exact commits), stop |
| `architecture-decision` | design needs a shared decision (ADR-059/065) | approve / approve limited / edit / request clarification |
| `agent-question` | implement/review/finalization ended with genuine open questions | answer and continue (guidance) |
| `remediation-exhausted` | remediation allowance spent with open findings | grant rounds (with optional guidance), stop |
| `no-progress` | same findings after N rounds; repair loop not converging | guidance, propose split (amendment), stop |
| `integration-conflict` | conflict under manual conflict policy | delegate resolution, resolve manually, abandon |
| `evidence-review` | checkpoint the map marks as human-required; plan acceptance | accept / reject with rationale |
| `environment-approval` | verification environment awaiting approval | audit and approve |
| `reviewer-assignment` | evidence profile needs an unassigned reviewer role | assign responsibilities |
| `map-adoption`, `amendment-decision`, `dependency-refresh-approval` | cross-project supervision | the corresponding decision |
| `provider-exhausted` | automatic provider retries used up | retry now, change agent, stop |
| `step-failed` | agent run failed for a non-provider reason | retry with guidance, stop |
| `restart-resume` | **unclean** interruption only | resume |
| `setup-required` | missing branch settings, bindings, profiles | open the setup step |
| `storage-pressure` | volume below reserve (with hysteresis) | open storage settings |

**Controller-owned (visible as status; never pushed)**

| Code | Meaning |
|---|---|
| `waiting-dependency`, `waiting-evidence` | a predecessor or controller-produced evidence is not ready yet |
| `waiting-capacity`, `waiting-resource`, `repository-busy` | admission or lock contention; retried automatically |
| `provider-backoff` | ADR-062 retry scheduled |
| `output-repair` | automatic re-prompt after an agent-output validation failure (R-C2) |
| `reassessment-pending`, `refresh-queued`, `scope-recovery-pending`, `automatic-merge-pending`, `recording-evidence` | the controller will act on its next pass |
| `scheduling-held` | the roadmap is paused by the operator (the pause itself was the decision) |

When automation gives up, it flips the owner to `operator` and changes the code in the same
transaction, for example `output-repair` → `agent-question` after two failed repairs.

## 2. Attention persistence and notifications

```text
controller transaction (cycle / roadmap / finalization / storage)
  ├─ state + audit + workspace event                      (ADR-010, unchanged)
  └─ upsert attention_items(subjectKey, code) {owner, message, refs, openedAt, openedGeneration}
     or close it {resolvedAt, resolvedBy: operator | automation | superseded}

AttentionService (read side; the single source of truth)
  ├─ GET /workspaces/:ws/attention  + `attention-changed` SSE event
  └─ eligible(item) = owner = operator
                    ∧ age ≥ settle (10–30 s)
                    ∧ every controller worker finished a pass started after openedGeneration
                    ∧ ¬(operator present ∧ age < presence grace)
                    ∧ subject not owned by an in-flight command

NotificationOutbox (delivery only)
  ├─ one digest per workspace per wake: newly eligible items + due reminders
  ├─ append-only notification_deliveries(itemIds, attempt, result)
  └─ reminder text rendered from the item's current state
```

Properties:

- One definition of "needs you".
- No pages for controller-owned or transitional states.
- A blocker keeps its identity across version bumps and rewording.
- History is auditable, so false alarms (`resolvedBy = automation ∧ delivered`) can be
  measured directly. (R-A1, R-A4)

The occurrence key is `subjectKey + code`, never the aggregate version. Set-valued alerts
(checkpoints, environments) re-page only when the set grows.

## 3. Controller kernel and decision core

```text
                 events (run status, command, evidence/merge change, timer due)
                                     │
                             ControllerKernel
         dirty set + precise timers + per-aggregate async mutex + bounded pool
            │                         │                            │
   CycleReconciler           RoadmapScheduler           FinalizationCoordinator
   facts ← one snapshot      admission/attempts only    stage ledger + promotion
   decide(state, facts)      (pure selection policy)    (pure stage policy)
     → Decision {launch | wait(code) | attention(code) | approve | effect | complete}
            │
   Effects: RunSupervisor (launch/supervise/journal) · RunContext (documents + brief)
            GitEffects (checkpoint/refresh/resolution) · MergeExecutor · EvidenceRecorder
            │
   Same transaction: aggregate state + Attention + audit + workspace event
```

- **Decision core (R-B4).** `CycleFacts` are built once from one read snapshot. They contain
  the latest run and turn, parsed reports (**one** open-questions parser, one report parser),
  gates, ownership, deadlines and budgets. `decide()` is pure, with an explicit ordered list of
  named guards, so precedence is written down instead of implied by `if` order. The valid
  operator actions come from the same code (R-A7), so Resume can never be accepted when it
  cannot help.
- **Characterize first (R-B2).** Extract today's post-run classification verbatim, then
  replay every cycle in a DB snapshot to record golden decisions. Refactor only behind that
  harness.
- **State shape (R-B4, DATA-04).** The ~27 optional recovery fields collapse into:
  - one `stop` record (the persisted attention plus its budgets and attempts);
  - an append-only per-cycle step history.

  Old cycle JSON is upcast on read (R-H3).
- **Ownership (R-B3).** `WorkCycle.owner {roadmapId, attemptId, entryId, definitionRevision}`,
  set on creation and backfilled on read. One memoized `cycleOwnership()` returns the frozen
  definition, the effective delegation (ADR-065 grants included), runnable and recovery
  state. It replaces 11 ad hoc scans and fixes the class of bug in CTRL-06.
- **One transition gate (R-A7).** Whole-item and scoped start/advance gates, including
  predecessor ancestry, live in `transitionGate(facts, phase)`. It runs when a command is
  accepted and again at the mutation boundary.
- **Kernel (R-B5).** No fixed-interval polling:
  - Run status, commands, evidence and merges mark aggregates dirty.
  - Deadlines and backoffs are precise timers.
  - A 30–60 s safety sweep catches external Git changes.
  - A per-aggregate async mutex (cycle id, roadmap id, repository path) replaces the nine
    in-memory lock sets.
  - A bounded pool means one launch preflight never delays another cycle.
  - Launch materialization uses async FS.
- **Scoped consistency (R-B6).** Commands lock the entries and bindings they touch, not the
  whole roadmap. A global invariant uses a *drain* state (stop admissions, let running steps
  finish), never "pause every cycle".
- **Restarts (R-B9).** Drain, then restart. A clean start auto-resumes. Only an unclean
  interruption produces `restart-resume` attention.

### Module layout (R-B7)

```text
apps/server/src/controller/
  kernel.ts                  dirty set, timers, per-aggregate mutex, pool
  cycle/facts.ts             snapshot → CycleFacts (one report/open-questions parser)
  cycle/machine.ts           pure decide(); ordered guards; transition table tests
  cycle/actions.ts           valid operator actions per attention code
  cycle/effects.ts           checkpoint, refresh, resolution step, launch request
  roadmap/selection.ts       pure admission (today's blocker/deferredEntries/complete)
  roadmap/ownership.ts       cycleOwnership, effectiveDelegation
  roadmap/recovery.ts        scope recovery as decision + effects
  gates/transition-gate.ts   one evaluator for whole-item and scoped work
  gates/attention.ts         codes, owner classification, legacy mapping (the only string reader)
apps/server/src/runs/
  supervisor.ts              launch/supervise/journal (today's AgentRunService minus brief/cycle policy)
  context.ts                 document materialization + brief composition
apps/server/src/merge/
  gate.ts (pure) · executor.ts
packages/planning (or a new map-model module)
  compiled map model: nodes, edges, producer/requirement sets; one satisfaction evaluator (R-F1)
```

## 4. Read side

- **Event-scoped invalidation (R-D2, R-D4).** One tested table maps each workspace event kind
  and subject to the query keys it invalidates. Every other event invalidates nothing. The
  browser uses a small keyed query store with:
  - single-flight and a dirty follow-up;
  - stale-while-revalidate;
  - structural sharing;
  - visibility-aware deferral;
  - trailing debounce with a max-wait.

  Polling is removed, except a 60 s visible-tab safety refresh for git- and clock-derived
  data.
- **View models (R-D5).** One endpoint per page region, each evaluated in one read
  transaction and one map snapshot:
  - `attention`
  - `work-items/:id/view`
  - `runs/:id/view`
  - a light `roadmaps` list, plus `roadmaps/:id/board` and `roadmaps/:id/progress`
  - definitions by revision (immutable, cacheable)

  Responses are compressed above ~8 KB and carry weak ETags (304 means no re-render).
  Git-derived facts are cached by resolved SHA.
- **Cost budgets (R-D3).**
  - No request over ~50 ms on the live dataset.
  - An idle tab makes zero requests.
  - A run hand-off costs one refresh per affected key.
  - Budgets are enforced by read-budget tests over a large generated fixture and watched
    through an event-loop-delay gauge.
- **Shared projections (R-D6)** keyed by a write generation, and SSE deltas, only if the
  measurements still call for them.

## 5. Data

- **Journal (R-H2).**
  - Store raw vendor lines only when normalization fails, or for a bounded window.
  - Move large tool-result bodies to compressed per-run files, keeping a digest and preview in
    SQLite.
  - An explicit, audited compaction command; the append-only trigger stays for normal writes.
  - Retention aligned with run-directory cleanup.
- **Aggregates.**
  - Roadmap control state stores `definitionRevision`, not a 230 KB copy of the definition
    (R-B3).
  - Evidence submissions become an index row plus a lazily decoded body (R-H4).
  - Canonical digests are persisted at write time instead of canonicalizing at read time.
- **Integrity (R-H3).**
  - Upcasters at the storage read boundary produce one current shape.
  - Contract validation runs at each aggregate's single save path.
  - `pnpm db:verify` validates a snapshot against current contracts before a contract change
    ships.
  - Compile-time equivalence checks between domain types and contract schemas.

## 6. Execution integrity

- **Verification receipts that gate merges are daemon-owned (R-G4).** Check launchers are
  thin clients of a daemon socket. The daemon runs the command in its own supervised process
  group, outside the agent's writable roots, and writes the receipt to SQLite.
- **Agents run with an allowlisted environment and isolated vendor configuration (R-G5).**
  The sandbox layout is designed so that ordinary commits and loopback tests need no
  escalation, and daemon Git runs without repository hooks.
- **Briefs lead with the goal and acceptance criteria (R-G6).** Controller protocol is
  composed in one module. Parent context is referenced through the handoff rather than
  inlined.

## 7. Formats

The plan bundle and v0.3 map are the ground truth (FMT report, "Format specification").

The target is a **compiled map model** built once per definition/binding revision, plus one
requirement evaluator, instead of 22 services reading raw JSON (R-F1). Features are recognized
from typed fields with explicit defaults, not from English strings and magic identifiers
(R-F2). Today's identifiers remain the defaults, so the live map behaves identically.

Format changes themselves are the last resort (R-F5, FMT Appendix A).
