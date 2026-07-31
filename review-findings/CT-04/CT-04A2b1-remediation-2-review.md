# CT-04A2b1 remediation 2 independent review

Reviewed remediation head: `b8a5493b9e33a82c3e4d6b43e39d6e4422d05576`
Report-only commit at review time: `e2be367d443294e83f7b7d5d9584dad60256abf3`
Review-record base: `569586c11d400e6811b99982b5b1c9ea8fe842a0`
Accepted source head: `e3b69c612a51b0b2a8d436ae3ea5355abd40745e`
Initial review: `b8a70cb1793775d93b72b8923d01242e55751eb25d1621b1213a3eb07e1d2f66`
Remediation 1 review: `4d35f08915b279918e3809cddeff6ebfac6cb45f213abca113513a0a0a83a8f8`
Migration 0004 SHA-256:
`409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e` (unchanged this turn)

Review checkout: `e2be367`, branch `ct=04a2b1-repository-journal`, working tree clean
before and after. `git diff b8a5493 e2be367` touches only the remediation commit report,
so the reviewed code head is `b8a5493`. Local environment: Node `v26.2.0`, Vitest
`4.1.10`, TypeScript `7.0.2`, POSIX, non-root UID `1000`. Every probe ran outside the
repository, against temporary SQLite databases, a `git archive` extract, and isolated
`git clone` copies. Nothing in the repository was modified by this review.

**This document is introduced after `e2be367`.** The verdict binds to that exact head.

## Verdict

**ACCEPTED.** No blocking findings remain.

Both remaining directed items are closed and independently verified. One new advisory,
`B1-A-08`, is recorded with no action recommended. One correction to my own remediation-1
direction is recorded below.

This turn touched only `scripts/`, `.gitignore`, and the accepted plan. No production
source, migration, contract, or protected artifact changed. **B2 lifecycle commands
remain absent.**

## Re-verified basis

| Item | Result |
|---|---|
| Migrations 0001–0004 | all four byte-identical to the pinned values; 0004 unchanged this turn |
| CT-04 protected specification, A2 and A2b supplements | byte-identical |
| Initial and remediation-1 review artifacts | untouched; hashes match the plan's pins |
| Production source, routes, services, manifests, lockfile | unchanged |
| Changed paths this turn | `scripts/` (4), `.gitignore`, accepted plan, two remediation reports |
| `pnpm check` | green: 68 files / 609 tests, 4 Playwright, `check:scope`, `check:protected` |
| Independent probe suite | 49 of 49 pass |

## Closed items

### `B1-R-02` — closed

`.gitignore` gains `.ct04a-*/`, the checker's `^\.ct04a-git-test-[^/]+\/` carve-out is
removed, and `.gitignore` is admitted to `CT04A2B1_ALLOWED_CHANGED_PATHS` with a matching
plan §3/§18 amendment to a 32-file tree.

Verified in an isolated clone at this head:

```text
baseline                                    -> ok=true
.ct04a-git-test-Q/…            (namespace 1) -> ok=true
+ .ct04a-hostile-home-Q/…      (namespace 2) -> ok=true
+ .ct04a-future-namespace-Q/…  (hypothetical) -> ok=true
untracked out-of-tree source file            -> ok=false  (still rejected)
```

The fix closes the **class**, not the two known instances: a future `.ct04a-*` scratch
namespace is covered without further change. The inventory retains its pre-commit
protection — an untracked new source file outside the accepted tree is still rejected.

Determinism at this head: **10 of 10 consecutive full-suite runs passed** (609 tests
each), against 3 failures in 8 runs at the original implementation head. The permanent
regression test creates both real scratch namespaces and asserts a clean inventory, so
the property is proven rather than assumed.

### `B1-A-07` — closed

`stripComments` performs a lexical pre-pass before `IMPORT_PATTERN` runs, replacing
comment bodies with spaces while preserving newlines and quoted text.

I treated this as the highest-risk change in the slice, because a hand-written lexer now
gates every import detection repository-wide. Three independent checks:

**1. Whole-tree regression.** Compared `findImports` at this head against the
previously-verified implementation at `569586c`, across all 196 tracked `.ts`, `.tsx`,
`.mjs`, and `.js` files:

```text
specifiers lost:   1
specifiers gained: 0
```

The single loss is `'mod'` from the checker's own doc comment
(`*   import x from 'mod';`) — a false positive the strip pass correctly removes. **No
real dependency edge was lost anywhere in the tree.**

**2. Adversarial lexer cases.** 20 constructs known to break naive comment strippers, all
correctly handled: regex literals containing an apostrophe, both quote characters,
escaped slashes, and comment-like sequences; division adjacent to a slash; strings
containing `//` and `/*`; escaped quotes in both quote styles; template literals with
`${…}` containing quotes and with trailing backslashes; JSX attributes and text
containing apostrophes; block comments containing quotes; nested-looking block-comment
terminators; and CRLF line endings.

**3. End-to-end.** On a `git archive` extract of this head, a multi-line
`node:child_process` import carrying `// don't` and a multi-line `@craftingtable/git`
import carrying `/* the "owner's" git */` both produce the full four violations, while
the clean baseline stays at zero.

The structural property that makes this safe is worth recording: `stripComments` only
ever *replaces comment bodies with whitespace* and copies quoted regions verbatim. It
therefore cannot delete a real import. A lexing error can only fail to remove a comment,
which surfaces as a loud false positive rather than a silent miss — with the single
exception noted in `B1-A-08`.

## New advisory

### `B1-A-08` — a regex character class containing an unescaped `/*` can hide a following import

**No action recommended.**

`stripComments` has one path that can produce a silent false negative. A regex literal
whose character class contains an unescaped `/*` — legal JavaScript — makes the lexer
enter block-comment state and blank source until the next `*/`, which can swallow a real
import:

```js
const re = /[/*]/;
import { a } from '@craftingtable/git';   // not detected
```

Exposure is nil and the construct is not accidental:

- **zero** tracked files contain such a construct;
- closely related forms are all handled correctly — `/[/]*/`, `/\/\*/`, and a regex with
  an unbalanced apostrophe followed by a real comment and import all detect normally;
- exploiting it requires deliberately authoring the regex *and* the hidden import in a
  scanned file.

The structural close is a real tokenizer, or tracking regex-literal context in the lexer.
Given that the slice has now had two remediation turns and the residual requires
deliberate construction, I would not ask for it here. Recording it so it is on file rather
than rediscovered later.

## Correction to my remediation-1 direction

Item 5 of my remediation-1 direction asked for a regression assertion that a near-miss
such as `.ct04a-git-testX/evil.ts` remains rejected, while item 1 specified the
`.ct04a-*/` glob. Those two are contradictory: the glob matches `.ct04a-git-testX/`. That
was my error, not the implementer's.

The implementer's near-miss assertion passes because it calls `b1ChangedPathViolations`
with a literal path, bypassing Git's exclusion. Through the real inventory the path is now
admitted. **The test no longer proves the end-to-end property its name implies**, and
should not later be read as though it does.

The containment property that matters is nonetheless intact, which I verified rather than
assumed:

```text
git add   .ct04a-smuggle/evil.ts   -> refused ("ignored by one of your .gitignore files")
present but untracked+ignored      -> inventory ok=true   (cannot be part of the slice)
git add -f, now tracked            -> inventory REJECTS
committed                          -> inventory REJECTS
```

An ignored file cannot enter the delivered artifact without `git add -f`, and forcing it
makes it tracked, where the base-to-worktree diff catches it immediately. The only
detection genuinely given up is of an uncommitted ignored file under `.ct04a-*`, which by
construction cannot ship. That is the correct trade.

## Cumulative position at acceptance

Across three independent reviews of this slice — initial, remediation 1, and this one —
every finding is now closed or dispositioned:

| Finding | Final state |
|---|---|
| `B1-R-01` multi-line import detection | closed; full tree parity, end-to-end proof |
| `B1-R-02` inventory nondeterminism | closed; class-level Git exclusion, 10/10 runs |
| `B1-A-01` exact-tree deviation | closed; contract amended, not only the gate |
| `B1-A-02` composite-FK catalog guards | closed; proven load-bearing by three byte mutations |
| `B1-A-03` description bound scope | closed; legacy exception pinned by assertion |
| `B1-A-04` append-path schema sniff | no change, by disposition |
| `B1-A-05` size overrun | no change, by disposition |
| `B1-A-06` review-artifact admission | closed |
| `B1-A-07` comment-punctuation evasion | closed; lexical strip pass, three-way verified |
| `B1-A-08` regex-class block-comment path | advisory, no action recommended |

The substantive slice was sound at the original implementation head and is unchanged by
any remediation: schema-4 correlation, composite ownership, strict nine-variant contracts,
the fail-closed mapper, bounded browser invalidation, and safe activity text all held
under independent adversarial probing from the first review onward. Every remediation
addressed the deterministic gates around that work, not the work itself.

The slice is ready for acceptance at `e2be367d443294e83f7b7d5d9584dad60256abf3`.

## Carried forward to CT-04A2b2

Not findings against this slice; context for the next one.

1. **`packages/git` scratch location.** Two call sites —
   `packages/git/test/test-support.ts:89` and
   `packages/git/test/repository-inspector.test.ts:431` — create scratch directories
   inside the working tree, while every other package uses
   `mkdtempSync(join(tmpdir(), …))`. I verified the outlier has no technical reason to be
   one: with both pointed at `tmpdir()`, the complete `packages/git` suite passes (5 files,
   64 tests) and no scratch directory appears in the working tree. This touches CT-04A1
   source and belongs in its own work item. Doing it would make the `.gitignore` entry dead
   but harmless. Caveat for whoever takes it: `packages/git` gathers device and inode
   evidence, and `/tmp` is commonly tmpfs; today's tests assert shape only, but a future
   same-device test would justify a sanctioned repo-local scratch directory instead.
2. **`B1-A-08`** above, if the import scanner is revisited.
3. **Inspection-history completeness.** B1's five kinds are not a complete change feed for
   `repository_inspections`; `verified`, `environment-evidence-still-changed`, and
   `failure-recorded` append durable inspections with no workspace event. B2 owns the
   zero-event lifecycle proof and CT-04E must fetch history rather than infer freshness.
