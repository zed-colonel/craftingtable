# CT-04A2a independent remediation review

Reviewed remediation head: `ccb9c7951f6143819e3c5ab30bd4d57157e8d658`
Report-only commit at review time: `d3168d4` (adds the remediation report only)
Prior reviewed head: `e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c`
Review addressed: `review-findings/CT-04/CT-04A2a-initial-review.md`
Remediation report: `implementation-reports/CT-04/CT-04A2a-remediation.md`
Accepted implementation plan: `work-items/CT-04/CT-04A2a-accepted-implementation-plan.md`
(SHA-256 `e3490f16333c9e80b9eab667cea10d57312bbbdbab9434ddb05bc7794e1da747`, unchanged)
Review checkout: `d3168d4`, branch `ct-04a2a-repository-model`, working tree clean before
and after. Local environment: Node `v26.2.0`, better-sqlite3 `13.0.1`, POSIX, effective
UID `1000`. All probes ran in a scratch directory outside the repository. Nothing in the
repository was modified by this review.

## Verdict

**CHANGES REQUIRED**

One narrowly scoped follow-up finding, `A2a-R-02`.

`A2a-R-01` is substantially delivered and the new control is real: 104 anchors are
required, derived from the untouched supplement and from accepted-plan §15.2 rather than
from a hand-maintained copy, and I independently proved the gate fails when an anchor is
removed, refuses to count an ID that appears in a comment instead of a title, and rejects
an A2b ID claimed in an A2a title. All four advisories were addressed, three of them with
production changes that I verified are correct and correctly contained.

The residual is that **ten protected IDs are now anchored to tests that do not exercise
them**, and for nine of those the untruthful anchor is the only one. Every one of the ten
behaviours does hold — I re-verified each at this head — so there is no defect. But
`check:protected` now prints "104 A2a proof anchors" and passes, which asserts proof that
does not exist. That is the specific hazard `A2a-R-01` was raised to remove, so it should
be closed before the slice is accepted. The fix is small: the missing assertions are
one-liners, and `A2a-R-02` below states each one.

## Verification performed

**Provenance and containment.** `git diff --stat e49a5aa ccb9c79` shows 15 files. The only
production change is `packages/storage/src/repositories/repository-registry/index.ts`
(three edits) plus one union member in `packages/storage/src/repository-types.ts`. No
schema, migration, domain, or public-contract production file changed —
`git diff --stat e49a5aa ccb9c79 -- packages/domain/src packages/contracts/src` reports
only `packages/contracts/src/repository.test.ts`. The `A2a-R-01` repair itself is confined
to test titles, the two check scripts and their tests, and the report, exactly as the
required outcome asked.

**Preservation.** `git diff --exit-code e49a5aa ccb9c79 -- protected/ …supplement.yaml
packages/storage/migrations/` is empty. Live hashes unchanged: supplement
`1000d564…`, protected spec `ce7a101c…`, migrations `42ade0fe…`, `6d2789c5…`,
`526df194…`. The supplement was not edited, renumbered, weakened, or reclassified.

**Full gate.** `pnpm check` at this head, exit 0: format 220 files, lint 221, typecheck,
build, **66 test files / 530 tests** (up 7), Playwright 4, `check:scope`, and
`check:protected` reporting "exact two-file manifest, hashes, and 104 A2a proof anchors".
The report's §4 figures reproduce.

**Test files not weakened.** Diffing the five test files that changed only for anchoring
(`repository.test.ts` contracts, `repository-schema.test.ts`, `migration-0003.test.ts`,
`migrations.test.ts`, `snapshot.test.ts`), every non-title line is unchanged. No assertion
was relaxed to make an anchor fit.

**Anchor gate, adversarially.** Using my own scratch copies rather than the repository's
negative test: removing `A2A-BIND-005..008`, `A2A-CON-009`, `A2A-MIG-002/003`, or
`A2-PROC-001..003` each produces exactly the expected `… has no test-title anchor`
errors; moving `A2A-CON-009` from a title into a trailing comment fails the gate, so a
comment cannot satisfy an anchor; and injecting `A2B-INSP-004` into an A2a title produces
`A2B-INSP-004 is an out-of-scope A2b test-title claim`. The title regex is line-anchored
to `describe`/`it`/`test`, and range and slash expansion behave as documented.

**Advisory closures, re-probed at this head.**

- `A2a-A-01` — `appendVerification` against an identifier that was never registered now
  returns exactly `{"kind":"repository-not-found"}` with no `status` field
  (`index.ts:457`). The fabricated `retired` claim is gone.
- `A2a-A-02` — retiring a repository to version 2 and then binding with expected version 1
  returns `{"kind":"repository-not-active","status":"retired"}` (`index.ts:547-554`),
  matching accepted plan §11.5. Active-parent version conflicts still return
  `repository-version-conflict`.
- `A2a-A-03` — `isForbiddenInA2a` now rejects `node:fs`, `node:fs/promises`, `node:net`,
  `node:http`, and `node:https`. See the residual note below.
- `A2a-A-04` — `applyTransition` now runs inside `transaction(...).immediate()`
  (`index.ts:265-304`). The accompanying test at
  `packages/storage/src/repository-transitions.test.ts:93` is a genuine proof: it opens a
  real second connection with `busy_timeout = 0`, attempts a competing write at the
  read-back point, and requires the exact `SQLITE_BUSY` code while the caller receives its
  own version-2 row.

**Regression sweep.** I re-ran my earlier probe batches at this head: the circular
graph, version and timestamp bypasses, terminal statuses, inspection immutability and
success/failure coupling, exact-byte round trip, identity reservation and release,
registration-graph negatives, forced retirement rollback, the 42-cell reducer matrix,
error-evidence normalization, digest-mismatch composition, the 44 contract probes, and
the display-name, single-registration, historical-attribution, and post-retirement
immutability probes all still pass. The three production edits regressed nothing.

## Blocking finding

### A2a-R-02 — ten protected IDs are anchored to tests that do not exercise them

**Severity:** blocking (assurance honesty; no behavioural defect)
**Files:** `packages/storage/src/repository-schema.test.ts:273`,
`packages/storage/src/repository-schema.test.ts:332`,
`packages/storage/src/repository-transitions.test.ts:308`

Two anchor sites carry 18 and 6 IDs respectively while asserting far less than they claim.

**`repository-schema.test.ts:332`** — title claims `A2A-MIG-006 A2A-INSP-006/007
A2A-BIND-002/003/012`. The entire body is:

```ts
expect(database.pragma('foreign_key_check')).toEqual([]);
expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
```

run against a valid registered database whose fixture contains **no binding row at all**.
That proves `A2A-MIG-006` ("clean"). It cannot prove any of the other five, each of which
requires an attempted violation:

| ID | Matrix scenario | Exercised here? |
|---|---|---|
| `A2A-INSP-006` | inspection references foreign-workspace repository → composite FK rejects | no |
| `A2A-INSP-007` | actor exists but is not workspace member | no |
| `A2A-BIND-002` | repository and project in different workspaces → composite FK rejects | no |
| `A2A-BIND-003` | same workspace but nonexistent/wrong project ID → rejected | no |
| `A2A-BIND-012` | revoked member actor | no |

**`repository-schema.test.ts:273`** — title claims 18 IDs. The body makes four assertions:
inspection update rejected, inspection delete rejected, repository `version + 2` rejected,
repository delete rejected. Those legitimately cover `A2A-INSP-008/009` and parts of
`A2A-REP-009..012`. The body contains **no binding statement and no baseline statement**,
so `A2A-BIND-009` (partial retired actor/time), `A2A-BIND-010` (unretire/retarget), and
`A2A-BIND-011` (delete binding row) are claimed without being touched — and `:273` is
their only anchor. `A2A-BASE-002/004/005/007/008` and `A2A-RET-007/008` are also claimed
here without being exercised, but those do have a truthful anchor elsewhere, so they are
noise rather than a gap.

**`A2A-RET-005`** ("retired repository inspection relation mutated → historical evidence
remains immutable") has two anchors, `:273` and `repository-transitions.test.ts:308`.
Neither retires the repository: `:273` uses `rawRegistered(…)` and `:308` uses
`setup(…)`, both of which stop at registration. The case is unproved at both sites.

**Sole-anchor and unexercised (nine):** `A2A-REP-013`, `A2A-INSP-006`, `A2A-INSP-007`,
`A2A-BIND-002`, `A2A-BIND-003`, `A2A-BIND-009`, `A2A-BIND-010`, `A2A-BIND-011`,
`A2A-BIND-012`. **Unproved at every anchor (one):** `A2A-RET-005`.

**No defect behind any of them.** I re-verified all ten behaviours at this head with
direct SQL: a foreign-workspace inspection parent, a non-member actor, a cross-workspace
project binding, a binding to a nonexistent project, a partial retirement leaving the
actor NULL, a binding retarget, a binding delete, deletion of a referenced membership row,
mutation of a retired repository's inspection, direct unretire, and deletion of a retired
repository row are all rejected. The implementation is right; only the proof is missing.

**`A2A-REP-013` needs a decision, not just a test.** Its scenario is "partial status
actor/time/reason fields → check rejects". I probed the readings: setting `status_reason`,
`status_changed_by_user_id`, or `status_changed_at` to NULL is rejected, and changing
`status` while leaving `status_reason` stale is rejected — so the case appears to be
satisfied structurally by `NOT NULL` plus the status/reason coupling CHECK. But a
transition that updates `status` and `status_reason` while leaving the status actor and
timestamp untouched **is accepted**, leaving attribution that names the registration actor
and registration time as the author of the new status. That is explicitly permitted by
accepted plan §11.1, which allows an equal timestamp and any valid member as status actor,
so I am not raising it as a defect. Whoever writes the `A2A-REP-013` proof should pin
which reading the case means.

**Required outcome.** Every protected and review-added ID has at least one anchor on a
test that actually exercises its matrix scenario, and no anchor claims a case its test does
not attempt. Removing the surplus IDs from `repository-schema.test.ts:273` and `:332` and
attaching each to a test that performs the corresponding rejection is sufficient; the ten
missing assertions are single statements of the same shape already used elsewhere in these
files. Do not satisfy this by broadening a title. Confine the change to test files: no
schema, migration, domain, contract, or storage production change is warranted, and the
`check:protected` script should not need to change either. If `A2A-REP-013` resolves to
"already structurally satisfied", say so in the report and anchor it to a test that
demonstrates the NULL and coupling rejections.

## Advisory findings

### A2a-A-05 — the A2a authority gate still allows bare `fs`, and several host modules

`scripts/check-forbidden-scope.mjs`. The remediation added `node:fs`, `node:fs/promises`,
`node:net`, `node:http`, and `node:https`, which closes the case I raised. Bare `fs` is
still permitted even though bare `child_process` has always been listed, and `node:dns`,
`node:dgram`, `node:worker_threads`, and `node:vm` are not covered. No A2a source imports
any of them today. This remains a pattern allowlist rather than a structural boundary; if
that shape is to change, CT-04A2b is the natural place to do it deliberately rather than
extending the list case by case.

### A2a-A-06 — the read-back race test depends on asserting the exact `SQLITE_BUSY` code

`packages/storage/src/repository-transitions.test.ts:113-127`. The competing statement sets
`status_reason = 'inspection-succeeded'`, which is not in the reason enum, so that update
would fail its CHECK even without the write lock. The test is sound as written because
`competingWriteWasBlocked` is set only for `code === 'SQLITE_BUSY'`, but the assertion
would silently stop proving lock-holding if that check were ever loosened to "threw".
Using a valid competing transition would make the test robust to that.

### A2a-A-07 — the process cases rest on a file-existence check

`A2-PROC-001`, `A2-PROC-002`, and `A2-PROC-003` are anchored to
`scripts/check-ct04-protected-package.test.mjs:77`, whose assertion is that
`verifyCt04A2aProofAnchors` returns ok; the underlying evidence is the
`CT04A2A_PROCESS_FILES` existence check. Existence establishes that the lineage artefacts
are committed, but not that the design review preceded the accepted plan
(`A2-PROC-001`) or that the completion report cites a real committed head
(`A2-PROC-003`). These are documentary cases and a test anchor is a category mismatch by
nature, so I am not treating this as blocking. `A2-PROC-003` is the one that could be made
real cheaply, by resolving the head the report names and asserting it is an ancestor of
`HEAD`.

## Scope confirmation

Confirmed absent at this head: `@craftingtable/git` import, child process, Fastify or
server production change, route, workspace-event kind or journal rebuild, notifier call,
browser change, new dependency, protected-file edit, and any edit to migrations 0001–0003.
No CT-04A2b protected case ID is claimed by any CT-04A2a test — now enforced by the gate.
`check:scope` and `check:protected` both pass.

## Reviewer notes for remediation

- Any remediation commit invalidates this verdict; re-review against the new exact head.
- `A2a-R-02` should be closable in `packages/storage/src/repository-schema.test.ts` and
  `packages/storage/src/repository-transitions.test.ts` alone. A diff that reaches into
  production, the migration, or `scripts/check-ct04-protected-package.mjs` needs an
  explicit justification.
- Do not edit, renumber, or reclassify
  `work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml`.
- The remediation report's §2 claim that "existing behavioral tests now carry the
  applicable protected/review IDs" should be corrected for the ten IDs above once they
  have real anchors.
