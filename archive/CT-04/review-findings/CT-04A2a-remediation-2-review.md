# CT-04A2a independent remediation-2 review

Reviewed state: **uncommitted working tree** on top of `d3168d4`
(`ct-04a2a-repository-model`); 11 modified files plus this review.
Prior reviewed heads: `e49a5aa` (initial), `ccb9c79` (remediation 1).
Reviews addressed: `review-findings/CT-04/CT-04A2a-initial-review.md`,
`review-findings/CT-04/CT-04A2a-remediation-review.md`.
Accepted implementation plan: `work-items/CT-04/CT-04A2a-accepted-implementation-plan.md`
(SHA-256 `e3490f16333c9e80b9eab667cea10d57312bbbdbab9434ddb05bc7794e1da747`, unchanged).
Local environment: Node `v26.2.0`, better-sqlite3 `13.0.1`, POSIX, UID `1000`. All probes
ran outside the repository. Nothing in the repository was modified by this review except
this file.

## Verdict

**CHANGES REQUIRED at the time of review; `A2a-R-03` was subsequently resolved by
operator-directed revert.** See §"Resolution of A2a-R-03" at the end of this file. The
body below records the review as it stood before that revert.

Both prior blocking findings are closed, and every advisory is addressed or improved on.
The proof-anchor work is now genuinely truthful, and the new documentary process controls
are stronger than what I asked for.

One new blocking finding, `A2a-R-03`. The migration amendment that implements the
`A2A-REP-013` tightening makes **all three repository mutators throw a raw `SqliteError`**
when the same actor acts at the same millisecond as the previous status change. That is a
plausible input on a millisecond-resolution clock, and these are typed-result APIs that
elsewhere never leak SQLite errors. It also means accepted plan §11.1 ("Equal millisecond
time is valid") and review-added case `A2A-REP-016` ("two valid same-time transitions
reach version 3") now hold only across *different* actors — the `A2A-REP-016` test had to
have a second user inserted into it to keep passing, which is the signal.

The tightening itself is the operator's call and is properly documented. What needs
closing is its blast radius, not its intent.

## Closure of prior findings

| Finding | Status | Evidence |
|---|---|---|
| `A2a-R-01` proof anchors | **closed** (turn 1) | gate reports 101 test-title anchors plus 3 documentary controls = 104 |
| `A2a-R-02` untruthful anchors | **closed** | verified below, all ten IDs |
| `A2a-A-01` fabricated `retired` | closed (turn 1) | `{"kind":"repository-not-found"}` |
| `A2a-A-02` bind/retire race | closed (turn 1) | `{"kind":"repository-not-active","status":"retired"}` |
| `A2a-A-03` fs/net gate | closed (turn 1) | `node:fs`, `node:net`, `node:http(s)` rejected |
| `A2a-A-04` transition read-back | closed (turn 1) | `transaction(...).immediate()` + `SQLITE_BUSY` proof |
| `A2a-A-05` bare `fs` | **open** | see `A2a-A-09` |
| `A2a-A-06` weak race statement | **closed** | competitor now uses `evidence-matches` and a strictly later timestamp, so the test no longer passes for the wrong reason |
| `A2a-A-07` documentary process cases | **closed, exceeded** | see below |

**`A2a-R-02` verified closed.** Each of the ten IDs now has a dedicated test that actually
attempts its matrix violation, and the surplus claims were stripped from the two
over-broad titles:

```text
A2A-REP-013            repository-schema.test.ts:416  (NULL actor, NULL time, missing
                                                       reason, reused pair, truthful later action)
A2A-INSP-006/007       repository-schema.test.ts:514
A2A-BIND-002/003       repository-schema.test.ts:536
A2A-BIND-009/010/011   repository-schema.test.ts:566
A2A-BIND-012           repository-schema.test.ts:607
A2A-RET-005/007/008    repository-transitions.test.ts:358 (retires first, then probes)
```

`repository-schema.test.ts:628` now claims only `A2A-MIG-006`, and
`repository-transitions.test.ts:327` is narrowed to `A2A-BASE-007/008`. Recomputing the
anchor map, no ID is now claimed by a test that does not attempt it.

**`A2a-A-07` exceeded.** `verifyCt04A2aDocumentLineage` checks that the design review pins
the live proposed-plan SHA-256, that the disposition pins both prior artefacts, that the
accepted plan carries the complete hash chain, and that all 18 `A2a-F-nn` findings appear
in the §20 reconciliation appendix. `verifyCt04A2aGitLineage` resolves the head the
completion report claims, requires it to be a real commit and an ancestor of `HEAD`, and
requires the report's introducing commit's parent to equal that head. That is a real
control for `A2-PROC-001/002/003`, not an existence check.

**Gate.** `pnpm check` passes on the working tree: format 220, lint 221, typecheck, build,
**66 files / 538 tests**, Playwright 4, `check:scope`, and `check:protected` reporting
"exact package and hashes, 101 A2a test-title anchors, and 3 documentary
process-lineage controls".

**Preservation.** `protected/`, the A2 supplement, and migrations `0001`/`0002` are
untouched. Migration `0003` **has changed** — see below; `docs/operations.md` correctly
documents the resulting checksum reset for anyone who ran the earlier candidate.

**Regression sweep.** My earlier probe batches still pass at this tree: circular graph,
identity reservation and non-disclosure, inspection immutability and coupling, exact-byte
round trip, arrays, the 42-cell reducer matrix, evidence normalization, digest-mismatch
composition, the 44 contract probes, forward migration preservation, and checksum drift.

## Blocking finding

### A2a-R-03 — the attribution amendment makes same-millisecond transitions crash

**Severity:** blocking (production defect introduced by the remediation)
**Files:** `packages/storage/migrations/0003-ct04a2a-repository-model.sql:333-336`,
`packages/storage/src/repositories/repository-registry/index.ts`

The amendment adds to `registered_repositories_transition_only`:

```sql
AND (
  NEW.status_changed_by_user_id IS NOT OLD.status_changed_by_user_id
  OR NEW.status_changed_at > OLD.status_changed_at
)
```

Registration writes `status_changed_by_user_id = registering actor` and
`status_changed_at = registration time`. So the first status change performed by the same
operator within the same millisecond as registration is now rejected by the trigger — and
the storage layer has no guard for it, so the rejection surfaces as a raw exception out of
APIs that otherwise never leak SQLite errors. Probed directly:

```text
applyTransition     same actor, same ms as registration  -> SqliteError: invalid repository transition
applyTransition     same actor, +1 ms                    -> {"kind":"changed", ... version 2}
retireWithBindings  same actor, same ms as registration  -> SqliteError: invalid repository transition
reaffirmEnvironment same actor, same ms as prior status  -> SqliteError: invalid repository transition
applyTransition     two transitions in one clock tick    -> second throws
```

All three mutators are affected. `applyTransition` returns typed `version-conflict` and
`state-conflict` results and `insert`/`register` deliberately never parse SQLite errors —
this is the one path that now escapes as `SqliteError`, on an input that is legal in the
domain and produced by an ordinary `Date.now()` clock.

**It also silently narrows two accepted-plan commitments.** Accepted plan §11.1 states
"requires `NEW.status_changed_at >= OLD.status_changed_at`. Equal millisecond time is
valid." Review-added case `A2A-REP-016` is "two valid same-time transitions reach version
3". Both are now true only when the actor differs. The evidence is in the remediation
itself: `repository-transitions.test.ts:46` keeps the `A2A-REP-016` title unchanged but
now inserts a second user and a second membership so the first transition can be performed
by `alternateUserId`. A protected-case proof was reshaped to fit a changed invariant
rather than the change being recorded against the case.

The tightening is well documented as a design decision — `ADR-017`, `docs/architecture.md`,
and `docs/operations.md` all describe it accurately, including the checksum-reset
consequence — and the operator directed it. I am not disputing the intent. The defect is
that a legal operation now crashes, and that the accepted plan and `A2A-REP-016` were left
saying something the schema no longer does.

**Required outcome.** Two things, in either order:

1. No legal repository transition may escape as an untyped `SqliteError`. Either the
   storage mutators guarantee fresh attribution before writing, or they detect the
   condition and return a typed result alongside `version-conflict` and `state-conflict`.
   Whichever is chosen, `applyTransition`, `reaffirmEnvironment`, and `retireWithBindings`
   all need it, and each needs a test that drives the same-actor same-millisecond case
   through the public API and asserts the typed outcome.
2. The invariant change is recorded against the artefacts it changes: accepted plan §11.1's
   "equal millisecond time is valid" and the meaning of `A2A-REP-016`. The repository has
   precedent for exactly this in
   `work-items/CT-04/CT-04A1-remediation-2-disposition-and-invariant-amendment.md`. If
   `A2A-REP-016` is now "two valid same-time transitions by different actors reach version
   3", that should be written down, not encoded only in a test fixture.

If on reflection the same-actor same-millisecond case should stay valid, the narrower fix
is to require a change in the attribution *pair* only when the status actor is unchanged
**and** the timestamp is unchanged **and** the transition is otherwise a no-op — but that
is a design call for the operator, not something I should specify.

## Advisory findings

### A2a-A-08 — `check:protected` now shells out to `git`, and the scope gate cannot see it

`scripts/check-ct04-protected-package.mjs` imports `node:child_process` and runs
`git cat-file`, `git merge-base`, `git log`, and `git rev-parse`. The calls use argument
arrays and are read-only, and `runCheck` walks only `apps/` and `packages/`, so `scripts/`
is never scanned — this passes `check:scope` because it is invisible to it, not because it
was exempted. Two consequences worth an explicit decision:

- `check:protected` is now history-dependent. `verifyCt04A2aGitLineage` requires the
  completion report's introducing commit's parent to equal the claimed head, so **a squash
  or rebase merge of this branch will break the gate on the target branch.** Merge with
  `--no-ff` to preserve the commit identities this control depends on.
- A slice whose premise is "authority-free" now spawns a process in its own gate. Given
  the recorded preference for structural boundaries over pattern allowlists, extending
  `runCheck` to cover `scripts/` (with an anchored exemption for this one file) would make
  the decision explicit rather than incidental.

### A2a-A-09 — bare `fs` is still allowed by the A2a rule

Carried over from `A2a-A-05`. `isForbiddenInA2a` rejects `node:fs` and `node:fs/promises`
but not bare `fs`, even though bare `child_process` has always been listed. `node:dns`,
`node:dgram`, `node:worker_threads`, and `node:vm` are also uncovered. No A2a source
imports any of them.

### A2a-A-10 — the remediation report was edited in place

`implementation-reports/CT-04/CT-04A2a-remediation.md` is modified rather than joined by a
`CT-04A2a-remediation-2.md`. The repository's own convention is a new report per cycle
(`CT-04A1-remediation.md`, `CT-04A1-remediation-2.md`). Editing in place mutates a document
my previous review cites by content, so the lineage no longer reads in order.

## State and next steps

I did not commit and did not merge, because `A2a-R-03` is a production defect rather than
a documentation gap, and the tree is uncommitted work with no remediation-2 report.

For the merge once `A2a-R-03` closes: commit the remediation with a `-remediation-2`
report, re-review at that exact head, then merge into `ct-04a-git-foundation` with
`--no-ff` so `A2-PROC-003`'s git-lineage control keeps resolving.

## Resolution of A2a-R-03

The operator reviewed the options and directed the reviewer to revert the trigger clause.
That revert was applied in this working tree by the reviewer, not by the implementer.

**What was reverted.** `packages/storage/migrations/0003-ct04a2a-repository-model.sql` is
restored byte-for-byte to its first-remediation form, SHA-256
`526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4` — the value both
implementation reports already quote. The four-line attribution clause is gone, and
`NEW.status_changed_at >= OLD.status_changed_at` is again the only time rule, restoring
accepted plan §11.1 verbatim. No amendment to §11.1 or `A2A-REP-016` is now needed, and no
local database needs a checksum reset.

**Coupled changes, all reverted or corrected.**

- `docs/architecture.md`, `docs/decisions/ADR-017-…md`, and `docs/operations.md` restored;
  the paragraphs describing the attribution rule and the `0003` reset are gone.
- `repository-transitions.test.ts:46` (`A2A-REP-016`) no longer inserts a second user and
  membership. Both same-time transitions are once again performed by the **same** actor,
  which is what the case means. The two now-unused domain imports were dropped.
- `repository-schema.test.ts:416` (`A2A-REP-013`) keeps everything SQL genuinely proves —
  NULL `status_changed_by_user_id`, NULL `status_changed_at`, and a missing or mismatched
  `status_reason` are all still rejected — and the stale-pair case is converted from a
  rejection into an executable, commented **accepted limitation**, followed by a positive
  assertion that a same-actor equal-millisecond transition still reaches version 3.
- The two implementation reports' statements about the amendment were corrected to
  describe the attempt and its revert, including the historical
  `fa088c2a…` checksum, rather than asserting a rule that no longer exists.

**Verification after the revert.** `pnpm check` passes end to end: format 220, lint 221,
typecheck, build, **66 files / 538 tests**, Playwright 4, `check:scope`, and
`check:protected` reporting 101 test-title anchors plus 3 documentary controls. Re-probed
directly, all five previously crashing cases now succeed:

```text
applyTransition     same actor, same ms as registration -> {"kind":"changed", ...}
applyTransition     same actor, +1 ms                   -> {"kind":"changed", ...}
retireWithBindings  same actor, same ms as registration -> {"kind":"changed", ...}
reaffirmEnvironment same actor, same ms as prior status -> {"kind":"changed", ...}
applyTransition     two transitions in one clock tick   -> both changed
```

My earlier probe batches — circular graph, identity reservation and non-disclosure,
inspection immutability and coupling, exact-byte round trip, arrays, the 42-cell reducer
matrix, evidence normalization, digest-mismatch composition, the 44 contract probes,
forward-migration preservation, and checksum drift — all still pass, and the anchor map
shows no over-broad site remaining.

**Independence caveat.** The revert was authored by the reviewer at the operator's
direction. This slice therefore ships with its final change reviewed by the person who
wrote it. The change is small, subtractive, and restores a previously reviewed state, but
that is a departure from the process protocol's independent-review expectation and is
recorded here rather than left implicit.

`A2a-A-08`, `A2a-A-09`, and `A2a-A-10` remained open as advisories at merge and were not
merge blockers.

## Disposition of the advisories

Closed in a follow-up cleanup commit after the merge, at the operator's direction.

**`A2a-A-08` — tooling tier.** `runCheck` now walks `scripts/` as an explicit development
tooling tier rather than skipping it. Tooling is scanned for Exo Stack dependencies and NUL
bytes; `node:child_process` is permitted only at paths named in
`DEVELOPMENT_PROCESS_AUTHORITY`, which today holds one entry with its reason recorded
(`scripts/check-ct04-protected-package.mjs`, read-only git lineage for `A2-PROC-003`). The
converse direction is enforced too: application source under `apps/` and `packages/` may not
import anything that *resolves* into `scripts/`, so tooling cannot leak into the shipped
daemon or browser. Resolution rather than pattern matching means a package's own
`src/scripts/` directory is unaffected. The success message no longer claims a single Git
authority repository-wide; it claims exactly one *production* Git authority and states that
tooling is scanned and separated.

**`A2a-A-09` — bare `fs`.** The A2a builtin denylist is replaced by an allowlist. Any
specifier that resolves to a Node builtin must be in `A2A_ALLOWED_NODE_BUILTINS`, which
holds `crypto` alone; structural tests additionally get `fs`, `os`, and `path` for fixtures,
and notably not `net` or `http`. Builtin identity comes from `module.builtinModules`, with
any `node:`-prefixed specifier treated as a builtin even if this release does not list it,
so a future builtin cannot enter through the gap. A test iterates every entry of
`builtinModules` in both bare and prefixed form and asserts the allowlist decides each one.

**`A2a-A-10` — per-turn reports.** Recorded rather than retrofitted, as directed. The rule
is now written into `work-items/CT-04/CT-04-process-protocol.md` §8: every implementation
and remediation turn produces its own report, and a later turn never edits an earlier
turn's report in place. The CT-04A2a round-2 miss is named there as the reason.
