# CT-04A2b1 design review

Reviewed proposed plan: `work-items/CT-04/CT-04A2b1-proposed-implementation-plan.md`
sha256 `79aa4580ebd5f5bd1fa3efe16ba1047f54a5d8b4aa4cf6366f93b9cc31cbb3a1` (untracked at review time, 849 lines)
Review checkout: `6aed9bda58fac0824f707691106aff0abbf35cdb`, branch `ct=04a2b1-repository-journal`
Accepted source head: `e3b69c612a51b0b2a8d436ae3ea5355abd40745e` (confirmed ancestor of the checkout)
Worktree otherwise clean; the only untracked path is the proposed plan itself.
Local SQLite via better-sqlite3; probes were run against `:memory:` databases from within
`packages/storage` and `packages/contracts` and deleted immediately. Nothing in the
repository was modified by this review.

**Verdict: revise.** Four High and seven Medium findings. The plan's migration mechanics
are the strongest part and mostly survive scrutiny; the findings concentrate where the
plan states an *outcome* — "SQL also enforces…", "fails closed", "repository scopes remain
available" — without naming the *mechanism*, and in one case where the named mechanism
provably does not do what the plan claims.

Recursive decomposition: **no further fan-out required.** See "Fan-out assessment".

### Revision 2

Issued before operator disposition, at the operator's request for a design recommendation
on B1-F-01 and B1-F-02. Changes from revision 1:

- **B1-F-02 is re-ranked High → Medium and its claim is restated.** Revision 1 asserted it
  reintroduced ADR-013's defect. On closer reading of migration 0001 that is wrong: the
  0001 payload CHECK is *unconditional*, which is why it blocked all future kinds, whereas
  B1's proposed CHECKs are kind-scoped and would not. The finding survives on a different
  and narrower basis. See the finding text and "Recommended disposition".
- **B1-F-01 is unchanged at High**, and now names a preferred option rather than leaving
  the choice open.
- **B1-F-05's required outcome is widened** to cover payload/structural disagreement.
- **B1-F-14 is added (Medium)**: the browser invalidates on payload IDs that no constraint
  verifies, while the FK-verified structural copy sits unused.
- A **"Recommended disposition"** section is added. It is advisory; the operator adjudicates.

Finding IDs are stable across revisions; B1-F-14 is appended rather than renumbered, so it
sits outside the otherwise-descending severity order.

## Verified declared facts

Every digest in §2.2 reproduces exactly, plus the A2b supplement:

```text
42ade0fe…  packages/storage/migrations/0001-ct02-foundation.sql
6d2789c5…  packages/storage/migrations/0002-ct03-planning.sql
526df194…  packages/storage/migrations/0003-ct04a2a-repository-model.sql
ce7a101c…  protected/CT-04-protected-acceptance-spec.yaml
1000d564…  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml
255fe8b6…  work-items/CT-04/CT-04A2b-protected-acceptance-supplement.yaml
```

Protected specifications are unmodified. No case was reclassified, weakened, or removed.

The following non-trivial claims were checked against source and hold. They are recorded so
the work is not repeated:

- **§2.3 item 7 is correct.** Schema 3 already carries every candidate key the three
  composite FKs need — `0003:209` `UNIQUE (workspace_id, id)`, `0003:55-56`
  `UNIQUE (workspace_id, repository_id, id)`, `0003:242`
  `UNIQUE (workspace_id, project_id, repository_id, id)`. Migration 0003 needs no change,
  and the plan is right to refuse to touch it.
- **§5.2's `resultingVersion === priorVersion + 1` holds for every reachable transition.**
  `applyTransition`, `reaffirmEnvironment`, `retireWithBindings` (both the repository row
  and each active binding), and binding `retire` all use `version = version + 1`
  (`packages/storage/src/repositories/repository-registry/index.ts`). Registration and
  binding insert both write literal `1`.
- **§5.2's `fromStatus !== toStatus` holds.** Every same-status outcome in
  `reduceRepositoryState` returns `{kind:'unchanged'}`, never `transition`;
  `identity-mismatch` and `evidence-blocked` are rejected as terminal before any transition
  could re-enter them. Notably `unavailable → unavailable` with a *different* reason is an
  `unchanged`, so it emits no event and leaves `status_reason` stale — an A2a semantic, not
  a B1 defect, but worth knowing before writing the status-event tests.
- **§5.4's `bindingVersion: 1` is correct.** Bindings are created at version 1 and retired
  exactly once, so binding retirement is always 1 → 2. The plan's generic "positive safe
  integers, prior + 1" is over-general but not wrong.
- **§2.3 item 6 is correct.** `packages/storage/src/migration-0002.test.ts:235` compares
  the schema-2 catalog against the entire `WORKSPACE_EVENT_KINDS` list and will break.
- **The snapshot contract needs no change.** `packages/contracts/src/snapshot.ts:31` is
  `recentActivity: z.array(workspaceEventEnvelopeSchema)`, composed rather than duplicated.
  Its absence from §3.2 is right.
- **No trigger or view in migrations 0001–0003 references `workspace_events`**, so the
  schema-4 rename cannot silently rewrite an unrelated trigger body. The 0002 rebuild
  precedent transfers cleanly.
- **`packages/storage/src/types.ts` is not A2a-classified.** `isA2aSource` matches
  `packages/storage/src/repository*.ts`, not `types.ts`, so B1's append-input change does
  not collide with the A2a authority-free rule.
- **There is no repository rename operation.** `displayName` appears only on
  `registerRepositoryRequestSchema`; no A2a primitive updates `display_name`. The five-kind
  vocabulary has no missing "renamed" event.
- **Migration 0001's payload CHECK is unconditional** (`0001-ct02-foundation.sql:118-124`).
  `kind IN ('workspace-created')` is a *separate* constraint; the payload check carries no
  kind guard and so applied to every row regardless of kind. That is the mechanism ADR-013
  describes, and it is why any second kind forced a rebuild. B1's proposed CHECKs are
  kind-scoped and do not share it. This corrects revision 1 of this review.
- **The payload/structural ID duplication is pre-existing and unenforced.**
  `apps/server/src/services/plan-import-service.ts:424-452` and
  `apps/server/src/services/work-item-service.ts:182-198` each write `projectId` (and
  `workItemId`) both structurally and inside the payload. Nothing checks that the two agree,
  and `apps/web/src/lib/workspace-projection.ts:95-106` invalidates on the **payload** copy —
  the one no foreign key verifies. B1 inherits this pattern rather than creating it; see
  B1-F-14.

### Probe results

| Probe | Result |
|---|---|
| `json_extract` inside a `CHECK` on a `STRICT` table | accepted by SQLite — the §6.3 design is *feasible* |
| `CHECK (col = json_extract(payload,'$.id'))` with the payload key **absent** | **passes** — see B1-F-01 |
| `Omit<WorkspaceEvent,'kind'\|'payload'>` retaining a non-common key | **fails to compile** — see B1-F-04 |
| Strict base + `.extend()` variant carrying a base-declared optional correlation | **parses** — see B1-F-03 |
| Composite FK `(ws, repo)` with a foreign-workspace parent | rejected |
| Composite FK `(ws, repo, inspection)` with a sibling repository's inspection | rejected |
| Composite FK `(ws, repo, inspection)` with `repo` NULL | **skipped entirely** — kind CHECKs are load-bearing, not redundant |
| `sqlite_sequence` high-water across rename → create → explicit-sequence copy | regresses from 3 to 2 without restore; explicit restore yields next = 4 |
| Same, on an **empty** journal | copy leaves a `sqlite_sequence` row at `seq = 0`, not an absent row |

The last row corrects an assumption a test could plausibly encode: after copying zero rows
the sequence row is *present and zero*, not missing. §7's "insert or update" covers it, but
a guard asserting "row absent" would be wrong. The second-to-last row is the strongest
evidence that §7 is necessary rather than defensive: without the explicit restore the next
append reuses a sequence that was already issued.

---

## Findings

### B1-F-01 — High — The payload/structural ID equality CHECK is vacuous exactly when the payload omits the ID

**Claim.** §6.3 states "SQL also enforces correlation/payload ID equality". Written the
natural way, that constraint catches a *contradicting* payload but silently accepts an
*absent* or *misspelled* one — which is the realistic failure mode.

**Evidence.** SQLite fails a CHECK only when the expression evaluates to FALSE; NULL
passes. `json_extract()` on an absent path returns NULL, so `repo = json_extract(payload,
'$.repositoryId')` is NULL — and therefore satisfied — whenever the key is missing.
Probed directly against `CHECK (repo IS NULL OR repo = json_extract(payload,
'$.repositoryId'))`:

```text
payload id matches structural id       ACCEPTED   (correct)
payload id CONTRADICTS structural id   rejected   (correct)
payload id key ABSENT                  ACCEPTED   <-- defect
payload id key MISSPELLED              ACCEPTED   <-- defect
payload id explicitly JSON null        ACCEPTED   <-- defect
```

This is precisely the failure the A2b implementation guidance §3.4 warned about: *"Do not
imply the database proves a condition it does not prove."*

**Violated.** A2B-I11; `B1-COR-005`, `B1-COR-009`, `B1-COR-010`, `B1-COR-011`. The
retirement/inspection coupling in §5.2 has the same shape and the same hole.

**Required design outcome.** Either
(a) write the constraint so absence fails — `json_extract(payload,'$.repositoryId') IS
repo`, or an explicit `json_type(payload,'$.repositoryId') = 'text' AND …`; **or**
(b) drop the equality CHECKs entirely and prove correlation/payload agreement in the
contracts and at the storage boundaries, which §9 already positions to do ("Storage does
not infer structural IDs from payload JSON" — the same seam can assert they agree).
The accepted plan must pick one and say which, and must not describe the DDL as proving
agreement unless option (a) is taken. **Option (b) is recommended**; see "Recommended
disposition".

**Adversarial proof.** The five-row table above, run as a direct-SQL suite against the real
schema-4 table, for every repository kind and every correlation dimension — absence,
misspelling, JSON null, and contradiction each asserted separately. A single
"contradiction rejected" case would have passed against the defective constraint.

---

### B1-F-02 — Medium — Payload semantics belong in the contracts, not in immutable DDL

*Re-ranked from High in revision 1, and restated. Revision 1 claimed this reintroduced
ADR-013's defect. That was wrong and the correction matters, because an implementer would
be right to reject the original argument.*

**What revision 1 got wrong.** Migration 0001's payload CHECK is *unconditional*
(`0001-ct02-foundation.sql:118-124`) — `kind IN ('workspace-created')` is a separate
constraint, and the payload check has no kind guard. That is why it blocked every future
kind and forced the rebuild ADR-013 describes. §6.3's proposed CHECKs are **kind-scoped**,
so a future schema-5 kind falls outside every arm and is not blocked. ADR-013 does not
prohibit what the plan proposes.

**Claim, restated.** §6.3 puts payload semantics in the only layer that cannot be
unit-tested in isolation, cannot be refactored, and has no mechanism keeping it in agreement
with the Zod schema that expresses the same rules — for a guarantee the read path can hold
more cheaply and more completely.

**Evidence.**
- The journal is append-only (`workspace_events_no_update` / `_no_delete`), so historical
  rows keep historical payloads permanently. The payload shape of an existing kind is
  therefore *already* immutable by construction; a CHECK adds no protection there. A real
  payload change requires a new kind or an envelope version bump, neither of which the
  CHECK obstructs.
- The rule adopted in ADR-013's place is recorded inline at
  `0002-ct03-planning.sql:549-550`: *"Kind-agnostic here; strict per-kind payload shape stays
  in the Zod contracts (ADR-003). A registered kind does not make a payload valid."* §6.3
  departs from that division; §14 does not acknowledge the departure.
- The threat model is thin. A payload/structural mismatch reaches the table only from a B2
  composition bug or direct SQL. It is not a boundary violation: the structural column is
  FK-verified against a real, same-workspace parent regardless of what the payload says.
  Wrong-workspace correlation *is* a boundary violation, and the FK already prevents it
  outright.
- B1-F-01 demonstrates the constraint does not currently work as described, so the layer is
  not merely awkward — it is the layer where the defect went unnoticed.

**Violated.** ADR-003; A2B-I12. `B1-MIG-004`.

**Residual cost if kept.** Only additive payload evolution stays safe. A CHECK that asserts
required-field presence and agreement tolerates a later optional field; one that asserts
shape exhaustively does not. If the CHECKs are kept, the accepted plan must state that they
are presence-and-agreement only, never exhaustive.

**Required design outcome.** The accepted plan must (a) print the exact CHECK expressions
verbatim rather than describing them; (b) restrict payload-aware CHECKs to the minimum that
structural columns genuinely cannot express; (c) if any are kept, amend ADR-013 to list the
schema-frozen payload paths and state the cost of changing one; (d) state what happens if B2
finds a frozen field must change. This finding and B1-F-01 resolve together: option (b) of
B1-F-01 dissolves both. See "Recommended disposition".

**Adversarial proof.** Parse `sqlite_master.sql` for every `json_extract(` / `json_type(`
occurrence bound to `workspace_events` and assert the set equals a committed allowlist, so
a future addition cannot enter unreviewed.

---

### B1-F-03 — High — Optional base correlations make illegal correlations wire-valid on the four legacy variants

**Claim.** Adding the three correlations to `workspaceEventBaseSchema` makes a
`project-created` envelope carrying `repositoryId` parse successfully and retain the value.

**Evidence.** `packages/contracts/src/workspace-event.ts:16-26` — the base is a
`strictObject` that every variant `.extend`s, so strictness is defeated the moment the key
exists on the base. Probed with the repository's own zod:

```text
legacy variant carrying repositoryId parses: true
parsed value retains: "repo-smuggled"
truly unknown key still rejected: true
```

§4 anticipates this only for the *new* variants ("The optional base must not make illegal
correlations type-correct for a specific variant"). §12.3 contains no legacy-variant
negative case; the only listed defense is `B1-COR-008`, which is SQL-level and therefore
does not protect the browser against a daemon that is wrong.

**Violated.** A2B-I11, A2B-I12. `B1-COR-008` has no wire counterpart; `JRN-REP-005`.

**Required design outcome.** State that **all nine** variants — including the four legacy
ones — explicitly forbid the correlations they do not carry, and add the contract cases.

**Adversarial proof.** One table-driven test over the full 9 kinds × 3 correlations matrix
asserting parse rejection for every illegal pair, generated from a single table so a tenth
kind cannot be added without adding a row. This closes the class; nine hand-written cases
would not.

---

### B1-F-04 — High — `EventBase` is derived by `Omit` over the union and drops the new correlations

**Claim.** The storage base mapper's type cannot express the new fields as currently
written, and the failure mode is a compile error at best.

**Evidence.** `packages/storage/src/repositories/workspace-events.ts:28`:
`type EventBase = Omit<WorkspaceEvent, 'kind' | 'payload'>`. `keyof` over a union is the
**intersection** of member keys, so once `repository-registered` declares a required
`repositoryId` that the four legacy variants do not declare, `repositoryId` leaves
`keyof WorkspaceEvent` and `EventBase` loses it. Probed with the repository's TypeScript:

```text
error TS2353: Object literal may only specify known properties,
and 'repositoryId' does not exist in type 'EventBase'.
```

The `?: never` approach proposed in §4 does not rescue this — it makes the base type
`never`-polluted instead.

**Violated.** A2B-I12; `B1-STO-001`, `B1-STO-005`.

**Required design outcome.** Export an explicit `WorkspaceEventBase` (or a
`WorkspaceEventCorrelations`) interface from `packages/domain/src/workspace-events.ts` and
have storage map against it, rather than deriving the base from the union. `§4`'s
"strengthen … with `?: never`" should be restated in terms of that named base.

**Adversarial proof.** A type-level assertion that the base mapper's return type contains
all three correlations, plus a round-trip test asserting `appendEvent → listAfter` returns
the exact **structural IDs** — not only the payload — for each of the five new kinds.
`B1-STO-001` as written ("exact structural correlations and payload round-trip") is
satisfiable by a test that only inspects the payload; it should be pinned to the
correlations explicitly.

---

### B1-F-05 — High — Mapper exhaustiveness is compile-time only; there is no runtime fail-closed arm

**Claim.** §9's "Unknown catalog kinds, invalid JSON, and invalid structural correlations
fail closed" names an outcome but no mechanism, and the current code does not fail closed.

**Evidence.** `mapEvent` (`workspace-events.ts:58-86`) has no `default` and no
`assertNever`. `row.kind` is *asserted* to `WorkspaceEventKind` by the row casts at lines
122, 153, and 171, so TypeScript is satisfied while a catalog kind with no domain branch
returns `undefined` at runtime — and `listAfter(...).map(mapEvent)` then yields an array
containing `undefined` that flows into SSE replay and the snapshot response. Compare
`packages/domain/src/repository.ts`, which does carry `assertNever`. B1 makes this reachable
for the first time: schema 4 registers five kinds, and any future migration can register a
sixth before the domain union catches up.

**Violated.** A2B-I12; `B1-STO-004`, `B1-STO-005`; `JRN-REP-004`.

**Required design outcome.** Require the mapper to throw on an unrecognised kind, on a row
whose structural correlations contradict its kind, **and on a row whose payload IDs
disagree with its structural correlations**, and state where that throw is caught, so one
poisoned row cannot silently truncate an SSE replay mid-stream or take down a snapshot
request for an otherwise healthy workspace.

The third clause is load-bearing beyond this finding. It is the single place that catches
payload/structural disagreement from *every* source — the B1 append helper, any future B2
write path, and direct SQL — at the point of consumption, in testable TypeScript. Adopting
it is what makes the SQL equality CHECK in B1-F-01/B1-F-02 redundant rather than merely
awkward.

**Adversarial proof.** Direct-SQL insert of (a) a catalog kind present in schema 4 but
absent from the domain union, (b) a row whose correlations contradict its kind, and (c) a
row whose payload ID differs from its structural correlation; assert `listAfter`,
`listRecentAtOrBefore`, and SSE replay each fail with a typed error in all three cases
rather than returning `undefined`, a short array, or a hole.

---

### B1-F-06 — Medium — `repositoryVersion` is undefined for the compound transition case

**Claim.** §5.3 defines `repositoryVersion` as "unchanged repository state version", but a
reachable reduction changes the version and the risk evidence in the same transaction.

**Evidence.** In `applyAssessment` (`packages/domain/src/repository.ts`), a
`risk-evidence-changed` assessment against a repository in `unavailable` or
`identity-evidence-changed` returns
`transition(status, 'active', 'evidence-matches', 'risk-evidence-changed')` — a status
transition *carrying* a risk-evidence disposition. `applyTransition` bumps
`version = version + 1`. So that transaction must emit a status event (prior → prior + 1)
and, per §2's vocabulary, an evidence event whose `repositoryVersion` is now ambiguous
between the two.

**Violated.** A2B-I05, A2B-I06; `A2B-JRN-009`; `B2-INSP-002`, `B2-INSP-009`.

**Required design outcome.** Define `repositoryVersion` as an exact quantity — "the
repository version in effect after the committing transaction" is the only unambiguous
reading — and state whether the compound case emits both events, in what order, and whether
they share one inspection correlation. B1 freezes this in the wire contract and possibly in
DDL, so B2 cannot renegotiate it.

**Adversarial proof.** Reducer-driven fixtures from each of `unavailable` and
`identity-evidence-changed` with a `risk-evidence-changed` assessment; assert the exact
event sequence and the exact `priorVersion` / `resultingVersion` / `repositoryVersion`
values, not merely that two events were appended.

---

### B1-F-07 — Medium — Repository stale scopes are write-only and unbounded, and the only consumer is outside the target tree

**Claim.** §10.2 makes repository scopes survive both `snapshot-loaded` and
`stale-consumed`, while B1 adds no consumer — so `repositoryIds` grows without bound and
nothing clears it short of a workspace switch.

**Evidence.** `apps/web/src/lib/workspace-projection.ts:176` bounds `events` with
`.slice(-100)`; `projectIds` and `workItemIds` are cleared by `stale-consumed` at line 187.
`apps/web/src/App.tsx:226` gates the refetch on
`!stale.workspaceSummary && stale.workItemIds.length === 0` and only then dispatches an
**unparameterised** `stale-consumed` — so a repository-only event never reaches consumption
at all, and a binding event (project + repository, no workspace summary) does not either.
`apps/web/src/App.tsx` is **absent from the plan's target tree (§3.2)** even though §10.2
changes the meaning of the action it dispatches.

I checked for a refetch loop and did not find one: `stale-consumed` changes object identity,
the effect re-runs, and the guard returns early. The defect is growth and coherence, not
looping.

**Violated.** CT03-I14; `B1-UI-006`, `B1-UI-007`.

**Required design outcome.** Bound `repositoryIds` explicitly; state that `App.tsx` is
deliberately unchanged and why; and prefer parameterising `stale-consumed` by scope **now**
rather than hard-coding "repository scopes survive". Hard-coding means CT-04E must change
the action's semantics a second time — a second opportunity for exactly this class of
error, in a slice that will be reasoning about repository fetches rather than about the
reducer's history.

**Adversarial proof.** Reduce far more than the cap of repository events and assert the
bound holds with stable-order dedup intact; reduce a long mixed legacy/repository sequence
and assert `stale-consumed` never clears a scope its dispatcher did not refetch.

---

### B1-F-08 — Medium — The kind/correlation CHECK's default arm is unspecified, so a future kind may be unconstrained

**Claim.** §6.3 enumerates rules for "legacy kinds" and for the five repository kinds but
never states how an *unlisted* kind is treated — which decides whether a schema-5 kind is
rejected or silently unconstrained.

**Evidence.** Written as `kind IN (<four legacy>) OR <repository rules>`, a schema-5 kind
satisfies neither arm and the constraint's overall shape decides the outcome; written as
`kind NOT IN (<five repository kinds>) → all repository correlations NULL`, it fails closed.
The plan does not say which, and the probe confirms this arm is load-bearing rather than
belt-and-braces: a composite FK with a NULL leading column is skipped entirely, so
inspection-without-repository (`B1-COR-005`) is caught *only* by the kind CHECK.

**Violated.** A2B-I11, A2B-I12; `B1-COR-005`, `B1-COR-008`.

**Required design outcome.** State the closure rule explicitly — an unlisted kind is forced
to all-NULL repository correlations — and make adding a kind without a correlation rule a
test failure rather than a silent pass.

**Adversarial proof.** Insert a synthetic schema-5 catalog kind carrying a repository
correlation by direct SQL and assert rejection. Then one parity test comparing the catalog,
the domain union, `WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA`, the mapper branches, the
invalidation table, and the description table as **one** nine-row set. That single test is
what closes the "a new kind slips through one of five surfaces" class; `B1-STO-005` and
`B1-UI-010` as written each guard one surface.

---

### B1-F-09 — Medium — Several durable inspection outcomes produce no event, so evidence history is unprojectable, and §12.8 overreaches

**Claim.** The five-kind vocabulary leaves three reachable durable outcomes invisible to the
journal, while §12.8 claims a contribution to `JRN-REP-004` (durable re-query foundation).

**Evidence.** `reduceRepositoryState` returns `{kind:'unchanged'}` with dispositions
`verified`, `environment-evidence-still-changed`, and `failure-recorded`. Each still appends
an immutable, globally sequenced `repository_inspections` row (A2B-I06,
`0003-ct04a2a-repository-model.sql:18-56`) but emits no workspace event and marks no browser
scope stale. `A2B-INSP-001` and `B2-INSP-007` confirm "no event" is intended, so this is a
vocabulary limit, not a bug.

**Violated.** Nothing directly. The issue is that the limitation is invisible: a CT-04E
inspection-history view would silently never refresh, and §12.8's `JRN-REP-004` claim reads
as broader than what B1 delivers.

**Required design outcome.** B1 must **not** add a sixth kind — its contract fixes five.
Instead, the accepted plan and ADR-018 must record explicitly that inspection-history
freshness is not derivable from the journal, and assign the gap (CT-04E fetch-on-view, or a
named follow-up), rather than leave it implied by silence. §12.8 should narrow its
`JRN-REP-004` wording accordingly.

**Adversarial proof.** A case asserting that an unchanged verification produces zero
workspace events and zero stale scopes — so the limitation is a tested, visible fact that a
later slice trips over deliberately rather than discovers.

---

### B1-F-10 — Medium — `B1-MIG-006` proves rollback for a *copy* of migration 0004, and there is no amendment policy for 0004

**Claim.** §12.1 proves rollback with a "test copy of 0004 with a uniquely identified
forced-failing guard". A hand-maintained copy drifts from the shipped bytes and then proves
nothing about the migration that actually runs.

**Evidence.** Migrations are discovered from disk and checksummed
(`packages/storage/src/migrations.ts:56-78`, `114-119`), and `B1-MIG-008` freezes 0004's
checksum once applied. A divergent copy would still pass its own test indefinitely.

**Violated.** `B1-MIG-006`; indirectly `B1-MIG-005`, `B1-MIG-008`.

**Required design outcome.** Derive the failing variant from the real 0004 bytes at test
time by exactly one documented substitution, asserting the marker matched exactly once and
that the bytes changed. Separately, state the amendment policy for 0004 during B1
remediation turns: no production database exists, so rewriting 0004 in place is legitimate,
but the plan should say so rather than leave a later reviewer to force an unnecessary 0005.

**Adversarial proof.** After the forced failure, assert schema 3 is *fully* readable —
queries, append-only triggers, indexes, and the exact four-row catalog — not merely that
`currentVersion === 3`. A rollback that leaves the schema at version 3 with dropped triggers
would pass the weaker assertion.

---

### B1-F-14 — Medium — Browser invalidation reads the payload ID, not the FK-verified structural one

*Added in revision 2.*

**Claim.** The reducer invalidates on the copy of the identifier that nothing verifies,
while the copy that composite foreign keys do verify sits unused. B1 is about to replicate
that for five more kinds.

**Evidence.** `apps/web/src/lib/workspace-projection.ts:95, 101, 106` read
`event.payload.projectId` and `event.payload.workItemId`. The envelope also carries
structural `projectId` / `workItemId`, populated by every producer —
`plan-import-service.ts:424-452` and `work-item-service.ts:182-198` each pass both — and it
is the *structural* column that `0002-ct03-planning.sql:560-570` constrains with
`(workspace_id, project_id)` and `(workspace_id, project_id, work_item_id)` foreign keys.
Nothing anywhere asserts the two copies agree. Plan §10.1's invalidation table does not say
which copy the new kinds will read.

**Violated.** A2B-I11 (correlations are structural, not payload convention); `B1-UI-003`,
`A2B-JRN-007`.

**Required design outcome.** State in §10.1 that the **structural correlation** is
authoritative for invalidation, and have `invalidatedBy` read it for the five new kinds.
Leave the four legacy kinds unchanged — they are accepted behaviour and rewriting them is
outside B1 — but record the asymmetry so it is a known, deliberate state rather than a
discovery for CT-04E. With the Zod agreement refinement recommended below, the two copies
provably agree, so this costs nothing and removes the question of which one to trust.

**Adversarial proof.** Reduce a binding event whose payload `projectId` differs from its
structural `projectId` and assert the *structural* project is the one marked stale. Under
the current design this test cannot be written, because the reducer has no access to the
verified value.

---

### B1-F-11 — Low — Composite FKs are specified without `ON DELETE` actions

**Evidence.** §6.2 shows all three FKs with no referential action. Every other FK in the
schema is explicit: `0002-ct03-planning.sql:560-570` and
`0003-ct04a2a-repository-model.sql:246-253` all use `ON DELETE RESTRICT`.

**Required design outcome.** State the action explicitly and match A2a.

**Adversarial proof.** Assert the exact `pragma_foreign_key_list(workspace_events)` rows
*including* `on_delete`, not merely that the three FKs exist. `B1-MIG-003`'s "exact
index/trigger catalog" should be read as covering the FK catalog too.

---

### B1-F-12 — Low — Scope-checker rules mix import-detectable categories with behaviours a scanner cannot see

**Evidence.** §13's rejection list puts "repository registry mutation" and "repository
lifecycle commands" alongside import specifiers such as `@craftingtable/git` and
`node:child_process`. The first two are not import-detectable. Meanwhile
`packages/storage/src/types.ts` — which B1 edits — already imports `./repository-types.js`
(`types.ts:24`), and `isA2aSource` matches `packages/storage/src/repository*.ts`, so an
over-broad pattern will either false-positive on accepted A2a source or be quietly vacuous.

**Required design outcome.** Express B1's rule as exact-path allowlists of permitted
specifiers per file — the shape §13 already proposes for the four file classes — and drop
the behavioural categories from the checker, proving those separately through §16's
route-inventory and no-server-production-change assertions. This also matches the recorded
preference for structural boundaries over pattern allowlists.

**Adversarial proof.** A negative fixture per forbidden specifier, plus a positive fixture
asserting the existing `types.ts → repository-types.js` import still passes. Also confirm
the import direction at the contracts seam: `A2A_FORBIDDEN_PATTERNS` contains
`/(?:^|\/)workspace-events?(?:\/|\.|$)/`, which forbids A2a source from importing the event
modules — B1 imports `repository.js` *from* `workspace-event.ts`, the permitted direction,
and a fixture should pin that so a later refactor cannot quietly reverse it.

---

### B1-F-13 — Info — Smaller corrections

- §3.2's target tree omits `apps/web/src/App.tsx` while §10.2 changes the semantics of the
  action it dispatches (B1-F-07). Either add it or state the deliberate omission.
- §6.5's guard list should say that a `sqlite_sequence` row is *present with `seq = 0`*
  after copying an empty journal, not absent; a guard asserting absence would be wrong.
- §12.4's `B1-STO-001` wording is satisfiable by a payload-only assertion; pin it to the
  structural correlations (B1-F-04).
- §12.8's `JRN-REP-004` claim should be narrowed (B1-F-09).
- §17's fan-out reasoning is sound and should be kept as written.

---

## Recommended disposition — B1-F-01 and B1-F-02

Advisory. The operator adjudicates; this section records the reviewer's recommendation and
its reasoning so the implementer receives an argument rather than a verdict.

**Recommendation: take option (b). Remove the payload-aware CHECKs from migration 0004
entirely.**

The reasoning is not ADR-013 — see the correction in B1-F-02. It is that each guarantee
should live in the layer that can actually prove it:

| Layer | Owns | Why there |
|---|---|---|
| SQL foreign keys | cross-workspace and wrong-parent ownership | the only layer that can see the other tables, and the only defense against direct SQL |
| SQL kind-scoped CHECKs | which correlations are NULL / non-NULL per kind, plus B1-F-08's all-NULL default arm | pure structural, needs no payload knowledge; closes the nullable-composite-FK skip the probe demonstrated |
| Zod contracts | payload shape, ID agreement, version arithmetic, retirement/inspection coupling | runs at both wire boundaries, is testable, and is already the single source of truth for payload shape (ADR-003) |
| Storage mapper, on read | fail closed on unknown kind, contradictory correlations, payload/structural disagreement | catches every write path *and* direct SQL, at the point of consumption (B1-F-05) |
| Storage append, on write | assert agreement | cheap and precise; §9 already receives both inputs separately |

What the SQL equality CHECK was uniquely good for is direct-SQL writes. The mapper clause
in B1-F-05 covers that case too, at read time, and covers it for rows written before the
constraint existed. Once that clause is adopted, the CHECK is redundant.

Two consequences the accepted plan should state explicitly:

1. **The database does not prove the retirement/inspection coupling.** SQL can only say
   that `repository-status-changed` *may* have a NULL inspection; it cannot say "NULL
   exactly when retiring" without reading `$.toStatus`. Write it as **SQL permits, Zod
   proves**. That is what guidance §3.4 asked for, and it is a better answer than a
   `json_extract` in DDL that implies a proof it does not deliver.
2. **ADR-018 should record the division**, not just the schema change: the database proves
   *ownership*, the contracts prove *semantics*. That is ADR-003's existing split, restated
   for structural correlations rather than only for payload shape. No ADR-013 amendment is
   needed under option (b), which is one fewer accepted decision disturbed.

If the operator prefers option (a) instead, the minimum is: use `IS` or an explicit
`json_type(...)` guard so absence fails (B1-F-01); assert presence and agreement only, never
exhaustive shape, so additive payload evolution stays legal (B1-F-02); print the expressions
verbatim; and amend ADR-013 with the frozen path list. Option (a) is defensible — it is not
what ADR-013 forbids — it is simply the more expensive way to buy less.

## New adversarial cases proposed for permanent inclusion

```text
B1-COR-013   payload ID absent / misspelled / JSON-null, per kind and per correlation
             dimension — not only the contradiction case (B1-F-01)
B1-COR-014   unlisted future catalog kind carrying a repository correlation is rejected
             (B1-F-08)
B1-CON-011   all nine variants reject every correlation they do not carry, table-driven
             over the 9 x 3 matrix (B1-F-03)
B1-STO-009   mapper throws on an unrecognised catalog kind, on contradictory correlations,
             and on payload/structural ID disagreement; listAfter, listRecentAtOrBefore,
             and SSE replay all fail loudly rather than yielding a hole (B1-F-05)
B1-STO-011   append rejects an input whose payload IDs disagree with its structural
             correlations, before any row is written (B1-F-01 option b)
B1-STO-010   nine-row parity: catalog x domain union x introduced-schema map x mapper
             branches x invalidation table x description table, asserted as one set
             (B1-F-08)
B1-MIG-009   schema-4 DDL references exactly the allowlisted payload JSON paths (B1-F-02)
B1-MIG-010   pragma_foreign_key_list(workspace_events) matches exactly, including on_delete
             (B1-F-11)
B1-UI-011    repositoryIds respects its bound and stable-order dedup under a long event
             stream; stale-consumed clears exactly what its dispatcher refetched (B1-F-07)
B1-UI-012    unchanged verification produces zero events and zero stale scopes — the
             documented projection limit (B1-F-09)
B1-UI-013    a binding event whose payload projectId differs from its structural projectId
             marks the *structural* project stale (B1-F-14)
B1-CON-012   payload IDs and structural correlations must agree, per kind and per
             dimension, at the contract boundary (B1-F-01 option b, B1-F-14)
```

`B1-COR-011` should be split so that the accepted retirement case and the rejected inverse
cases are separately identified; as one ID it can be reported green while only the positive
half was proven.

## Fan-out assessment

**No further split.** The process protocol §4 triggers are more than roughly 60 changed
files, more than one new authority boundary, or both a major schema and a substantial
browser surface. B1 predicts ~30 files, adds **zero** authority boundaries, and its browser
surface is two production files adding two stale-scope fields and five description
branches — not substantial by any reading that keeps the word meaningful. §17's reasoning is
correct and its stated stop conditions are the right ones.

One structural recommendation instead: make **slice 2 (migration) an explicit operator
checkpoint** before slices 3–5 begin. Migration 0004 is the only artifact B1 freezes by
checksum, and B1-F-01, B1-F-02, B1-F-08, B1-F-10, and B1-F-11 all land inside it. Reviewing
the DDL once, on its own, before the storage and browser work is built on top of it is
cheaper than discovering a constraint defect after slice 4.

## Process notes

- `B1-PROC-001` is satisfied by this review. `B1-PROC-002` and `B1-PROC-003` correctly
  remain open; §1's refusal to claim them is right, as is §15's refusal to record an
  implementation head that does not yet exist.
- §2.1's checkout reconciliation is accurate: `e3b69c6` is an ancestor of `6aed9bd`, the
  single descendant commit is the planning package, and no product source differs.
- The plan's §2.3 "every source divergence" list is the strongest part of the document —
  seventeen items, and I found every one of them to be true. Items 6, 7, 8, and 10 in
  particular are the kind of thing that is normally discovered during implementation.
- Five of my eleven substantive findings (B1-F-01, B1-F-03, B1-F-04, B1-F-05, B1-F-14) are
  places where the plan asserts, or inherits, a guarantee that the *existing accepted
  source* silently does not provide. That is a pattern worth naming for B2: the A2a and
  CT-03 seams are good, but their type-level and CHECK-level guarantees are weaker than they
  read, and B2's outer transaction and adapter parity work will have the same character.
- Revision 2 corrects a reviewer error rather than a plan error (B1-F-02). It is recorded
  in place rather than silently amended, because the disposition attaches to finding IDs and
  a reader following the lineage should be able to see what changed and why. The original
  claim is quoted in the finding so the correction is checkable, not merely asserted.
